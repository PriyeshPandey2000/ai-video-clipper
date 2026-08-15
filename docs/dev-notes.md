# Dev Notes

## Stack

- **App**: `apps/desktop` — Electron 32, React 19, electron-vite, Tailwind 4
- **Main process**: `apps/desktop/src/main/` — IPC handlers in `ipc.ts`, entry in `index.ts`
- **Renderer**: `apps/desktop/src/renderer/src/` — `App.tsx` root, components alongside
- **Packages**: `packages/ffmpeg`, `packages/types`, `packages/database`, `packages/ai`, `packages/captions`, `packages/whisper`, `packages/transcript`, `packages/export`, `packages/ui`, `packages/utils`, `packages/player`

## Commands

```bash
pnpm dev                                         # turbo dev — builds packages, then starts Electron

pnpm --filter @video-editor/types build          # must rebuild after editing packages/types
pnpm --filter @video-editor/ffmpeg build         # must rebuild after editing packages/ffmpeg
cd apps/desktop && pnpm typecheck                # always run this before committing
```

## IPC change workflow

1. Edit `packages/types/src/index.ts` (`IpcChannels`)
2. `pnpm --filter @video-editor/types build`
3. Edit `apps/desktop/src/main/ipc.ts`
4. Edit renderer call site
5. `cd apps/desktop && pnpm typecheck`

## FFmpeg blur bg

`packages/ffmpeg/src/index.ts` — blurBg mode:

- **Background**: `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=...`
- **Foreground**: `scale=1080:1920:force_original_aspect_ratio=decrease` (fit, NOT fill)
- **Overlay**: `overlay=(W-w)/2:(H-h)/2` (centered)

Never use `force_original_aspect_ratio=increase` for foreground — it fills the canvas and hides the background entirely.

## Live testing — Playwright + CDP

Test infra files live on disk but are NOT committed to product branches (separate PR):

- `apps/desktop/playwright.config.ts`
- `apps/desktop/tests/e2e/helpers/launch.ts`
- `apps/desktop/tests/e2e/smoke.spec.ts`

### Critical: ELECTRON_RUN_AS_NODE leak

Claude Code leaks `ELECTRON_RUN_AS_NODE=1` into child processes → `require("electron")` returns binary path string → `electron.app` is undefined → app crashes.

**Always unset before spawning:**

```bash
env -u ELECTRON_RUN_AS_NODE pnpm run dev:e2e
```

### Steps to live-test a feature

**Step 1** — Temporarily add to `apps/desktop/package.json` scripts:

```json
"dev:e2e": "E2E_TEST=1 electron-vite dev"
```

**Step 2** — Temporarily add to `apps/desktop/src/main/index.ts` before `createWindow()`:

```typescript
if (process.env["E2E_TEST"]) {
  app.commandLine.appendSwitch("remote-debugging-port", "9315")
}
```

**Step 3** — Kill any stale process on port 9315:

```bash
lsof -ti:9315 | xargs kill -9 2>/dev/null
```

**Step 4** — Launch:

```bash
env -u ELECTRON_RUN_AS_NODE pnpm run dev:e2e &> /tmp/e2e-dev.log &
```

**Step 5** — Wait for CDP:

```bash
for i in $(seq 1 30); do curl -s http://localhost:9315/json/version > /dev/null 2>&1 && echo "ready" && break; sleep 2; done
```

**Step 6** — Connect via Node:

```javascript
const { chromium } = require("./node_modules/@playwright/test")
const browser = await chromium.connectOverCDP("http://localhost:9315")
const ctx = browser.contexts()[0]
let page
for (const p of ctx.pages()) {
  if (p.url().includes("localhost")) {
    page = p
    break
  }
}
await page.screenshot({ path: "/tmp/test.png" })
await browser.close()
```

**Step 7** — After testing, revert BOTH temp changes (package.json + main/index.ts). Verify with `git diff` before committing. These must never appear in a product commit.

**Step 8** — Kill test app:

```bash
lsof -ti:9315 | xargs kill -9 2>/dev/null
```

### Finding UI elements

