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
