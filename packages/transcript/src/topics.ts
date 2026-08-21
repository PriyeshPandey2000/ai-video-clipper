// Node-only (ONNX model file resolution) — not renderer-safe, unlike sentences.ts/boundaries.ts
// in this package. Do not value-import this file from the renderer without a source alias.
import { join } from "node:path"
import type { Sentence } from "@video-editor/types"

export interface TopicSegment {
  sentences: Sentence[]
  startMs: number
  endMs: number
}

const MODEL_ID = "Xenova/all-MiniLM-L6-v2"

// TextTiling parameters
const WINDOW_SIZE = 3 // sentences on each side of each boundary candidate
const SMOOTHING_ROUNDS = 2
const MIN_SEGMENT_SENTENCES = 4 // discard boundaries that produce micro-segments
const MIN_CONTENT_MS = 2 * 60 * 1000 // skip segmentation for very short content

type Extractor = (
  texts: string[],
  opts: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][] }>

let cachedExtractor: Extractor | null = null
let cachedDir: string | null = null

async function getExtractor(modelsDir: string): Promise<Extractor> {
  if (cachedExtractor && cachedDir === modelsDir) return cachedExtractor
  // Dynamic import keeps onnxruntime-node out of the startup critical path.
  const { pipeline, env } = await import("@huggingface/transformers")
  env.cacheDir = join(modelsDir, "sbert")
  const p = await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" })
  cachedExtractor = p as unknown as Extractor
  cachedDir = modelsDir
  return cachedExtractor
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom < 1e-10 ? 0 : dot / denom
}

function mean(vecs: number[][]): number[] {
  if (vecs.length === 0) return []
  const dim = vecs[0]!.length
  const out = new Array<number>(dim).fill(0)
  for (const v of vecs) for (let i = 0; i < dim; i++) out[i]! += v[i]!
  return out.map((x) => x / vecs.length)
}

/** Similarity at each potential boundary: cosine between the W-sentence blocks on each side. */
function blockSims(embs: number[][], W: number): number[] {
  const n = embs.length
  const sims: number[] = []
  for (let k = W; k < n - W; k++) {
    sims.push(cosine(mean(embs.slice(k - W, k)), mean(embs.slice(k, k + W))))
  }
  return sims // sims[i] corresponds to boundary at sentence index i + W
}

function smooth(arr: number[], rounds: number): number[] {
  let cur = [...arr]
  for (let r = 0; r < rounds; r++) {
    const next = [...cur]
    for (let i = 1; i < cur.length - 1; i++) {
      next[i] = (cur[i - 1]! + cur[i]! + cur[i + 1]!) / 3
    }
    cur = next
  }
  return cur
}

/**
 * TextTiling depth score: how deep of a valley is position k relative to the peaks on each
 * side? Walks outward from k in each direction until the similarity stops rising.
 */
function depthScores(sims: number[]): number[] {
  return sims.map((val, k) => {
    let lp = val
    for (let i = k - 1; i >= 0; i--) {
      if (sims[i]! >= lp) lp = sims[i]!
      else break
    }
    let rp = val
    for (let i = k + 1; i < sims.length; i++) {
      if (sims[i]! >= rp) rp = sims[i]!
      else break
    }
    return lp + rp - 2 * val
  })
}

/**
 * Finds topic boundary positions (indices into the original sentences array) where depth
 * exceeds mean + 0.5σ and is a local maximum (no adjacent boundary emitted).
 */
function findBoundaries(sims: number[], W: number): number[] {
  const smoothed = smooth(sims, SMOOTHING_ROUNDS)
  const depths = depthScores(smoothed)
  if (depths.length === 0) return []

  const mu = depths.reduce((a, b) => a + b, 0) / depths.length
  const sigma = Math.sqrt(depths.reduce((a, b) => a + (b - mu) ** 2, 0) / depths.length)
  const threshold = mu + 0.5 * sigma

  const boundaries: number[] = []
  for (let i = 0; i < depths.length; i++) {
    if (depths[i]! <= threshold) continue
    const prev = i > 0 ? depths[i - 1]! : -Infinity
    const next = i < depths.length - 1 ? depths[i + 1]! : -Infinity
    if (depths[i]! >= prev && depths[i]! >= next) {
      boundaries.push(i + W)
    }
  }
  return boundaries
}

function buildSegments(sentences: Sentence[], boundaries: number[]): TopicSegment[] {
  const cuts = [0, ...boundaries, sentences.length]
  const segs: TopicSegment[] = []
  for (let i = 0; i < cuts.length - 1; i++) {
    const slice = sentences.slice(cuts[i]!, cuts[i + 1]!)
    if (slice.length === 0) continue
    segs.push({
      sentences: slice,
      startMs: slice[0]!.startMs,
      endMs: slice[slice.length - 1]!.endMs,
    })
  }
  return segs
}

