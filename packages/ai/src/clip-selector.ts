import { createHash } from "node:crypto"
import {
  CLIP_SELECTION_TEMPERATURE,
  STRUCTURED_OUTPUT_SUFFIX,
  readChunkFailure,
  type AiClient,
  type ChunkFailure,
} from "./client"
import type { z } from "zod"
import { z as zod } from "zod"
import type { Word, Sentence } from "@video-editor/types"
import { CLIP_PROFILE_IDS, type ClipProfileId, type VideoAnalysis } from "@video-editor/types"
import {
  refineClipBoundaries,
  passesQualityGate,
  MIN_CLIP_MS,
  MAX_CLIP_MS,
  LEAD_IN_MS,
  TAIL_MS,
  END_SEARCH_MS,
  COMPLETE_THOUGHT_PAUSE_MS,
  MAX_BACKWARD_SENTENCES,
  DANGLING_OPENERS,
} from "@video-editor/transcript"
import type { TopicSegment } from "@video-editor/transcript"
import { CLIP_PROFILES, type ClipProfile } from "./profiles"
import { mapPool, withRateLimitRetry, isRateLimitError, realSleep, type Sleep } from "./concurrency"
import {
  judgeClipVoted,
  judgeQuestionsFor,
  failedHardQuestions,
  disagreementCounts,
  JUDGE_SYSTEM_PROMPT,
  JUDGE_USER_TEMPLATE,
  JUDGE_BEFORE_SENTENCES,
  JUDGE_SAMPLES,
  JUDGE_DEAD_SCORE,
  UNIVERSAL_JUDGE_QUESTIONS,
  PROFILE_QUESTION_WEIGHT,
  GRADE_VALUE,
  type ClipJudgement,
  type JudgeQuestion,
} from "./clip-judge"
import {
  analyzeVideo,
  renderVideoContext,
  analysisInputFingerprintFields,
  ANALYSIS_PROMPT,
  VIDEO_CONTEXT_TEMPLATE,
  videoContextSample,
} from "./video-analysis"

export interface ClipSuggestion {
  title: string
  startMs: number
  endMs: number
  score: number
  reason: string
  platform: "tiktok" | "reels" | "shorts" | "generic"
  /** Non-blocking defects (e.g. cold open). Drives the eval harness's cold-open rate. */
  warnings: string[]
  /** The judge's verdict on this clip's exact exported range (#99). `score` is derived from it. */
  judge?: ClipJudgement
  /**
   * The raw samples behind `judge` when it was voted (#125). Length 1 when the first sample was
   * clearly dead or a resample failed. Absent when the clip was never judged.
   */
  judgeSamples?: ClipJudgement[]
}

export interface ClipRejection {
  title: string
  reasons: string[]
}

/**
 * Provenance for one clip-selection run, so a stored clip can be traced back to the
 * configuration that produced it. Written to `clips` on insert; see #89.
 *
 * `pipelineHash` is the source of truth — it is a fingerprint of every prompt template and
 * heuristic threshold the selection path reads, so it changes automatically when any of them
 * change. `pipelineVersion` is a human-readable label for the surrounding *code*, which the
 * fingerprint cannot see: a logic change in `refineClipBoundaries` that touches no constant
 * leaves the hash identical. Bump it by hand in that case.
 */
export interface ClipSelectionProvenance {
  pipelineVersion: string
  pipelineHash: string
  /** The model that served the structured (clip-selection) calls. */
  model: string
  /**
   * The genre profile the rubric was swapped to. A profile id, not one of the old content types:
   * `interview`/`tutorial`/`solo`/`generic` are gone, and this column now records what the LLM
   * decided the video was.
   */
  contentType: ClipProfileId
  /** True when `contentType` is the user's choice rather than the classifier's. */
  contentTypeOverridden: boolean
}

export interface ClipSelectionResult extends ClipSelectionProvenance {
  clips: ClipSuggestion[]
  /** Candidates dropped by the quality gate — surfaced so "only 2 clips" is explainable. */
  rejected: ClipRejection[]
  /**
   * What the classifier made of the video (#98): profile, confidence, summary, speakers, topics.
   *
   * Present on every return path including the empty-transcript one, for the same reason `trace`
   * is: a caller that stores it must not have to special-case the runs where it is missing, and a
   * report that omits it on a zero-sentence video is indistinguishable from an older build's.
   */
  analysis: VideoAnalysis
  /**
   * Every candidate's full history, in the order returned (#97). Optional because a caller that
   * only wants clips should not pay to accumulate it, and present on every run — including the
   * empty-transcript path — so a report never silently omits the field.
   *
   * This is data, not a log: `selectClips` returns it and the caller decides whether to write a
   * file. `packages/ai` does no I/O.
   */
  trace?: ClipSelectionTrace
}

/** One candidate as the LLM proposed it, before any of our heuristics touched it. */
export interface TraceCandidate {
  /** Which chunk (0-based) the candidate came from. Chunks overlap, so this is not recoverable later. */
  chunk: number
  /** The sentence range exactly as the model returned it. */
  startSentence: number
  endSentence: number
  title: string
  reason: string
  platform: "tiktok" | "reels" | "shorts" | "generic"
}

/** What became of a candidate. Every candidate ends in exactly one of these. */
export type TraceOutcome =
  | "kept"
  | "gate-rejected"
  | "invalid-range"
  | "duplicate"
  | "judge-rejected"
  | "judge-failed"
  | "over-budget"

export interface TraceEntry extends TraceCandidate {
  outcome: TraceOutcome
  /**
   * The judge's verdict on the refined clip (#99), or null when the candidate never reached the
   * judge (mechanical rejection, pre-judge duplicate) or the judge call failed.
   */
  judge: ClipJudgement | null
  /**
   * The raw samples behind `judge` when it was voted (#125), empty when the candidate never reached
   * the judge. Kept on the entry as well as in the stored record so the report can show a
   * disagreement the single-sample `judge` would hide.
   */
  judgeSamples: ClipJudgement[]
  /** Why the judge stage rejected it: a failed hard question, or the call error. Else empty. */
  judgeReasons: string[]
  /** Final refined boundaries, or null when refinement produced nothing. */
  startMs: number | null
  endMs: number | null
  /** mm:ss form of the final boundaries. The report's primary human-readable form. */
  startTimecode: string | null
  endTimecode: string | null
  /** The `RefinedBoundary` flags, kept verbatim so the report can explain a gate rejection. */
  boundary: {
    danglingUnresolved: boolean
    endedOnCompleteThought: boolean
    tooShort: boolean
  } | null
  /** Gate verdict. Present even when refinement failed, with the reason that actually stopped it. */
  gate: { passed: boolean; reasons: string[]; warnings: string[] }
  /** Title of the kept clip this candidate duplicated, when `outcome` is "duplicate". */
  duplicateOf: string | null
  /** Rank in the final output, when kept. Null otherwise. */
  finalRank: number | null
  /**
   * Exact transcript text between startMs and endMs — the words the exported clip will actually
   * contain. This is the field that answers "what does this clip say?", which the kept-clips
   * table cannot, because a user trim rewrites startMs/endMs in place.
   */
  text: string | null
  /**
   * What the judge's `bestOpeningSentence` proposed, and what was done about it (#100). Present for
   * every clip that reached the opening step — including when nothing was proposed, so the report
   * can say "no better opening" rather than leaving the question open. Null only when the clip was
   * rejected before that step.
   */
  opening: OpeningRetry | null
}

/**
 * The record of one attempt to move a clip's opening sentence (#100).
 *
 * Both scores are kept, never just the winner's: the point of the step is to show that the judge's
 * proposal was measured rather than trusted, and a report that only printed the adopted score could
 * not tell a reviewer whether moving the opening helped.
 */
export interface OpeningRetry {
  /** The clip's start before any retry. */
  originalStartMs: number
  originalStartTimecode: string
  /** Sentence the judge proposed as the strongest opening, or null when it proposed none. */
  suggestedSentence: number | null
  /** Score of the original cut. */
  originalScore: number
  /** The re-judged cut's start. Null when no alternative was ever built. */
  retryStartMs: number | null
  retryStartTimecode: string | null
  /** Score of the re-judged cut. Null when no call was made, or it failed. */
  retryScore: number | null
  /** True when the re-judged cut replaced the original. */
  adopted: boolean
  /** Why the step ended the way it did, in one clause. The report's human-readable explanation. */
  note: string
}

