# Architecture Decision Records

## ADR-001: Pipeline-first, not a full editor

**Decision:** Build an AI content pipeline with a thin review UI, not a traditional video editor.

**Why:** Full editors (Descript, Opus Clip, CapCut) already exist and would take 18+ months to compete with. Our moat is AI output quality + local processing + speed + one-click publish — not editing features. Users want content published, not to edit.

**Consequence:** No timeline tracks, layers, effects panel, or keyframe animation in v1. Review UI = approve/reject clips, trim endpoints, view AI outputs.

---

## ADR-002: SQLite for project storage

**Decision:** Each project stored as a SQLite file (`project.db`) with media referenced by path.

**Why:** Transcript of a 2hr podcast = tens of thousands of word-level records. JSON would be slow to parse and can't be queried. SQLite gives atomic writes, fast queries, single-file backup. Media stays as files on disk — never embedded.

**Rejected:** Folder + `project.json` — too slow for transcript data, no atomic writes.

---

## ADR-003: FFmpeg bundled inside app

**Decision:** Ship FFmpeg binary inside the Electron app (`resources/ffmpeg/`).

**Why:** Reliability. Don't depend on user's FFmpeg install (version mismatch, missing codecs, not installed at all). Bigger download but zero setup friction.

---

## ADR-004: Whisper downloaded on first run

**Decision:** Ship whisper-cli binary bundled, models downloaded on first use.

**Why:** Models are 75MB–1.5GB. Bundling even `tiny` would make the app download huge. Better UX = small app download, then prompt user to download model once with progress bar.

---

## ADR-005: Cloud AI (OpenAI/Anthropic) with user's API key

**Decision:** User provides their own API key for clip selection, blog post, captions.

**Why:** Cloud models (GPT-4o, Claude) produce significantly higher quality output than local models for content tasks. User controls cost. No backend infrastructure needed for v1.

**Future:** May add optional proxy backend later for freemium tier where we absorb API costs.

---

## ADR-006: Feature-gated freemium

**Decision:** Free tier = transcription + filler/silence removal. Paid = AI clip suggestions, blog post, social captions, chapter markers.

**Why:** Clear value ladder. Free tier is genuinely useful (transcription alone is valuable). Paid tier unlocks the AI magic — obvious reason to upgrade.

**Implementation:** License check deferred to later milestone.

---

## ADR-007: Mac first, cross-platform architecture

**Decision:** Build cross-platform from day one in code, but ship Mac first.

**Why:** Mac = faster iteration, better M-series AI performance, simpler code signing. But don't write Mac-only code — keep FFmpeg/Whisper paths platform-aware from day one so Windows/Linux ports are low-friction.

---

## ADR-008: Main process owns all I/O

**Decision:** Renderer (React) has zero direct access to filesystem, DB, or AI APIs. All data via typed IPC.

**Why:** Security. Electron's `contextIsolation: true` + `sandbox: false` gives main process full Node access while keeping renderer isolated. Also testable — main process logic can be unit tested without a browser context.
