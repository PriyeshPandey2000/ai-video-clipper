# Pipeline Implementation Log

> Running log of changes made during pipeline construction. Each entry documents what changed and why.

---

## Session 1 — AI stages wired into pipeline

**Goal:** Connect `@video-editor/ai` modules into `pipeline:start` so the pipeline produces clip suggestions, blog posts, and social captions automatically after transcription.

### Changes

#### `apps/desktop/src/main/ipc.ts`

- Imported `selectClips`, `generateBlogPost`, `generateSocialCaptions` from `@video-editor/ai`
- After transcription + filler/silence detection completes:
  1. `selectClips()` → write results to `clips` table
  2. `generateBlogPost()` → write to `ai_outputs` (type `blog_post`)
  3. `generateSocialCaptions()` → write to `ai_outputs` (type `social_caption`)
- AI stage wrapped in try/catch — pipeline still completes with transcript if AI fails

**Trade-off:** Sequential AI calls for simpler progress reporting. Adds ~10-15s to pipeline but avoids DB write races.

---

## Session 2 — Structured output: approach and constraints

**Problem:** LLM returning wrong field names (`start`/`end` instead of `startMs`/`endMs`).

**Root cause:** Prompt never told the model what fields to use — model invented them.

**Fix:** Added explicit field descriptions to system prompts. This was a prompt problem, not a mode problem.

### Structured output mode decisions

| Route                                                          | Result                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `meta-llama/llama-4-scout-17b-16e-instruct` with `json_schema` | Model violates enum constraints → 400                                             |
| `openai/gpt-oss-20b` with `strict: true`                       | AI SDK Zod→JSON Schema doesn't set `additionalProperties: false` everywhere → 400 |
| `llama-3.3-70b-versatile` with `json_object` mode              | Works — model follows explicit field descriptions                                 |

**Current approach:** `json_object` mode (best-effort). AI SDK validates against Zod client-side, throws `NoObjectGeneratedError` on mismatch. Pipeline catches this gracefully.

**To upgrade:** Switch to `moonshotai/kimi-k2-instruct-0905` with `structuredOutputs: true` + Zod v4's `toJSONSchema()`.

---

## Session 3 — Whisper CLI integration rewrite

**Problem:** Old code used `-oj` (stdout JSON) + `--word-timestamps true`. whisper-cli outputs JSON to a file (`audio.wav.json`) not stdout; the stdout reader was never getting any data.

**Fix:** Switch to `-ojf` (output JSON file) + read the file after the process closes. Added `normalizeWhisperResult()` to map whisper-cli JSON format (`WhisperCliResult`) to the internal `WhisperTranscriptionResult` type.

### Changes

#### `packages/whisper/src/index.ts`

- Args changed: `-oj --word-timestamps true` → `-ojf -sow -t 4`
  - `-ojf`: write JSON to `<audioPath>.json` file
  - `-sow`: split output on word boundaries (subtitle formatting, harmless for JSON)
  - `-t 4`: 4 threads
- Added `normalizeWhisperResult(raw: WhisperCliResult)`: maps token-level offsets (ms) to `WhisperWord` (seconds), filters special tokens (those starting with `[` or `<`)
- Added `MODEL_FILES` record: model → filename (e.g. `large` → `ggml-large-v3.bin`)
- Added `large` model support

**Why separate `MODEL_FILES`:** `modelPath()` was previously computing `ggml-${model}.bin` which breaks for `large` (file is `ggml-large-v3.bin`, not `ggml-large.bin`).

---

## Session 4 — TranscriptViewer + ClipReview UI

**Goal:** Show transcript and clips in the app with highlight sync between them.

### Changes

#### `apps/desktop/src/renderer/src/TranscriptViewer.tsx` (new)

- Fetches words via `project:get-words` IPC
- Renders word-by-word with filler word dimming (grey), click-to-seek
- Silence gap markers shown inline (e.g. `● 2.3s`)
- `highlightRange` prop: words within range get violet highlight + auto-scroll
- Virtual pagination: renders 500 words at a time, loads more on scroll

