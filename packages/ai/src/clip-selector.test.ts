import { describe, it, expect } from "vitest"
import type { Word } from "@video-editor/types"
import { buildSentences } from "@video-editor/transcript"
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

function range(prompt: string): [number, number] {
  const m = prompt.match(/Sentences #(\d+) to #(\d+)/)!
  return [Number(m[1]), Number(m[2])]
}

const twoPerChunk: Handler = (prompt) => {
  const [lo, hi] = range(prompt)
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

describe("chunking (C5 stopgap)", () => {
  it("splits long transcripts into overlapping chunks covering the whole video", async () => {
    const prompts: string[] = []
    await selectClips(mockClient(twoPerChunk, prompts), words, sentences)
    const ranges = prompts.map(range)

    expect(prompts.length).toBeGreaterThan(1)
    expect(ranges[0]![0]).toBe(0)
    expect(ranges.at(-1)![1]).toBe(sentences.length - 1)
    expect(ranges[1]![0]).toBeLessThan(ranges[0]![1]) // overlap
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
      const [lo, hi] = range(prompt)
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
      const [lo, hi] = range(prompt)
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
