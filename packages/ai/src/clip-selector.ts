import type { AiClient } from "./client"
import type { z } from "zod"
import { z as zod } from "zod"
import type { Word, Sentence } from "@video-editor/types"
import {
  refineClipBoundaries,
  passesQualityGate,
  MIN_CLIP_MS,
  MAX_CLIP_MS,
} from "@video-editor/transcript"
import type { TopicSegment } from "@video-editor/transcript"

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

export interface ClipSelectionResult {
  clips: ClipSuggestion[]
  /** Candidates dropped by the quality gate — surfaced so "only 2 clips" is explainable. */
  rejected: ClipRejection[]
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

/** Round-robin by rank so a later chunk isn't starved by an earlier one. */
function interleaveByRank(perChunk: Candidate[][]): Candidate[] {
  const merged: Candidate[] = []
  const depth = Math.max(0, ...perChunk.map((c) => c.length))
  for (let rank = 0; rank < depth; rank++) {
    for (const chunk of perChunk) {
      const candidate = chunk[rank]
      if (candidate) merged.push(candidate)
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

// ─── C4 — content-type detection and rubric swap ────────────────────────────

export type ContentType = "interview" | "tutorial" | "solo" | "generic"

/**
 * Infers content type from the transcript heuristically.
 * Used to swap the system prompt so the LLM applies the right clip-selection rubric.
 */
export function detectContentType(sentences: Sentence[]): ContentType {
  if (sentences.length === 0) return "generic"
  const text = sentences.map((s) => s.text).join(" ")

  // Tutorial: step-by-step language dominates
  if (
    /\bstep\s*(?:one|two|three|1|2|3)\b|\bhow\s+to\b|\bin\s+this\s+(?:video|tutorial)\b|\bby\s+the\s+end\b/i.test(
      text,
    )
  )
    return "tutorial"

  // Interview: high question ratio or clear host/guest signals
  const questions = sentences.filter((s) => s.text.trim().endsWith("?")).length
  const questionRatio = questions / sentences.length
  if (
    questionRatio > 0.12 ||
    /\bmy\s+guest\b|\bjoined\s+by\b|\bgreat\s+question\b|\btell\s+me\s+about\b/i.test(text)
  )
    return "interview"

  return "solo"
}

const CONTENT_TYPE_SUFFIX: Record<ContentType, string> = {
  generic: "",
  solo: "",
  interview: `

This is an INTERVIEW. Prioritise these clip shapes:
- Guest says something surprising and the host visibly reacts (pushback, laughter, "really?")
- Guest shares a personal story with a clear unexpected turn
- Moment of genuine disagreement or tension between speakers
- Bold claim the host challenges or the guest doubles down on
- Rare disclosure: "I've never told anyone this", "what most people don't know"`,
  tutorial: `

This is a TUTORIAL. Prioritise these clip shapes:
- One complete actionable step with a clear stated outcome ("do X → get Y")
- The mistake most people make, followed immediately by the correct approach
- Before/after or wrong-way/right-way reveal
- A single rule or mental model that changes how you do something
HARD RULE: never clip a partial step. A clip that starts or ends mid-instruction fails on its own.`,
}

// ─── D5 — hook-first check ───────────────────────────────────────────────────

/**
 * Tries to advance the clip's start sentence to the first sentence with a hook marker.
 * Trims at most `maxTrim` sentences forward. Returns the original start if no hook is
 * found within that window — the caller adds a "weak opening" warning.
 */
function hookFirstAdjust(
  sentenceByIndex: Map<number, Sentence>,
  startSentence: number,
  endSentence: number,
  maxTrim = 2,
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
          if (meanRms > rmsBaseline + 3) loudTag = "loud"
        }
      }

      // B6: burst tag — sentence follows a notable silence (>800ms gap)
      const gapMs = s.startMs - prevEndMs
      const burstTag = gapMs > 800 ? "burst" : ""
      prevEndMs = s.endMs

      const tags = [
        HOOK_RE.test(s.text) ? "hook" : "",
        wps > wpsBaseline * 1.3 ? "fast" : "",
        wps < wpsBaseline * 0.7 ? "slow" : "",
        loudTag,
        burstTag,
        wordCount > 0 && fillerCount / wordCount > 0.15 ? "filler:high" : "",
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
  const prompt = shuffled.map(({ c, id }) => `id=${id} "${c.title}" — ${c.reason}`).join("\n")

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

async function selectFromChunk(
  client: AiClient,
  chunk: Sentence[],
  words: Word[],
  arousalPerSec: number[] = [],
  contentType: ContentType = "generic",
): Promise<Candidate[]> {
  const schema = zod.object({ clips: zod.array(CandidateSchema).max(20) })
  const firstIndex = chunk[0]!.index
  const lastIndex = chunk[chunk.length - 1]!.index
  const prompt = `Sentences #${firstIndex} to #${lastIndex}.

${buildAnnotatedPrompt(chunk, words, arousalPerSec)}

Select every clip worth posting, best first. Each clip should span roughly ${MIN_CLIP_MS / 1000}–${MAX_CLIP_MS / 1000} seconds of transcript time.
Only use sentence indices between ${firstIndex} and ${lastIndex}.
Return fewer clips — or an empty array — rather than padding with weak ones.`

  // C4 — append content-type rubric suffix to base system prompt.
  const system = SYSTEM_PROMPT + (CONTENT_TYPE_SUFFIX[contentType] ?? "")

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

export async function selectClips(
  client: AiClient,
  words: Word[],
  sentences: Sentence[],
  topics: TopicSegment[] = [],
  maxClips = 10,
  arousalPerSec: number[] = [],
): Promise<ClipSelectionResult> {
  if (sentences.length === 0) return { clips: [], rejected: [] }

  // C4 — detect content type once; each chunk uses the same type-specific rubric.
  const contentType = detectContentType(sentences)
  console.log(`[content-type] ${contentType}`)

  // D5 — fast lookup for hook-first check in the candidate loop below.
  const sentenceByIndex = new Map(sentences.map((s) => [s.index, s]))

  const chunks = topicsToChunks(sentences, topics)
  const perChunk: Candidate[][] = []
  for (const chunk of chunks) {
    // client.generateObject already retries transient/malformed-JSON failures internally. If a
    // chunk still fails after that, drop just this chunk's candidates rather than aborting clip
    // selection for the whole video — other chunks' clips are still worth surfacing.
    try {
      perChunk.push(await selectFromChunk(client, chunk, words, arousalPerSec, contentType))
    } catch (err) {
      console.error(
        `[clip-selector] chunk (sentences #${chunk[0]?.index}-#${chunk[chunk.length - 1]?.index}) failed after retries, skipping:`,
        err,
      )
      perChunk.push([])
    }
  }

  const clips: ClipSuggestion[] = []
  const rejected: ClipRejection[] = []
  const ranked = interleaveByRank(perChunk)

  for (const candidate of ranked) {
    // D5 — try to trim opening forward to a hook sentence before boundary refinement.
    const { adjustedStart } = hookFirstAdjust(
      sentenceByIndex,
      candidate.startSentence,
      candidate.endSentence,
    )

    const boundary = refineClipBoundaries(words, sentences, adjustedStart, candidate.endSentence)
    if (!boundary) {
      rejected.push({ title: candidate.title, reasons: ["invalid sentence range"] })
      continue
    }

    const gate = passesQualityGate(boundary, candidate.strong)
    if (!gate.passed) {
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
    if (clips.some((existing) => overlapRatio(existing, suggestion) > 0.5)) continue

    clips.push(suggestion)
    if (clips.length >= maxClips) break
  }

  // Display score from final rank, so the UI has a number without the LLM inventing one.
  const total = clips.length
  clips.forEach((clip, i) => {
    clip.score = total <= 1 ? 1 : Number((1 - i / total).toFixed(2))
  })

  return { clips, rejected }
}
