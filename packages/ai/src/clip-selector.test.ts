import { describe, it, expect } from "vitest"
import type { Word, Sentence } from "@video-editor/types"
import { buildSentences } from "@video-editor/transcript"
import type { TopicSegment } from "@video-editor/transcript"
import type { AiClient } from "./client"
import {
  selectClips,
  computePipelineFingerprint,
  PIPELINE_FINGERPRINT,
  PIPELINE_VERSION,
} from "./clip-selector"

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
  it("passes the transcript through verbatim when it contains $ and template syntax", async () => {
    // Regression: the transcript used to be substituted with String.replace, so replacement
    // patterns inside the *spoken* text were interpreted. "$$" collapsed to "$", and "$'"
    // spliced the remainder of the template into the middle of the sentence, silently handing the
    // model a garbled transcript. The transcript is now substituted last, via a function.
    const hostile: string[] = [
      "Revenue",
      "went",
      "from",
      "$0",
      "to",
      "$$1.4M",
      "and",
      "the",
      "growth",
      "was",
      "real.",
      "She",
      "said",
      "it's",
      "fine",
      "and",
      "left.",
      "The",
      "minimum",
      "is",
      "{{MIN_SEC}}",
      "seconds",
      "flat.",
    ]
    const w: Word[] = []
    let ms = 0
    for (const token of hostile) {
      w.push({
        id: `h${w.length}`,
        projectId: "p",
        text: token,
        startMs: ms,
        endMs: ms + 300,
        confidence: 0.9,
        speakerLabel: null,
      })
      ms += 350
    }

    const prompts: string[] = []
    await selectClips(
      mockClient(() => ({ clips: [] }), prompts),
      w,
      buildSentences(w),
    )

    const prompt = prompts[0]!
    // Every hostile token survives exactly as written.
    for (const token of hostile) {
      expect(prompt).toContain(token)
    }
    // "$$" must not have collapsed to "$"...
    expect(prompt).toContain("$$1.4M")
    expect(prompt).not.toContain(" to $1.4M ")
    // ...and "$'" must not have spliced the rest of the template in after the transcript.
    // The template's tail ("Select every clip worth posting") belongs at the very end, once.
    expect(prompt.match(/Select every clip worth posting/g) ?? []).toHaveLength(1)
    expect(prompt).not.toMatch(
      /it's fine and left\.[\s\S]*Select every clip worth posting[\s\S]*Select every clip worth posting/,
    )
    // The real placeholders were still substituted — spoken "{{MIN_SEC}}" must not become "15".
    expect(prompt).toContain("roughly 15")
    expect(prompt).toContain("The minimum is {{MIN_SEC}} seconds flat.")
  })

  it("renders rerank lines with literal braces in a title left untouched", async () => {
    // Regression: the rerank line used to be built by `.replace`-ing {ID}/{TITLE}/{REASON}
    // placeholders, so a model-authored title containing the literal text "{REASON}" made the
    // trailing replace consume the placeholder inside the title — the reason landed in the title
    // and a bare "{REASON}" was stranded at the end of the line.
    const hostile: Handler = (prompt) => {
      const r = range(prompt)
      if (!r) return { ranking: [0, 1] }
      const [lo, hi] = r
      return {
        clips: [
          {
            startSentence: lo,
            endSentence: Math.min(lo + 12, hi),
            title: "Use {REASON} and $' and $$ here",
            reason: "REAL-REASON",
            strong: true,
            platform: "shorts",
          },
          {
            startSentence: Math.min(lo + 40, hi),
            endSentence: Math.min(lo + 52, hi),
            title: "second",
            reason: "r2",
            strong: true,
            platform: "shorts",
          },
        ],
      }
    }

    const prompts: string[] = []
    await selectClips(mockClient(hostile, prompts), words, sentences)

    // The rerank call is the one whose payload is bare `id=N` lines, not a "Sentences #x to #y" header.
    const rerank = prompts.find((p) => /id=\d+ "/.test(p) && !/Sentences #/.test(p))
    expect(rerank).toBeDefined()
    // Braces, dollar-quote and doubled-dollar all survive as literal text...
    expect(rerank).toContain('"Use {REASON} and $\' and $$ here"')
    // ...and the real reason is present exactly once, in its own position after the dash.
    expect(rerank).toContain('" — REAL-REASON')
    expect(rerank!.match(/REAL-REASON/g) ?? []).toHaveLength(1)
  })

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

// ─── Pipeline fingerprint (#89) ─────────────────────────────────────────────
// The fingerprint is what makes a stored clip traceable to the config that produced it, so these
// tests are about it not going stale rather than about any particular digest value.
describe("pipeline provenance (#89)", () => {
  const stubClient = (structuredModel = "test/model") =>
    ({
      provider: "groq",
      textModel: "test/model",
      structuredModel,
      complete: async () => "",
      generateObject: async () => ({ clips: [] }),
    }) as unknown as AiClient

  it("is a sha256 hex digest", () => {
    expect(PIPELINE_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/)
  })

  it("exposes a hand-bumped version label", () => {
    expect(PIPELINE_VERSION).toMatch(/^v\d/)
  })

  it("returns provenance on the empty-transcript path, not just when clips exist", async () => {
    // A zero-sentence video returns early. If provenance were assembled after that early return,
    // the fields would be missing exactly when a caller is easiest to get wrong.
    const result = await selectClips(stubClient(), [], [])
    expect(result.clips).toEqual([])
    expect(result.pipelineHash).toBe(PIPELINE_FINGERPRINT)
    expect(result.pipelineVersion).toBe(PIPELINE_VERSION)
    expect(result.model).toBe("test/model")
    expect(result.contentType).toBe("generic")
  })

  it("records the structured model, not the text model", async () => {
    // Clip selection goes through generateObject, so the structured model is the one that served
    // it. Attributing a clip to the text model would make model comparisons meaningless.
    const result = await selectClips(stubClient("structured-only"), [], [])
    expect(result.model).toBe("structured-only")
  })

  it("fingerprint tracks the effective clip budget, not just the default", async () => {
    // ipc.ts passes maxClips explicitly, so a run with a different budget is a different
    // configuration and must not be filed under the default's hash.
    const words = transcript(120)
    const sentences = buildSentences(words)
    const at5 = await selectClips(stubClient(), words, sentences, [], 5)
    const at10 = await selectClips(stubClient(), words, sentences, [], 10)
    expect(at5.pipelineHash).not.toBe(at10.pipelineHash)
    expect(at10.pipelineHash).toBe(PIPELINE_FINGERPRINT)
    expect(at5.pipelineHash).toBe(computePipelineFingerprint(5))
  })

  it("detects the content type from the transcript rather than asserting the type is valid", async () => {
    // The previous version of this test asserted the result was one of the four ContentType
    // values, which the type system already guarantees — it could not fail. This feeds a
    // transcript with explicit step-by-step language and asserts the classifier commits to it.
    const words: Word[] = []
    let ms = 0
    const lines = [
      "Step one is to open the settings panel.",
      "Step two is to pick the model you want.",
      "Step three is to wait for the download.",
      "By the end of this video you will have it working.",
    ]
    for (const line of lines) {
      for (const token of line.split(" ")) {
        words.push({
          id: `t${words.length}`,
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
    const result = await selectClips(stubClient(), words, buildSentences(words))
    expect(result.contentType).toBe("tutorial")
  })
})