/** Chunk layout for the run. Decides which sentences the model ever saw. */
export interface TraceChunk {
  index: number
  firstSentence: number
  lastSentence: number
  /** Candidates the model returned for this chunk, before interleaving. */
  candidateCount: number
  /**
   * Candidates the model returned that we discarded to hold the chunk to its own cap
   * (`maxCandidatesFor`). Zero on every run that stayed under the cap.
   *
   * This is a runaway guard, not a recall ceiling: the cap scales with the chunk so it does not fire
   * on dense but legitimate content, and the model orders best-first, so what is dropped is its
   * *worst* candidates. It used to be a flat 20 enforced by the response schema — a chunk returning
   * 21 candidates failed validation, retried at temperature 0 (same answer), and lost every
   * candidate including the good ones. Hence a schema-level cap is not the place to enforce a
   * budget. Reported so a run that hit the ceiling is visible rather than quietly smaller.
   */
  candidatesDropped: number
  /**
   * The chunk's model call failed even after the client's retries, so this chunk contributed
   * nothing — as opposed to a chunk the model answered with no candidates.
   *
   * Without this the two are the same `candidateCount: 0`, and a run where every chunk failed
   * (bad key, rate limit, dropped connection, misspelled CLIP_MODEL) becomes indistinguishable
   * from a run where the model simply had nothing to offer. That distinction is what stops a
   * failed run from being treated as a successful empty one.
   */
  failed: boolean
  /** Why it failed. Present only when `failed`. */
  error?: string
  /**
   * True when this chunk's section was eventually analysed after a rough start: either the chunk
   * answered on a later fresh attempt (`failed: false`), or it was a chunk that failed and was then
   * split (`failed: true`, `bisected: true`).
   */
  recovered?: boolean
  /**
   * Present with `failed: true` on a chunk whose model calls all failed but which was then split in
   * two and analysed as two halves — the halves are separate entries carrying `splitOf` pointing
   * back here. The parent contributes no candidates of its own.
   */
  bisected?: boolean
  /**
   * Present on the halves of a bisected chunk: the index of the `bisected` entry they came from.
   * A reader sees "chunk 2 failed → 2a/2b" as a single story instead of two unexplained rows.
   */
  splitOf?: number
  /**
   * Why the chunk's own call(s) failed, from the client's failure recorder. Present on every entry
   * whose call failed at least once (so also on a chunk that later recovered), and it carries only
   * what the SDK actually reported — nothing is inferred.
   */
  failure?: ChunkFailure
}

export interface ClipSelectionTrace {
  temperature: number
  sentenceCount: number
  chunks: TraceChunk[]
  /** One entry per candidate returned, in generation order (chunk, then the model's own order). */
  candidates: TraceEntry[]
  /** The judge's question table for this run, so the report is self-describing. */
  judgeQuestions: JudgeQuestion[]
  /**
   * Total judge calls this run, opening-retry samples included (#125). The single-call equivalent
   * is the count of judged clips, so the ratio here is the vote's real cost multiplier — the number
   * to watch before shipping the vote, and the reason it must be measured rather than assumed.
   */
  judgeCallCount: number
}

/**
 * The model picks sentence indices, never milliseconds (C1). A hallucinated timestamp is
 * structurally impossible: every ms in the output is derived from our own word table.
 *
 * Exported so `scripts/recall-ablation.ts` validates against the same shape the pipeline does.
 * A private copy there once required a `strong` field this schema dropped in v3, so the script
 * was parsing answers into a type the pipeline no longer produced (#91).
 */
export const CandidateSchema = zod.object({
  startSentence: zod.number().int().min(0),
  endSentence: zod.number().int().min(0),
  title: zod.string(),
  reason: zod.string(),
  platform: zod.enum(["tiktok", "reels", "shorts", "generic"]),
})

type Candidate = zod.infer<typeof CandidateSchema>

/**
 * The system half of every clip-selection call, exported because a tool that claims to mirror the
 * pipeline must import this rather than paste it (#91). `buildChunkPrompts` is what actually
 * assembles what the model reads — this is only the base it appends the profile rubric to.
 */
export const SYSTEM_PROMPT = `You are a short-form video editor selecting clips from a long transcript.

The transcript is given as numbered sentences with optional signal tags in {braces}:
#12 [10500-14200] {fast} Nobody expected this outcome.
#13 [14200-16000] So then everything changed.

Signal tags — use as extra evidence, not hard rules:
  {fast}        — speech rate significantly above speaker's rolling baseline (excitement)
  {slow}        — speech rate below baseline (deliberate emphasis or emotional weight)
  {loud}        — audio energy significantly above speaker's rolling baseline (emotional peak)
  {burst}       — sentence follows a notable silence (>800ms gap) — strong clip start point
  {filler:high} — >15% filler words (um/uh/like/basically…) — weaker content

Return clips as SENTENCE INDEX RANGES. Never write a timestamp — the numbers in brackets are for
your reference only, and any time value you output is discarded.

WHAT MAKES A CLIP WORTH POSTING — look for these, in rough order of value:
1. Hook — the opening line creates curiosity, tension, or a promise in one sentence
2. Emotional peak — anger, excitement, vulnerability, genuine laughter
3. Opinion bomb — a strong, specific, contestable claim the speaker commits to
4. Revelation — a surprising fact, number, or reversal of expectation
5. Conflict — disagreement, pushback, a challenged assumption
6. Quotable line — compressed, repeatable, survives without context
7. Story peak — a complete beat with setup, turn, and payoff
8. Practical value — one actionable idea a viewer could use today

A clip MUST be self-contained. Someone who never saw the source video should understand it.
Prefer a range that starts where a thought starts and ends where it resolves.

RECALL: list every plausible clip in this chunk, best first. A later step judges each clip strictly
on its exact text, so do not self-censor — but do not pad with clips you can see are weak either.
Do not assign numeric scores.

Return JSON with a "clips" array. Each item: startSentence, endSentence, title, reason,
platform ("tiktok" | "reels" | "shorts" | "generic").`

// Only chunk long-form content; short videos go to the LLM in one call.
const CHUNK_THRESHOLD_MS = 30 * 60 * 1000
const CHUNK_SIZE_MS = 20 * 60 * 1000
const CHUNK_OVERLAP_MS = 150 * 1000

/**
 * C5: topic-coherent chunking. Groups topic segments from B2 into context-sized calls so
 * no candidate sits in the "lost-in-the-middle" dead zone of a long context window.
 *
 * Falls back to fixed-time chunking when segmentation returned only one segment (either the
 * content was too uniform or the ONNX model was unavailable).
 */
