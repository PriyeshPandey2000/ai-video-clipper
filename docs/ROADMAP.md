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

## Phase 6 — Distribution ❌ Not started

- [ ] App icon + branding (Clipper logo)
- [ ] Mac DMG build
- [ ] Code signing + notarization (Apple Developer account required)
- [ ] Auto-update via `electron-updater`
- [ ] Onboarding flow (first-run walkthrough: drop video → pick model → transcribe)
- [ ] `scripts/setup.sh` — full dev environment bootstrap

## Phase 7 — Creator features ❌ Not started

- [ ] Clip trim UI — adjust AI-suggested clip start/end before export
- [ ] Animated styled captions — bold word-highlight captions burned into clips (CapCut style)
- [ ] 9:16 vertical reframe — crop/pad clips for TikTok/Reels/Shorts export
- [ ] Customizable filler word list — add/remove words per project from UI
- [ ] Whisper model manager — download/delete models from UI, show disk usage
- [ ] Audio crossfade at episode splice points (issue #10)
- [ ] Episode SRT timestamp remapping (issue #7)

## Phase 8 — Distribution + reach ❌ Not started

- [ ] Windows support
- [ ] Direct publish to TikTok / Instagram Reels / YouTube Shorts
- [ ] Natural language clip search ("find where I mention pricing")
