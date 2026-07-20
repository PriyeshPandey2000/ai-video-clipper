# Roadmap

## Phase 1 — Foundation ✅ Done

- [x] Monorepo scaffold (Turborepo + pnpm + TypeScript + ESLint + Prettier + Husky)
- [x] Package architecture defined and stubbed
- [x] SQLite schema (projects, words, clips, segments, ai_outputs)
- [x] IPC channel type contract
- [x] Base UI components (Button, Card, Badge, Progress, Spinner)
- [x] `pnpm install` + `pnpm dev` opens Electron window

## Phase 2 — Core pipeline ✅ Done

- [x] File drop / import flow (renderer UI → IPC → main)
- [x] FFmpeg proxy generation + audio extraction
- [x] Whisper model download with progress bar, model size picker (tiny/base/small/medium/large)
- [x] Transcription → DB write (word-level timestamps via whisper-cpp JSON output)
- [x] Filler word + silence detection → DB write
- [x] Project list view (sidebar)
- [x] Video player with proxy playback

## Phase 3 — AI layer ✅ Done

- [x] API key loading via .env (GROQ_API_KEY searched from monorepo root upward)
- [x] Clip suggestion flow (timestamped transcript → AI → DB) — duration-aware clip count
- [x] Social captions generation (stored in ai_outputs table)
- [x] Pipeline progress UI (stage + progress bar + message)

## Phase 4 — Review UI ✅ Done

- [x] Transcript viewer (word-level, click-to-seek, filler word highlighting)
- [x] Clip review cards (title, AI score, reason, approve/reject, select-to-highlight transcript)
- [x] Chapter ↔ transcript highlight sync (click chapter → highlight range in transcript viewer)
- [x] Social captions panel (per-platform copy button, hashtags, empty state for missing API key)

## Phase 5 — Export ✅ Done

- [x] Clip export — FFmpeg cut per approved clip to chosen output folder, marks clip as `exported`
- [x] Subtitle burn-in toggle (default on) — time-offset SRT generated per clip, burned via `-vf subtitles=`
- [x] Full episode export — FFmpeg trim+concat removing filler+silence segments, optional subtitle burn-in
- [x] SRT export — words table → grouped subtitle lines (≤8 words, ≤4s, 1s pause breaks)
- [x] Output folder picker — native OS folder dialog, defaults to `~/Downloads/<project-name>/`
- [x] Reveal in Finder after every export (`shell.showItemInFolder`)
- [x] Bulk clip export — Export all approved clips in one click

## Phase 5.5 — Stability + UI polish ✅ Done

- [x] Bundled portable FFmpeg with libass (subtitle burn-in works without Homebrew on end-user machines)
- [x] `scripts/setup-ffmpeg.sh` — one-shot dev setup using `ffmpeg-full` + `dylibbundler`
- [x] Fix disk leak: Whisper JSON temp file cleanup after transcription
- [x] Fix FILLER_WORDS sync between transcript package and renderer
- [x] Fix stale `selectedProject` derived from wrong list
- [x] Fix stale closure on `handleExport` in ClipReview (wrong output folder)
- [x] Fix word filter in subtitle generation (words straddling clip end were dropped)
- [x] Fix `srtPath` silently dropped in single-interval episode export fast-path
- [x] App renamed to **Clipper**
- [x] Homepage with 3 recent project cards + drop zone
- [x] Sidebar redesign: search, compact + button, status dots, relative timestamps, dividers, Settings footer
- [x] Export controls: action buttons in header, settings row (subtitles, folder, SRT) below
- [x] Paragraph-based transcript rendering grouped at silence gaps; fix text-justify globally
- [x] Home navigation; fix auto-select re-redirect bug
- [x] Lucide icons; dark scrollbar styles; cursor-pointer audit

## Phase 6 — Distribution 🔄 In progress