#### `apps/desktop/src/renderer/src/ClipReview.tsx` (new)

- Fetches clips via `clip:list` IPC
- Sorted by `startMs`
- Click card → calls `onSelectClip(startMs, endMs)` → sets `highlightRange` in parent → TranscriptViewer highlights matching words
- Approve/Reject → `clip:update-status` IPC, optimistic UI update

#### `apps/desktop/src/main/ipc.ts`

- Added `project:get-words` handler
- Added `clip:list` handler

#### `apps/desktop/src/renderer/src/App.tsx` (ProjectView)

- Added `highlightRange` state
- `handleSelectClip`: sets `highlightRange` + seeks video to clip start
- `handleSeekWord`: seeks video + clears `highlightRange`
- Renders `<TranscriptViewer>` and `<ClipReview>` when `project.status === "ready"`
- Model picker moved into ProjectView header (inline segment button group)

#### `apps/desktop/src/preload/index.ts` + `env.d.ts`

- Added `project:get-words` and `clip:list` to `InvokeChannels`

---

## Session 5 — .env loading in main process

**Problem:** `GROQ_API_KEY` not available in Electron main process. Node doesn't auto-load `.env`; in dev mode `process.cwd()` isn't the monorepo root.

**Fix:** Search upward from `app.getAppPath()` for a `.env` file and load it via `dotenv` before anything else.

#### `apps/desktop/src/main/index.ts`

```ts
const envPaths = [
  join(dirname(app.getAppPath()), ".env"), // works in dev: app is at apps/desktop → goes to root
  join(app.getAppPath(), ".env"),
  join(app.getAppPath(), "../../.env"),
  join(__dirname, "../../../../.env"),
]
for (const p of envPaths) {
  if (existsSync(p)) {
    dotenv.config({ path: p })
    break
  }
}
```

**Note:** `app.getAppPath()` is safe to call before `app.whenReady()`. `app.getPath("userData")` is not.

---

## Session 6 — Chapter↔transcript timestamp fixes

**Problem:** Chapters (AI clip suggestions) weren't highlighting the correct transcript sections. Three bugs:

### Bug 1 — No timestamps in LLM input

`wordsToPlainText` was passed to `selectClips` → LLM received raw text with no timestamps → any `startMs`/`endMs` values were hallucinated.

**Fix:** Switch to `wordsToTimestampedText` which produces `[10.50] Hello [11.20] world ...` format.

### Bug 2 — Seconds vs milliseconds mismatch

Transcript shows timestamps in seconds (`[10.50]`) but system prompt asked for milliseconds output with no explanation of how to convert. LLM returned seconds-as-milliseconds (off by 1000x).

**Fix:** System prompt now explicitly says "multiply by 1000" with a worked example.

### Bug 3 — Impossible clip constraints for short videos

`selectClips` was called with hardcoded "find 5 clips of 30-90 seconds". For a 50-second video this is physically impossible → LLM forced to hallucinate timestamps to satisfy the count.

**Fix:** `selectClips` now takes `videoDurationMs` and computes:

- `targetMin = max(10s, duration × 20%)`
- `targetMax = duration × 60%`
- `clipCount = min(maxClips, floor(duration / targetMin))`

### Bonus — durationMs was always 0

`projects.durationMs` was never updated after transcription (defaulted to 0 from `project:create`). Now computed from last word's `endMs` and written to DB during the analyzing stage.

---

## Session 7 — Social captions panel + pipeline hardening

**Goal:** Phase 4 completion — surface AI outputs in the UI, remove out-of-scope blog post feature, make pipeline failure-safe.

### Changes

#### `apps/desktop/src/renderer/src/CaptionsPanel.tsx` (new)

