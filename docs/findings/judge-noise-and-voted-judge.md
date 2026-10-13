# Judge noise, output variance, and the voted-judge experiment (`v5`)

Status: **experiment complete, not merged.** The voted judge cut the judge's verdict-flip rate
from 15–17% to 2%, but it did **not** improve end-to-end reproducibility (Jaccard stayed at 0.33,
inside the old 0.17–0.50 band). The run-to-run variance is therefore **upstream of the judge** —
in generation/boundary/chunking — not in the judge. This document records what was verified, what
was built, and why `v5` is held back.

Date: 2026-10-13. Videos: `e35a3d5d` (48 min, conversation), `3ef0c250` (10 min, solo_opinion),
`3f237b6a` (8 min, story).

## 1. Starting point — the gate-5 fix

Commit `c64fb7e` ("scale the per-chunk candidate cap with chunk duration") replaced the flat
`MAX_CANDIDATES_PER_CHUNK=20` with `maxCandidatesFor()` (floor 20, +2/min, ceiling 50) in
`packages/ai/src/clip-selector.ts`. The Oct-12 smoke run had failed gate 5 on `e35a3d5d`
("10 candidates dropped over the per-chunk cap").

A re-run of the smoke driver passed all gates on all three videos. The failing clip now reported
`chunks 3 (0 failed)`, `kept 9`, `no cap drops`. The fix was confirmed to do what it claims.

## 2. Reproducibility findings

The pass was real but **not reproducible**. Reading every stored report revealed:

- **Candidate counts swing run to run on the same video, same code.** `e35a3d5d` produced
  53 / 31 / 28 / 43 candidates → 10 / 8 / 4 / 9 kept.
- **The top of the list changes.** Across two runs, the rank-1 clip had **0.00** overlap, and only
  3/10 kept clips matched (Jaccard 0.19). Two runs two minutes apart shared only 2 clips.
- **A recurring core of ~9 moments keeps being found** (recall is roughly stable); which survive and
  their rank is what shuffles. So the instability is downstream of candidate discovery.
- **The genre classifier is re-rolled every run and can flip.** The same video `3ef0c250` was
  classified `educational (high)` on Oct-9 and `solo_opinion (high)` on Oct-12/13. Both "high"
  confidence. The profile swap changes the rubric and the judge questions, and the yield swings 3x
  (16 candidates → 1 kept under `educational`; 10–13 → 2–3 kept under `solo_opinion`).

Reason: temperature is pinned to 0 (`client.ts`), but `openai/gpt-oss-120b` is served
non-deterministically, and the analysis call is re-run each time rather than cached.

## 3. Judge noise — isolated and quantified

`pnpm report-table --detail` showed `judge-rejected` is 75–80% of every funnel. A purpose-built
harness, `scripts/judge-noise.ts`, re-judged one stored run's candidates N times each with **no
regeneration**, reconstructing the exact production `judgeClip` input (same words, sentences,
context block, questions, and `refineClipBoundaries` boundary).

**Parity was verified before trusting the numbers:**

- The current `PIPELINE_FINGERPRINT` equals the report's `pipelineHash` (`e333aed2ac0b…`), so the
  harness judged with the same code that produced the report.
