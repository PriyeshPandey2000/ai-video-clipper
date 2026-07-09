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
- [x] Blog post generation (stored in ai_outputs table)
- [x] Social captions generation (stored in ai_outputs table)
- [x] Pipeline progress UI (stage + progress bar + message)

## Phase 4 — Review UI 🟡 In progress

- [x] Transcript viewer (word-level, click-to-seek, filler word highlighting, silence gap markers)
- [x] Clip review cards (title, AI score, reason, approve/reject, select-to-highlight transcript)
- [x] Chapter ↔ transcript highlight sync (click chapter → highlight range in transcript viewer)
- [ ] Blog post viewer (data exists in DB, no UI yet)
- [ ] Social captions panel (data exists in DB, no UI yet)

## Phase 5 — Export ❌ Not started

- [ ] Clip export with FFmpeg (MP4 + optional burned captions) — handler is a stub returning `[]`
- [ ] SRT caption export
- [ ] Blog post markdown export
- [ ] Full episode export (fillers + silences removed)

## Phase 6 — Polish + monetization ❌ Not started

- [ ] Freemium license gate
- [ ] Onboarding flow
- [ ] Whisper model management (upgrade/delete downloaded models)
- [ ] App icon + branding
- [ ] Mac DMG + auto-update (electron-updater)
- [ ] Code signing + notarization