function topicsToChunks(sentences: Sentence[], topics: TopicSegment[]): Sentence[][] {
  if (sentences.length === 0) return []
  const totalMs = sentences[sentences.length - 1]!.endMs - sentences[0]!.startMs
  if (totalMs <= CHUNK_THRESHOLD_MS) return [sentences]

  if (topics.length <= 1) return fixedChunks(sentences)

  const chunks: Sentence[][] = []
  let current: Sentence[] = []
  let currentMs = 0

  for (const seg of topics) {
    const segMs = seg.endMs - seg.startMs
    if (current.length > 0 && currentMs + segMs > CHUNK_SIZE_MS) {
      chunks.push(current)
      // Carry the tail of the just-closed chunk into the next one — otherwise a clip whose
      // sentences straddle this topic-segment boundary is invisible to both LLM calls. The
      // fixed-time fallback already does this; topic chunking silently didn't.
      current = [...trailingOverlap(current, CHUNK_OVERLAP_MS), ...seg.sentences]
      currentMs = current[current.length - 1]!.endMs - current[0]!.startMs
    } else {
      current.push(...seg.sentences)
      currentMs += segMs
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Trailing sentences within `overlapMs` of a chunk's end, for carrying into the next chunk. */
function trailingOverlap(chunk: Sentence[], overlapMs: number): Sentence[] {
  if (chunk.length === 0) return []
  const chunkEndMs = chunk[chunk.length - 1]!.endMs
  let start = chunk.length - 1
  while (start > 0 && chunkEndMs - chunk[start - 1]!.startMs <= overlapMs) start--
  return chunk.slice(start)
}

/** Fallback for when topic segmentation found no boundaries (uniform content or model unavailable). */
function fixedChunks(sentences: Sentence[]): Sentence[][] {
  const chunks: Sentence[][] = []
  let cursor = 0
  while (cursor < sentences.length) {
    const chunkStartMs = sentences[cursor]!.startMs
    let end = cursor
    while (end < sentences.length && sentences[end]!.endMs - chunkStartMs <= CHUNK_SIZE_MS) end++
    chunks.push(sentences.slice(cursor, Math.max(end, cursor + 1)))
    if (end >= sentences.length) break

    const nextStartMs = sentences[end]!.startMs - CHUNK_OVERLAP_MS
    let next = end
    while (next > cursor + 1 && sentences[next - 1]!.startMs >= nextStartMs) next--
    cursor = Math.max(next, cursor + 1)
  }
  return chunks
}

function overlapRatio(a: ClipSuggestion, b: ClipSuggestion): number {
  const start = Math.max(a.startMs, b.startMs)
  const end = Math.min(a.endMs, b.endMs)
  if (end <= start) return 0
  return (end - start) / Math.min(a.endMs - a.startMs, b.endMs - b.startMs)
}

/** mm:ss for report output. Clips are bounded by MAX_CLIP_MS (90s) so hours never appear. */
function toTimecode(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${String(sec).padStart(2, "0")}`
}

// ─── Concurrency ─────────────────────────────────────────────────────────────

/** Chunk-generation and judge calls in flight at once. Speed only — not part of the fingerprint. */
const CHUNK_CONCURRENCY = 3
const JUDGE_CONCURRENCY = 3
/**
 * How many fresh attempts a chunk gets when its call fails (the client's own structured-output
 * retries are already exhausted by then). Each attempt makes a new call, so a provider blip that
 * clears within a backoff window never costs the chunk its candidates.
 *
 * The waits are 2s, 6s, 18s — honest exponential backoff that stays under the 20s rate-limit cap
 * (`RATE_LIMIT_POLICY.maxWaitMs`) shared with `withRateLimitRetry`. Rate-limit responses are not
 * retried here: `withRateLimitRetry` already owns those, at a 1s/2s/4s cadence honouring
 * `retry-after`.
 */
const CHUNK_RETRY_ATTEMPTS = 3
const CHUNK_RETRY_BASE_MS = 2_000
/**
 * Share of judge calls that may fail before the run is treated as failed. A run where most judge
 * calls died has not judged the clips it returns; keeping its few survivors and replacing the
 * user's previous suggestions with them would be worse than failing.
 */
const MAX_JUDGE_FAILURE_RATIO = 0.5
/**
 * Overlap above which a refined candidate is dropped as a seam duplicate BEFORE judging. Chunks
 * overlap by 150s, so the same moment arrives twice with near-identical bounds; judging both just
 * spends calls. Looser overlaps are still deduped after scoring, where the better one is kept.
 */
const PRE_JUDGE_DUPLICATE_OVERLAP = 0.9

/**
 * Runaway guard on candidates per chunk — NOT a recall limiter.
 *
 * The prompt asks the model to "list every plausible clip" and the system prompt says not to
 * self-censor, so whatever it proposes is a moment we asked for. The old fixed ceiling of 20 then
 * silently sliced that tail off — throwing away the very recall the prompt was built to collect.
 * A dense 20-minute chunk routinely proposes ~30, so the cap fired on real content, not on runaway
 * output, and gate 5 ("candidates dropped over the per-chunk cap") started failing on long videos.
 *
 * So the ceiling scales with the chunk's own length — a longer section can legitimately hold more
 * moments — with a floor so a short section is not starved and a ceiling so a model listing
 * hundreds of near-duplicates cannot blow up the judge budget. A full 20-minute chunk
 * (`CHUNK_SIZE_MS` the chunking target) allows 40; the ceiling only bites above ~25 minutes.
 */
const CANDIDATE_CAP_FLOOR = 20
// Exported so tests can assert against the real ceiling instead of duplicating/hardcoding it.
export const CANDIDATE_CAP_CEIL = 50
const CANDIDATE_CAP_PER_MINUTE = 2

/** Candidates one chunk may keep. See the cap policy above; floors/ceilings keep it well-defined. */
function maxCandidatesFor(chunk: Sentence[]): number {
  const first = chunk[0]
  const last = chunk[chunk.length - 1]
  if (!first || !last) return CANDIDATE_CAP_FLOOR
  const minutes = (last.endMs - first.startMs) / 60_000
  const scaled = Math.ceil(minutes * CANDIDATE_CAP_PER_MINUTE)
  return Math.min(CANDIDATE_CAP_CEIL, Math.max(CANDIDATE_CAP_FLOOR, scaled))
}
/** Default clip count per video. Overridable per call, so the effective value is hashed per run. */
const DEFAULT_MAX_CLIPS = 10

const FILLER_SET = new Set([
  "um",
  "uh",
  "uhm",
  "hmm",
  "like",
  "basically",
  "literally",
  "actually",
  "right",
  "so",
  "yeah",
])
const WPS_WINDOW = 5

// Signal-tag thresholds. Named rather than inlined so the pipeline fingerprint can cover them —
// they steer the prompt as much as any wording does, and an unnamed `> baseline + 3` is untunable.
const WPS_FAST_RATIO = 1.3
const WPS_SLOW_RATIO = 0.7
/** Raw RMS delta above the rolling mean, NOT decibels — measureArousal emits linear amplitude. */
const LOUD_RMS_DELTA = 3
const BURST_GAP_MS = 800
const FILLER_DENSITY_RATIO = 0.15
/** Overlap fraction above which a lower-ranked candidate is dropped as a duplicate. */
const DEDUPE_OVERLAP_RATIO = 0.5

function buildAnnotatedPrompt(
  chunk: Sentence[],
  words: Word[],
  arousalPerSec: number[] = [],
): string {
  const wpsHistory: number[] = []
  const rmsHistory: number[] = []
  let prevEndMs = chunk[0]?.startMs ?? 0

  return chunk
    .map((s) => {
      const wordCount = s.lastWordIndex - s.firstWordIndex + 1
      const durSec = Math.max((s.endMs - s.startMs) / 1000, 0.1)
      const wps = wordCount / durSec
      const wpsBaseline =
        wpsHistory.length > 0 ? wpsHistory.reduce((a, b) => a + b, 0) / wpsHistory.length : wps
      wpsHistory.push(wps)
      if (wpsHistory.length > WPS_WINDOW) wpsHistory.shift()

      const sentWords = words.slice(s.firstWordIndex, s.lastWordIndex + 1)
      const fillerCount = sentWords.filter((w) =>
        FILLER_SET.has(w.text.toLowerCase().replace(/[.,!?]+$/, "")),
      ).length

      // B4: loud tag from per-second audio RMS
      let loudTag = ""
      if (arousalPerSec.length > 0) {
        const startSec = Math.floor(s.startMs / 1000)
        const endSec = Math.max(startSec + 1, Math.ceil(s.endMs / 1000))
        const sentRms = arousalPerSec.slice(startSec, endSec)
        if (sentRms.length > 0) {
          const meanRms = sentRms.reduce((a, b) => a + b, 0) / sentRms.length
          const rmsBaseline =
            rmsHistory.length > 0
              ? rmsHistory.reduce((a, b) => a + b, 0) / rmsHistory.length
              : meanRms
          rmsHistory.push(meanRms)
          if (rmsHistory.length > WPS_WINDOW) rmsHistory.shift()
          if (meanRms > rmsBaseline + LOUD_RMS_DELTA) loudTag = "loud"
        }
      }

      // B6: burst tag — sentence follows a notable silence (>800ms gap)
      const gapMs = s.startMs - prevEndMs
      const burstTag = gapMs > BURST_GAP_MS ? "burst" : ""
      prevEndMs = s.endMs

      const tags = [
        wps > wpsBaseline * WPS_FAST_RATIO ? "fast" : "",
        wps < wpsBaseline * WPS_SLOW_RATIO ? "slow" : "",
        loudTag,
        burstTag,
        wordCount > 0 && fillerCount / wordCount > FILLER_DENSITY_RATIO ? "filler:high" : "",
      ].filter(Boolean)

      const tagStr = tags.length > 0 ? ` {${tags.join(",")}}` : ""
      return `#${s.index} [${s.startMs}-${s.endMs}]${tagStr} ${s.text}`
    })
    .join("\n")
}

const USER_PROMPT_TEMPLATE = `{{CONTEXT}}

Sentences #{{FIRST}} to #{{LAST}}.

{{TRANSCRIPT}}

List every plausible clip, best first. Each clip should span roughly {{MIN_SEC}}–{{MAX_SEC}} seconds of transcript time.
Only use sentence indices between {{FIRST}} and {{LAST}}.
Return an empty array if nothing in this section is a plausible clip.`

// {{TRANSCRIPT}} goes in LAST, and via a function replacement. Three reasons, all load-bearing:
//
// 1. Order. Substituting the transcript before the other placeholders means transcript text that
//    happens to contain "{{MIN_SEC}}" gets substituted again, corrupting spoken words.
// 2. `$` handling. In a string replacement `$$` collapses to `$` and `$'` inserts the remainder of
//    the template. A transcript containing "$$1M" or a dollar-quote came out garbled — `$$1M`
//    became `$1M`, and `$'` spliced the rest of the prompt into the middle of the sentence. A
//    function replacement treats its argument as literal text and skips all of that.
//
// 3. {{CONTEXT}} is also a function replacement, for reasons 1 and 2 again. It carries
//    model-authored text — the summary and topic strings — so the same corruption applies, and a
//    summary containing the literal "{{TRANSCRIPT}}" would otherwise swallow the whole transcript.
//
// Both function replacements treat their argument as opaque, so neither substituted value is ever
// re-scanned for placeholders.
function renderUserPrompt(
  chunk: Sentence[],
  words: Word[],
  arousalPerSec: number[],
  contextBlock: string,
): string {
  return USER_PROMPT_TEMPLATE.replaceAll("{{FIRST}}", String(chunk[0]!.index))
    .replaceAll("{{LAST}}", String(chunk[chunk.length - 1]!.index))
    .replaceAll("{{MIN_SEC}}", String(MIN_CLIP_MS / 1000))
    .replaceAll("{{MAX_SEC}}", String(MAX_CLIP_MS / 1000))
    .replace("{{CONTEXT}}", () => contextBlock)
    .replace("{{TRANSCRIPT}}", () => buildAnnotatedPrompt(chunk, words, arousalPerSec))
}

// ─── The prompt, as an exported pair (#91) ───────────────────────────────────

/**
 * Everything `selectClips` decides *before* any chunk is rendered: which profile is in effect and
 * the context block every chunk of the run shares.
 *
 * Extracted so `scripts/recall-ablation.ts` resolves the same three values the pipeline resolves
 * instead of re-deriving them and drifting. Callers pass the analysis they intend to use — the
 * pipeline passes the one `analyzeVideo` just returned, the ablation script passes the one stored
 * for the run it is measuring, which is the same object by construction.
 */
export function resolveSelectionContext(
  analysis: VideoAnalysis,
  profileOverride: ClipProfileId | null,
): { profileId: ClipProfileId; profile: ClipProfile; contextBlock: string } {
  const profileId = profileOverride ?? analysis.profile
  // Rendered once, not per chunk: it is a pure function of the analysis and the effective profile,
  // so every chunk of a run necessarily carries the identical block.
  const contextBlock = renderVideoContext(analysis, {
    profileId: analysis.profile,
    override: profileOverride,
  })
  return { profileId, profile: CLIP_PROFILES[profileId], contextBlock }
}

/**
 * The exact system + user strings one selection call sends.
 *
 * This is the single definition of "the pipeline prompt". `selectFromChunk` builds its request
 * from it, and `scripts/recall-ablation.ts` builds its unchunked whole-transcript request from it,
 * so the two can only disagree on the *inputs* (which sentences, which analysis, whether arousal
 * was measured) and never on the wording — which is precisely the failure #91 existed to fix.
 *
 * `arousalPerSec` defaults to `[]`, the same value the pipeline falls back to when ffmpeg fails:
 * no `{loud}` tags rather than a differently-worded prompt.
 */
export function buildChunkPrompts(args: {
  chunk: Sentence[]
  words: Word[]
  profile: ClipProfile
  contextBlock: string
  arousalPerSec?: number[]
}): { system: string; prompt: string } {
  const { chunk, words, profile, contextBlock } = args
  const arousalPerSec = args.arousalPerSec ?? []
  return {
    // #98 — the profile's rubric, appended to the base system prompt. This is the swap the regex
    // detector used to perform; what changed is that the profile now comes from the model's own
    // reading of the video instead of a keyword match.
    system: SYSTEM_PROMPT + profile.rubric,
    prompt: renderUserPrompt(chunk, words, arousalPerSec, contextBlock),
  }
}

// ─── Pipeline fingerprint (#89) ─────────────────────────────────────────────

/**
 * Human-readable label for the clip-selection *code*. Bump by hand when a change alters output
 * without touching any constant in the fingerprint — a logic edit in `refineClipBoundaries` or
 * the boundary or gate logic is invisible to the hash by construction.
 *
 * v2 — the genre-profile pipeline (#98) replaced the regex content-type detector. The hash moved
 * on its own because the rubric swap is hashed; the version moves because what a profile *is* was
 * redefined, which no constant in the fingerprint can see.
 *
 * v3 — generation is for recall; every refined clip is judged on its exact text and ranked across
 * all chunks (#99). The per-chunk `strong` flag, the title-only Borda re-rank, round-robin
 * interleaving and the hook-first trim are gone.
 *
 * v4 — the judge's `bestOpeningSentence` chooses the opening sentence (#100). `HOOK_RE` is deleted,
 * along with the `{hook}` prompt tag and the regex "weak opening" warning it fed: a tag that fires
 * on most ordinary sentences tells the model nothing. The version moves because what decides a clip
 * start changed, from a regex to a model — which no constant in the fingerprint can see, though the
 * hash does move on its own via `judgeSystem`.
 *
 * v5 — every judged clip is sampled up to `JUDGE_SAMPLES` times and voted (#125): per-question
 * median grade, mean score. A single sampled hard "no" no longer rejects a clip. The version moves
 * because the *decision rule* changed from one call to a majority, which no rubric constant shows;
 * the count and thresholds are also hashed below.
 */
export const PIPELINE_VERSION = "v5-voted-judge"

/**
 * sha256 over every prompt template and heuristic threshold the clip-selection path reads, so a
 * stored clip can be traced to the exact configuration that produced it.
 *
 * Coverage is deliberately broad, and the boundary constants matter most: `LEAD_IN_MS`, `TAIL_MS`,
 * `END_SEARCH_MS` and friends decide the exact startMs/endMs that #89 stores as a clip's original
 * boundaries. If tuning one of them moved stored boundary-error numbers while the hash stayed
 * identical, the metric would be unattributable — which is the one thing this column exists to
 * prevent.
 *
 * Three things are deliberately NOT folded in:
 * - `PIPELINE_VERSION`. The two answer different questions: the hash says "what config was this?",
 *   the version says "what code was this?". Folding the version in would make every manual bump
 *   look like a configuration change.
 * - The model. It is recorded per-run on the clip row, because the same fingerprint is
 *   legitimately paired with different models and comparing those is the point of storing it.
 * - `lookingFor` and `defaultLengthMs` from the profile table (#98). Neither reaches a prompt:
 *   `defaultLengthMs` is held at the global 15–90s. Hashing a value nothing sends would make "it is
 *   in the hash" a claim this function could not honestly make. `judgeQuestions` IS hashed now —
 *   the judge sends them.
 * - Concurrency limits and rate-limit waits. They change speed, never what the model reads.
 *
 * Known remaining gap: a behavioural change in code that reads none of these constants — a logic
 * edit inside `refineClipBoundaries`. That is what `PIPELINE_VERSION` is for.
 * The zod candidate schema is not hashed either: it is sent to the SDK, not to the model as text,
 * so in `json_object` mode a schema edit does not change the prompt.
 *
 * `maxClips` is a per-call argument rather than a constant, so the fingerprint is computed from
 * the effective value. Hashing a package-level default would silently mislabel any caller that
 * overrode it.
 *
 * `temperature` is likewise a parameter, defaulting to the constant the client actually sends.
 * It has to be a parameter rather than an inlined read of the constant purely so a test can prove
 * the digest moves when the temperature does — an unhashed temperature is the bug this closes,
 * and "it is in the hash" is only a meaningful claim if that is checked. `profiles` follows the
 * same rule for the same reason: a rubric the hash does not cover is the exact defect #98's
 * predecessor had, so there has to be a way to prove each rubric is covered.
 */
export function computePipelineFingerprint(
  maxClips: number,
  temperature: number = CLIP_SELECTION_TEMPERATURE,
  profiles: Record<ClipProfileId, ClipProfile> = CLIP_PROFILES,
): string {
  return createHash("sha256")
    .update(
      [
        `system:${SYSTEM_PROMPT}`,
        // #98: the analysis call and the context block it feeds. Both decide what the model reads
        // before it ever sees a sentence, so both belong in the configuration this hash names.
        `analysisSystem:${ANALYSIS_PROMPT}`,
        `analysisContextTemplate:${VIDEO_CONTEXT_TEMPLATE}`,
        `analysisContextSample:${videoContextSample()}`,
        ...analysisInputFingerprintFields(),
        // Every rubric, not just the one the last run used. The rubric is chosen per video, so a
        // hash covering only the effective profile would let two runs with different rubrics
        // collide — and "which rubric produced this clip" is the question the profile replaced the
        // regex to answer. Sorted by id so the record's insertion order cannot move the digest.
        ...CLIP_PROFILE_IDS.slice()
          .sort()
          .map((id) => `rubric:${id}=${profiles[id].rubric}`),
        `user:${USER_PROMPT_TEMPLATE}`,
        `structuredSuffix:${STRUCTURED_OUTPUT_SUFFIX}`,
        // #99 — the judge: what it is told, the questions it answers, and how answers become a
        // score. All of it decides which clips win, so all of it names the configuration.
        `judgeSystem:${JUDGE_SYSTEM_PROMPT}`,
        `judgeUser:${JUDGE_USER_TEMPLATE}`,
        `judgeBeforeSentences:${JUDGE_BEFORE_SENTENCES}`,
        `judgeGrades:${JSON.stringify(GRADE_VALUE)}`,
        ...UNIVERSAL_JUDGE_QUESTIONS.map(
          (q) => `judgeQ:${q.id}|w=${q.weight}|hard=${q.hard}|${q.text}`,
        ),
        `judgeProfileQuestionWeight:${PROFILE_QUESTION_WEIGHT}`,
        // #125 — how many samples a clip gets, when the first is treated as clearly dead, and how
        // the samples combine. All three change which clips are kept, so all three name the config.
        `judgeSamples:${JUDGE_SAMPLES}`,
        `judgeDeadScore:${JUDGE_DEAD_SCORE}`,
        `judgeAggregation:median-grade-mean-score`,
        // Every profile's questions, not just the effective one — same reasoning as the rubrics.
        ...CLIP_PROFILE_IDS.slice()
          .sort()
          .map((id) => `judgeProfileQ:${id}=${JSON.stringify(profiles[id].judgeQuestions)}`),
        `maxJudgeFailureRatio:${MAX_JUDGE_FAILURE_RATIO}`,
        `preJudgeDuplicateOverlap:${PRE_JUDGE_DUPLICATE_OVERLAP}`,
        // #100 — the judge prompt is already hashed above as `judgeSystem`, which is where the
        // opening-sentence instruction now lives, so the retry needs no entry of its own. What did
        // change is that HOOK_RE no longer exists: `hookRe` and `hookFirstMaxTrim` are gone from the
        // hash because nothing reads them.
        // Sorted: FILLER_SET is a Set, and its iteration order is not a stable thing to hash.
        `filler:${[...FILLER_SET].sort().join(",")}`,
        `danglingOpeners:${[...DANGLING_OPENERS].sort().join(",")}`,
        // Boundary refinement — these set the stored original_start_ms/original_end_ms.
        `leadInMs:${LEAD_IN_MS}`,
        `tailMs:${TAIL_MS}`,
        `endSearchMs:${END_SEARCH_MS}`,
        `completeThoughtPauseMs:${COMPLETE_THOUGHT_PAUSE_MS}`,
        `maxBackwardSentences:${MAX_BACKWARD_SENTENCES}`,
        // Chunking — decides which sentences the model ever sees on long videos.
        `chunkThresholdMs:${CHUNK_THRESHOLD_MS}`,
        `chunkSizeMs:${CHUNK_SIZE_MS}`,
        `chunkOverlapMs:${CHUNK_OVERLAP_MS}`,
        // Signal tags.
        `wpsWindow:${WPS_WINDOW}`,
        `wpsFast:${WPS_FAST_RATIO}`,
        `wpsSlow:${WPS_SLOW_RATIO}`,
        `loudRmsDelta:${LOUD_RMS_DELTA}`,
        `burstGapMs:${BURST_GAP_MS}`,
        `fillerDensity:${FILLER_DENSITY_RATIO}`,
        // Gates and selection shape.
        `minClipMs:${MIN_CLIP_MS}`,
        `maxClipMs:${MAX_CLIP_MS}`,
        `dedupeOverlap:${DEDUPE_OVERLAP_RATIO}`,
        `candidateCapFloor:${CANDIDATE_CAP_FLOOR}`,
        `candidateCapCeil:${CANDIDATE_CAP_CEIL}`,
        `candidateCapPerMinute:${CANDIDATE_CAP_PER_MINUTE}`,
        `maxClips:${maxClips}`,
        // Temperature (#97/#90). Left out, two runs differing only in temperature would share a
        // hash — and the hash is the thing that makes a stored clip's behaviour attributable.
        `temperature:${temperature}`,
        // NUL separator: it cannot occur in any prompt, regex source or word list above, so no
        // field boundary can be forged by content. (Escaped, not a raw byte — a literal NUL in
        // source makes the file binary to grep and friends.)
      ].join("\n\u0000"),
    )
    .digest("hex")
}

/** Fingerprint for a run using the default clip budget. See computePipelineFingerprint. */
export const PIPELINE_FINGERPRINT = computePipelineFingerprint(DEFAULT_MAX_CLIPS)

async function selectFromChunk(
  client: AiClient,
  chunk: Sentence[],
  words: Word[],
  profile: ClipProfile,
  contextBlock: string,
  arousalPerSec: number[] = [],
): Promise<{ candidates: Candidate[]; dropped: number }> {
  // No `.max()` on the array. The cap is a budget we impose on ourselves after the fact, and
  // enforcing it here made a dense chunk fail validation — then fail its retries at temperature 0
  // with the same oversized answer — and lose every candidate it had, good ones included. The prompt
  // asks for every plausible clip, so this is a runaway guard sized to the chunk, not a recall
  // limiter (see the cap policy); it costs one `slice`.
  const schema = zod.object({ clips: zod.array(CandidateSchema) })
  const firstIndex = chunk[0]!.index
  const lastIndex = chunk[chunk.length - 1]!.index
  const { prompt, system } = buildChunkPrompts({
    chunk,
    words,
    profile,
    contextBlock,
    arousalPerSec,
  })

  const result = await client.generateObject({
    prompt,
    schema: schema as unknown as z.ZodType<{ clips: Candidate[] }>,
    system,
  })
  // Out-of-chunk ranges are malformed rather than surplus, so they go first: a model that invented
  // a sentence index should not also spend our budget.
  const inRange = result.clips.filter(
    (c) => c.startSentence >= firstIndex && c.endSentence <= lastIndex,
  )
  // Reversed ranges (`start: 900, end: 100`) pass the filter above, and `refineClipBoundaries` swaps
  // them rather than discarding them — a recoverable slip, not a broken one. So they are kept, but
  // they must not be allowed to spend the budget: reversed candidates filling every slot would push
  // out every well-formed one, which is the exact failure the cap was meant to prevent. Well-formed
  // candidates are laid down first, so a reversed range can only use a slot no real candidate
  // wanted, and the model's own best-first order still decides the winners.
  const wellFormed = inRange.filter((c) => c.startSentence <= c.endSentence)
  const reversed = inRange.filter((c) => c.startSentence > c.endSentence)
  const ordered = [...wellFormed, ...reversed]
  const candidates = ordered.slice(0, maxCandidatesFor(chunk))
  return { candidates, dropped: ordered.length - candidates.length }
}

/**
 * How one chunk turned out, before it is assigned a trace index. The tree shape exists because a
 * failed chunk may be split in two and each half analysed separately, and the report needs to tell
 * a plain failure from a failure that was recovered — both of which the halves themselves encode.
 * Each node carries its own sentence span, so a half reports its half rather than its parent's.
 */
type ChunkNode =
  | {
      kind: "answered"
      firstSentence: number
      lastSentence: number
      candidates: Candidate[]
      dropped: number
      /** How many fresh attempts this chunk needed to get an answer (1 on a clean run). */
      attempts: number
      /** Failure of the last failed attempt that preceded this answer, when there was one. */
      failure?: ChunkFailure
    }
  | {
      kind: "failed"
      firstSentence: number
      lastSentence: number
      error: string
      failure?: ChunkFailure
    }
  | {
      kind: "bisect"
      firstSentence: number
      lastSentence: number
      error: string
      failure?: ChunkFailure
      left: ChunkNode
      right: ChunkNode
    }

/** True when a chunk's whole tree failed — after a split, that means both halves failed. */
function treeFailed(node: ChunkNode): boolean {
  if (node.kind === "answered") return false
  if (node.kind === "failed") return true
  return treeFailed(node.left) && treeFailed(node.right)
}

async function runChunkNode(
  client: AiClient,
  chunk: Sentence[],
  words: Word[],
  profile: ClipProfile,
  contextBlock: string,
  arousalPerSec: number[],
  sleep: Sleep,
  depth: number,
): Promise<ChunkNode> {
  const firstSentence = chunk[0]!.index
  const lastSentence = chunk[chunk.length - 1]!.index
  // A top-level chunk earns the full retry budget; a half produced by a split gets a single attempt.
  // The halves are already the recovery path — giving each one three more tries would turn the
  // worst case into nine calls (3 + 3 + 3) for one bad section, which is exactly the amplification
  // the one-level bisection exists to avoid. Worst case stays 3 + 1 + 1 = 5.
  const maxAttempts = depth === 0 ? CHUNK_RETRY_ATTEMPTS : 1
  let lastError: unknown
  let lastFailure: ChunkFailure | undefined
  let rateLimited = false
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { candidates, dropped } = await withRateLimitRetry(
        () => selectFromChunk(client, chunk, words, profile, contextBlock, arousalPerSec),
        sleep,
      )
      // Recovered mid-way: the earlier failures are still worth recording so the report can say an
      // answer arrived on the Nth try, not that the call was clean.
      return {
        kind: "answered",
        firstSentence,
        lastSentence,
        candidates,
        dropped,
        attempts: attempt,
        ...(lastFailure ? { failure: lastFailure } : {}),
      }
    } catch (err) {
      lastError = err
      lastFailure = readChunkFailure(err) ?? undefined
      console.warn(
        `[clip-selector] chunk #${firstSentence}-#${lastSentence} attempt ${attempt}/${maxAttempts} failed:`,
        err,
      )
      // `withRateLimitRetry` has already spent its own 1s/2s/4s(+retry-after) budget on a 429;
      // retrying here or splitting the chunk would only pile more calls onto a throttled key.
      if (isRateLimitError(err)) {
        rateLimited = true
        break
      }
      if (attempt < maxAttempts) await sleep(CHUNK_RETRY_BASE_MS * 3 ** (attempt - 1))
    }
  }
  const error = lastError instanceof Error ? lastError.message : String(lastError)
  // A one-sentence chunk cannot be split further, halves never split again (`depth > 0`), and a
  // rate-limited chunk is a throttling problem rather than a section the model could not read.
  if (depth === 0 && chunk.length > 1 && !rateLimited) {
    const mid = Math.ceil(chunk.length / 2)
    const left = await runChunkNode(
      client,
      chunk.slice(0, mid),
      words,
      profile,
      contextBlock,
      arousalPerSec,
      sleep,
      depth + 1,
    )
    const right = await runChunkNode(
      client,
      chunk.slice(mid),
      words,
      profile,
      contextBlock,
      arousalPerSec,
      sleep,
      depth + 1,
    )
    console.warn(
      `[clip-selector] chunk #${firstSentence}-#${lastSentence} split in two after all ${maxAttempts} attempts`,
    )
    return {
      kind: "bisect",
      firstSentence,
      lastSentence,
      error,
      ...(lastFailure ? { failure: lastFailure } : {}),
      left,
      right,
    }
  }
  return {
    kind: "failed",
    firstSentence,
    lastSentence,
    error,
    ...(lastFailure ? { failure: lastFailure } : {}),
  }
}

