# Clipper

Open-source alternative to OpusClip, Descript & Submagic. Turn long recordings into viral shorts for TikTok, Reels & YouTube Shorts — transcribes locally, bring your own API key, no subscription, no watermark.

**Mac only for now.** Windows support planned.

## What it does

- Transcribes locally via Whisper. Your video never leaves your machine; only the transcript text is sent to Groq, with your own API key, to pick clips
- AI works out what kind of video it is (podcast, tutorial, comedy…), proposes clips, then judges each one on its exact text and ranks the best across the whole video
- Review, trim, and approve clips in a visual editor
- Export clips as 9:16 vertical video with burned-in subtitles
- Export full episode with filler words and silences removed

## Install

**macOS, Apple Silicon (M1 or later).** Windows support planned.

1. Download the latest `.dmg` from [Releases](https://github.com/PriyeshPandey2000/ai-video-clipper/releases/latest)
2. Open it, drag Clipper to Applications
3. Launch Clipper, add your [Groq API key](https://console.groq.com) (free) in Settings

The app is signed and notarized — no Gatekeeper warnings.

### Build from source

For development or contributing. Requires [Homebrew](https://brew.sh).

```bash
git clone https://github.com/PriyeshPandey2000/ai-video-clipper.git
cd ai-video-clipper
bash scripts/setup.sh
```

The script installs Node.js, pnpm, dependencies, and the bundled FFmpeg/Whisper. It also creates a `.env` template.

Add your Groq key to `.env`:

```
GROQ_API_KEY=your_key_here
```

```bash
pnpm dev
```

## How it works

Think of Clipper as an **assembly line**, not a video editor. A long recording goes in one end, ready-to-post shorts come out the other. You just review the parts the AI picks.

```mermaid
flowchart LR
    classDef step fill:#0f4c4c,stroke:#4fd1c5,color:#ecfeff,stroke-width:2px
    classDef human fill:#5a3d0f,stroke:#e0a72e,color:#fff7ed,stroke-width:2px

    A["1 · Drop a video"]:::step --> B["2 · Transcribe it<br/>(Whisper, local)"]:::step
    B --> C["3 · AI finds the<br/>best moments"]:::step
    C --> D["4 · Review & approve"]:::human
    D --> E["5 · Export 9:16 shorts"]:::step
```

1. Drop a video file into the app
2. Pick a Whisper model and click Transcribe
3. AI works out what kind of video it is, proposes clips, and judges each one on its exact text — review and approve
4. Toggle 9:16 reframe if needed, drag to set crop position
5. Click Export Clips or Export Episode

## Architecture

<p align="center">
  <img src="docs/architecture.svg" alt="Clipper architecture: renderer, Electron main, pipeline packages, local storage, clip selection and external services" width="100%">
</p>

The diagram shows the architecture once the clip-selection roadmap (#100–#105 and #108) has landed. [`docs/ROADMAP.md`](docs/ROADMAP.md) lists what is built today.

Each package does one job and keeps no shared state, and no package but `database` ever touches SQLite. One conductor, [`apps/desktop/src/main/ipc.ts`](apps/desktop/src/main/ipc.ts), calls them in order and persists the result after each step. The UI lives in [`apps/desktop/src/renderer`](apps/desktop/src/renderer) and only ever talks to the conductor over typed IPC.

- Want to improve clip picking? Start at `packages/ai` (`clip-selector.ts` runs the pipeline, `clip-judge.ts` judges each clip, `profiles.ts` holds the genre rubrics)
- Fix a transcription quirk? Start at `packages/whisper` or `packages/transcript`
- Change the export pipeline? Start at `packages/ffmpeg`, `packages/captions`, or `packages/export`

The deep dive — IPC contracts, database schema, dependency rules — is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tech stack

Electron · React 19 · TypeScript · Tailwind v4 · SQLite (Drizzle ORM) · whisper.cpp · FFmpeg · Groq (gpt-oss-120b)

## Contributing

Issues and PRs welcome. Check [open issues](https://github.com/PriyeshPandey2000/ai-video-clipper/issues) for what's being worked on.

```bash
bash scripts/setup.sh  # first-time setup
pnpm dev               # start app
pnpm turbo typecheck   # type check all packages
pnpm turbo lint        # lint all packages
pnpm test              # run the unit tests
```

## License

MIT
