import { describe, it, expect } from "vitest"
import type { Word, Sentence } from "@video-editor/types"
import { buildSentences } from "@video-editor/transcript"
import type { TopicSegment } from "@video-editor/transcript"
import type { AiClient } from "./client"
import { selectClips } from "./clip-selector"

function transcript(count: number): Word[] {
  const words: Word[] = []
  let ms = 0
  for (let i = 0; i < count; i++) {
    const phrase =
      i % 3 === 0
        ? `Nobody expected outcome number ${i} to happen.`
        : i % 3 === 1
          ? `So then everything changed in year ${i}.`
          : `Revenue tripled after change number ${i}.`
    for (const token of phrase.split(" ")) {
      words.push({
        id: `w${words.length}`,
        projectId: "p",
        text: token,
        startMs: ms,
        endMs: ms + 300,
        confidence: 0.9,
        speakerLabel: null,
      })
      ms += 350
    }
    ms += 400
  }
  return words
}

// 1400 phrases ≈ 64 min, comfortably past the 30-min chunking threshold.
const words = transcript(1400)
const sentences = buildSentences(words)

type Handler = (prompt: string) => unknown

function mockClient(handler: Handler, prompts: string[] = []): AiClient {
  return {
    provider: "groq",
    textModel: "mock",
    structuredModel: "mock",
    async complete() {
      return ""
    },
    async generateObject({ prompt }) {
      prompts.push(prompt)
      return handler(prompt) as never
    },
  }
}

function range(prompt: string): [number, number] | null {
  const m = prompt.match(/Sentences #(\d+) to #(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2])]
}

const twoPerChunk: Handler = (prompt) => {
  const r = range(prompt)
  if (!r) return { ranking: [] } // re-ranking call — return empty so reRankWithBorda falls back
  const [lo, hi] = r
  return {
    clips: [
      {
        startSentence: lo,
        endSentence: Math.min(lo + 12, hi),
        title: `clip-${lo}`,
        reason: "r",
        strong: true,
        platform: "shorts",
      },
      {
        startSentence: Math.min(lo + 40, hi),
        endSentence: Math.min(lo + 52, hi),
        title: `clip2-${lo}`,
        reason: "r",
        strong: true,
        platform: "shorts",
      },
    ],
  }
}

describe("chunking — fixed fallback (no topics)", () => {
  it("splits long transcripts into overlapping chunks covering the whole video", async () => {
    const prompts: string[] = []
    await selectClips(mockClient(twoPerChunk, prompts), words, sentences)
    // Filter to generation prompts only — re-ranking prompts have a different format (C2).
    const ranges = prompts.map(range).filter((r): r is [number, number] => r !== null)

    expect(ranges.length).toBeGreaterThan(1)
    expect(ranges[0]![0]).toBe(0)
    expect(ranges.at(-1)![1]).toBe(sentences.length - 1)
    expect(ranges[1]![0]).toBeLessThan(ranges[0]![1]) // overlap
  })
})

function topicsFromSentences(sents: Sentence[], segmentCount: number): TopicSegment[] {
  const perSegment = Math.ceil(sents.length / segmentCount)
  const segments: TopicSegment[] = []
  for (let i = 0; i < sents.length; i += perSegment) {
    const slice = sents.slice(i, i + perSegment)
    if (slice.length === 0) continue
    segments.push({
      sentences: slice,
      startMs: slice[0]!.startMs,
      endMs: slice[slice.length - 1]!.endMs,
    })
  }
  return segments
}

describe("chunking — topic-coherent (C5)", () => {
  it("carries overlap across a topic-segment boundary, same as the fixed-time fallback", async () => {
    // 8 small topic segments over the ~64min transcript forces multiple chunk flushes.
    const topics = topicsFromSentences(sentences, 8)
    const prompts: string[] = []
    await selectClips(mockClient(twoPerChunk, prompts), words, sentences, topics)
    const ranges = prompts.map(range).filter((r): r is [number, number] => r !== null)

    expect(ranges.length).toBeGreaterThan(1)
    expect(ranges[0]![0]).toBe(0)
    expect(ranges.at(-1)![1]).toBe(sentences.length - 1)
    // Regression check: topic chunking used to have zero overlap between chunks, unlike the
    // fixed-time fallback below — a clip straddling a boundary was invisible to both calls.
    // Sentence indices are inclusive, so a one-sentence overlap (nextStart === previousEnd)
    // is valid too — check every adjacent boundary, not just the first.
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]![0]).toBeLessThanOrEqual(ranges[i - 1]![1])
    }
  })
})