- Toggles are `<div>` inside `<label>`, not `<button>` — use `page.locator('label').filter({ hasText: 'X' }).locator('div').first()`
- Episode framing slider: `page.locator('input[type=range]').first()`
- 9:16 toggle: `page.locator('span', { hasText: /^9:16$/ })`

## Aspect ratio guard

`ar < 1` → portrait → block with "already portrait" message.
`ar < 1.2` → near-square → warn but allow.
`ar >= 1.2` → proceed.
Not `ar <= 1` — square (1:1) should warn, not block.

## Wave 3 clip-selection decisions

### Implemented

**D5 — Hook-first opening** (`packages/ai/src/clip-selector.ts:hookFirstAdjust`)
Advances clip start up to 2 sentences to find a hook sentence (HOOK_RE). Adds "weak opening" warning if none found. HOOK_RE requires 2+ digit numbers (not any digit) to avoid false positives.

**C4 — Content-type rubric** (`packages/ai/src/clip-selector.ts:detectContentType`)
Detects interview / tutorial / solo from question ratio + keyword heuristics. Appends a type-specific rubric suffix to the LLM system prompt per chunk.

**#46 — Recall ablation** (`scripts/recall-ablation.ts`)
Sends full unchunked transcript to LLM in one call, compares against pipeline clips by IoU ≥ 50%.
Run: `GROQ_API_KEY=... pnpm recall-ablation <projectId>`

**B3 — Chunk overlap increase** (`packages/ai/src/clip-selector.ts`, CHUNK_OVERLAP_MS)
Increased from 60 s → 150 s. Ensures moments near chunk boundaries appear in full context in at least one chunk. Only affects videos > 30 min (CHUNK_THRESHOLD_MS). Zero risk for shorter content.

**E5 — Hook text overlay** (`packages/ffmpeg/src/index.ts:buildDrawtextFilter`)
Burns the clip title as a text overlay for the first 3 s of every exported clip, fading out between 2.5–3 s. Implemented via `drawtext` with `alpha='if(lt(t,2.5),1,max(0,(3-t)/0.5))'`. Applied to all four filter paths (blurBg, reframe, subtitle-only, bare). `hookText` is not forwarded to `exportEpisode` (multi-interval D7 path) — acceptable because that path is for jump-cut clips where timing is more complex.

---

### Dropped permanently — with rationale

**B12 — Pre-filter candidates to top ~25%**
Recall ablation (#46) on the jobs video returned 66.7% (needed ≥90%). The full-transcript single-call LLM actually missed a clip that the chunked pipeline caught. Chunking helps by giving the LLM focused context windows ("lost in the middle" phenomenon). A pre-filter would silently drop good clips with no way to recover. **Do not implement.**

**A6 — SenseVoice ONNX (emotion/laughter/BGM tags)**
Would require: 300 MB ONNX model download, `onnxruntime-node` native addon, architecture-specific `.node` binaries (fragile on macOS Electron), audio chunking pipeline, model version management. The existing `{loud}` and `{burst}` acoustic heuristics cover ~80% of the emotional signal for free. If emotion classification is ever needed, prefer a cloud API call rather than a bundled local model.

**B5 — Laughter detection**
Depended on A6 (SenseVoice). Dropped with it.

**E1/E2 — Active speaker reframe + LR-ASD crop smoothing**
Would require: LR-ASD ONNX model, video frame extraction pipeline, per-frame bounding-box inference, crop smoothing filter graph. Same infrastructure fragility as A6. `crop_x=0.5` covers solo talking-head content correctly. If dual-speaker interview framing is ever needed, implement via a lightweight cloud face-detection API at export time, not a bundled local model.

---

### Multi-scale windows (B3 original proposal) — pivoted

Original B3 proposed 15/30/45/60/90 s sliding windows. This would have multiplied LLM calls and created a deduplication nightmare. Pivoted to the simpler fix: increase the existing overlap constant. Solved the boundary problem at ~10% cost increase vs 5× cost increase.

## Commit rules

- Never mention Claude or AI in commit messages or PR descriptions
- Product commits: product files only
- Test infra (playwright.config.ts, tests/, dev:e2e script, E2E_TEST block in main/index.ts) → separate PR only
