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
- [x] Mac DMG build (`electron-builder`, dmg + zip targets)
- [x] Code signing + notarization — hardened runtime, `xcrun notarytool`, stapled dmg/zip
- [x] Tag-triggered release pipeline (`.github/workflows/release.yml`) — build, sign, notarize, draft GitHub Release with assets
- [x] Auto-update via `electron-updater` — check on launch, top-right toast, never restarts while a transcription/export is active
- [ ] Onboarding flow (first-run walkthrough: drop video → pick model → transcribe)

## Phase 7 — Creator features ✅ Done

- [x] Clip trim UI — drag handles adjust AI-suggested clip start/end, saves to DB, reflects in export
- [x] Animated styled captions — bold word-highlight captions burned into clips (CapCut style)
- [x] 9:16 vertical reframe — drag-on-video crop overlay, per-clip position saved to DB, 1080×1920 FFmpeg output
- [x] Customizable filler word list — add/remove words per project from UI
- [x] Whisper model manager — Settings page with per-model download (live progress), delete, disk usage
- [x] Hard concat at episode splice points (issue #10) — crossfade (`3a1b777`) caused AV drift over long episodes and was reverted (`2216dcc`); cuts land at near-silent boundaries so hard concat is imperceptible
- [x] Episode SRT timestamp remapping (issue #7)

## Phase 8 — Distribution + reach ❌ Not started

- [ ] Windows support
- [ ] Direct publish to TikTok / Instagram Reels / YouTube Shorts
- [ ] Natural language clip search ("find where I mention pricing")

## Phase 9 — Smarter clip selection 🔄 Mostly done (see `docs/CLIP-DETECTION-RESEARCH.md` for the real wave-by-wave record; this section was stale — most of it already shipped)

- [x] Semantic block preprocessing — `buildSentences` groups word-level timestamps into sentences at punctuation/pause boundaries before the LLM call (sentence-level, not a separate metadata-tagged "block" concept, but same purpose)
- [x] Block-ID-based LLM output — LLM returns `startSentence`/`endSentence` sentence indices, never raw milliseconds; every ms in the final output is resolved from our own word table, making a hallucinated timestamp structurally impossible
- [x] Code-level timestamp validation — `refineClipBoundaries` snaps to word edges, clamps to `[MIN_CLIP_MS, MAX_CLIP_MS]` (15–90s)
- [x] FFmpeg audio energy scoring — `measureArousal` extracts per-second RMS, surfaced as `{loud}`/`{fast}`/`{slow}`/`{burst}` signal tags in the prompt (arousal-based rather than a literal `Energy: High/Low` field, same purpose)
- [~] Content type detection — `detectContentType` classifies interview/tutorial/solo/generic and swaps the rubric per type; narrower taxonomy than podcast/interview/tutorial/vlog, and no sparse/dense density signal
- [x] Explicit virality criteria in prompt — the exact ranked signal list (hook, emotional peak, opinion bomb, revelation, conflict, quotable line, story peak, practical value) is in the system prompt
- [ ] Hook sentence per clip — not shipped; `hookText` in the export path is just the clip's title reused, not a separate LLM-returned opening line
- [~] Duration guidance in prompt — hard 15–90s clamp is enforced, but the tiered "45–90s sweet spot, shorter only for standalone one-liners" guidance isn't in the prompt
- [x] Retry on bad LLM JSON — implemented (issue #73)
- [x] Dedupe overlapping clips — drops any candidate overlapping >50% with a higher-ranked one
- [x] Long video chunking — >30min transcripts split into 20-min chunks with overlap (150s, not the originally planned 60s), scored per chunk and deduped across chunks; topic-coherent chunking (the primary path) and the fixed-time fallback both carry the overlap correctly as of the chunk-cross-boundary fix

## Phase 10 — Measurement & evals 🔄 In progress

Everything in Phase 9 shipped on judgement, not measurement. We cannot currently say whether Borda reranking, the content-type rubric, hook-first trimming or the signal tags made clips better or worse, so prompt and scoring changes are coin flips. This phase is the prerequisite for the next round of clip-selection work — not a follow-up to it.

- [ ] **#89** Preserve the AI's original cut — add `original_start_ms`, `original_end_ms`, `ai_rank` and `pipeline_version` to `clips`. `setClipTimes` overwrites the AI's boundaries today, so every manual trim destroys the only record of what the model chose; without it, real usage can never become labelled data
- [ ] **#46** Mechanical eval harness (planned in `docs/CLIP-DETECTION-RESEARCH.md` Part 4 since Wave 1 and never built; blocked by #90, #91) — `scripts/eval.ts` replays the real `selectClips` over 3–5 cached transcripts read straight from the local DB (no Whisper re-run) and reports cold-open rate, truncated-ending rate, length compliance, gate-rejection breakdown, and cost/wall-clock per hour of video. Writes `evals/<commit>.json` so each change diffs against the last
- [ ] **#90** Stability floor before any A/B — the pipeline is nondeterministic (no temperature set, `Math.random` in the dedupe/shuffle path). Measure top-5 overlap across 3 identical runs of the same video first; if run-to-run overlap is low, a single before/after comparison proves nothing and needs to become a mean of N
- [~] `pnpm prompt-bench` — A/B two or more system prompts over one cached transcript through a `systemPromptOverride` hook on `selectClips`, printing a side-by-side markdown report. Qualitative triage for picking what to measure, deliberately not a scoring harness
- [ ] **#91** Fix `scripts/recall-ablation.ts` prompt drift — it claims to mirror the pipeline prompt but copy-pastes an older one with no signal tags and no content-type suffix, so its numbers describe a pipeline that no longer exists. Import the prompt rather than duplicating it
- [ ] **#92** Tighten `HOOK_RE` and the filler set — `hook` currently matches most/first/last/only/ever/always, any 2+ digit number and any question, which is most podcast sentences, and `filler:high` includes "so", "right", "actually", "like" and "yeah". A tag on nearly everything is noise the model learns to ignore, and it also drives `hookFirstAdjust` and the weak-opening warning. Measure the tag rate, then tighten against the eval
- [ ] **#93** Density-check `detectContentType` — one "how to" anywhere in a 60-minute podcast currently classifies the whole video as a tutorial and swaps the rubric for every chunk
- [ ] **#94** Ablate before extending — disable Borda rerank, the content-type rubric, hook-first trim and the signal tags one at a time and delete whatever doesn't move the numbers. Reranking in particular only sees the LLM's own title and reason, never the transcript, and costs an extra call per chunk
- [ ] Taste tier, later and weak (needs #89) — precision@5, boundary error and rank quality from real usage once the columns above have been collecting across 15+ videos. This is a preference oracle of n=1; track it, don't tune against it

Feature freeze until the mechanical numbers exist: no SenseVoice, diarization or reframe work until the eval says where quality is actually being lost.

## Polish backlog ✅ Done

- [x] 9:16 reframe for episode export — global cropX slider, pre-fills from first clip's saved cropX
- [x] Crop position indicator on clip cards — L/C/R badge derived from cropX
- [x] "Saved" flash feedback after drag-commit on crop overlay
- [x] Blur background fill — blurred source as background for 9:16 export (foreground fit-centered, bg visible above/below)
- [x] Source aspect ratio detection — blocks portrait, warns near-square
- [x] Trim changes reset clip status from "exported" → "approved"

## Out of scope (premature for early stage)

- Face tracking / computer vision scoring — requires Python/ML infra, different stack entirely
- Hook pattern matching engine — semantic block prompt already handles 80% of this
- Dynamic hot-zone windowing — matters only for 2h+ recordings, overengineered for MVP
- Audio pitch / laughter detection — nice signal but high complexity vs. marginal gain