describe("output invariants", () => {
  it("emits clips inside the platform length window with no heavy overlap", async () => {
    const { clips } = await selectClips(mockClient(twoPerChunk), words, sentences)
    expect(clips.length).toBeGreaterThan(0)

    for (const c of clips) {
      expect(c.endMs).toBeGreaterThan(c.startMs)
      expect(c.startMs).toBeGreaterThanOrEqual(0)
      expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(15_000)
      expect(c.endMs - c.startMs).toBeLessThanOrEqual(90_000)
    }

    for (let i = 0; i < clips.length; i++) {
      for (let j = i + 1; j < clips.length; j++) {
        const a = clips[i]!
        const b = clips[j]!
        const start = Math.max(a.startMs, b.startMs)
        const end = Math.min(a.endMs, b.endMs)
        const ratio =
          end <= start ? 0 : (end - start) / Math.min(a.endMs - a.startMs, b.endMs - b.startMs)
        expect(ratio).toBeLessThanOrEqual(0.5)
      }
    }
  })

  it("derives display scores from rank, descending (C8)", async () => {
    const { clips } = await selectClips(mockClient(twoPerChunk), words, sentences)
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i]!.score).toBeLessThanOrEqual(clips[i - 1]!.score)
    }
  })
})

describe("C1 — hallucinated timestamps are structurally impossible", () => {
  it("ignores any millisecond field the model invents", async () => {
    const liar: Handler = (prompt) => {
      const r = range(prompt)
      if (!r) return { ranking: [] }
      const [lo, hi] = r
      return {
        clips: [
          {
            startSentence: lo,
            endSentence: Math.min(lo + 12, hi),
            startMs: 999_999_999,
            endMs: -5,
            title: "liar",
            reason: "r",
            strong: true,
            platform: "shorts",
          },
        ],
      }
    }
    const { clips } = await selectClips(mockClient(liar), words, sentences)
    expect(clips.length).toBeGreaterThan(0)
    for (const c of clips) {
      expect(c.startMs).toBeLessThan(999_999_999)
      expect(c.endMs).toBeGreaterThan(0)
    }
  })
})

describe("B13 — variable clip count", () => {
  it("returns zero clips when nothing is marked strong, with reasons", async () => {
    const weak: Handler = (prompt) => {
      const r = range(prompt)
      if (!r) return { ranking: [] }
      const [lo, hi] = r
      return {
        clips: [
          {
            startSentence: lo,
            endSentence: Math.min(lo + 12, hi),
            title: "weak",
            reason: "r",
            strong: false,
            platform: "shorts",
          },
        ],
      }
    }
    const { clips, rejected } = await selectClips(mockClient(weak), words, sentences)
    expect(clips).toHaveLength(0)
    expect(rejected[0]!.reasons).toContain("not marked strong")
  })

  it("handles an empty model response without throwing", async () => {
    const { clips } = await selectClips(
      mockClient(() => ({ clips: [] })),
      words,
      sentences,
    )
    expect(clips).toHaveLength(0)
  })
})

describe("hostile input", () => {
  it("survives out-of-range and reversed sentence indices", async () => {
    const insane: Handler = () => ({
      clips: [
        {
          startSentence: -50,
          endSentence: 999_999,
          title: "oob",
          reason: "r",
          strong: true,
          platform: "shorts",
        },
        {
          startSentence: 900,
          endSentence: 100,
          title: "reversed",
          reason: "r",
          strong: true,
          platform: "shorts",
        },
      ],
    })
    const { clips } = await selectClips(mockClient(insane), words, sentences)
    // Assert the count first, or the loop below silently passes if a regression empties `clips`.
    expect(clips.length).toBeGreaterThan(0)
    for (const c of clips) {
      expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(15_000)
      expect(c.endMs - c.startMs).toBeLessThanOrEqual(90_000)
    }
  })

  it("returns nothing for an empty transcript", async () => {
    const { clips } = await selectClips(
      mockClient(() => ({ clips: [] })),
      [],
      [],
    )
    expect(clips).toHaveLength(0)
  })
})

describe("chunk failure isolation", () => {
  it("keeps clips from other chunks when one chunk's generateObject call fails every attempt", async () => {
    const flaky: Handler = (prompt) => {
      const r = range(prompt)
      if (!r) return { ranking: [] } // re-ranking call
      // This mock stands in for the whole AiClient, so it bypasses createGroqClient's own
      // internal retry (covered separately in client.test.ts) — this test is only about the
      // outer per-chunk try/catch in selectClips: does the very first chunk failing outright
      // still let later chunks' clips through, instead of aborting the whole run.
      const [lo] = r
      if (lo === 0) throw new Error("simulated malformed JSON")
      return twoPerChunk(prompt)
    }
    const { clips } = await selectClips(mockClient(flaky), words, sentences)
    // First chunk's candidates are lost, but later chunks still produced clips — selectClips
    // didn't abort the whole run when one chunk failed.
    expect(clips.length).toBeGreaterThan(0)
  })
})
