# Pipeline Implementation Log

> Running log of changes made during pipeline construction. Each entry documents what changed and why.

---

## Phase 1 — Wire AI stages into pipeline

**Goal:** Connect the existing `@video-editor/ai` modules into `pipeline:start` IPC handler so the pipeline produces clip suggestions, blog posts, and social captions automatically after transcription.

### Changes

#### `apps/desktop/src/main/ipc.ts`

- Imported `selectClips`, `generateBlogPost`, `generateSocialCaptions` from `@video-editor/ai`
- After transcription + filler/silence detection completes, call:
  1. `selectClips()` → write results to `clips` table (one row per clip suggestion)
  2. `generateBlogPost()` → write to `ai_outputs` table with type `blog`
  3. `generateSocialCaptions()` → write to `ai_outputs` table with type `captions`
- Sent `pipeline:complete` only after all AI stages finish

**Why:** The AI package was complete but disconnected. This was <30 lines of glue code that completes the data flow from import → transcription → AI analysis → stored results. Without this, no data exists for the review UI to display.

**Trade-off:** Runs AI stages sequentially (not parallel) to keep progress reporting simple. For long transcripts this adds ~10-15s to pipeline time, but avoids race conditions in DB writes.

---

## Phase 2 — Transcript Viewer UI

**Goal:** Show the word-level transcript in the renderer with filler word highlighting, silence markers, and click-to-seek.

### Changes

#### `apps/desktop/src/renderer/src/TranscriptViewer.tsx`

- New component: renders words from DB with color-coded filler words (`uh`, `um`, `like`, etc.)
- Silence markers shown as clickable gaps between words
- Click any word → `window.api.invoke("player:seek", { ms })` to jump video to that timestamp

**Why:** The transcript is the most immediate output of the pipeline and the foundation for reviewing clip suggestions. Users need to quickly scan the transcript, see where filler words cluster, and jump to specific moments.

**Design choices:**

- Flat word list (not grouped into sentences) to stay aligned with DB storage — sentences are reconstructed server-side later
- Filler words highlighted in amber, silence markers as thin gray bars — easy to spot at a glance
- Click-to-seek uses existing IPC channel `project:get` pattern

---

## Phase 3 — Clip Review UI

**Goal:** Display AI-suggested clips with score, reason, and platform targeting. Let user approve/reject.

### Changes

#### `apps/desktop/src/renderer/src/ClipList.tsx`

- New component: fetches clips from `clips` table via `project:get` IPC
- Each clip card shows: title, score (0-1), platform badge, reason text, duration bar
- Approve/Reject buttons → `clip:update-status` IPC

#### `apps/desktop/src/renderer/src/ClipPreview.tsx`

- New component: plays clip boundaries on the VideoPlayer (startMs → endMs loop)
- Shows clip number cards overlaying the timeline

**Why:** Clip suggestions are the core deliverable. The UI needs to make it fast to scan suggestions and decide which to keep.

**Design choices:**

- Score as a progress bar (visual, fast to scan)
- Platform badge with icon (TikTok/Reels/Shorts)
- Reason text kept to 1-2 lines (details on hover)
- Approve/Reject is optimistic UI — updates instantly, syncs to DB in background

---

## Phase 4 — Export

**Goal:** Render approved clips as MP4 files using FFmpeg.

### Changes

#### `packages/export/src/index.ts`

- Filled in stub: `exportSingleClip()` now calls `ffmpeg.exportClip()` with correct start/end times
- Added `exportMultipleClips()` for batch exporting all approved clips

#### `apps/desktop/src/main/ipc.ts`

- `export:clips` handler now calls `exportSingleClip()` per approved clip
- Sends progress per clip, then `export:complete` with array of output paths

**Why:** Without export, clips live only in the app database. Export is what makes them usable (upload to social media, share with team).

**Design choices:**

- One FFmpeg call per clip (not a single concatenated render) — allows parallel processing in future, and each clip is independently usable
- Output format: MP4 with H.264 + AAC, matching source resolution

---

## Phase 5 — Content Generation UI

**Goal:** Show AI-generated blog post and social captions inside the app.

### Changes

#### `apps/desktop/src/renderer/src/AiOutputPanel.tsx`

- New component: fetches `ai_outputs` from DB, shows blog post (rendered markdown) and social captions per platform
- Copy-to-clipboard button for each output

**Why:** These are secondary outputs but valuable for repurposing content across formats. Users expect to see them after the pipeline runs.

---

## Phase 6 — Testing & Error Handling

**Goal:** Add basic test infrastructure and error recovery for AI calls.

### Changes

#### Root `package.json`

- Added `vitest` as devDependency
- `test` script: `vitest run`

#### `packages/ai/src/__tests__/client.test.ts`

- Tests: `createAiClient` throws without API key, `generateText` returns string, `generateObject` returns validated schema

#### `apps/desktop/src/main/__tests__/ipc.test.ts`

- Tests: pipeline stages handle AI failures gracefully, DB writes rollback on error

**Why:** The AI stage is the most failure-prone part (network errors, API errors, malformed responses). Without tests, regressions are silent.

**Design choices:**

- AI calls wrapped in try/catch with retry (3 attempts, exponential backoff)
- If AI stage fails, pipeline still completes with partial results (transcript still useful)
- All errors logged to DB for debugging

---

## Appendix: Key Decisions During Implementation

### Why Groq over OpenAI/Anthropic?

- Cheaper (Llama 4 Scout: ~$0.15/M tokens vs GPT-4o: $2.50/M)
- Fast inference (280+ tokens/s)
- Vercel AI SDK gives us provider abstraction — swap later with one config change

### Why Llama 4 Scout for structured output?

- Supports `json_schema` response format (best-effort mode), unlike most Groq models
- Fast enough for ~10s clip analysis per request
- Falls back to `llama-3.3-70b` for freeform text (blog posts, captions)

### Why not use `strict: true` structured outputs?

- Only GPT-OSS models support it on Groq
- GPT-OSS 20B/120B are good but cost more and are less available under load
- Best-effort + client-side Zod validation + retry is sufficient reliability for v1

### Why wire AI in main process (not a separate worker)?

- Simpler architecture for v1 — no IPC between worker and main
- AI calls are simple HTTP requests (no CPU-bound work), so they don't block the event loop
- Can extract to a worker later if needed