- [x] App icon — Clipper C lettermark (SVG + 1024×1024 PNG), `productName` updated to "Clipper"
- [x] `scripts/setup.sh` — full dev environment bootstrap (Node, pnpm, FFmpeg bundle, .env template)
- [ ] Mac DMG build
- [ ] Code signing + notarization (Apple Developer account required)
- [ ] Auto-update via `electron-updater`
- [ ] Onboarding flow (first-run walkthrough: drop video → pick model → transcribe)

## Phase 7 — Creator features 🔄 In progress

- [x] Clip trim UI — drag handles adjust AI-suggested clip start/end, saves to DB, reflects in export
- [x] Animated styled captions — bold word-highlight captions burned into clips (CapCut style)
- [x] 9:16 vertical reframe — drag-on-video crop overlay, per-clip position saved to DB, 1080×1920 FFmpeg output
- [x] Customizable filler word list — add/remove words per project from UI
- [ ] Whisper model manager — download/delete models from UI, show disk usage
- [x] Audio crossfade at episode splice points (issue #10)
- [x] Episode SRT timestamp remapping (issue #7)

## Phase 8 — Distribution + reach ❌ Not started

- [ ] Windows support
- [ ] Direct publish to TikTok / Instagram Reels / YouTube Shorts
- [ ] Natural language clip search ("find where I mention pricing")

## Phase 9 — Smarter clip selection ❌ Not started

- [ ] Semantic block preprocessing — group word-level timestamps into silence-bounded blocks with metadata (filler density, WPM, speaker) before LLM call; reduces token usage 50–70%
- [ ] Block-ID-based LLM output — LLM returns `start_block_id` / `end_block_id` instead of raw milliseconds; backend resolves precise timestamps from DB, eliminating hallucination
- [ ] Code-level timestamp validation — clamp LLM output to `[0, durationMs]`, snap to nearest word boundary, cap clip at 90s
- [ ] FFmpeg audio energy scoring — extract per-second RMS amplitude, compute energy level per block, pass as `Energy: High/Low` signal to LLM
- [ ] Content type detection — separate LLM call before scoring classifies video as podcast / interview / tutorial / vlog + density (sparse/dense); main prompt tuned per type
- [ ] Explicit virality criteria in prompt — replace generic "find engaging segments" with ranked signal list: hook moments, emotional peaks, opinion bombs, revelation moments, conflict, quotable one-liners, story peaks, practical value
- [ ] Hook sentence per clip — LLM returns the single opening line that makes someone stop scrolling; shown on clip card alongside reason
- [ ] Duration guidance in prompt — 45–90s sweet spot, shorter only for standalone one-liner, longer only when story arc needs full context
- [ ] Retry on bad LLM JSON — up to 3 attempts with progressively stricter instruction before failing; prevents pipeline crash on malformed output
- [ ] Dedupe overlapping clips — after scoring, drop any clip that overlaps >50% with a higher-scored one
- [ ] Long video chunking — transcripts >30 min split into 20-min chunks with 60s overlap, scored per chunk then deduped across chunks

## Polish backlog (post-phase completion)

- 9:16 reframe for episode export — needs a single global cropX setting, not per-clip; different UX from clip reframe
- Crop position indicator on clip cards — small visual showing saved L/C/R position without having to select the clip
- "Saved" flash feedback after drag-commit on crop overlay
- Blur background fill for non-16:9 sources — add blurred copy of video as background instead of cropping (Kapwing style)
- Source aspect ratio detection — warn or skip reframe if source is already portrait/square
- Trim changes reset clip status from "exported" → "approved" — currently stays "exported" even after re-trimming; re-export button covers this but auto-reset would be cleaner

## Out of scope (premature for early stage)

- Face tracking / computer vision scoring — requires Python/ML infra, different stack entirely
- Hook pattern matching engine — semantic block prompt already handles 80% of this
- Dynamic hot-zone windowing — matters only for 2h+ recordings, overengineered for MVP
- Audio pitch / laughter detection — nice signal but high complexity vs. marginal gain
