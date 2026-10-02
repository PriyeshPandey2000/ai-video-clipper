import { createHash } from "node:crypto"
import { CLIP_SELECTION_TEMPERATURE, STRUCTURED_OUTPUT_SUFFIX, type AiClient } from "./client"
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
  /** The model's own calibrated `strong` flag — the only judgement input the gate takes. */
  strong: boolean
  platform: "tiktok" | "reels" | "shorts" | "generic"
}

/** What became of a candidate. Every candidate ends in exactly one of these. */
export type TraceOutcome = "kept" | "gate-rejected" | "invalid-range" | "duplicate" | "over-budget"

export interface TraceEntry extends TraceCandidate {
  outcome: TraceOutcome
  /**
   * The range after the hook-first trim (D5). Differs from `startSentence` whenever a hook was
   * found within the trim window; recording both is what makes a "the model said 40, we cut from 42"
   * discrepancy explainable.
   */
  trimmedStartSentence: number | null
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
}

/** Chunk layout for the run. Decides which sentences the model ever saw. */
export interface TraceChunk {
  index: number
  firstSentence: number
  lastSentence: number
  /** Candidates the model returned for this chunk, before interleaving. */
  candidateCount: number
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
}

export interface ClipSelectionTrace {
  temperature: number
  sentenceCount: number
  chunks: TraceChunk[]
  /** One entry per candidate returned, in the order they were ranked. */
  candidates: TraceEntry[]
}

/**
 * The model picks sentence indices, never milliseconds (C1). A hallucinated timestamp is
 * structurally impossible: every ms in the output is derived from our own word table.
 */
const CandidateSchema = zod.object({
  startSentence: zod.number().int().min(0),
  endSentence: zod.number().int().min(0),
  title: zod.string(),
  reason: zod.string(),
  strong: zod.boolean(),
  platform: zod.enum(["tiktok", "reels", "shorts", "generic"]),
})

type Candidate = zod.infer<typeof CandidateSchema>