/**
 * Unpicks one chunk's node tree into `trace.chunks` and `perChunk`, assigning positional indexes as
 * it goes so `TraceEntry.chunk` stays an index into `trace.chunks`. DFS order — parent, then its
 * two halves — keeps a bisect's story together. `parentIndex` is set only on the halves of a split.
 */
function flattenChunkNode(
  node: ChunkNode,
  traceChunks: TraceChunk[],
  perChunk: Candidate[][],
  parentIndex?: number,
): void {
  const index = traceChunks.length
  const base = { index, firstSentence: node.firstSentence, lastSentence: node.lastSentence }
  switch (node.kind) {
    case "answered":
      perChunk.push(node.candidates)
      traceChunks.push({
        ...base,
        candidateCount: node.candidates.length,
        candidatesDropped: node.dropped,
        failed: false,
        // True when this slot's candidates came from a fresh retry or from a split of a failed
        // chunk — the two recovery paths the report must distinguish from a clean answer.
        recovered: parentIndex !== undefined || node.attempts > 1,
        ...(parentIndex !== undefined ? { splitOf: parentIndex } : {}),
        ...(node.failure ? { failure: node.failure } : {}),
      })
      return
    case "failed":
      perChunk.push([])
      traceChunks.push({
        ...base,
        candidateCount: 0,
        candidatesDropped: 0,
        failed: true,
        error: node.error,
        ...(parentIndex !== undefined ? { splitOf: parentIndex } : {}),
        ...(node.failure ? { failure: node.failure } : {}),
      })
      return
    case "bisect":
      // A hinge, not a hole: it contributed nothing itself, but its halves follow and the report
      // reads the whole story as one row plus its splits.
      perChunk.push([])
      traceChunks.push({
        ...base,
        candidateCount: 0,
        candidatesDropped: 0,
        failed: true,
        bisected: true,
        error: node.error,
        ...(node.failure ? { failure: node.failure } : {}),
      })
      flattenChunkNode(node.left, traceChunks, perChunk, index)
      flattenChunkNode(node.right, traceChunks, perChunk, index)
      return
  }
}

