# Clip selection 3 — judge the final cut, rank globally (#99)

Status: **shipped** in #110 (PR A, the pipeline, and PR B, `judge_json` plus the `ClipReview`
chips, together). The note below lists where the build differs from this plan; where they differ,
the code wins. The plan text itself is kept as written before the build.

Depends on #97 (re-run + selection report) and #98 (genre profiles, `VIDEO CONTEXT` block,
`judgeQuestions`) — both merged (#109).

> **Status: PR A implemented.** This document was written before the build. Where the code
> differs, the code wins; the differences, decided in review, are:
>
> - **Graded answers, no `overall` rating.** Each question is `yes` (1) / `partly` (0.5) / `no` (0).
>   `score = Σ weight × grade ÷ Σ weight`. A 1–10 rating was dropped: decision C8 in
>   `CLIP-DETECTION-RESEARCH.md` rules out absolute LLM scores, and graded answers already break ties.
> - **Hard requirements reject only on a clear `no`** (`standalone`, `payoff`); `partly` passes.
> - **Judge-failure rule:** one failed call rejects that candidate; if **more than half** fail the run
>   throws before any swap, so a re-selection keeps the previous suggestions.
> - **Seam duplicates (≥ 90% overlap) are dropped before judging**; looser overlap is deduped after
>   scoring, keeping the higher score.
> - **Chunk generation runs 3 at a time**, results kept in chunk order; 429s on generation and judge
>   calls back off (honouring `retry-after`, else 1s/2s/4s, max 20s, 4 attempts).
> - **PR A had no database migration:** `clips.ai_score` carries the real score and per-question
>   answers live in the run's selection report. **PR B** (stacked on the same branch) adds
>   `clips.judge_json` (migration `0005`), stores the verdict with its questions copied in, and shows
>   pass/fail chips and the judge's note in `ClipReview`.
> - Judge ids for profile questions are positional (`comedy_1`). `bestOpeningSentence` is stored in
>   the judgement but unused until #100. The score is a pure function of the answers.
> - Not built: `JUDGE_MAX_CANDIDATES` cap (log first), batching (batch size is 1 by design).

---

## 1. Problem statement

"Best clips" should mean _the best moments across the whole video, judged on what will actually be
exported._ Today the pipeline does neither. Five defects compound:

| #   | Defect                                                                                                                                                                                                                                                                        | Where                                                                                         | Effect                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Ranking by chunk quota, not quality.** `interleaveByRank` takes rank #1 from every chunk, then #2 from every chunk, … and `maxClips` cuts the list.                                                                                                                         | `clip-selector.ts` `interleaveByRank`                                                         | On a long video the best moment of a dull section outranks the second-best moment of a great one. Strong clips are dropped purely because of where they sit.                              |
| 2   | **"Strong" is judged per chunk.** The generation prompt asks for `strong: boolean`; `passesQualityGate` rejects anything not marked strong. The model only sees its ~20-minute chunk.                                                                                         | `SYSTEM_PROMPT` "STRONG FLAG", `boundaries.ts` `passesQualityGate(boundary, llmMarkedStrong)` | The bar moves between chunks — a weak chunk still yields "strong" clips. It also forces generation to be strict, which kills recall: an uncertain moment is never compared with anything. |
| 3   | **The re-rank never sees the clip.** `reRankWithBorda` sends only `id="title" — reason`, never the transcript, after an unseeded `Math.random()` shuffle.                                                                                                                     | `reRankWithBorda`, `renderRerankLine`, `shuffle`                                              | It ranks the model's own summaries of its picks, costs one extra LLM call per chunk, and is the most likely source of run-to-run variance (#90, #94).                                     |
| 4   | **The model judges a range the code then changes.** After the model picks `startSentence..endSentence`: `hookFirstAdjust` moves the start forward up to 2 sentences; `refineClipBoundaries` moves it back up to 3 (D2), extends the end up to 5s (D4), clamps to 15–90s (D6). | `hookFirstAdjust`, `refineClipBoundaries`                                                     | The exported clip can differ materially from what was judged, and **nothing ever evaluates the final cut.**                                                                               |
| 5   | **The score is fake.** `clip.score = 1 - i / total`.                                                                                                                                                                                                                          | end of `selectClips`                                                                          | The top clip always shows 1.0 even when every clip is weak. The user cannot tell a great batch from a bad one.                                                                            |

### Current flow

```
transcript
  → topicsToChunks            (one chunk if ≤ 30 min; else ~20 min chunks, 150 s overlap)
  → per chunk:
       generateObject          (CandidateSchema incl. `strong`, ≤ 20 per chunk)
       reRankWithBorda         (shuffle + title-only rerank call, Borda merge)
  → interleaveByRank           (round-robin across chunks)
  → per candidate, in that order:
       hookFirstAdjust → refineClipBoundaries → passesQualityGate(strong)
       → overlap dedupe (keep earlier) → stop at maxClips
  → score = 1 - i/total
```

---

## 2. Target flow

```
generate (recall)  →  refine boundaries (deterministic)  →  mechanical gate
   →  judge the final text (precision, one call per candidate)
   →  hard-requirement gate  →  rank ALL chunks together by judge score
   →  overlap dedupe (keep higher score)  →  top maxClips
```

The key change: **the thing that is scored is the thing that is exported**, and scores are
comparable across chunks because each candidate is judged on its own, against the same rubric.

---

## 3. Detailed design

### Step 1 — Generate for recall

- Keep chunking exactly as is (`topicsToChunks`, sizes unchanged). Whether to drop chunking is
  decided in the test issue (#101), not here.
- Generation prompt (`SYSTEM_PROMPT`):
  - Remove the `STRONG FLAG` paragraph and `strong` from the output spec.
  - Replace "Be strict … returning weak clips is worse than returning nothing" with: _list every
    plausible clip in this chunk; a later step judges each one strictly, so do not self-censor._
  - Keep the "what makes a clip worth posting" list, the self-contained rule, and the #98 profile
    rubric + `VIDEO CONTEXT` block, so candidates are still the right _kind_ of moment.
  - Keep "best first" ordering. It no longer decides the final rank, but it is recorded in the
    trace and is the order used if the judge cap (below) is ever hit.
- `CandidateSchema`: drop `strong`. Keep `title`, `reason`, `platform`, sentence range.
- `MAX_CANDIDATES_PER_CHUNK` stays 20. Raise only if reports show the model hitting the cap.
- Delete `reRankWithBorda`. That removes one LLM call per chunk, which partly pays for the judge.

### Step 2 — Refine every candidate (deterministic)

- Run `refineClipBoundaries` directly on the model's range.
- **Do not** run `hookFirstAdjust`. It is deleted; #100 replaces it with the judge's
  `bestOpeningSentence`.
- Keep the mechanical rejections: invalid range, too short, does not end on a complete thought.
  These happen **before** judging, so we never pay for a call on a clip that cannot ship.
- `passesQualityGate(boundary)` — drop the `llmMarkedStrong` parameter; update its tests.
- `HOOK_RE` stays: it still drives the `{hook}` signal tag in the generation prompt and the
  `"weak opening"` warning on the final opener.

### Step 3 — Judge the final cut

**One call per candidate**, so judgements are independent and there is no position bias across a
list.

**Judge prompt (user message)** contains:

1. The #98 `VIDEO CONTEXT` block (profile, summary, speakers, topics) — same renderer the
   generation step uses.
2. Up to **2 sentences before** the clip, clearly fenced:
   `[BEFORE CLIP — viewer does NOT see this]` … `[CLIP STARTS]`.
   This is what lets the judge tell whether the clip depends on missing context.
3. **The exact text of the refined clip** — the words between `startMs` and `endMs`, i.e. the same
   string already recorded as `trace.entry.text`. Rendered as numbered sentences so the judge can
   name `bestOpeningSentence`.
4. The duration in seconds.

All model-authored or transcript text is substituted with function replacements (same reason as
`renderUserPrompt`: `$`-patterns and `{{…}}` in spoken text must not corrupt the prompt).

**Questions.** Universal set — ids are stable because they are stored:

| id           | question                                                                            | weight (initial) |
| ------------ | ----------------------------------------------------------------------------------- | ---------------- |
| `hook`       | Would the first sentence on its own make a scrolling viewer stop and keep watching? | 3                |
| `standalone` | Does it make complete sense to someone who has never seen this video?               | 2 · **hard**     |
| `payoff`     | Does it end on a resolution: an answer, punchline, conclusion or reveal?            | 2 · **hard**     |
| `oneIdea`    | Is it about one idea, rather than drifting between topics?                          | 1                |
| `postable`   | Would a professional short-form editor for this channel actually post it?           | 3                |

Plus the effective profile's three `judgeQuestions` from `profiles.ts`, weight 1 each. They are
plain strings today, so they get positional ids **`<profileId>.1`, `.2`, `.3`** (e.g.
`conversation.2`). Reordering a profile's questions therefore changes the ids — that is
acceptable because it also changes the fingerprint, and stored answers are always read together
with the run's `pipelineHash`.

**Judge output schema** (built per run, because the question ids depend on the profile):

```ts
{
  answers: { hook: boolean, standalone: boolean, payoff: boolean, oneIdea: boolean,
             postable: boolean, "conversation.1": boolean, ... },
  overall: number,              // integer 1–10 — see "Scoring" for why this exists
  note: string,                 // one sentence, shown in the UI in PR B
  bestOpeningSentence: number   // sentence index inside the clip; consumed by #100, stored now
}
```

`bestOpeningSentence` is added now so #100 does not need a second schema change. It is validated
(must be a sentence inside the clip) and otherwise ignored in PR A.

**Scoring** — named constants, all in the fingerprint:

- `yesScore` = Σ(weight of each yes) / Σ(all weights), 0–1.
- `overallScore` = (overall − 1) / 9, 0–1.
- **`score = 0.6 · yesScore + 0.4 · overallScore`**, rounded to 2 dp.

_Why the extra `overall` field (deviation from the issue text):_ with ~8 booleans and integer
weights, many candidates land on the same `yesScore`. Global ranking among ties would then fall
back to arbitrary order — the exact problem we are removing. A single 1–10 overall rating breaks
ties with a judgement about _this_ clip. The yes/no answers still do the gating and still drive
most of the score.

**Hard requirements:** `standalone` and `payoff` must both be yes, otherwise the candidate is
rejected with outcome `judge-rejected` and reason `"fails standalone"` / `"fails payoff"`. These
are the two defects that make a clip unpostable regardless of anything else.

**Sampling:** one sample at the client's pinned temperature. Only if the #97 reports show answers
flipping across re-runs do we move to 3 samples and use the share of yes as a probability. That
is a data decision, not an up-front one — PR A logs everything needed to make it.

**Concurrency and rate limits:**

- Judge calls run through a small pool, **concurrency 3** (`JUDGE_CONCURRENCY`).
- `client.generateObject` already retries 3× with 500 ms / 1000 ms backoff. That is too short for
  a Groq HTTP 429, whose window is seconds. Add a 429-aware wait: when the error is a rate limit,
  honour `retry-after` if present, else back off exponentially (1 s, 2 s, 4 s, capped), for a
  bounded number of attempts. Implemented in the judge path (or the client, if it stays generic
  and the other callers benefit) — decided while reading the AI SDK error shape.
- **A judge call that still fails rejects only that candidate** (outcome `judge-failed`, with the
  error). It never aborts the run.
- **If every judge call fails, the run throws** — same rule as "every chunk failed" today. An empty
  result and a broken run must not be the same value, because a re-selection swaps suggestions for
  whatever comes back.

**Cost estimate.** Typical video: 1–6 chunks, 5–15 candidates per chunk after the mechanical gate
→ roughly 10–60 small judge calls, minus the 1–6 rerank calls we delete. Each call carries one
clip (≤ 90 s of speech) plus context, so a few hundred to ~1.5k tokens.
Open decision (§7): a `JUDGE_MAX_CANDIDATES` cap.

### Step 4 — Rank, dedupe, cut

1. Sort **all surviving candidates from all chunks together** by judge score, descending.
   Tie-break deterministically: higher `overall`, then earlier `startMs`. No `Math.random`.
2. Walk that list with the existing overlap dedupe (`DEDUPE_OVERLAP_RATIO = 0.5`). Because the list
   is score-ordered, the higher-scored clip of any overlapping pair is the one kept.
3. Take the top `maxClips`; the rest are recorded as `over-budget`.
4. `ClipSuggestion.score` = the judge score (no longer rank-derived). Stored as `aiScore`.
   `aiRank` stays the final position.

### Delete

`interleaveByRank`, `reRankWithBorda`, `shuffle`, `RERANK_SYSTEM`, `renderRerankLine`,
`RERANK_FORMAT_SAMPLE`, `hookFirstAdjust`, `HOOK_FIRST_MAX_TRIM`, the rank-derived score, the
`strong` field (schema, trace, gate). This makes the seeded-shuffle half of #90 moot.

---

## 4. Data, trace and report changes

**Database** — migration `0005_add-clip-judge` (drizzle-kit, following `0002_add-clip-provenance`):

- `clips.judge_json` — nullable `text`. Stores `{ answers, overall, note, score, bestOpeningSentence }`.
  NULL on every row written before this migration (not knowable; no backfill).
- `clips.ai_score` already exists — now carries the real judge score.

**Desktop main (`ipc.ts`)** — `runClipSelection` writes `aiScore` and `judgeJson` per clip row.
Nothing else about the swap changes. The "all chunks failed" defence stays, and gets a sibling
check for "all judge calls failed".

**Trace (`ClipSelectionTrace`)**:

- `TraceCandidate.strong` → removed.
- `TraceEntry.trimmedStartSentence` → removed (no hook trim any more).
- New `TraceEntry.judge: { answers, overall, note, score, bestOpeningSentence } | null` — null
  when the candidate never reached the judge (mechanical rejection) or the call failed.
- New outcomes: `judge-rejected` (failed a hard requirement) and `judge-failed` (call error).
  Every candidate still ends in exactly one outcome.
- New trace field: the judge question list for the run (`id`, text, weight, hard) so the report
  is self-describing.

**Selection report (`selection-report.ts`)** — shows every candidate's judge answers as a compact
✓/✗ row, `overall`, `score` and `note`, **including rejected candidates**, plus the run's question
table. This is the acceptance check for "several clips from one chunk, none from another".

**Fingerprint (`computePipelineFingerprint`)**:

- Remove: `rerankSystem`, `rerankFormat`, `HOOK_FIRST_MAX_TRIM`.
- Add: judge system prompt, judge user-prompt template + a rendered sample, universal questions by
  id, every profile's `judgeQuestions` (the #98 comment that excludes them is now false and is
  updated), weights, hard requirements, `0.6/0.4` blend, before-clip context sentence count.
- Not hashed: `JUDGE_CONCURRENCY` and retry timings — they change speed, not output.
- Bump `PIPELINE_VERSION` → `v3-judge-global-rank`.

---

## 5. Files touched (PR A)

| File                                                                  | Change                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/ai/src/clip-selector.ts`                                    | Generation prompt, schema, delete rerank/interleave/hook-trim, new ranking loop, fingerprint, version |
| `packages/ai/src/clip-judge.ts` (new)                                 | Judge prompt, questions, schema builder, scoring, concurrency pool, 429 handling                      |
| `packages/ai/src/profiles.ts`                                         | Doc comment on `judgeQuestions` (now sent + hashed); no question text changes                         |
| `packages/transcript/src/boundaries.ts`                               | `passesQualityGate(boundary)` signature                                                               |
| `packages/types/src/index.ts`                                         | `ClipJudgement` type; clip row gains `judgeJson`                                                      |
| `packages/database/src/schema.ts` + `resources/drizzle/0005_*` + meta | `judge_json` column                                                                                   |
| `apps/desktop/src/main/ipc.ts`                                        | Persist score + judgement; all-judge-failed guard                                                     |
| `apps/desktop/src/main/selection-report.ts`                           | Judge columns and question table                                                                      |
| Tests                                                                 | see §6                                                                                                |

UI (`ClipReview` chips, note, real score display) is **PR B**.

---

## 6. Tests (mocked `AiClient`)

- **Global ranking across chunks:** chunk 2's model-rank #2 outranks chunk 1's #1 when the judge
  scores it higher; the final list may hold several clips from one chunk and none from another.
- **Hard requirement:** a candidate with `standalone: false` or `payoff: false` is
  `judge-rejected` with that reason and appears in the trace.
- **Dedupe keeps the higher score**, regardless of chunk or model order.
- **429 retry:** a judge call that rate-limits once then succeeds is kept; one that never succeeds
  is `judge-failed` and the rest of the run survives.
- **All judge calls fail → throws** (no silent empty result).
- **Judge sees the refined text**, including D2/D4 boundary changes, and the before-clip fence.
- **Score is the judge score**, not rank-derived; weak batches show low scores.
- **No `Math.random`** in the selection path (grep-style test or by construction).
- **Fingerprint moves** when a judge question, weight, or a profile's `judgeQuestions` changes.
- Update: `passesQualityGate` tests, trace tests that reference `strong` / `trimmedStartSentence`,
  the C8 "scores from rank" test (inverted), report tests, DB migration test.
- `pnpm build`, `pnpm typecheck`, lint, `pnpm vitest run` all green.

---

## 7. Open decisions (defaults chosen; flag if you disagree)

1. **`JUDGE_MAX_CANDIDATES` cap.** Default: **no cap in PR A**, log the count per run. If reports
   show > ~40 judge calls per video or 429 pain, add a cap that picks _which_ candidates to judge
   by round-robin over model order — used only for budget, never for the final rank.
2. **Blend 0.6 / 0.4 and the weights.** Starting values, to be tuned against the #101 test videos.
   All in the fingerprint, so every tuning step is attributable.
3. **Profile question ids are positional** (`conversation.1`). Cheap and stable enough given the
   fingerprint; switch to named ids if a profile's questions start being edited often.
4. **Pre-judge dedupe of seam duplicates.** Chunk overlap means the same moment can be judged
   twice. Default: judge both and keep the higher score (matches the issue). Revisit if cost bites.

---

## 8. Risks

- **Judge calibration.** An LLM judge is not ground truth. The score is honest about _what the
  judge thought of the exported text_, which is strictly better than a rank position — but whether
  it tracks real-world performance is only answered by #46 / #101. PR A stores every answer so
  that question can be asked.
- **Run time.** More calls than today; concurrency 3 keeps it bounded. Progress events will name
  the judging phase so a longer run does not look stuck.
- **Recall jump.** A looser generation prompt yields more candidates; the mechanical gate and the
  hard requirements are what keep precision. If the final lists get worse, the first suspects are
  the weights and the hard requirements, not the recall change.

---

## 9. Acceptance (from #99)

- [ ] On a long test video, the final list can contain several clips from one chunk and none from
      another — visible in the report.
- [ ] Every final clip's score comes from judging the exact exported range.
- [ ] Candidates failing `standalone` or `payoff` appear in the report as rejected with that reason.
- [ ] No `Math.random` remains in the selection path.
- [ ] Unit tests cover global ranking, hard-requirement rejection, dedupe-by-score, 429 retry.
- [ ] Typecheck, lint and tests pass.

Not in scope: chunk size / removing chunking (#101), topic diversity caps (#103), judge-chosen
opening (#100), UI chips (PR B).