const SYSTEM_PROMPT = `You are a short-form video editor selecting clips from a long transcript.

The transcript is given as numbered sentences with optional signal tags in {braces}:
#12 [10500-14200] {hook,fast} Nobody expected this outcome.
#13 [14200-16000] So then everything changed.

Signal tags — use as extra evidence, not hard rules:
  {hook}        — question, number, superlative, reveal, or contrarian framing detected
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

RANKING: return clips in order, best first. Do not assign numeric scores — ordering is your
judgment, and an absolute score would be noise.

STRONG FLAG: set "strong": true only if you would personally post this clip. Be strict. A
transcript with no outstanding moments should return few clips, or none. Returning weak clips is
worse than returning nothing.

Return JSON with a "clips" array. Each item: startSentence, endSentence, title, reason, strong,
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

/** A candidate plus the chunk it came from, carried through ranking so the trace can say which. */
interface RankedCandidate {
  chunk: number
  candidate: Candidate
}

/** Round-robin by rank so a later chunk isn't starved by an earlier one. */
function interleaveByRank(perChunk: Candidate[][]): RankedCandidate[] {
  const tagged: RankedCandidate[][] = perChunk.map((candidates, chunk) =>
    candidates.map((candidate) => ({ chunk, candidate })),
  )
  const merged: RankedCandidate[] = []
  const depth = Math.max(0, ...tagged.map((c) => c.length))
  for (let rank = 0; rank < depth; rank++) {
    for (const chunk of tagged) {
      const ranked = chunk[rank]
      if (ranked) merged.push(ranked)
    }
  }
  return merged
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

// ─── D5 — hook-first check ───────────────────────────────────────────────────

/** D5 — how many sentences forward hook-first trim may move a clip's start. */
const HOOK_FIRST_MAX_TRIM = 2
/** Ceiling on candidates requested per chunk, independent of how many survive the gate. */
const MAX_CANDIDATES_PER_CHUNK = 20
/** Default clip count per video. Overridable per call, so the effective value is hashed per run. */
const DEFAULT_MAX_CLIPS = 10

/**
 * Tries to advance the clip's start sentence to the first sentence with a hook marker.
 * Trims at most `maxTrim` sentences forward. Returns the original start if no hook is
 * found within that window — the caller adds a "weak opening" warning.
 */
function hookFirstAdjust(
  sentenceByIndex: Map<number, Sentence>,
  startSentence: number,
  endSentence: number,
  maxTrim = HOOK_FIRST_MAX_TRIM,
): { adjustedStart: number; noHook: boolean } {
  for (let i = 0; i <= maxTrim; i++) {
    const idx = startSentence + i
    // Never trim so far that fewer than 3 sentences remain in the clip.
    if (idx > endSentence - 2) break
    const sent = sentenceByIndex.get(idx)
    if (sent && HOOK_RE.test(sent.text)) return { adjustedStart: idx, noHook: false }
  }
  return { adjustedStart: startSentence, noHook: true }
}

// B7/B8/B10 — local signals injected as prompt metadata so the LLM can weight them without
// seeing raw audio. No model needed: speech rate from timestamps, hooks from regex, filler
// from the existing word set.
const HOOK_RE =
  /(?:\?$)|(?:\b\d{2,})|(?:\b(?:best|worst|biggest|most|least|first|last|only|never|always|ever)\b)|(?:\b(?:nobody|don't tell|secret|hidden|misconception|myth)\b)|(?:\b(?:here.?s why|that.?s why|turns out|here.?s the thing|the truth is)\b)/i
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
        HOOK_RE.test(s.text) ? "hook" : "",
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

// C2 — listwise ranking stability. Shuffling the list before a second pass and merging with
// Borda count removes the order-sensitivity of a single listwise call: the same video should
// produce the same top clips across runs, not a coin flip based on which example appeared first.
const RERANK_SYSTEM =
  "Re-rank the given clip candidates for viral short-form video potential. Each candidate is " +
  'shown with an explicit "id=N" field. Return a JSON object with a "ranking" array containing ' +
  "every id value — not list positions — in your preferred order, best first."

/**
 * How each candidate is presented to the rerank pass. It only ever sees the model's own title and
 * reason — never the transcript — so this format is part of what the fingerprint must cover.
 *
 * Interpolation, not `.replace` on a placeholder template. An earlier version built this from
 * `{ID}`/`{TITLE}`/`{REASON}` placeholders so the format could be hashed as a literal, but that
 * traded one injection bug for another: a model-authored title containing the literal text
 * `{REASON}` made the trailing `.replace` consume the placeholder *inside the title*, splicing the
 * reason into it and stranding `{REASON}` at the end of the line. The fingerprint no longer needs
 * the raw format for that — see `RERANK_FORMAT_SAMPLE` below.
 */
function renderRerankLine(id: number, c: Pick<Candidate, "title" | "reason">): string {
  return `id=${id} "${c.title}" — ${c.reason}`
}

// Sample rendering of the line above, hashed into the fingerprint so the format still counts as
// covered. A change to the format changes this string; nothing is parsed to get there.
const RERANK_FORMAT_SAMPLE = renderRerankLine(0, { title: "T", reason: "R" })

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

async function reRankWithBorda(client: AiClient, candidates: Candidate[]): Promise<Candidate[]> {
  if (candidates.length <= 1) return candidates

  // Key on array position, not startSentence — the schema doesn't guarantee unique
  // startSentence values across candidates.
  const tailRank = candidates.length
  const indexed = candidates.map((c, id) => ({ c, id }))

  const shuffled = shuffle(indexed)
  const schema = zod.object({ ranking: zod.array(zod.number().int()) })
  const prompt = shuffled.map(({ c, id }) => renderRerankLine(id, c)).join("\n")

  let pass2Ranking: number[]
  try {
    const result = await client.generateObject({
      prompt,
      schema: schema as unknown as z.ZodType<{ ranking: number[] }>,
      system: RERANK_SYSTEM,
    })
    pass2Ranking = result.ranking
  } catch {
    return candidates
  }

  // Build pass 2 rank map; unmentioned candidates get tail rank (Borda tail-rank rule).
  const pass2Rank = new Map<number, number>(indexed.map(({ id }) => [id, tailRank]))
  for (let i = 0; i < pass2Ranking.length; i++) {
    const id = pass2Ranking[i]
    if (id !== undefined && pass2Rank.has(id)) pass2Rank.set(id, i)
  }

  return indexed
    .map(({ c, id }) => ({
      c,
      // pass1 rank is simply the candidate's position in the original (already-ranked) list.
      borda: id + (pass2Rank.get(id) ?? tailRank),
    }))
    .sort((a, b) => a.borda - b.borda)
    .map(({ c }) => c)
}

const USER_PROMPT_TEMPLATE = `{{CONTEXT}}

Sentences #{{FIRST}} to #{{LAST}}.

{{TRANSCRIPT}}