/**
 * When a segment exceeds maxMs, split it at the deepest valley within its own sim profile.
 * Recurses until all pieces fit or they're too short to split further.
 */
function splitAtDeepestValley(
  sentences: Sentence[],
  allEmbs: number[][],
  globalOffset: number,
  maxMs: number,
): TopicSegment[] {
  if (sentences.length < WINDOW_SIZE * 2 + 1) {
    return [
      { sentences, startMs: sentences[0]!.startMs, endMs: sentences[sentences.length - 1]!.endMs },
    ]
  }

  const localEmbs = allEmbs.slice(globalOffset, globalOffset + sentences.length)
  const sims = blockSims(localEmbs, WINDOW_SIZE)
  if (sims.length === 0) {
    return [
      { sentences, startMs: sentences[0]!.startMs, endMs: sentences[sentences.length - 1]!.endMs },
    ]
  }

  // Deepest valley = minimum similarity
  let minIdx = 0
  for (let i = 1; i < sims.length; i++) {
    if (sims[i]! < sims[minIdx]!) minIdx = i
  }
  const splitAt = minIdx + WINDOW_SIZE // index into `sentences` local array

  const left = sentences.slice(0, splitAt)
  const right = sentences.slice(splitAt)
  const result: TopicSegment[] = []

  for (const [half, offset] of [
    [left, 0],
    [right, splitAt],
  ] as [Sentence[], number][]) {
    if (half.length === 0) continue
    const seg: TopicSegment = {
      sentences: half,
      startMs: half[0]!.startMs,
      endMs: half[half.length - 1]!.endMs,
    }
    if (seg.endMs - seg.startMs > maxMs && half.length >= WINDOW_SIZE * 2 + 1) {
      result.push(...splitAtDeepestValley(half, allEmbs, globalOffset + offset, maxMs))
    } else {
      result.push(seg)
    }
  }
  return result
}

/**
 * Segments `sentences` into topically coherent groups using the TextTiling algorithm with
 * SBERT block similarity (Solbiati 2021). Falls back to a single segment if the ONNX model
 * is unavailable or the content is too short to segment meaningfully.
 *
 * Any segment exceeding `maxSegmentMs` is recursively split at its deepest internal valley,
 * so callers can rely on the output fitting context-window constraints.
 */
export async function segmentTopics(
  sentences: Sentence[],
  modelsDir: string,
  maxSegmentMs = 20 * 60 * 1000,
): Promise<TopicSegment[]> {
  const whole: TopicSegment =
    sentences.length > 0
      ? { sentences, startMs: sentences[0]!.startMs, endMs: sentences[sentences.length - 1]!.endMs }
      : { sentences: [], startMs: 0, endMs: 0 }

  if (sentences.length < WINDOW_SIZE * 2 + 1) return sentences.length > 0 ? [whole] : []

  const totalMs = whole.endMs - whole.startMs
  if (totalMs < MIN_CONTENT_MS) return [whole]

  let extractor: Extractor
  try {
    extractor = await getExtractor(modelsDir)
  } catch (err) {
    console.warn("[topics] SBERT model unavailable, falling back to a single segment:", err)
    return [whole]
  }

  let embs: number[][]
  try {
    const out = await extractor(
      sentences.map((s) => s.text),
      { pooling: "mean", normalize: true },
    )
    embs = out.tolist()
  } catch (err) {
    console.warn("[topics] embedding extraction failed, falling back to a single segment:", err)
    return [whole]
  }

  const sims = blockSims(embs, WINDOW_SIZE)
  const rawBoundaries = findBoundaries(sims, WINDOW_SIZE)

  // Remove boundaries that would produce a segment smaller than MIN_SEGMENT_SENTENCES.
  const filtered: number[] = []
  for (const b of rawBoundaries) {
    const prev = filtered[filtered.length - 1] ?? 0
    if (b - prev >= MIN_SEGMENT_SENTENCES && sentences.length - b >= MIN_SEGMENT_SENTENCES) {
      filtered.push(b)
    }
  }

  const segments = buildSegments(sentences, filtered)

  // Recursively split any segment that still exceeds maxSegmentMs.
  const result: TopicSegment[] = []
  for (const seg of segments) {
    if (seg.endMs - seg.startMs > maxSegmentMs) {
      const globalOffset = seg.sentences[0]!.index
      result.push(...splitAtDeepestValley(seg.sentences, embs, globalOffset, maxSegmentMs))
    } else {
      result.push(seg)
    }
  }
  return result
}
