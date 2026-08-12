import type { Word, Sentence } from "@video-editor/types"

/** D6 — platform length clamp. Replaces the old `duration * 0.2` math. */
export const MIN_CLIP_MS = 15_000
export const MAX_CLIP_MS = 90_000

/** D3 — breathing room. Placed inside the pause, never past its midpoint. */
const LEAD_IN_MS = 180
const TAIL_MS = 300

/** D4 — how far past the chosen end we may search for a complete thought. */
const END_SEARCH_MS = 5_000
/**
 * A pause this long counts as a thought ending even without punctuation.
 *
 * MUST stay above `SENTENCE_GAP_MS` (700) in sentences.ts. A sentence with no terminator only
 * exists because a pause split it, so any threshold at or below the split gap marks every such
 * sentence "complete" and D4's forward search never fires.
 */
const COMPLETE_THOUGHT_PAUSE_MS = 900

/** D2 — cap on backward expansion, so one dangling word can't drag in a whole topic. */
const MAX_BACKWARD_SENTENCES = 3

/**
 * Openers that signal the sentence depends on something before it.
 *
 * This drives a *repair* (expand backwards until the referent resolves), never a rejection —
 * so false positives are cheap: they widen the clip slightly. Contractions are deliberately
 * absent, which is why legitimate hooks like "That's why I stopped taking meetings" pass:
 * the token is `that's`, not `that`.
 */
const DANGLING_OPENERS = new Set([
  "he",
  "she",
  "they",
  "it",
  "him",
  "her",
  "them",
  "his",
  "their",
  "theirs",
  "hers",
  "this",
  "that",
  "these",
  "those",
  "there",
  "and",
  "so",
  "but",
  "because",
  "which",
  "or",
  "then",
  "also",
  "plus",
  "anyway",
  "however",
  "though",
  "otherwise",
  "meanwhile",
  "instead",
  "therefore",
  "thus",
])

