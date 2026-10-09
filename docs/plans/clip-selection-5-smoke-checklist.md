# Clip selection 5 — smoke checklist (run before #101)

Status: **not started.** This is the step that comes before the 5-video test in `#101`. It needs no
reference moments and no labelling, because it measures something different: **does the app work at
all?** A run that returns zero clips, or silently falls back on a genre, is a bug — and a bug cannot
be scored by "did it find my 3 moments".

Purpose: three videos, three runs, one reading of the reports. Gate #101 on a clean pass.

## Prerequisites

- The app builds and runs: `pnpm build`, then `pnpm dev`.
- A working Groq key, set in the app's **Settings** (stored encrypted in `config.json`; the pipeline
  reads that, not `.env`). `.env` matters only for scripts you run by hand.
- Any three videos you already have. **Do not** use the benchmark set — this phase exists to find
  breakage, and a video that breaks the app is not a benchmark video.

## Procedure (per video)

1. Import the video, transcribe it once, run **clip selection**.
2. Read the report — nothing else, and label nothing:

   ```bash
   pnpm report-table --detail <project name or id>
   ```

Reports land in
`~/Library/Application Support/@video-editor/desktop/projects/<projectId>/selection-reports/`.

## Gates (all must pass on all three videos)

| #   | Check                                            | Where it shows                                | Fail means                                                                          |
| --- | ------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | `genre detected`, not `FALLBACK`                 | `profile … FALLBACK — genre detection failed` | #98 analysis is misfiring; every downstream number is on the wrong rubric           |
| 2   | `chunks N (0 failed)`                            | `chunks`                                      | A chunk call failed — its moments can never be selected                             |
| 3   | `funnel X candidates → Y kept`, Y ≥ 1            | `funnel`                                      | Zero kept: either generation returned nothing or the judge/gate rejected everything |
| 4   | no `judge-failed` unless a known 429             | `funnel`                                      | Judge calls are erroring                                                            |
| 5   | no `candidate(s) dropped over the per-chunk cap` | under the table row                           | The per-chunk cap is a recall ceiling — moments were discarded unjudged             |
| 6   | `(0 failed)` and a nonzero `hash`                | `chunks`, `hash`                              | Provenance missing — this run can't be compared to the next                         |

## Record

One line per video, in this file or the `#101` issue:

```
<video>  <profile (confidence)>  genre=<detected|FALLBACK>  chunks=<n>/<failed>  cand=<n>  kept=<n>  judge mean=<x>  verdict=<pass|fail: gate #>
```

## Stop rule

**Any gate failure stops the benchmark.** Fix that cause first — it is a reliability bug, and the
5-video test's whole design assumes each layer is working. Do not start #101, do not download
benchmark videos, do not touch model comparison until all three runs pass.

Current known state: the only two reports on disk (both `$9k_mo website`) show
`genre FALLBACK` + `profile solo_opinion (low)` — **gate 1 is already failing.** That is the first
thing to investigate, before the benchmark exists.

## After a clean pass

Freeze the set per the amended `#101` criteria — 5 benchmark videos + 1 negative control + 1
held-out, length spread with one >30 min, decent audio, content you know cold — write the 3
reference moments **before** the first run, then baseline twice for a noise floor (#90).

## Related

- `#101` — the 5-video manual test (this gate precedes it)
- `#46` — the formal eval harness (`pnpm report-table` is its mechanical-metrics core)
- `#90` — noise floor (the baseline-twice step)
- `#98` — genre profiles (gate 1)