export interface SelectClipsOptions {
  /** Wait function for rate-limit backoff. Injected so tests do not sleep for real. */
  sleep?: Sleep
}

/**
 * Picks clips from a transcribed video.
 *
 * `profileOverride` (#98) is the user's choice of genre profile, and it wins over the classifier's.
 * The analysis still runs either way, because the summary, speakers and topics are what the
 * context block carries and a user overriding a bad *profile* is not saying the *description* is
 * wrong. Pass `null` for "use what the classifier decided".
 */
export async function selectClips(
  client: AiClient,
  words: Word[],
  sentences: Sentence[],
  topics: TopicSegment[] = [],
  maxClips = DEFAULT_MAX_CLIPS,
  arousalPerSec: number[] = [],
  profileOverride: ClipProfileId | null = null,
  options: SelectClipsOptions = {},
): Promise<ClipSelectionResult> {
  const sleep = options.sleep ?? realSleep
  // Runs before the provenance literal is built so the profile can go straight in, rather than
  // being defaulted and overwritten. `analyzeVideo` answers the documented fallback without an API
  // call when there are no sentences, so this costs nothing on the empty-transcript path.
  const analysis = await analyzeVideo(client, sentences, topics, sleep)
  const { profileId, profile, contextBlock } = resolveSelectionContext(analysis, profileOverride)

  const judgeQuestions = judgeQuestionsFor(profile)

  const provenance: ClipSelectionProvenance = {
    pipelineVersion: PIPELINE_VERSION,
    // Fingerprint the *effective* clip budget, not the default — ipc.ts passes maxClips
    // explicitly, so hashing a package constant would mislabel any override.
    pipelineHash: computePipelineFingerprint(maxClips, client.temperature),
    // Clip selection goes through generateObject, so the structured model is the one that served it.
    model: client.structuredModel,
    contentType: profileId,
    contentTypeOverridden: profileOverride !== null,
  }
  // Present on every return path, including this one. A report that omits `trace` on a
  // zero-sentence video is indistinguishable from a report written by an older build.
  const trace: ClipSelectionTrace = {
    // From the client, not the constant: this is the temperature that was actually sent with the
    // calls, and the client is the thing that knows. Reading the constant here would make the
    // report assert a value about the run that the run did not necessarily use.
    temperature: client.temperature,
    sentenceCount: sentences.length,
    chunks: [],
    candidates: [],
    judgeQuestions,
    judgeCallCount: 0,
  }
  if (sentences.length === 0) {
    return { ...provenance, analysis, clips: [], rejected: [], trace }
  }

  // #98 — one profile for the whole video, logged with the confidence behind it. The confidence
  // is the part worth having in the log: a low-confidence classification is the first thing to
  // check when a run picks the wrong moments, and `analyzeVideo` has already swallowed any failure
  // that made it low.
  console.log(
    `[clip-profile] ${profileId} (${analysis.confidence}${
      provenance.contentTypeOverridden ? ", user override" : ""
    })${analysis.fallback ? " — analysis unavailable" : ""}${analysis.secondaryProfile ? `, also ${analysis.secondaryProfile}` : ""}`,
  )

  // ── Step 1 — generate for recall, chunks in parallel ───────────────────────
  const chunks = topicsToChunks(sentences, topics)
  // mapPool returns the node trees in chunk order; `flattenChunkNode` unpicks them in that same
  // order afterwards, so the trace and the candidate order are identical on every run regardless
  // of which response arrives first.
  const chunkNodes = await mapPool(chunks, CHUNK_CONCURRENCY, (chunk) =>
    runChunkNode(
      client,
      chunk,
      words,
      profile,
      contextBlock,
      arousalPerSec,
      sleep,
      // Top-level chunks may recover a total failure by splitting; the halves themselves may not
      // (one level of bisection keeps the worst-case call budget finite).
      0,
    ),
  )

  const perChunk: Candidate[][] = []
  for (const node of chunkNodes) flattenChunkNode(node, trace.chunks, perChunk)

  // A run where every chunk failed has told us nothing about the transcript — only that the API was
  // unreachable. Throwing here, before any swap, is what lets a re-selection keep its previous
  // suggestions. The partial-failure case (some chunks answered) still succeeds. A chunk counts as
  // failed once its whole tree is failed (a bisect only recovered when a half answered).
  const allFailed = chunkNodes.filter((n) => treeFailed(n)).length
  if (chunks.length > 0 && allFailed === chunks.length) {
    throw new Error(
      `Clip selection failed for all ${chunks.length} chunk(s) after retries. ` +
        `This is an API or model-configuration failure, not an absence of good clips. ` +
        `First error: ${trace.chunks.find((c) => c.failed)?.error ?? "unknown"}`,
    )
  }

  // ── Step 2 — refine every candidate, deterministic, no LLM ─────────────────
  const rejected: ClipRejection[] = []
  interface Survivor {
    entry: TraceEntry
    boundary: NonNullable<ReturnType<typeof refineClipBoundaries>>
    candidate: Candidate
    warnings: string[]
    suggestion: ClipSuggestion
  }
  const survivors: Survivor[] = []

  perChunk.forEach((candidates, chunk) => {
    for (const candidate of candidates) {
      // Every candidate gets an entry, whatever happens to it: each silent drop is a question the
      // report exists to answer.
      const entry: TraceEntry = {
        chunk,
        startSentence: candidate.startSentence,
        endSentence: candidate.endSentence,
        title: candidate.title,
        reason: candidate.reason,
        platform: candidate.platform,
        outcome: "kept",
        judge: null,
        judgeSamples: [],
        judgeReasons: [],
        startMs: null,
        endMs: null,
        startTimecode: null,
        endTimecode: null,
        boundary: null,
        gate: { passed: false, reasons: [], warnings: [] },
        duplicateOf: null,
        finalRank: null,
        text: null,
        opening: null,
      }
      trace.candidates.push(entry)

      // The model's range goes straight to refinement. The hook-first trim that used to run here
      // moved the start after the model had judged the range; the judge now sees the final cut.
      const boundary = refineClipBoundaries(
        words,
        sentences,
        candidate.startSentence,
        candidate.endSentence,
      )
      if (!boundary) {
        entry.outcome = "invalid-range"
        entry.gate.reasons = ["invalid sentence range"]
        rejected.push({ title: candidate.title, reasons: ["invalid sentence range"] })
        continue
      }

      entry.startMs = boundary.startMs
      entry.endMs = boundary.endMs
      entry.startTimecode = toTimecode(boundary.startMs)
      entry.endTimecode = toTimecode(boundary.endMs)
      entry.boundary = {
        danglingUnresolved: boundary.danglingUnresolved,
        endedOnCompleteThought: boundary.endedOnCompleteThought,
        tooShort: boundary.tooShort,
      }
      // Words inside the final boundary, not the model's requested sentence range — this is the
      // text the exported clip will contain.
      entry.text = words
        .filter((w) => w.startMs >= boundary.startMs && w.endMs <= boundary.endMs)
        .map((w) => w.text)
        .join(" ")

      // Mechanical rejections happen BEFORE judging, so no call is spent on a clip that cannot ship.
      const gate = passesQualityGate(boundary)
      entry.gate = { passed: gate.passed, reasons: gate.reasons, warnings: gate.warnings }
      if (!gate.passed) {
        entry.outcome = "gate-rejected"
        rejected.push({ title: candidate.title, reasons: gate.reasons })
        continue
      }

      // The judge's `hook` answer (#99) and its `bestOpeningSentence` (#100) replace the old regex
      // "weak opening" warning, which fired on most ordinary sentences and so carried no information.
      const suggestion: ClipSuggestion = {
        title: candidate.title,
        startMs: boundary.startMs,
        endMs: boundary.endMs,
        // Replaced by the judge's score once the clip is judged.
        score: 0,
        reason: candidate.reason,
        platform: candidate.platform,
        warnings: [...gate.warnings],
      }

      // Chunk overlap makes the same moment arrive twice with near-identical bounds. Drop the
      // later copy now rather than pay to judge both.
      const twin = survivors.find(
        (s) => overlapRatio(s.suggestion, suggestion) >= PRE_JUDGE_DUPLICATE_OVERLAP,
      )
      if (twin) {
        entry.outcome = "duplicate"
        entry.duplicateOf = twin.suggestion.title
        continue
      }

      survivors.push({ entry, boundary, candidate, warnings: suggestion.warnings, suggestion })
    }
  })

  // ── Step 3 — judge each final cut, one voted call per clip ─────────────────
  type JudgeResult =
    { ok: true; judgement: ClipJudgement; samples: ClipJudgement[] } | { ok: false; error: string }
  // Total judge calls, counted where they happen so the report can state the vote's real cost
  // (#125). A first-sample failure throws before samples exist, so it is not counted here.
  let judgeCallCount = 0
  const judged = await mapPool(survivors, JUDGE_CONCURRENCY, async (s): Promise<JudgeResult> => {
    try {
      const { judgement, samples } = await judgeClipVoted({
        client,
        questions: judgeQuestions,
        context: contextBlock,
        words,
        sentences,
        boundary: s.boundary,
        sleep,
      })
      judgeCallCount += samples.length
      return { ok: true, judgement, samples }
    } catch (err) {
      console.error(`[clip-judge] judging "${s.candidate.title}" failed:`, err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  const judgeFailures = judged.filter((j) => !j.ok).length
  // Mirrors the all-chunks-failed rule: a run that mostly failed to judge has not judged what it
  // would return, and a re-selection would swap the user's suggestions for it. Throw before the swap.
  if (survivors.length > 0 && judgeFailures / survivors.length > MAX_JUDGE_FAILURE_RATIO) {
    const firstError = judged.find((j): j is { ok: false; error: string } => !j.ok)?.error
    throw new Error(
      `Clip judging failed for ${judgeFailures} of ${survivors.length} clip(s). ` +
        `This is an API or model failure, not a verdict on the clips. First error: ${firstError ?? "unknown"}`,
    )
  }

  const scored: Survivor[] = []
  survivors.forEach((s, i) => {
    const result = judged[i]!
    if (!result.ok) {
      s.entry.outcome = "judge-failed"
      s.entry.judgeReasons = [`judge call failed: ${result.error}`]
      rejected.push({ title: s.candidate.title, reasons: s.entry.judgeReasons })
      return
    }
    s.entry.judge = result.judgement
    s.entry.judgeSamples = result.samples
    s.suggestion.judge = result.judgement
    s.suggestion.judgeSamples = result.samples
    s.suggestion.score = result.judgement.score
    const failed = failedHardQuestions(result.judgement.answers, judgeQuestions)
    if (failed.length > 0) {
      s.entry.outcome = "judge-rejected"
      s.entry.judgeReasons = failed.map((id) => `fails ${id}`)
      rejected.push({ title: s.candidate.title, reasons: s.entry.judgeReasons })
      return
    }
    scored.push(s)
  })

  // ── Step 3.5 — a judge-chosen opening, replacing the regex hook-trim (#100) ──
  //
  // The first two seconds decide whether a viewer swipes, so the opening sentence matters more than
  // any other choice in the cut. It used to be made by a regex matching questions, numbers and
  // superlatives, which fires on so much ordinary speech that it carried no information and often
  // deleted the setup that made the clip make sense. The judge reads the real text instead.
  //
  // One extra call per clip that has a proposal, and exactly one: a second round would let the
  // model keep trading sentences until the score went up, which measures nothing but the model's
  // persistence. Adoption requires a STRICTLY higher score, so a tie leaves the original in place.
  //
  // Runs before ranking, because it can change the score the ranking depends on — and before the
  // overlap dedupe, because a later start can stop two clips overlapping.
  const openingRetries = scored.filter((s) => s.entry.judge?.bestOpeningSentence != null).length
  console.log(`[clips] ${openingRetries} clip(s) have a judge-suggested opening to try`)

  await mapPool(scored, JUDGE_CONCURRENCY, async (s) => {
    const original = s.entry.judge!
    const suggested = original.bestOpeningSentence
    /** The alternative cut, once one exists. Null until the re-judge returns. */
    type OpeningFacts = { startMs: number; timecode: string; score: number }
    const base = {
      originalStartMs: s.boundary.startMs,
      originalStartTimecode: s.entry.startTimecode!,
      suggestedSentence: suggested,
      originalScore: original.score,
      retryStartMs: null,
      retryStartTimecode: null,
      retryScore: null,
      adopted: false,
    }
    const keep = (note: string, retry?: OpeningFacts): void => {
      s.entry.opening = {
        ...base,
        retryStartMs: retry?.startMs ?? null,
        retryStartTimecode: retry?.timecode ?? null,
        // Recorded even when the proposal loses. A report that could only show the winner's score
        // could not answer whether moving the opening helped, which is the whole point of the step.
        retryScore: retry?.score ?? null,
        adopted: false,
        note,
      }
    }

    if (suggested == null) {
      keep("no better opening suggested")
      return
    }
    // Only ever moves the start forward. A proposal at or before the current start has already been
    // weighed by the judge as the first line of this cut, so there is nothing to try.
    if (suggested <= s.boundary.startSentenceIndex) {
      keep("suggested opening is not later than the current one")
      return
    }

    // D2 still runs, and that is the point: it expands backward over a dangling opener, repairing
    // the new start instead of fighting a regex for it.
    const boundary = refineClipBoundaries(words, sentences, suggested, s.boundary.endSentenceIndex)
    if (!boundary) {
      keep("suggested opening produced no valid range")
      return
    }
    if (boundary.startSentenceIndex === s.boundary.startSentenceIndex) {
      keep("D2 repaired the suggested opening back to the current start")
      return
    }
    // Starting later runs the length clamp again, so the alternative can fail the mechanical gate
    // the original passed. A cut that cannot ship is not an improvement, whatever the judge says.
    const gate = passesQualityGate(boundary)
    if (!gate.passed) {
      keep(`suggested opening fails the quality gate: ${gate.reasons.join("; ")}`)
      return
    }

    const retryStartMs = boundary.startMs
    const retryStartTimecode = toTimecode(boundary.startMs)
    let judgement: ClipJudgement
    let retrySamples: ClipJudgement[]
    try {
      // The moved opening is judged by the same voted path (#125): it is the same "is this cut
      // postable" question, so it gets the same noise control as the first judgement. Its samples
      // become the entry's samples when the proposal is adopted.
      const voted = await judgeClipVoted({
        client,
        questions: judgeQuestions,
        context: contextBlock,
        words,
        sentences,
        boundary,
        sleep,
      })
      judgement = voted.judgement
      retrySamples = voted.samples
      judgeCallCount += voted.samples.length
    } catch (err) {
      keep(`re-judge failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    const retryScore = judgement.score
    const facts: OpeningFacts = {
      startMs: retryStartMs,
      timecode: retryStartTimecode,
      score: retryScore,
    }
    const failedHard = failedHardQuestions(judgement.answers, judgeQuestions)
    if (failedHard.length > 0) {
      keep(`re-judged opening fails ${failedHard.join(", ")}`, facts)
      return
    }
    if (retryScore <= original.score) {
      keep("re-judged opening did not score higher", facts)
      return
    }

    // Adopted: the clip now starts at the judge's sentence and carries the second judgement.
    s.boundary = boundary
    s.suggestion.startMs = boundary.startMs
    s.suggestion.endMs = boundary.endMs
    s.suggestion.score = retryScore
    s.suggestion.judge = judgement
    s.suggestion.judgeSamples = retrySamples
    s.suggestion.warnings = [...gate.warnings]
    s.warnings = s.suggestion.warnings
    s.entry.startMs = boundary.startMs
    s.entry.endMs = boundary.endMs
    s.entry.startTimecode = retryStartTimecode
    s.entry.endTimecode = toTimecode(boundary.endMs)
    s.entry.boundary = {
      danglingUnresolved: boundary.danglingUnresolved,
      endedOnCompleteThought: boundary.endedOnCompleteThought,
      tooShort: boundary.tooShort,
    }
    s.entry.gate = { passed: true, reasons: [], warnings: gate.warnings }
    s.entry.judge = judgement
    s.entry.judgeSamples = retrySamples
    s.entry.text = words
      .filter((w) => w.startMs >= boundary.startMs && w.endMs <= boundary.endMs)
      .map((w) => w.text)
      .join(" ")
    s.entry.opening = {
      ...base,
      retryStartMs,
      retryStartTimecode,
      retryScore,
      adopted: true,
      note: `judge proposed sentence #${suggested}`,
    }
  })

  trace.judgeCallCount = judgeCallCount
  // #125 — the vote's real cost and its residual noise, in one line: how many calls it took, and
  // which questions the samples disagreed on (the candidates for a wording fix, `payoff` first).
  const disagreements = disagreementCounts(
    scored.map((s) => s.entry.judgeSamples),
    judgeQuestions,
  ).filter((d) => d.voted > 0 && d.disagreed > 0)
  console.log(
    `[clip-judge] ${judgeCallCount} judge call(s) for ${survivors.length} clip verdict(s) — ` +
      (disagreements.length
        ? `sample disagreement: ${disagreements.map((d) => `${d.id} ${d.disagreed}/${d.voted}`).join(", ")}`
        : "samples agreed on every question"),
  )

  // ── Step 4 — rank every chunk together, dedupe, cut ────────────────────────
  // Best score first; ties broken by position in the video so the order never depends on anything
  // random or on which response arrived first.
  scored.sort(
    (a, b) =>
      b.suggestion.score - a.suggestion.score || a.suggestion.startMs - b.suggestion.startMs,
  )

  const clips: ClipSuggestion[] = []
  for (const s of scored) {
    // The list is score-ordered, so any earlier clip that overlaps this one scored at least as well.
    const duplicate = clips.find(
      (existing) => overlapRatio(existing, s.suggestion) > DEDUPE_OVERLAP_RATIO,
    )
    if (duplicate) {
      s.entry.outcome = "duplicate"
      s.entry.duplicateOf = duplicate.title
      continue
    }
    if (clips.length >= maxClips) {
      s.entry.outcome = "over-budget"
      continue
    }
    clips.push(s.suggestion)
    s.entry.finalRank = clips.length - 1
  }

  return { ...provenance, analysis, clips, rejected, trace }
}
