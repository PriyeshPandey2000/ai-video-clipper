# Architecture

## Core principle

Pipeline-first. Not a video editor. Long recording → AI → publishable content.
Users don't want to edit. They want content published. The editor is a thin review layer.

## Tech stack

| Layer            | Choice                                | Why                                                        |
| ---------------- | ------------------------------------- | ---------------------------------------------------------- |
| Desktop runtime  | Electron 32                           | Cross-platform, full Node.js access for FFmpeg/Whisper     |
| UI               | React 19 + Vite 5                     | Fast DX, component model, HMR                              |
| Styling          | Tailwind CSS 4                        | Utility-first, no runtime CSS                              |
| Language         | TypeScript 5 strict                   | Catch errors early, great IDE support                      |
| Monorepo         | Turborepo + pnpm workspaces           | Parallel builds, shared packages, caching                  |
| Database         | SQLite (Drizzle ORM + better-sqlite3) | Local, fast, relational, atomic writes                     |
| Video processing | FFmpeg (bundled)                      | Industry standard, reliable, no dependency on user install |
| Transcription    | Whisper.cpp (downloaded on first run) | Local, private, no API cost, word-level timestamps         |
| AI (content)     | OpenAI / Anthropic (user's API key)   | Cloud, high quality, user controls cost                    |

## Process architecture

```
┌─────────────────────────────────────┐
│           Renderer Process          │
│   React UI — display only           │
│   Video playback (HTML5 <video>)    │
│   No direct file/DB/AI access       │
└──────────────┬──────────────────────┘
               │ IPC (contextBridge)
┌──────────────┴──────────────────────┐
│           Main Process              │
│   SQLite database                   │
│   FFmpeg subprocess                 │
│   Whisper subprocess                │
│   AI API calls (OpenAI/Anthropic)   │
│   File system access                │
└─────────────────────────────────────┘
```

**Rule:** Renderer never touches filesystem, DB, or AI APIs directly.
All data flows through typed IPC channels defined in `@video-editor/types`.

## Monorepo layout

```
video-ai-editor/
├── apps/
│   └── desktop/               ← Electron app (main + preload + renderer)
│
├── packages/
│   ├── types/                 ← Shared TS types + IPC channel map
│   ├── utils/                 ← Pure utility functions (no side effects)
│   ├── database/              ← Drizzle schema, migrations, DB init
│   ├── ai/                    ← OpenAI/Anthropic abstraction layer
│   ├── ffmpeg/                ← FFmpeg wrapper (clip export, proxy gen, audio extract)
│   ├── whisper/               ← Whisper model download + transcription runner
│   ├── transcript/            ← Transcript processing (filler detection, silence, SRT)
│   ├── export/                ← Export pipeline orchestration
│   ├── player/                ← React <VideoPlayer> component
│   └── ui/                    ← Shared UI components (Button, Card, Badge, etc.)
│
├── docs/
│   ├── ARCHITECTURE.md        ← this file
│   ├── DECISIONS.md           ← ADRs
│   └── ROADMAP.md             ← phased feature plan
```

## Data pipeline

```
1. User drops video
        ↓
2. Main process: copy to project folder, create project.db
        ↓
3. FFmpeg: generate proxy (low-res for fast playback) + extract audio (WAV 16kHz)
        ↓
4. Whisper: transcribe audio → word-level timestamps → write to DB (words table)
        ↓
5. transcript package: detect filler words + silences → write to DB (segments table)
        ↓
6. AI (cloud): analyze timestamped transcript → clip suggestions + blog post + captions
        ↓
7. Write AI outputs to DB (clips table, ai_outputs table)
        ↓
8. Notify renderer via IPC: "pipeline:complete"
        ↓
9. Renderer: display clip cards, transcript, AI outputs
        ↓
10. User: approve/reject clips, edit blog post, copy captions
        ↓
11. Export: FFmpeg cuts approved clips → burns captions → writes to exports/
```

## Project storage

```
~/Library/Application Support/VideoAIEditor/projects/
  {project-id}/
    project.db          ← SQLite (metadata, words, clips, segments, ai_outputs)
    original.mp4        ← original file (never modified)
    proxy.mp4           ← low-res for fast playback
    audio.wav           ← extracted audio for Whisper
    exports/
      clip_01_abc12345.mp4
      blog_post.md
```

Media is always referenced by path, never embedded in SQLite.

## IPC channel contract

All channels typed in `packages/types/src/index.ts` → `IpcChannels`.
Preload exposes `window.api.invoke(channel, args)` and `window.api.on(channel, callback)`.
Never use `ipcRenderer.send` / `ipcRenderer.sendSync` directly.

## Package dependency rules

```
ui        → (no internal deps)
types     → (no internal deps)
utils     → (no internal deps)
database  → types, utils
whisper   → types
ffmpeg    → types
transcript → types, utils, whisper (types only)
ai        → types
export    → types, utils, ffmpeg
player    → types
desktop   → all packages
```

No circular deps. `types` and `utils` are pure leaf packages.

## FFmpeg binary

Bundled at `resources/ffmpeg/ffmpeg` (mac/linux) or `resources/ffmpeg/ffmpeg.exe` (win).
In dev: resolved relative to workspace root.
In prod: resolved from `process.resourcesPath`.
Download prebuilt binaries from ffmpeg.org static builds for each platform.

## Whisper binary + models

Binary: `resources/whisper/whisper-cli` (bundled, same pattern as FFmpeg).
Models: downloaded to `app.getPath("userData")/models/whisper/ggml-{size}.bin` on first use.
Default model: `base` (~145MB). User can switch to `small` for better accuracy.

## AI abstraction

`@video-editor/ai` exposes `createAiClient(provider, apiKey)` → `AiClient`.
All AI calls go through `AiClient.complete(prompt, systemPrompt)`.
Swap provider by changing the `provider` arg — no other code changes needed.
API key stored in system keychain (implementation: later).

## Coding standards (enforced)

- Strict TypeScript — no `any`, no `as unknown as X` without comment
- No barrel re-exports from `apps/desktop` — import from packages directly
- React components: render + interaction only. Business logic in services/packages.
- No direct DB calls from renderer — IPC only
- Path aliases: `@/` maps to `src/renderer/src/` in renderer
- Pre-commit hook runs `lint-staged` (ESLint + Prettier)