- `clip-judge.ts` was unmodified on disk; the only recent change (#120, `225b10f`) is a
  `bestOpeningSentence` schema tolerance — score-inert.
- Boundary replay reproduced the stored bounds exactly.

**Results (single sample, 3 repeats each):**

| video      | clips | mean score range | kept↔rejected flips |
| ---------- | ----- | ---------------- | ------------------- |
| `e35a3d5d` | 41    | 0.103            | 6–7 / 41 (15–17%)   |
| `3ef0c250` | 10    | 0.074            | 1 / 10 (10%)        |
| `3f237b6a` | 9     | 0.090            | 1 / 9 (11%)         |

The cleanest evidence is moments with **byte-identical input** across runs: `16:55–17:49` (55 s)
flipped kept/rej/rej/kept; `37:05–37:22` was KEPT at score 0.21 in one run and REJECTED at 0.21 in
another — **same score, opposite verdict**. The flip is in the **hard gate** (a single sampled
`payoff`/`standalone` "no"), not in the score.

Note: an earlier claim that a 0.86×3 clip was a "lucky draw" was wrong and is retracted — those runs
judged a one-sentence-shorter cut (`#390–#397` vs `#390–#398`). Boundary, not luck.

## 4. The `v5` voted judge (implemented, held back)

Rule: sample each judged clip up to k=3 times and vote (`packages/ai/src/clip-judge.ts`).

- Per-question **median grade** (`yes` > `partly` > `no`); a hard gate rejects only when the median
  is `no`.
- Score = **mean** of per-sample scores; note from the sample closest to that mean; best-opening is
  the modal non-null, ties toward the earlier sentence.
- **1 sample returns itself unchanged**, so unsampled output is byte-identical to before.
- **Skip rule**: a first sample that is "clearly dead" (`score < 0.15` **or** both hard questions
  `no`) is not resampled — this catches false _accepts_ too, not only rejects. Measured revival of
  skipped clips: **0 / 23** (`e35`), **0 / 3** (Yash), **0 / 4** ($9k) → the "both hard no" clause
  stays.
- **Failure split**: a failed first sample rethrows (counts toward the 50% abort); a failed resample
  is swallowed and the samples in hand are used.
- **Opening retry votes too** (same function).
- Samples are stored in `clips.judge_json` (`ClipJudgeRecord.samples?`, backward-compatible) and on
  the trace entry; a per-question **disagreement tally** is logged per run.
- Fingerprint hashes `judgeSamples`, `judgeDeadScore`, and the aggregation rule;
  `PIPELINE_VERSION` → `v5-voted-judge` (hash `c015bc5cbd6d`).
- Temperature untouched (0).

### Success test (voted path, `judge-noise.ts --voted`)

| video      | single flip | voted flip | voted mean range |
| ---------- | ----------- | ---------- | ---------------- |
| `e35a3d5d` | 15–17%      | **2%**     | 0.063            |
| `3ef0c250` | 10%         | **0%**     | 0.054            |
| `3f237b6a` | 11%         | **11%**    | 0.097            |

Judge calls per full run: **67 / 71 / 97** (~1.6–2.3× the single-call count).

### End-to-end result — the reason it is not merged

Three full runs of `e35a3d5d` on `v5` (all hash `c015bc5c`, 8 clips kept each):

```
run1 vs run2: 4/8 matched, Jaccard 0.33
run1 vs run3: 4/8 matched, Jaccard 0.33
run2 vs run3: 4/8 matched, Jaccard 0.33
```

Jaccard 0.33 is **inside** the old 0.17–0.50 band — no improvement. The vote removed the judge's
verdict noise but the kept set still reshuffles, so **the dominant variance source is upstream of
the judge**: generation proposes different spans/candidates each run, and chunking/boundary
refinement move the cuts. Shipping `v5` would add ~2× judge calls for no reproducibility gain.

Two knife-edge clips remain, exactly as predicted for a majority vote: `e35 34:41` voted scores
`[0.42, 0.42, 0.41]` yet the median `payoff` still flips — a ~50% question that no vote fixes.

## 5. Conclusion and next steps

1. **Do not merge `v5`.** It is correct and tested but does not move the metric that matters.
2. **Attack the real source: generation / boundary / chunking.** The Jaccard result points there.
   This is a separate lane (e.g. the mid-thought spans behind `R7`/`R10`, the `2:58`/`26:xx`
   boundary movers, and candidate-count variance).
3. **Cache the genre per transcript.** Cheap, independent, and removes the 3x yield swing from a
   re-rolled classifier.
4. **Keep the instrumentation.** `judgeCallCount`, `disagreementCounts`, and the skip-rule measurement
   are useful regardless of whether the vote ships.
5. **Still needed: human labels.** Noise is not calibration. `docs/eval/short-videos-blind.md` and
   `docs/eval/e35-blind.md` are the labelling sheets; the judge's score-vs-label AUC is the next
   measurement, and it is independent of the vote.

## 6. Files and tooling

- `packages/ai/src/clip-judge.ts` — `judgeClipVoted`, `aggregateJudgements`, `isClearlyDead`,
  `disagreementCounts`, `JUDGE_SAMPLES`, `JUDGE_DEAD_SCORE`, `toJudgeRecord` samples.
- `packages/ai/src/clip-selector.ts` — voted call sites (judge + opening), `trace.judgeCallCount`,
  run-level disagreement log, fingerprint + `v5-voted-judge`.
- `packages/types/src/index.ts` — `ClipJudgeRecord.samples?`, `ClipJudgeSample`, parser pass-through.
- `apps/desktop/src/main/ipc.ts`, `selection-report.ts` — store and render samples + judge calls.
- `scripts/judge-noise.ts` — the judge-stability harness (`--voted` mode, skip-rule measurement).
- `scripts/smoke-run.ts`, `scripts/report-table.ts` — surface `judgeCallCount`.
- `docs/plans/clip-selection-5-smoke-checklist.md` — Tools section documenting the harness.
- Tests: `aggregateJudgements`, `isClearlyDead`, `disagreementCounts`, and the adopted-opening
  samples regression in `packages/ai/src/*.test.ts`.

Validation: typecheck 22/22, lint clean, prettier clean, 245 tests pass.

## 7. Reproduce

```bash
# verdict-flip rate on the shipped path (voted)
GROQ_API_KEY=... node --experimental-strip-types scripts/judge-noise.ts \
  e35a3d5d-f56d-4493-a814-6fdfa4c87d36 20261013T094502022Z.json 3 --voted

# single-sample rate, plus the skip-rule revival number
GROQ_API_KEY=... node --experimental-strip-types scripts/judge-noise.ts \
  e35a3d5d-f56d-4493-a814-6fdfa4c87d36 20261013T094502022Z.json 3

# full run (writes a report; --detail shows judge calls)
GROQ_API_KEY=... node --experimental-strip-types scripts/smoke-run.ts <projectId>
pnpm report-table --detail <projectId>
```
