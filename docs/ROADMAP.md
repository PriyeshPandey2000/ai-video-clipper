# Roadmap

## Phase 1 — Foundation (current)

- [x] Monorepo scaffold (Turborepo + pnpm + TypeScript + ESLint + Prettier + Husky)
- [x] Package architecture defined and stubbed
- [x] SQLite schema (projects, words, clips, segments, ai_outputs)
- [x] IPC channel type contract
- [x] Base UI components (Button, Card, Badge, Progress, Spinner)
- [x] VideoPlayer component
- [ ] `pnpm install` + `pnpm dev` opens Electron window

## Phase 2 — Core pipeline (next)

- [ ] File drop / import flow (renderer UI → IPC → main)
- [ ] FFmpeg proxy generation + audio extraction
- [ ] Whisper model download UI (progress bar, model size picker)
- [ ] Transcription → DB write
- [ ] Filler word + silence detection → DB write
- [ ] Project list view

## Phase 3 — AI layer

- [ ] API key input + keychain storage
- [ ] Clip suggestion flow (transcript → AI → DB)
- [ ] Blog post generation
- [ ] Social captions generation
- [ ] Pipeline progress UI (stages + progress bar)

## Phase 4 — Review UI

- [ ] Clip review cards (video preview + approve/reject)
- [ ] Transcript viewer with highlighted filler/silence
- [ ] Blog post editor (basic rich text)
- [ ] Social captions panel

## Phase 5 — Export

- [ ] Clip export with FFmpeg (MP4 + optional burned captions)
- [ ] SRT caption export
- [ ] Blog post markdown export
- [ ] Full episode export (fillers + silences removed)

## Phase 6 — Polish + monetization

- [ ] Freemium license gate
- [ ] Onboarding flow
- [ ] Whisper model management (upgrade/delete)
- [ ] App icon + branding
- [ ] Mac DMG + auto-update (electron-updater)
- [ ] Code signing + notarization
