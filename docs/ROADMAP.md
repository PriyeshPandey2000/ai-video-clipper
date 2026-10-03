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

## Phase 9 — Smarter clip selection ✅ Done (the original list; superseded in places by Phase 10)

The wave-by-wave record is in `docs/CLIP-DETECTION-RESEARCH.md`. What shipped, and what has since changed:

- [x] Semantic block preprocessing — `buildSentences` groups word timestamps into sentences at punctuation/pause boundaries before the LLM call
- [x] Block-ID-based LLM output — the model returns `startSentence`/`endSentence` indices, never milliseconds; a hallucinated timestamp is structurally impossible
- [x] Code-level timestamp validation — `refineClipBoundaries` snaps to word edges and clamps to 15–90s
- [x] Audio energy scoring — `measureArousal` per-second RMS, surfaced as `{loud}`/`{fast}`/`{slow}`/`{burst}` prompt tags
- [x] Content type detection — **replaced** by the LLM genre profile (#98, Phase 10); the regex detector is gone
- [x] Explicit virality criteria in the prompt — the ranked signal list is in the system prompt
- [~] Hook sentence per clip — the judge now returns `bestOpeningSentence` and it is stored, but nothing uses it yet (#100)
- [~] Duration guidance — the 15–90s clamp is enforced; per-genre ranges wait on #102
- [x] Retry on bad LLM JSON (#73)
- [x] Dedupe overlapping clips — now after scoring, keeping the higher-scored clip
- [x] Long video chunking — >30 min split into ~20 min chunks with 150s overlap, topic-coherent first, fixed-time fallback

## Phase 10 — Clip selection quality 🔄 In progress

Goal: the best clips across the whole video, judged on what is actually exported. Issues in order:

- [x] **#89** Provenance — original AI cut, rank, pipeline version/hash, model and profile stored per clip
- [x] **#97** Re-run clip selection from the stored transcript, plus a per-run selection report (#106)
- [x] **#98** Genre profile — LLM analysis (profile, confidence, summary, speakers, topics), six profiles with rubrics and judge questions, override column, `project:get/set-clip-profile` (#109), and the genre control in `ClipReview`: detected profile and confidence, override dropdown that re-runs selection, `visual` warning
- [x] **#99** Judge every final cut, rank globally (#110) — recall-first generation, one judge call per refined clip, graded answers, hard `standalone`/`payoff` gate, global ranking, real scores, `judge_json` + chips in `ClipReview`. Removed: `strong`, Borda re-rank, random shuffle, hook-first trim, round-robin interleaving
- [ ] **#100** Judge-chosen opening sentence (replaces the regex hook-trim; `bestOpeningSentence` is already stored)
- [ ] **#101** The 5-video manual test: profile accuracy, your 15 reference moments, model comparison, chunking decision. Run this before building more knobs
- [ ] **#102** Clip settings: length range, clip count, profile override UI, free-text topic steer
- [ ] **#103** Topic diversity cap (only if #101 shows clustering)
- [ ] **#104** One-tap reject reasons + feedback per pipeline version
- [ ] **#105** Speaker labels (diarization) for conversation videos
- [ ] **#108** Pick the genre before the first run (Auto stays default)
- [ ] **#107** Review follow-ups, including re-suggesting rejected moments (do before #104)

## Phase 11 — Measurement & evals ❌ Not started

Phase 9 and 10 shipped on judgement, not measurement. #101 is the lightweight version; this phase is
the formal one.

- [ ] **#46** Mechanical eval harness over 3–5 cached transcripts: cold-open rate, truncated-ending rate, length compliance, gate rejections, judge-call count, cost/time per hour. Taste tier (precision@5) later and weak
- [ ] **#90** Noise floor — the shuffle is gone and temperature is pinned (done in #97/#99); what remains is measuring top-5 overlap across 3 identical runs, and deciding single-run vs mean-of-N
- [ ] **#91** `scripts/recall-ablation.ts` still carries an old copy of the prompt (it still asks for `strong`); import the real one
- [ ] **#92** Tighten `HOOK_RE` and the filler set — `hook` still drives a prompt tag and the "weak opening" warning (it no longer moves boundaries)
- [ ] **#94** Ablate what is left — signal tags and per-profile rubrics; Borda and the hook-first trim are already deleted. New candidate: the judge's questions and weights (starting values, never tuned)

Feature freeze until #101's numbers exist: no SenseVoice or reframe work until we know where quality is being lost.

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
