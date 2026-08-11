import type { AiClient } from "./client"
import type { z } from "zod"
import { z as zod } from "zod"
import type { Word, Sentence } from "@video-editor/types"
import {
  sentencesToPrompt,
  refineClipBoundaries,
  passesQualityGate,
  MIN_CLIP_MS,
  MAX_CLIP_MS,
} from "@video-editor/transcript"

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

The transcript is given as numbered sentences:
#12 [10500-14200] Hello everyone, welcome to today's episode

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

/** Wave 1 stopgap chunking. Replaced by topic-coherent chunking (C5) once B2 lands. */
const CHUNK_THRESHOLD_MS = 30 * 60 * 1000
const CHUNK_SIZE_MS = 20 * 60 * 1000
const CHUNK_OVERLAP_MS = 60 * 1000

function chunkSentences(sentences: Sentence[]): Sentence[][] {
  if (sentences.length === 0) return []
  const totalMs = sentences[sentences.length - 1]!.endMs - sentences[0]!.startMs
  if (totalMs <= CHUNK_THRESHOLD_MS) return [sentences]

  const chunks: Sentence[][] = []
  let cursor = 0
  while (cursor < sentences.length) {
    const chunkStartMs = sentences[cursor]!.startMs
    let end = cursor
    while (end < sentences.length && sentences[end]!.endMs - chunkStartMs <= CHUNK_SIZE_MS) end++
    chunks.push(sentences.slice(cursor, Math.max(end, cursor + 1)))
    if (end >= sentences.length) break

    // Step back so the next chunk overlaps — a clip straddling the seam still appears whole once.
    const nextStartMs = sentences[end]!.startMs - CHUNK_OVERLAP_MS
    let next = end
    while (next > cursor + 1 && sentences[next - 1]!.startMs >= nextStartMs) next--
    // Guard: a single sentence longer than CHUNK_SIZE_MS leaves `end === cursor`, and without
    // this the cursor never advances and the main process hangs.
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

async function selectFromChunk(client: AiClient, chunk: Sentence[]): Promise<Candidate[]> {
  const schema = zod.object({ clips: zod.array(CandidateSchema).max(20) })
  const firstIndex = chunk[0]!.index
  const lastIndex = chunk[chunk.length - 1]!.index
  const prompt = `Sentences #${firstIndex} to #${lastIndex}.

${sentencesToPrompt(chunk)}

Select every clip worth posting, best first. Each clip should span roughly ${MIN_CLIP_MS / 1000}–${MAX_CLIP_MS / 1000} seconds of transcript time.
Only use sentence indices between ${firstIndex} and ${lastIndex}.
Return fewer clips — or an empty array — rather than padding with weak ones.`

  const result = await client.generateObject({
    prompt,
    schema: schema as unknown as z.ZodType<{ clips: Candidate[] }>,
    system: SYSTEM_PROMPT,
  })
  return result.clips.filter((c) => c.startSentence >= firstIndex && c.endSentence <= lastIndex)
}

export async function selectClips(
  client: AiClient,
  words: Word[],
  sentences: Sentence[],
  maxClips = 10,
): Promise<ClipSelectionResult> {
  if (sentences.length === 0) return { clips: [], rejected: [] }

  const chunks = chunkSentences(sentences)
  const perChunk: Candidate[][] = []
  for (const chunk of chunks) {
    perChunk.push(await selectFromChunk(client, chunk))
  }

  const clips: ClipSuggestion[] = []
  const rejected: ClipRejection[] = []
  const ranked = interleaveByRank(perChunk)

  for (const candidate of ranked) {
    const boundary = refineClipBoundaries(
      words,
      sentences,
      candidate.startSentence,
      candidate.endSentence,
    )
    if (!boundary) {
      rejected.push({ title: candidate.title, reasons: ["invalid sentence range"] })
      continue
    }

    const gate = passesQualityGate(boundary, candidate.strong)
    if (!gate.passed) {
      rejected.push({ title: candidate.title, reasons: gate.reasons })
      continue
    }

    const suggestion: ClipSuggestion = {
      title: candidate.title,
      startMs: boundary.startMs,
      endMs: boundary.endMs,
      // Derived from rank for display only — the model never emits a number (C8).
      score: 0,
      reason: candidate.reason,
      platform: candidate.platform,
      warnings: gate.warnings,
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