function firstToken(text: string): string {
  return text
    .trim()
    .split(/\s+/)[0]!
    .toLowerCase()
    .replace(/[^a-z']/g, "")
}

export function startsWithDanglingReference(sentence: Sentence): boolean {
  return DANGLING_OPENERS.has(firstToken(sentence.text))
}

export interface RefinedBoundary {
  startMs: number
  endMs: number
  durationMs: number
  startSentenceIndex: number
  endSentenceIndex: number
  /** True when backward expansion hit its cap with the opener still dangling. */
  danglingUnresolved: boolean
  /** True when the clip ends on `.`/`!`/`?` or a long pause. */
  endedOnCompleteThought: boolean
  /** True when the clip could not be grown to MIN_CLIP_MS. */
  tooShort: boolean
}

/**
 * Deterministic boundary refinement (D1–D4, D6). The LLM never supplies a millisecond — it
 * supplies sentence indices, and every timestamp below is derived from our own word table.
 */
export function refineClipBoundaries(
  words: Word[],
  sentences: Sentence[],
  startSentenceIndex: number,
  endSentenceIndex: number,
  opts?: { minMs?: number; maxMs?: number },
): RefinedBoundary | null {
  if (sentences.length === 0 || words.length === 0) return null

  const minMs = opts?.minMs ?? MIN_CLIP_MS
  const maxMs = opts?.maxMs ?? MAX_CLIP_MS
  const last = sentences.length - 1

  let startIdx = Math.max(0, Math.min(startSentenceIndex, last))
  let endIdx = Math.max(0, Math.min(endSentenceIndex, last))
  if (endIdx < startIdx) [startIdx, endIdx] = [endIdx, startIdx]

  const span = (a: number, b: number): number => sentences[b]!.endMs - sentences[a]!.startMs

  // D2 — expand backwards while the opener depends on earlier context.
  let expansions = 0
  while (
    expansions < MAX_BACKWARD_SENTENCES &&
    startIdx > 0 &&
    startsWithDanglingReference(sentences[startIdx]!) &&
    span(startIdx - 1, endIdx) <= maxMs
  ) {
    startIdx--
    expansions++
  }
  const danglingUnresolved = startsWithDanglingReference(sentences[startIdx]!)

  // D4 — extend forward to land on a complete thought.
  const completeAt = (idx: number): boolean => {
    const s = sentences[idx]!
    if (s.endsWithTerminator) return true
    const next = sentences[idx + 1]
    return next === undefined || next.startMs - s.endMs >= COMPLETE_THOUGHT_PAUSE_MS
  }
  const endSearchLimit = sentences[endIdx]!.endMs + END_SEARCH_MS
  while (
    !completeAt(endIdx) &&
    endIdx < last &&
    sentences[endIdx + 1]!.endMs <= endSearchLimit &&
    span(startIdx, endIdx + 1) <= maxMs
  ) {
    endIdx++
  }

  // D6 — length clamp. Trim from the end so the hook at the start survives.
  while (span(startIdx, endIdx) > maxMs && endIdx > startIdx) endIdx--
  // The growth loop needs its own maxMs guard, or reaching the minimum can push the range back
  // over the maximum and leave endSentenceIndex pointing past where the cut actually lands.
  while (span(startIdx, endIdx) < minMs && endIdx < last && span(startIdx, endIdx + 1) <= maxMs) {
    endIdx++
  }

  // D1 — snap to real word edges.
  const firstWordIndex = sentences[startIdx]!.firstWordIndex
  const firstWord = words[firstWordIndex]
  let lastWordIndex = sentences[endIdx]!.lastWordIndex
  if (!firstWord || !words[lastWordIndex]) return null

  const leadWord = words[firstWordIndex - 1]
  const leadGap = leadWord ? Math.max(0, firstWord.startMs - leadWord.endMs) : LEAD_IN_MS
  const startMs = Math.max(0, firstWord.startMs - Math.min(LEAD_IN_MS, Math.floor(leadGap / 2)))

  // A single sentence longer than maxMs is the only way to reach a hard clamp. Pull back to the
  // last word that fits rather than cutting at an arbitrary millisecond, so the export never
  // ends mid-word.
  let truncatedMidSentence = false
  if (words[lastWordIndex]!.endMs - startMs > maxMs) {
    const limit = startMs + maxMs
    while (lastWordIndex > firstWordIndex && words[lastWordIndex]!.endMs > limit) lastWordIndex--
    // Not even the first word fits the hard limit — the timestamps are unusable, so drop the
    // candidate rather than emit a clip that breaks the length contract or cuts mid-word.
    if (words[lastWordIndex]!.endMs > limit) return null
    truncatedMidSentence = lastWordIndex < sentences[endIdx]!.lastWordIndex
  }

  const lastWord = words[lastWordIndex]
  if (!lastWord) return null

  // D3 — move the cut into the surrounding pause, never past its midpoint.
  const trailWord = words[lastWordIndex + 1]
  const tailGap = trailWord ? Math.max(0, trailWord.startMs - lastWord.endMs) : TAIL_MS
  let endMs = lastWord.endMs + Math.min(TAIL_MS, Math.floor(tailGap / 2))
  // `lastWord.endMs` is already inside the limit, so this only trims padding, never a word.
  if (endMs - startMs > maxMs) endMs = startMs + maxMs
  if (endMs <= startMs) return null

  const durationMs = Math.round(endMs) - Math.round(startMs)

  // Quality metadata is computed from the FINAL boundary. Capturing it before the D6 clamp let a
  // clip be extended onto an unterminated sentence and still report a complete ending.
  return {
    startMs: Math.round(startMs),
    endMs: Math.round(endMs),
    durationMs,
    startSentenceIndex: startIdx,
    endSentenceIndex: endIdx,
    danglingUnresolved,
    endedOnCompleteThought: completeAt(endIdx) && !truncatedMidSentence,
    tooShort: durationMs < minMs,
  }
}

export interface QualityGateResult {
  passed: boolean
  reasons: string[]
  /** Non-blocking defects. Feed the eval harness's cold-open rate; never drop a clip. */
  warnings: string[]
}

/**
 * B13 — the absolute gate. Deterministic checks only; the LLM's own opinion enters as a
 * calibrated binary (`strong`), never as a numeric threshold (C8). A project is allowed to
 * yield two clips, or zero.
 *
 * Only defects with no available repair block a clip. A dangling opener is a *warning*: D2
 * already attempted the repair, and rejecting on it would be the hard blacklist we ruled out —
 * it discards good content because of where the model's range happened to start, and a clip
 * beginning at sentence 0 has nothing to expand into and could never pass.
 */
export function passesQualityGate(
  boundary: RefinedBoundary,
  llmMarkedStrong: boolean,
): QualityGateResult {
  const reasons: string[] = []
  const warnings: string[] = []

  if (!llmMarkedStrong) reasons.push("not marked strong")
  if (boundary.tooShort) reasons.push(`shorter than ${MIN_CLIP_MS}ms`)
  if (!boundary.endedOnCompleteThought) reasons.push("does not end on a complete thought")

  if (boundary.danglingUnresolved) warnings.push("opens mid-thought after backward expansion")

  return { passed: reasons.length === 0, reasons, warnings }
}