Select every clip worth posting, best first. Each clip should span roughly {{MIN_SEC}}–{{MAX_SEC}} seconds of transcript time.
Only use sentence indices between {{FIRST}} and {{LAST}}.
Return fewer clips — or an empty array — rather than padding with weak ones.`

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

// ─── Pipeline fingerprint (#89) ─────────────────────────────────────────────

/**
 * Human-readable label for the clip-selection *code*. Bump by hand when a change alters output
 * without touching any constant in the fingerprint — a logic edit in `refineClipBoundaries` or
 * `hookFirstAdjust` is invisible to the hash by construction.
 *
 * v2 — the genre-profile pipeline (#98) replaced the regex content-type detector. The hash moved
 * on its own because the rubric swap is hashed; the version moves because what a profile *is* was
 * redefined, which no constant in the fingerprint can see.
 */
export const PIPELINE_VERSION = "v2-genre-profile"

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
 * - `judgeQuestions`, `lookingFor` and `defaultLengthMs` from the profile table (#98). None of them
 *   reaches a prompt in this version — the judging pass that consumes `judgeQuestions` is a
 *   separate issue, and `defaultLengthMs` is held at the global 15–90s. Hashing a string nothing
 *   sends would make "it is in the hash" a claim this function could not honestly make.
 *
 * Known remaining gap: a behavioural change in code that reads none of these constants — a logic
 * edit inside `refineClipBoundaries` or `hookFirstAdjust`. That is what `PIPELINE_VERSION` is for.
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
        `rerankSystem:${RERANK_SYSTEM}`,
        `rerankLineFormat:${RERANK_FORMAT_SAMPLE}`,
        `hookRe:${HOOK_RE.source}`,
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
        `hookFirstMaxTrim:${HOOK_FIRST_MAX_TRIM}`,
        `maxCandidatesPerChunk:${MAX_CANDIDATES_PER_CHUNK}`,
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
): Promise<Candidate[]> {
  const schema = zod.object({ clips: zod.array(CandidateSchema).max(MAX_CANDIDATES_PER_CHUNK) })
  const firstIndex = chunk[0]!.index
  const lastIndex = chunk[chunk.length - 1]!.index
  const prompt = renderUserPrompt(chunk, words, arousalPerSec, contextBlock)

  // #98 — the profile's rubric, appended to the base system prompt. This is the swap the regex
  // detector used to perform; what changed is that the profile now comes from the model's own
  // reading of the video instead of a keyword match.
  const system = SYSTEM_PROMPT + profile.rubric

  const result = await client.generateObject({
    prompt,
    schema: schema as unknown as z.ZodType<{ clips: Candidate[] }>,
    system,
  })
  const generated = result.clips.filter(
    (c) => c.startSentence >= firstIndex && c.endSentence <= lastIndex,
  )
  return reRankWithBorda(client, generated)
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
): Promise<ClipSelectionResult> {
  // Runs before the provenance literal is built so the profile can go straight in, rather than
  // being defaulted and overwritten. `analyzeVideo` answers the documented fallback without an API
  // call when there are no sentences, so this costs nothing on the empty-transcript path.
  const analysis = await analyzeVideo(client, sentences, topics)
  const profileId = profileOverride ?? analysis.profile
  const profile = CLIP_PROFILES[profileId]
  // Rendered once, not per chunk: it is a pure function of the analysis and the effective profile,
  // so every chunk of a run necessarily carries the identical block.
  const contextBlock = renderVideoContext(analysis, {
    profileId: analysis.profile,
    override: profileOverride,
  })

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

  // D5 — fast lookup for hook-first check in the candidate loop below.
  const sentenceByIndex = new Map(sentences.map((s) => [s.index, s]))

  const chunks = topicsToChunks(sentences, topics)
  const perChunk: Candidate[][] = []
  let failedChunks = 0
  for (const chunk of chunks) {
    // client.generateObject already retries transient/malformed-JSON failures internally. If a
    // chunk still fails after that, drop just this chunk's candidates rather than aborting clip
    // selection for the whole video — other chunks' clips are still worth surfacing.
    try {
      const candidates = await selectFromChunk(
        client,
        chunk,
        words,
        profile,
        contextBlock,
        arousalPerSec,
      )
      perChunk.push(candidates)
      trace.chunks.push({
        index: trace.chunks.length,
        firstSentence: chunk[0]!.index,
        lastSentence: chunk[chunk.length - 1]!.index,
        candidateCount: candidates.length,
        failed: false,
      })
    } catch (err) {
      console.error(
        `[clip-selector] chunk (sentences #${chunk[0]?.index}-#${chunk[chunk.length - 1]?.index}) failed after retries, skipping:`,
        err,
      )
      perChunk.push([])
      // Recorded even though it produced nothing: "chunk 3 of 5 returned no candidates at all"
      // and "chunk 3 of 5 never ran" are very different answers to why a long video yielded two
      // clips, and the report is the only place either is visible.
      trace.chunks.push({
        index: trace.chunks.length,
        firstSentence: chunk[0]!.index,
        lastSentence: chunk[chunk.length - 1]!.index,
        candidateCount: 0,
        failed: true,
        error: err instanceof Error ? err.message : String(err),
      })
      failedChunks++
    }
  }

  // A run where every chunk failed has told us nothing about the transcript — it has only told
  // us the API was unreachable. Returning zero clips from it would be a lie the caller cannot
  // detect: an empty result and a broken run are the same value.
  //
  // Throwing here is what lets a re-selection keep its previous suggestions. runClipSelection
  // swaps suggestions for the returned clips, so "all chunks failed" must be an exception that
  // happens *before* the swap rather than an empty list that reaches it. The partial-failure case
  // (some chunks answered) deliberately still succeeds — those clips are real.
  if (chunks.length > 0 && failedChunks === chunks.length) {
    throw new Error(
      `Clip selection failed for all ${chunks.length} chunk(s) after retries. ` +
        `This is an API or model-configuration failure, not an absence of good clips. ` +
        `First error: ${trace.chunks.find((c) => c.failed)?.error ?? "unknown"}`,
    )
  }

  const clips: ClipSuggestion[] = []
  const rejected: ClipRejection[] = []
  const ranked = interleaveByRank(perChunk)

  for (const { chunk, candidate } of ranked) {
    // D5 — try to trim opening forward to a hook sentence before boundary refinement.
    const { adjustedStart } = hookFirstAdjust(
      sentenceByIndex,
      candidate.startSentence,
      candidate.endSentence,
    )

    // Every candidate gets an entry, whatever happens to it. The three ways this loop used to
    // `continue`/`break` silently (refine-null, gate-reject, dedupe) are the exact questions the
    // report exists to answer, so each is now an outcome rather than a bare skip.
    const entry: TraceEntry = {
      chunk,
      startSentence: candidate.startSentence,
      endSentence: candidate.endSentence,
      title: candidate.title,
      reason: candidate.reason,
      strong: candidate.strong,
      platform: candidate.platform,
      outcome: "kept",
      trimmedStartSentence: adjustedStart,
      startMs: null,
      endMs: null,
      startTimecode: null,
      endTimecode: null,
      boundary: null,
      gate: { passed: false, reasons: [], warnings: [] },
      duplicateOf: null,
      finalRank: null,
      text: null,
    }
    trace.candidates.push(entry)

    const boundary = refineClipBoundaries(words, sentences, adjustedStart, candidate.endSentence)
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
    // text the exported clip will contain, which is what "what does this clip say?" means.
    entry.text = words
      .filter((w) => w.startMs >= boundary.startMs && w.endMs <= boundary.endMs)
      .map((w) => w.text)
      .join(" ")

    const gate = passesQualityGate(boundary, candidate.strong)
    entry.gate = { passed: gate.passed, reasons: gate.reasons, warnings: gate.warnings }
    if (!gate.passed) {
      entry.outcome = "gate-rejected"
      rejected.push({ title: candidate.title, reasons: gate.reasons })
      continue
    }

    // D2's backward expansion can walk the boundary's actual start earlier than adjustedStart
    // (e.g. the hook sentence itself opens with a dangling reference like "So" or "This"), which
    // would make a stale noHook computed at adjustedStart lie about what the clip really opens
    // on. Re-check HOOK_RE against the sentence the clip actually starts on.
    const finalOpener = sentenceByIndex.get(boundary.startSentenceIndex)
    const noHook = !finalOpener || !HOOK_RE.test(finalOpener.text)

    const suggestion: ClipSuggestion = {
      title: candidate.title,
      startMs: boundary.startMs,
      endMs: boundary.endMs,
      // Derived from rank for display only — the model never emits a number (C8).
      score: 0,
      reason: candidate.reason,
      platform: candidate.platform,
      warnings: [...gate.warnings, ...(noHook ? ["weak opening"] : [])],
    }

    // Chunk overlap intentionally produces duplicates at the seams; keep the better-ranked one.
    const duplicate = clips.find(
      (existing) => overlapRatio(existing, suggestion) > DEDUPE_OVERLAP_RATIO,
    )
    if (duplicate) {
      entry.outcome = "duplicate"
      entry.duplicateOf = duplicate.title
      continue
    }

    // Previously a `break` — candidates past the budget were never examined at all. They are now
    // recorded as over-budget instead, which costs nothing and stops the report from implying
    // the model never proposed them.
    if (clips.length >= maxClips) {
      entry.outcome = "over-budget"
      continue
    }

    clips.push(suggestion)
    entry.finalRank = clips.length - 1
  }

  // Display score from final rank, so the UI has a number without the LLM inventing one.
  const total = clips.length
  clips.forEach((clip, i) => {
    clip.score = total <= 1 ? 1 : Number((1 - i / total).toFixed(2))
  })

  return { ...provenance, analysis, clips, rejected, trace }
}
