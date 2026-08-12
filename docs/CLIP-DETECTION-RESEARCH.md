# Clip Detection — Technique Research & Decision Doc

> Rev 5 — post-review, post-first-real-run. Every technique below has been argued over twice and
> several were corrected by an actual video. Rejected items are kept **with the reason**, so we
> don't re-litigate them in three weeks.
>
> **Part 6** = review log (what changed between revisions and who was right).
> **Part 7** = devlog (what shipped, why, and what to check first when something breaks).

---

## Part 0 — Pre-Wave 1 baseline

> Snapshot of the code **before** Wave 1 shipped, kept as the starting point the plan reacts to.
> For what the code does now, see the devlog in Part 7.

| Step       | File                                  | Reality                                                                                          |
| ---------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Transcribe | `packages/whisper/src/index.ts:161`   | whisper.cpp, `-ojf -sow -t 4`. Word times from **token offsets**, no DTW, no VAD                 |
| Serialize  | `packages/transcript/src/index.ts:78` | `wordsToTimestampedText` → `[10.50] Hello [10.80] everyone` for **every word**                   |
| Select     | `packages/ai/src/clip-selector.ts:41` | One Groq call, `llama-3.3-70b-versatile`, json_object mode. LLM emits `startMs`/`endMs` directly |
| Clamp      | `packages/ai/src/clip-selector.ts:62` | Only clamps to `[0, videoDurationMs]`. No snapping to words                                      |
| Store      | `apps/desktop/src/main/ipc.ts:314`    | Straight to `clips` table                                                                        |

### Bugs found while reading

**1. Clip length math broken for anything long** — `clip-selector.ts:46-48`

```ts
const targetMin = Math.max(10, Math.round(durationSec * 0.2)) // 60-min video → 720s
const targetMax = Math.max(targetMin, Math.round(durationSec * 0.6)) // → 2160s
```

60-min podcast → prompt asks for clips **12 to 36 minutes long**. Short-form target is 15–90s.
Likely the single largest cause of bad output. One-line fix.

**2. Token budget explodes** — 60-min podcast ≈ 9,000 words → ~36k tokens of mostly-noise input.

**3. No boundary snapping** — LLM ms used raw. The `words` table sits unused. This is issue #28.

**4. Clip count hardcoded to 5** — `maxClips = 5`. See B13; this is a quality bug, not a config nit.

---

## Part 1 — Premises corrected before building

### SenseVoice is a signal source, not a Whisper replacement

Real: 400k hours training, ~15x faster than Whisper-Large, emotion (SOTA-or-better on 7 datasets),
audio events (laughter/applause/BGM/crying), Apache-2.0, local. CTC timestamps added Nov 2024.