- Fetches `ai_outputs` via `project:get-ai-outputs` IPC
- Finds `social_caption` row, parses JSON as `SocialCaption[]` (`platform`, `caption`, `hashtags`)
- Per-platform copy button: copies `caption + "\n\n" + #hashtag #hashtag`; shows "Copied!" for 1500 ms
- Hashtags styled `text-violet-400/70`
- Empty state explains GROQ_API_KEY requirement

#### `apps/desktop/src/main/ipc.ts`

- Added `project:get-ai-outputs` handler
- Removed `generateBlogPost` import and call from pipeline — blog post not relevant to video app; data still accumulates in DB from prior runs
- Removed `plainText` variable (was only used by blog post)
- Entire `pipeline:start` body now wrapped in outer try/catch → sets project `status: "error"`, fires `pipeline:error` event

#### Bug fixes

- `selectClips` score thresholds in `ClipReview` were checking raw `0–1` value against `>= 7` / `>= 4` → score always showed red. Fixed to `>= 0.7` / `>= 0.4`.
- AI score display: raw `0–1` value shown as `0.8/10`. Fixed to `Math.round(score * 10)/10` display.
- `Button` import in `ClipReview` was unused → ESLint pre-commit hook failure. Removed.

---

## Session 8 — Export (Phase 5)

**Goal:** Full export pipeline — clip cuts, episode edit, SRT, subtitle burn-in, output folder picker.

### Architecture decisions

**Clip subtitle burn-in:** Each clip gets its own SRT with timestamps offset by `-clip.startMs`. Written to OS temp dir, passed to FFmpeg `-vf subtitles=`, deleted after encode. This keeps clip SRTs self-contained (start at 00:00:00,000).

**Episode export concat filter:** FFmpeg `trim`+`setpts`+`concat` filter graph removes filler and silence segments. Keep intervals computed as the inverse of the segments table: sort segments by startMs, walk a cursor from 0, push gap before each segment. Optional `subtitles=` filter appended to `[outv]` output when burn-in enabled.

**SRT grouping strategy:** ≤8 words per subtitle line, hard break on >4s duration or >1s pause between words. Produces readable output without a forced-alignment library.

### Changes

#### `packages/ffmpeg/src/index.ts`

- Added `EpisodeExportOptions` + `exportEpisode()`: builds FFmpeg `filter_complex` from keep-intervals array, optional `srtPath` appends `subtitles=` filter on concat output
- Added `srtPath?` to `EpisodeExportOptions`

#### `packages/database/src/index.ts`

- Exported `inArray` from `drizzle-orm` (needed by `export:clips` for batch clip lookup)

#### `apps/desktop/src/main/ipc.ts`

- `export:clips`: loads clips by ID, generates per-clip offset SRT when `burnSubtitles=true`, writes to temp file, calls `exportClip`, deletes temp file, marks clips `exported` in DB
- `export:full`: inverts segments → keep intervals, calls `exportEpisode` with optional full SRT
- `export:srt`: builds SRT from words table, writes to output folder
- `dialog:pick-folder`: opens native `showOpenDialog({ openDirectory })`, returns chosen path or null
- `shell:show-item`: calls `shell.showItemInFolder(path)` — reveals file in Finder/Explorer
- Helper functions added: `sanitizeName`, `msToSrtTime`, `buildSrt`

#### `apps/desktop/src/renderer/src/ClipReview.tsx`

- Accepts `exportSettings: { outputDir: string; burnSubtitles: boolean }` prop
- "Export" button appears on `approved` clips, shows "Exporting..." state, transitions to "Exported" on success, auto-reveals file in Finder

#### `apps/desktop/src/renderer/src/App.tsx`

- ProjectView: `outputDir` + `burnSubtitles` state
- Header (when `status === "ready"`): "Burn subs" checkbox, folder picker button (shows current folder name), "Export SRT", "Export Episode" buttons
- Folder picker opens `dialog:pick-folder` IPC, updates `outputDir` state for session
- All export calls use shared `outputDir` / `burnSubtitles` settings