Caveat: timestamps are **CTC alignment on a non-autoregressive model**, and the documented accuracy
edge is mainly **Chinese/Cantonese** (7.81% CER vs Whisper-large-v3's 20.02%). For English word-level
cut points, forced alignment is stronger. Emotion labels are **per-utterance and coarse** — a feature
in a scoring function, not ground truth.

**Verdict:** parallel **tag track** (emotion + events, time-aligned). Whisper stays transcript-of-record.

### "Virality score" is not a real model output

OpusClip markets 0–100 as trained on millions of viral videos, but the published factors are
**Hook / Flow / Trend** — a rubric an LLM can apply, not a learned regressor. No public evidence of a
trained virality model. Our differentiator must be **cut precision + presentation + honesty about
clip count**, all measurable. Not score mysticism.

---

## Part 2 — Technique catalogue

Tiers: **T1** proven/deterministic/ship now · **T2** strong, real work · **T3** experimental.
**REJECTED** entries stay in the doc with the reason.

### Stage A — Transcript & alignment quality

| #   | Technique                                 | Verdict                                   | Notes                                                                                     |
| --- | ----------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| A1  | Forced alignment (WhisperX / MFA)         | **T2 — later, optional "precision mode"** | Best word times (~20–50ms), but Python/torch dep inside Electron. Not v1                  |
| A2  | **whisper.cpp `--dtw <preset>`**          | **T1 — Wave 1**                           | Cross-attention DTW token timestamps. See implementation trap below                       |
| A3  | **whisper.cpp `--vad -vm <silero ggml>`** | **T1 — Wave 1**                           | Kills Whisper's silence-hallucination class. See correction below                         |
| A4  | **Punctuation → sentence units**          | **T1 — Wave 1**                           | Whisper already returns punctuation in segment text; we discard it and keep only words    |
| A5  | Speaker diarization (pyannote)            | **T2 — Wave 3**                           | Needed for interview clip shapes ("guest says wild thing, host reacts"). Heavy Python dep |
| A6  | SenseVoice tag track                      | **T2 — Wave 2**                           | ONNX, local, no Python. Emotion + laughter + BGM-flag ("don't clip here, music bed")      |
| A7  | Default model `medium`, not `base`        | **T1 — Wave 1**                           | Shipped as `medium`: on a real video `base` produced `226` for `2026` and `EA` for `AI`   |

**A2 implementation trap (verified in `examples/cli/cli.cpp`):** `--dtw` **requires** a preset
argument — `--dtw` alone hits `requires_value_error()`. Valid presets: `tiny`, `tiny.en`, `base`,
`base.en`, `small`, `small.en`, `medium`, `medium.en`, `large.v1`, `large.v2`, `large.v3`,
`large.v3.turbo`. Unknown preset → `error: unknown DTW preset` and **exit code 3**, which
`packages/whisper/src/index.ts:186` rejects on.

Our `MODEL_FILES` maps `large` → `ggml-large-v3.bin`, so `--dtw large` **will fail**. Need an explicit map:

```ts
const DTW_PRESET: Record<WhisperModel, string> = {
  tiny: "tiny",
  base: "base",
  small: "small",
  medium: "medium",
  large: "large.v3",
}
```

**A3 correction:** `--vad` is **not** "zero extra model." It requires a separately downloaded Silero
ggml file passed via `-vm` (`ggml-silero-v6.2.0.bin`, produced by `convert-silero-vad-to-ggml.py`,
fetched by `download-vad-model.sh`). It _is_ Silero. The real argument for it: swaps a **Python/torch
dependency for a ggml file our already-bundled binary loads**, reusing the exact
download-on-first-use path we have for Whisper models (`downloadModel` in `packages/whisper`).
Cheaper than originally written — hence Wave 1, not Wave 2.

### Stage B — Candidate generation (local, before any API call)

| #   | Technique                                                                                                                    | Verdict                        | Notes                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **Sentence-level serialization** `[10500-14200] Hello everyone, welcome`                                                     | **T1 — Wave 1**                | **2.3x** fewer tokens measured on a real 10-min transcript (34,805 → 14,934 chars) — not the 3–5x originally claimed. Still the best value:effort in the doc, and the LLM reasons over meaning instead of word soup |
| B2  | **TextTiling algorithm + SBERT similarity**                                                                                  | **T2 — Wave 2**                | See correction below                                                                                                                                                                                                |
| B3  | Multi-scale windows (15/30/45/60/90s) anchored on sentence + topic starts                                                    | **T1 — Wave 2**                | Proper candidate set instead of the LLM inventing windows                                                                                                                                                           |
| B4  | Audio arousal — RMS + LUFS + F0 variance + spectral centroid, per 1s                                                         | **T1 — Wave 2**                | ffmpeg `astats`/`ebur128`. Prosody carries emotion independent of words                                                                                                                                             |
| B5  | Laughter / applause                                                                                                          | **T2 — Wave 2**                | Comes free via A6. Strongest non-verbal marker in podcasts                                                                                                                                                          |
| B6  | **Pause→burst shape** (setup→punchline)                                                                                      | **T1 — Wave 2**                | Usage corrected below — it's a _climax anchor_, not a start point                                                                                                                                                   |
| B7  | Speech-rate delta vs rolling baseline                                                                                        | **T1 — Wave 2**                | Trivial from word timestamps. Speed-up = excitement, slow-down = emphasis                                                                                                                                           |
| B8  | Lexical hook markers — questions, numbers, superlatives, 2nd person, contrarian ("nobody tells you"), reveals ("here's why") | **T1 — Wave 2**                | Cheap, high precision                                                                                                                                                                                               |
| B9  | **Dangling-reference detection**                                                                                             | **T1 — Wave 1**                | Mechanism corrected below — it's a **repair**, not a filter                                                                                                                                                         |
| B10 | Filler-word density penalty                                                                                                  | **T1 — Wave 2**                | `detectFillerWords` already exists, free                                                                                                                                                                            |
| B11 | Scene / shot detection (PySceneDetect)                                                                                       | **REJECTED v1**                | Talking-head is single-shot. Revisit only for edited content                                                                                                                                                        |
| B12 | Pre-filter to top ~25% by composite score                                                                                    | **T1 — Wave 2**                | 3–5x cost/latency cut, _and_ LLM accuracy rises with signal density                                                                                                                                                 |
| B13 | **Variable clip count + absolute quality threshold**                                                                         | **T1 — Wave 1, high priority** | See below — bigger lever than most of this table                                                                                                                                                                    |
| B14 | ~~TF-IDF sentence importance~~                                                                                               | **REJECTED**                   | See below                                                                                                                                                                                                           |
| B15 | ~~Distance-to-topic-centroid as controversy proxy~~                                                                          | **REJECTED**                   | See below                                                                                                                                                                                                           |
| B16 | Position-in-topic-segment prior                                                                                              | **MOVED to D2**                | Right signal, wrong stage                                                                                                                                                                                           |

**B2 correction — it is not TextTiling _vs_ SBERT.** Solbiati et al. 2021 keep TextTiling's machinery
(block similarity, depth score, valley detection, smoothing) and swap **only the similarity function**
from lexical to BERT/SBERT. Raw "cosine between adjacent sentences → find valleys" without
depth-scoring and smoothing is _noisier_ than TextTiling — sentence-level cosine on spoken transcript
is jumpy.

**Spec: TextTiling algorithm, SBERT similarity function.**

_Caveat on the headline number:_ the paper's **15.5% error reduction** is measured on AMI and ICSI —
structured multi-speaker meetings with clear agenda shifts. Podcasts are rambling, single-dominant-
speaker, topic-bleed heavy. **The algorithm transfers; the 15.5% does not.** Do not quote it as an
expected gain here. Measure on our own golden set.

**B6 correction — the original usage was inverted.** Shape is real: pause >300ms → high-energy burst
within 1s. But that marks the **climax**, not the in-point. Starting 150ms into the pre-punchline
silence delivers the payoff to a joke the viewer never heard set up. Correct use: **detect the burst,
extend the window backwards to capture the setup, target the punchline landing at ~60–75% through
the clip.** Anchor for the clip interior, never the start.

**B9 correction — repair, not filter.** Hard-blacklisting starts like `"as I was saying"` discards good
content because of where a sliding window happened to land. D2 already expands backwards to sentence
start; a dangling reference should mean **"keep extending back until the referent resolves"**.
Also `"that's why"` / `"which is why"` are legitimate hook openers ("That's why I stopped taking
meetings before noon") — blacklisting them costs real clips. Implement as an escalating backward
expansion with a cap, then penalise only if unresolved at the cap.

**B13 — variable clip count.** `maxClips = 5` hardcoded. A dense interview has 12 good moments; a
rambling vlog has 1. Forcing 5 **pads with garbage**, and the 3 bad clips poison trust in the 2 good
ones. Fix: absolute quality threshold, not fixed top-N. The pipeline must be allowed to return 2
clips — or zero, with _"no strong moments found in this video."_ No paid tool will ever say that,
which is exactly why saying it makes us more trustworthy than all of them.

**B14 REJECTED — TF-IDF as an interestingness signal.** Wrong direction. High-TF-IDF sentences in a
podcast transcript are proper nouns, jargon, and ASR errors. Viral hooks are the opposite: **common
words in an unusual arrangement** ("nobody tells you this", "I was completely wrong about"). TF-IDF is
inherited from extractive summarization (TextRank/LexRank) — a summary picks what's _representative_;
a clip needs what's _provocative_. Different objective.

**B15 REJECTED — centroid distance as controversy proxy.** Distance from the topic centroid measures
**digression**, not controversy. Controversial claims are usually _central_ to the topic. What is
actually far from the centroid: tangents, asides, sponsor reads, ASR garbage, someone answering a
different question. Controversy is not a geometric property. High junk risk.

### Stage C — LLM ranking

| #   | Technique                                                                                                                      | Verdict                         | Notes                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **LLM emits candidate IDs, never milliseconds**                                                                                | **T1 — Wave 1, non-negotiable** | _The_ fix for #28. LLM picks `#47`, we look up exact ms. Hallucinated timestamps become structurally impossible                                                                                                                                     |
| C2  | **Listwise ranking + shuffled passes + Borda merge**                                                                           | **T2 — Wave 2**                 | See spec below                                                                                                                                                                                                                                      |
| C3  | Explicit virality rubric — hook, emotional peak, opinion bomb, revelation, conflict, quotable, arc completion, practical value | **T1 — Wave 1**                 | Current prompt says only "most engaging segments"                                                                                                                                                                                                   |
| C4  | Content-type detection → rubric swap (podcast/interview/solo/tutorial/vlog)                                                    | **T2 — Wave 3**                 | Tutorial's best clip = complete step; podcast's = hot take                                                                                                                                                                                          |
| C5  | **Topic-coherent chunking** (not fixed 20-min)                                                                                 | **T1 — Wave 2**                 | See correction below                                                                                                                                                                                                                                |
| C6  | ~~Two-model cascade (8B shortlist → 70B finalize)~~                                                                            | **REJECTED at this scale**      | See below                                                                                                                                                                                                                                           |
| C7  | Dedupe — temporal IoU merge (>50% → keep higher) then MMR for semantic diversity                                               | **T1 — Wave 2**                 | Stops 3 near-identical clips of one story                                                                                                                                                                                                           |
| C8  | Relative ranking only, never absolute "87/100"                                                                                 | **T1 — Wave 1**                 | LLM absolute scores are noise; ordering is the signal. Derive a display number if the UI needs one                                                                                                                                                  |
| C9  | Trained virality regressor                                                                                                     | **REJECTED**                    | No labeled clips+engagement dataset. Revisit only if we collect user outcome data                                                                                                                                                                   |
| C10 | Multimodal moment retrieval (Moment-DETR / UniVTG / VideoLights)                                                               | **REJECTED v1**                 | SOTA on QVHighlights, but that benchmark is _query-driven_ ("find the moment where X"), not "find what's inherently clippable." Frame sampling a 60-min video is slow and expensive locally. Audio+text carries most of the signal for talking-head |

**C2 spec.** Listwise beats pointwise (pointwise LLM scores are uncalibrated and drift across prompts),
but listwise is **order-sensitive** — shuffle candidate order across 2 passes and merge. Merge with
**Borda count** (sum of rank positions), _not_ score averaging — averaging reintroduces exactly the
absolute-score noise listwise was chosen to escape. **Tail-rank handling:** if a pass returns only
top-K rather than a full permutation, unranked candidates must all get rank K+1, otherwise Borda
silently rewards being _mentioned_ over being _good_.

**C5 correction — depends on B2.** Fixed 20-min chunks slice topic boundaries in half and the LLM
sees half a story. Correct order: **segment topics first (B2), then group topics into
context-sized chunks.** Fallback for the case a single topic exceeds context (a 25-min uninterrupted
rant is common): split at the **deepest internal depth-score valley**, never at a fixed offset.
Until B2 lands (Wave 2), Wave 1 keeps fixed chunks with 60s overlap as a stopgap.

**C6 REJECTED at this scale.** If B12 already cut to ~40 candidates, inserting an 8B model between a
tuned composite local score and the 70B is likely **net information loss** — the 8B's semantic ranking
is probably worse than the heuristic it would override, plus an extra failure surface. Cascades earn
their cost at _hundreds_ of candidates. Revisit only if candidate count justifies it.

### Stage D — Boundary refinement

| #   | Technique                                                                                                        | Verdict         | Notes                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------- |
| D1  | Snap start to word start, end to word end                                                                        | **T1 — Wave 1** | Never cut mid-word                                                              |
| D2  | **Expand start backwards to sentence start, escalating until referent resolves**                                 | **T1 — Wave 1** | Absorbs B9 and B16. Cap the expansion; penalise only if still unresolved at cap |
| D3  | **Cut inside the silence** — pause midpoint, ~120–250ms lead-in, ~200–400ms tail                                 | **T1 — Wave 1** | Cuts landing exactly on the waveform are the "cheap tool" sound                 |
| D4  | End on a complete thought — require sentence-final punctuation and/or >400ms pause; extend up to +5s to find one | **T1 — Wave 1** | Kills mid-sentence endings                                                      |
| D5  | Hook-first check — verify hook in first ~3s, else shift start or flag                                            | **T2 — Wave 2** | 65% who watch 3s watch 10s; strong-hook videos ~2.4x more likely to be pushed   |
| D6  | Platform length clamp — 15–60s Reels/TikTok, ≤90s Shorts                                                         | **T1 — Wave 1** | Fixes the 12-minute-clip bug                                                    |
| D7  | Internal jump cuts — strip filler + long silences inside the clip                                                | **T1 — Wave 2** | Reuse the existing `exportEpisode` trim+concat path                             |

### Stage E — Presentation

| #   | Technique                                                                | Verdict                   | Notes                                                                          |
| --- | ------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------ |
| E1  | Active speaker detection reframe (LR-ASD, IJCV 2025 / TalkNet ~90.8 mAP) | **T2 — Wave 3**           | Static center-crop on a 2-person podcast is the #1 visual tell of a cheap tool |
| E2  | Smoothed crop path — Kalman/EMA + hysteresis                             | **T1 — required with E1** | Unsmoothed tracking looks worse than no tracking                               |
| E3  | Blurred-background fallback                                              | **HAVE IT**               | Recent commits                                                                 |
| E4  | Word-level animated captions                                             | **IN FLIGHT**             | `ANIMATED-CAPTIONS-PLAN.md`; word timings already exist                        |
| E5  | Auto hook text overlay (first 2–3s)                                      | **T2 — Wave 3**           | Standard on every paid tool                                                    |
| E6  | **Two-pass `loudnorm` to -14 LUFS**                                      | **T1 — Wave 1**           | Reasoning corrected below                                                      |

**E6 correction — right action, wrong reason.** There is **no evidence loudness affects the
recommendation algorithm.** YouTube and TikTok normalize loud content _down_ and leave quiet content
alone — they do not boost. The actual mechanism is **perceived production quality → retention**: a
quiet clip feels amateur and gets scrolled. Also use **two-pass** loudnorm (measure pass, then apply
pass); single-pass mangles dynamic range.

---

## Part 2.5 — Why each technique raises hit odds

Product framing. Read this before arguing wave priority.

**Nothing here predicts virality.** Neither does OpusClip — their score is a rubric, not a regressor
(Part 1). Virality = topic × audience × timing × platform push × luck. We control two things:
**recall** (if a hit-worthy moment exists, we find it) and **craft** (nothing about our execution is
the reason it failed). Everything below sorts into how it serves those two.

### Bucket 1 — Remove guaranteed-failure defects

Direct causal chains, not correlations. Highest confidence in the doc.

| Technique                                | Mechanism                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clip-length fix**                      | 12-minute "short" is unpostable. 100% failure → 0%                                                                                                        |
| **C1 IDs not ms**                        | Hallucinated timestamp → clip starts 8s into the thought → user doesn't post it. Same defect class as the length bug                                      |
| **D2 backward expansion**                | Opens mid-thought → confusion inside 1s → scroll. ~35% drop off in the first 3s; confusion spends that budget on nothing                                  |
| **D4 complete-thought ending**           | No payoff → low average view duration. **AVD is a real ranking input** on all three platforms                                                             |
| **D3 pause-aware cuts**                  | Cutting on the waveform sounds clipped and cheap → perceived quality → scroll                                                                             |
| **A2 `--dtw` / A3 `--vad` / A7 `small`** | Bad word times → desynced captions. Captions drive retention; desynced captions kill it                                                                   |
| **E6 loudnorm**                          | Quiet clip reads as amateur beside normalized clips in-feed                                                                                               |
| **B13 variable clip count**              | Padding to 5 means shipping 3 bad clips. Primary mechanism: destroys trust in the tool. Secondary (see caveat below): may drag the user's channel average |

### Bucket 2 — Raise odds the good moment gets found

Probabilistic, not guaranteed. This is the **recall** half.

| Technique                         | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B2 topic segmentation**         | Gives the clip a complete **arc** — setup → payoff. Arc completeness is what makes a clip self-contained, which is what makes it shareable out of context                                                                                                                                                                                                                                                                                          |
| **B12 pre-filter**                | Concentrates LLM attention on dense signal. **Also the doc's only downside-tail technique** — see below                                                                                                                                                                                                                                                                                                                                            |
| **C5 topic-coherent chunking**    | **Lost-in-the-middle**: LLM attention degrades for content in the centre of a long context. Chunking keeps each call small enough that no candidate is judged from a dead zone. Secondary: a candidate sitting on a chunk edge is ranked with truncated surrounding context, so its arc looks incomplete. **Not** a deletion mechanism — with overlap, every sentence still appears in some chunk (unlike B12, which permanently drops candidates) |
| **B4–B8 audio + lexical signals** | Finds moments the transcript cannot show. A 30s burst of raised voice + laughter is a clip without reading a word                                                                                                                                                                                                                                                                                                                                  |
| **B1 sentence serialization**     | Less noise → better reasoning. Same model, better input                                                                                                                                                                                                                                                                                                                                                                                            |
| **C2 listwise + Borda**           | **Stability.** Same video → same top clips. Currently it's a coin flip between runs                                                                                                                                                                                                                                                                                                                                                                |
| **C3 rubric**                     | Model told what to look for instead of "engaging"                                                                                                                                                                                                                                                                                                                                                                                                  |
| **C7 dedupe**                     | Five different moments, not five angles on one                                                                                                                                                                                                                                                                                                                                                                                                     |

**B12 is asymmetric and needs a gate.** Every other technique fails by _not helping_. B12 fails by
**silently destroying good clips** — if recall is 85%, quality is structurally capped and no prompt or
model upgrade recovers the dropped 15%. Do not ship B12 before the recall ablation in Part 4 is
running. It is the one place where an optimization can make output worse.

### Bucket 3 — Retention mechanics

Closest thing to a real hit lever, because retention _is_ the distribution input.

D5 hook-first (most-documented lever in short-form) · D7 jump cuts for pacing · E1 speaker-tracked
reframe (subject actually in frame) · E4 captions · E5 hook overlay.

### Bucket 4 — Cost/latency only

**Empty.** The only pure cost-saving item was C6, and C6 is rejected. Token savings from B1 and B12
are a _side effect_ — never the justification. If a proposal's only argument is cost, it does not
compete for wave priority.

### Claims deliberately hedged

- **"Bad clips drag channel distribution."** Widely believed by creators and consistent with how
  recommendation systems weight account history, but platforms don't confirm it and it hasn't been
  empirically isolated. Strong prior, not a proven mechanism. **B13 stands on trust-in-tool alone** —
  it does not need this claim.
- **"Most viewers watch muted."** The 85% figure is a 2016 Facebook study and does not transfer:
  TikTok and Reels are sound-on by default. Captions still earn their place — comprehension under
  accents / fast speech / jargon, accessibility, and as a motion element that holds attention. Right
  conclusion, wrong classic citation.

### The only real moat

Outcome data — posted clip + actual view count, thousands of rows. We don't have it; no open-source
competitor does either. If we ever collect it opt-in, that is the only path to genuine prediction.
Everything else in this doc a competent team copies in a month.

Position honestly: **"we find the best moment in your video and cut it correctly."** Provable.
Not "we predict what goes viral" — nobody can, and users find out.

---

## Part 3 — Target pipeline

```text
Long video
  │
  ├─ [ffmpeg]                audio extract → 16k mono wav
  ├─ [whisper.cpp --vad -vm] speech-gated decode (no silence hallucination)      A3
  ├─ [whisper.cpp --dtw P]   words + punctuation + sentences, P from DTW_PRESET  A2 A4 A7
  ├─ [SenseVoice]            per-utterance emotion + laughter/applause/BGM       A6
  └─ [ffmpeg astats/ebur128] per-second RMS / LUFS / F0 / centroid               B4
  │
  ▼
LOCAL CANDIDATE GENERATION   (zero API cost)
  sentence units                                                                 B1
  topic segmentation: TextTiling machinery + SBERT similarity                    B2
  multi-scale windows anchored on sentence + topic starts                        B3
  score: arousal + emotion + laughter + pause→burst + rate-delta
         + hook markers − filler density                                         B4–B10
  keep top ~25%                                                                  B12
  │
  ▼
ONE LLM PASS   (sees ~25% of content, sentence-level, candidates numbered)
  topic-coherent chunks, deepest-valley split if a topic overflows context       C5
  listwise rank by explicit rubric, 2 shuffled passes, Borda merge, tail-rank    C2 C3 C8
  RETURNS CANDIDATE IDs — never timestamps                                       C1
  │
  ▼
LOCAL REFINEMENT   (deterministic, no model)
  dedupe: IoU merge → MMR diversity                                              C7
  snap to words → expand back until referent resolves → cut in pause             D1 D2 D3
  verify complete-thought ending, extend up to +5s                               D4
  hook-in-first-3s check                                                         D5
  clamp to platform length                                                       D6
  APPLY ABSOLUTE QUALITY THRESHOLD — return 2 clips, or zero, if that's the truth B13
  │
  ▼
SECOND LLM PASS (short) — titles + hook lines + captions, survivors only
  │
  ▼
EXPORT: ASD reframe + smoothing + animated captions + jump cuts                  E1 E2 E4 D7
        + two-pass loudnorm -14 LUFS                                             E6
```

---

## Part 4 — Eval harness (two tiers, not one)

Every open-source competitor ships a prompt and hopes. The harness is the compounding asset.
**But it must be split** — one tier is objective, the other is a preference oracle of n=1 and will be
overfit to if we treat it as ground truth.

| Tier                       | Metrics                                                                                                           | Targets                | Videos needed                | Optimize against?               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------- | ------------------------------- |
| **Mechanical** — objective | boundary error p95; cold-open rate; truncated-ending rate; length compliance; cost + wall-clock per hour of video | <200ms; <2%; <2%; 100% | **3–5 is enough**            | **Yes, hard.** Track per commit |
| **Taste** — weak label     | precision@5 (clips a human would actually post)                                                                   | >3/5                   | **15+, ideally 2+ labelers** | Track, don't chase              |

3 videos ≈ 15 clip judgments — noise dominates entirely for the taste tier, but ~30 clip boundaries
is plenty for the mechanical tier. **Start mechanical in Wave 1.**

**Pre-filter recall is unmeasurable as originally specified.** "Recall of human-marked clips in the
top 25%" requires a human marking _every_ good moment across a full 60-min video — hours per video,
and it won't get done. Practical substitute: run the LLM over **100%** of the transcript once per
golden video, treat its picks as the reference set, then measure whether the pre-filter would have
dropped them. An **ablation, not a labeling job**.

---

## Part 5 — Wave plan

### Wave 1 — cheap, deterministic, huge

1. **Fix clip-length bug** — `clip-selector.ts:46`, hardcode 15–90s. One line
2. **B13 variable clip count + absolute quality threshold** — allow returning 2, or zero
3. **C1 LLM returns candidate IDs**, never ms
4. **B1 sentence-level serialization** (A4 punctuation → sentences)
5. **D1–D4, D6** snapping, backward expansion, pause-aware cuts, ending check, length clamp
6. **C3 virality rubric** + **C8 relative ranking only**
7. **A2 `--dtw <preset>`** with `DTW_PRESET` map + **A7 default `medium`**
8. **A3 `--vad -vm`** + silero ggml download reusing `downloadModel`
9. **E6 two-pass loudnorm -14 LUFS**
10. **Mechanical eval tier, 3–5 golden videos** — boundary error tracked per commit
11. Stopgap: fixed 20-min chunks + 60s overlap for >30min video (replaced by C5 in Wave 2)

### Wave 2 — the quality moat

12. **B2** TextTiling + SBERT topic segmentation
13. **C5** topic-coherent chunking (replaces the Wave 1 stopgap)
14. **B7** speech-rate delta + **B8** lexical hook markers + **B10** filler density — injected as
    prompt metadata (no candidate windows needed; B3 deferred until B12 ships)
15. **C2** listwise + shuffled passes + Borda, **C7** dedupe
16. **#46** pre-filter recall ablation (LLM-over-100% reference, not a labeling job)
17. **B12** pre-filter to top ~25% — **only after #46 confirms ≥90% recall**
18. **B4** audio arousal (RMS/LUFS/F0/centroid) + **B6** pause→burst anchor
    (B3 candidate windows ship here if B12 ships)
19. **D7** internal jump cuts

### Wave 3 — visible polish

20. **A6** SenseVoice tag track (emotion + laughter + BGM; ~300 MB, separate inference pass —
    transcript carries most signal for solo talking-head before this)
21. **B3** multi-scale candidate windows (only needed to feed B12 at scale)
22. **B5** laughter / applause (free via A6; deferred with A6)
23. **D5** hook-first check (minor post-refinement guard)
24. **E1/E2** active speaker reframe + smoothing
25. **A5** diarization
26. **C4** content-type rubrics, **E5** hook overlay
27. **A1** WhisperX/MFA optional precision mode
28. Taste eval tier once 15+ golden videos exist

### Rejected — do not re-litigate

| Item                            | Reason                                                                  |
| ------------------------------- | ----------------------------------------------------------------------- |
| B11 scene detection             | Wrong content type (talking-head is single-shot)                        |
| B14 TF-IDF importance           | Summarization signal, wrong objective; surfaces jargon/names/ASR errors |
| B15 centroid distance           | Measures digression, not controversy; high junk risk                    |
| C6 8B→70B cascade               | Net information loss at ~40 candidates                                  |
| C9 virality regressor           | No dataset                                                              |
| C10 multimodal moment retrieval | Benchmark mismatch (query-driven), slow, expensive locally              |
| A1 as _default_                 | Python/torch dep in Electron. Optional mode only                        |
| Silero as separate Python dep   | Superseded by A3 (ggml via bundled binary)                              |
| Cold-open hard blacklist        | Superseded by D2 repair mechanism                                       |

---

## Part 6 — Review log

Changes from Rev 1, and who was right.

**Accepted, Rev 1 was wrong**

- Eval belongs in Wave 1, not Wave 2 — and splits into mechanical / taste tiers
- C5 chunking depends on B2 (fixed chunks slice topics) — missed entirely in Rev 1
- Borda count, not score averaging, for merging shuffled listwise passes
- E6 loudnorm belongs in Wave 1, and must be two-pass
- SBERT was buried under TextTiling in Rev 1's ordering
- Variable clip count (B13) — missed by **both** reviewers in Rev 1

**Accepted with correction**

- A3 `--vad`: conclusion right, facts wrong. Not "zero extra model" and not "since v1.5" — it requires a downloaded Silero ggml via `-vm`. The real argument is ggml-vs-Python, which makes it _cheaper_ than Rev 1 assumed → promoted to Wave 1
- B2: not "TextTiling as fallback." Solbiati 2021 _is_ TextTiling with BERT similarity. Keep the depth-score/valley/smoothing machinery. And the 15.5% figure is AMI/ICSI meetings — algorithm transfers, number does not
- B9 cold-open: right instinct, wrong mechanism — repair via D2 backward expansion, not a blacklist
- B6 pause→burst: right signal, inverted usage — climax anchor, not in-point
- E6: right action, wrong justification — retention, not algorithm distribution

**Rejected on review**

- B14 TF-IDF, B15 centroid distance — both borrowed from extractive summarization, wrong objective
- C6 8B cascade — net information loss at this candidate count
- B16 position-in-topic — not rejected, _relocated_ from B12 scoring to D2 start-selection

**Rev 3 — mechanism buckets added (Part 2.5)**

- B12 pre-filter reclassified cost → **recall**. It caps quality structurally; contradicted Part 4 of Rev 2
- B12 additionally flagged as the doc's **only downside-tail technique** — gate it behind the recall ablation
- C1 was missing from the bucket framework entirely. Now Bucket 1 alongside the length bug
- C5 reclassified cost → **recall** (same bisection mechanism as B12)
- Bucket 4 (cost-only) is **empty** — its only member was the rejected C6. Cost is never a priority argument
- "Bad clips drag channel distribution" downgraded to a hedged prior. B13 stands on trust-in-tool alone
- "Most viewers watch muted" — 85% is Facebook 2016, doesn't transfer to sound-on-default TikTok/Reels. Caption justification rewritten

**Rev 4 — C5 justification corrected**

- Rev 3 claimed C5 shares B12's "bisection" mechanism. **Wrong.** B12 is a _filter_ (candidates
  permanently deleted, irreversible). C5 is a _context reorganizer_ (with overlap, every sentence
  still appears in some chunk; nothing is deleted). Only a clip longer than the overlap window can
  straddle a boundary — narrow edge case, not systematic recall loss
- C5 stays in Bucket 2, correct justification: **lost-in-the-middle** attention degradation in long
  contexts, plus truncated ranking context at chunk edges

**Rev 5 — findings from the first real-video run** (10:43 talking-head, `medium`)

- **`words` were BPE subword tokens, not words.** Pre-existing bug in `normalizeWhisperResult`.
  whisper.cpp marks word starts with a **leading space** (`" Hello"`, `" everyone"`, then `","`
  and `"'s"` continue the previous token); the code trimmed every token and pushed it as its own
  word. Real damage: `2026`→`22`/`6`, `full-stack`→`full`/`-`/`st`/`ack`, and **228 punctuation-only
  "words"** flowing into SRT export, captions, and filler detection. Fixed by merging on the
  leading-space marker — punctuation-only records now **0**
- **`--dtw` was a silent no-op.** whisper.cpp prints
  `dtw_token_timestamps is not supported with flash_attn - disabling` and continues with `dtw = 0`.
  Flash attention is **on by default**, so `--no-flash-attn` is mandatory alongside `--dtw`.
  Costs ~40% transcription time (1:34 → 2:13 on 10:43 of audio)
- **The 40-word cap was splitting mid-phrase.** On `medium` + VAD, 25/99 sentences hit the cap and
  broke at arbitrary word 40 (`...because a lot` / `of people are confused`) — and those edges
  become clip boundaries. Now backs off to the last clause break, else the longest pause: **25 → 1**
- B1's real reduction is **2.3x**, not 3–5x. Doc corrected
- `medium` clearly beats `base` on this content (`2026` vs `226`, `AI` vs `EA`), confirming A7

**Claim that failed verification**

- _"`--dtw` alone is sufficient, no preset needed."_ **False.** Verified in `examples/cli/cli.cpp`:
  `--dtw` consumes `ARGV_NEXT` and errors without it; an unknown preset prints
  `error: unknown DTW preset` and returns **exit code 3**, which our spawn handler rejects.
  Our `large` → `ggml-large-v3.bin` mapping means `--dtw large` **fails** — hence the `DTW_PRESET`
  map in A2. Not zero-friction; small but real.

---

## Sources

- [AI-Youtube-Shorts-Generator](https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator) · [openshorts](https://github.com/mutonby/openshorts) · [ai-clipping-comfyui](https://github.com/Anil-matcha/ai-clipping-comfyui)
- [OpusClip — Virality Score](https://help.opus.pro/docs/article/virality-score) · [OpusClip — Shorts length & retention](https://www.opus.pro/blog/ideal-youtube-shorts-length-format-retention)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) · [CLI source (`--dtw` parsing)](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp) · [Silero VAD issue #3003](https://github.com/ggml-org/whisper.cpp/issues/3003) · [convert-silero-vad-to-ggml.py](https://github.com/ggml-org/whisper.cpp/blob/master/models/convert-silero-vad-to-ggml.py)
- [SenseVoice](https://github.com/QwenAudio/SenseVoice) · [SenseVoiceSmall model card](https://huggingface.co/FunAudioLLM/SenseVoiceSmall) · [FunASR](https://github.com/modelscope/FunASR)
- [WhisperX](https://github.com/m-bain/whisperX) · [WhisperX paper](https://www.isca-archive.org/interspeech_2023/bain23_interspeech.pdf) · [WhisperX vs MFA (issue #1247)](https://github.com/m-bain/whisperX/issues/1247) · [MFA / alignment state of the art 2026](https://arxiv.org/pdf/2606.18466)
- [Solbiati 2021 — Unsupervised Topic Segmentation with BERT Embeddings](https://arxiv.org/abs/2106.12978) · [Topic segmentation on podcasts](https://arxiv.org/pdf/2307.13394)
- [QVHighlights / Moment-DETR](https://ar5iv.labs.arxiv.org/html/2107.09609) · [VideoLights](https://arxiv.org/pdf/2412.01558) · [LD-DETR](https://arxiv.org/pdf/2501.10787)
- [LR-ASD (IJCV 2025)](https://github.com/Junhua-Liao/LR-ASD) · [TalkNet-ASD](https://github.com/TaoRuijie/TalkNet-ASD) · [LoCoNet](https://arxiv.org/pdf/2301.08237)
- [MultiLinguahah — unsupervised laughter segmentation](https://arxiv.org/html/2605.06309) · [FunnyNet-W](https://arxiv.org/pdf/2401.04210) · [Perceptual audio features for emotion detection](https://link.springer.com/article/10.1186/1687-4722-2012-16)
- [Pointwise vs listwise reranking](https://zeroentropy.dev/articles/should-you-use-llms-for-reranking-a-deep-dive-into-pointwise-listwise-and-cross-encoders/) · [LLMs for Reranking survey](https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.176300630.01740917/v1)
- [Hook / first-3-seconds retention](https://virvid.ai/blog/first-3-seconds-hook-faceless-shorts-2026) · [Standalone clip construction](https://pixflow.net/blog/standalone-short-video-clips/) · [Platform LUFS targets](https://clickyapps.com/creator/video/guides/lufs-targets-2025)

---

# Part 7 — Devlog

Running record of what shipped, why, and what to check first when something breaks. Newest last.

---

## Wave 1 — `feat/clip-selection-wave1` (2026-08-11)

**Goal:** stop the pipeline producing unusable clips. Not "find better moments" — that's Wave 2.
This wave is entirely about removing defects that guarantee a clip fails regardless of how good
the moment was.

**Verification:** 25 unit tests, typecheck 22/22, lint 22/22, build 12/12, plus an end-to-end run
against a real 10:43 talking-head video (`medium` model). Three of the four bugs below were found
_by that real run_, not by the tests — noted because it's the argument for #46.

### Changes

#### `packages/ai/src/clip-selector.ts` — rewritten

| Change                                                                                    | Why                                                                                                                              |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Model returns `startSentence`/`endSentence`, never ms                                     | Hallucinated timestamps become structurally impossible (issue #28). Every ms is derived from our own `words` table               |
| Removed `duration * 0.2` length math                                                      | For a 60-min podcast it asked for clips **12–36 minutes long**. Single largest cause of bad output                               |
| 8-point virality rubric in the system prompt                                              | Old prompt said only "identify the most engaging segments" — no definition of engaging                                           |
| Strict `strong: boolean`, no numeric score                                                | LLM absolute scores are uncalibrated and drift between prompts; ordering is the signal. Binaries calibrate far better than 0–100 |
| Display score derived from final rank                                                     | UI needs a number; the model shouldn't invent one                                                                                |
| Variable clip count, may return zero                                                      | `maxClips = 5` padded results with garbage. 3 bad clips poison trust in the 2 good ones                                          |
| Chunking above 30 min: 20-min chunks, 60s overlap, round-robin rank merge, IoU>0.5 dedupe | Wave 1 stopgap. Overlap deliberately creates duplicates at seams, so dedupe is required, not optional                            |

**Design tension resolved:** C8 (no absolute LLM scores) vs B13 (absolute quality gate). Answer —
the model emits a _binary_, the gate is _deterministic_. No numeric threshold on an LLM number
anywhere in the pipeline.

**Hang fixed:** a single sentence longer than the chunk size left `cursor` unadvanced in
`chunkSentences` — an infinite loop in the main process. Guarded with `Math.max(next, cursor + 1)`.

#### `packages/transcript/src/sentences.ts` — new

`buildSentences` groups words on terminator / ≥700ms pause / 40-word cap. `sentencesToPrompt`
emits `#12 [10500-14200] text`. Measured **2.3x** token reduction on real data — the 3–5x in the
original plan was optimistic.

#### `packages/transcript/src/boundaries.ts` — new

D1–D4 + D6. Snap to word edges → expand backwards off a dangling opener → cut inside the pause
(≤180ms lead-in, ≤300ms tail, never past the pause midpoint) → extend up to +5s for a complete
thought → clamp to 15–90s. Plus `passesQualityGate`.

#### `packages/whisper/src/index.ts`

Token→word merge, `--dtw` + `DTW_PRESET`, `--no-flash-attn`, `--vad -vm` with auto-download,
default model `base` → `medium`.

#### `packages/ffmpeg/src/index.ts`

Two-pass `loudnorm` to -14 LUFS behind `normalizeLoudness`. Measure pass parses loudnorm's JSON
from stderr; on any failure it returns null and export proceeds unnormalized rather than failing.

#### UI

`ClipReview` empty state split on `analysisComplete`.

### Bugs found and fixed

| #   | Bug                                                                          | Root cause                                                                                                                              | How it was caught |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| #42 | `words` were BPE subword tokens (`2026`→`22`/`6`, 228 punctuation-only rows) | `normalizeWhisperResult` trimmed each token, destroying whisper's leading-space word-start marker                                       | Real video run    |
| #43 | `--dtw` silently disabled, `dtw = 0`                                         | Flash attention on by default; whisper.cpp disables DTW and continues at exit 0                                                         | Real video run    |
| #44 | Sentence cap split mid-phrase (25/99 sentences)                              | Hard break at word 40                                                                                                                   | Real video run    |
| #45 | Empty state read as failure when the gate correctly returned zero            | Single empty state couldn't distinguish "didn't run" from "found nothing"                                                               | Code review       |
| —   | D4 forward search was dead code                                              | `COMPLETE_THOUGHT_PAUSE_MS` (400) below `SENTENCE_GAP_MS` (700), so every pause-split sentence auto-qualified as complete               | Unit test         |
| —   | Dangling reference implemented as a hard _filter_                            | Contradicted the agreed "repair, not filter" design; rejected 100% of candidates in one test, and a clip at sentence 0 could never pass | Unit test         |

### Measured numbers (10:43 talking-head, `medium`)

|                                     | Before       | After                      |
| ----------------------------------- | ------------ | -------------------------- |
| Punctuation-only word records       | 228          | **0**                      |
| Sentences hitting the word cap      | 25 / 99      | **1 / 102**                |
| DTW enabled                         | `dtw = 0`    | **`dtw = 1`**              |
| Export loudness                     | -17.90 LUFS  | **-14.09 LUFS** (TP -1.50) |
| Prompt size (word → sentence level) | 34,805 chars | **14,934 chars** (2.3x)    |

### Costs accepted

- `--no-flash-attn` makes transcription ~40% slower (1:34 → 2:13 on 10:43). Required, or `--dtw`
  does nothing
- Two-pass loudnorm adds a decode pass: +1.7s on a 30s clip
- `medium` default is ~6x slower than `base` but visibly more accurate (`2026` vs `226`,
  `AI` vs `EA`)

### If something breaks, check here first

- **Clips start mid-sentence again** → `DANGLING_OPENERS` in `boundaries.ts`, and confirm D2's
  backward expansion isn't hitting `MAX_BACKWARD_SENTENCES`
- **Clips end mid-thought** → `COMPLETE_THOUGHT_PAUSE_MS` must stay **above** `SENTENCE_GAP_MS`,
  or D4's forward search silently no-ops
- **Zero clips returned** → expected behaviour if nothing passed the gate. The reasons are logged
  by the pipeline (`[clips] N kept, M dropped`). If everything is dropped for one reason, that
  threshold is miscalibrated
- **Captions/SRT show fragments like `st` / `ack`** → the token merge in
  `normalizeWhisperResult` regressed; check the leading-space test
- **Word timestamps look coarse** → confirm whisper stderr says `dtw = 1`, not `dtw = 0`
- **Whisper exits 3** → `DTW_PRESET` mapping. `large` must map to `large.v3`
- **Main process hangs during selection** → `chunkSentences` cursor guard

### Deliberately not done in Wave 1

Topic segmentation (B2), local scoring (B4–B10), pre-filter (B12), listwise ranking (C2), SenseVoice
(A6), active-speaker reframe (E1) — all Wave 2/3. And **#46, the eval harness**, which is the last
Wave 1 item and the reason three of the four bugs above were found by hand rather than by CI.
