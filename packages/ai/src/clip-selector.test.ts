import { describe, it, expect } from "vitest"
import type { Word, Sentence } from "@video-editor/types"
import { buildSentences } from "@video-editor/transcript"
import type { TopicSegment } from "@video-editor/transcript"
import type { AiClient } from "./client"
import { CLIP_SELECTION_TEMPERATURE } from "./client"
import {
  selectClips,
  computePipelineFingerprint,
  PIPELINE_FINGERPRINT,
  PIPELINE_VERSION,
} from "./clip-selector"
import type { TraceEntry } from "./clip-selector"
import { CLIP_PROFILES } from "./profiles"
import { UNIVERSAL_JUDGE_QUESTIONS } from "./clip-judge"
import { vi } from "vitest"
import type { JudgeGrade } from "./clip-judge"

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

/** The classifier's answer when a test has no opinion. `solo_opinion` is the documented default. */
export const defaultAnalysis = {
  profile: "solo_opinion",
  confidence: "high",
  summary: "A single speaker argues a case to camera.",
  speakers: [{ role: "Host" }],
  mainTopics: ["hooks"],
}

/**
 * Routes the classification call (#98) separately from the selection and re-ranking calls.
 *
 * selectClips now opens with one structured call, and every handler in this file matches on the
 * *selection* prompt's "Sentences #N to #M" or returns a ranking shape. Handing those a
 * classification response would make every test fail in a way that says nothing about the test, so
 * the analysis prompt is recognised by its leading marker and answered from its own handler.
 */
function mockClient(
  handler: Handler,
  prompts: string[] = [],
  analysisHandler: Handler = () => defaultAnalysis,
  systems: string[] = [],
  judgeHandler: JudgeHandler = allYes,
): AiClient {
  return {
    provider: "groq",
    textModel: "mock",
    structuredModel: "mock",
    // Mirrors the real client so tests see the same determinism the pipeline now relies on.
    temperature: CLIP_SELECTION_TEMPERATURE,
    async complete() {
      return ""
    },
    async generateObject({ prompt, system }) {
      prompts.push(prompt)
      // Recorded separately because the rubric is a system-prompt concern: asserting on `prompts`
      // alone would only ever see the user half of what the model read.
      if (system) systems.push(system)
      if (prompt.startsWith(ANALYSIS_PROMPT_MARKER)) return analysisHandler(prompt) as never
      // #99 — the judge call. Recognised by the fence the judge prompt wraps the clip in.
      if (prompt.includes("[CLIP STARTS]")) return judgeHandler(prompt, system ?? "") as never
      return handler(prompt) as never
    },
  }
}

type JudgeHandler = (prompt: string, system: string) => unknown

/** Question ids the judge was asked, read back out of its own system prompt. */
function questionIds(system: string): string[] {
  const ids: string[] = []
  for (const m of system.matchAll(/^- ([\w.]+): /gm)) ids.push(m[1]!)
  return ids
}

/** A judge answer giving `grade` to every question, or `grade(id)` per question. */
function judgement(
  system: string,
  grade: JudgeGrade | ((id: string) => JudgeGrade),
  extra: Record<string, unknown> = {},
) {
  const answers: Record<string, JudgeGrade> = {}
  for (const id of questionIds(system)) answers[id] = typeof grade === "string" ? grade : grade(id)
  return { answers, note: "A fine clip.", ...extra }
}

const allYes: JudgeHandler = (_prompt, system) => judgement(system, "yes")

/** First sentence index of the clip a judge prompt is about — what the judge is looking at. */
function clipStart(prompt: string): number {
  const m = prompt.match(/\[CLIP STARTS\]\n#(\d+)/)
  return m ? Number(m[1]) : -1
}

/** No waiting in tests. */
const noSleep = { sleep: async () => {} }

/** `analyzeVideo` prefixes its prompt with this; no selection or ranking prompt begins with it. */
const ANALYSIS_PROMPT_MARKER = "TRANSCRIPT"

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

  it("scores clips with the judge's score, not their rank (#99)", async () => {
    // Every answer "partly" is 0.5 whatever the position. The old rank-derived score gave the top
    // clip 1.0 even when the whole batch was mediocre.
    const meh: JudgeHandler = (_p, system) => judgement(system, "partly")
    const { clips } = await selectClips(
      mockClient(twoPerChunk, [], undefined, [], meh),
      words,
      sentences,
    )
    expect(clips.length).toBeGreaterThan(0)
    for (const c of clips) expect(c.score).toBe(0.5)
  })

  it("orders clips by score, best first", async () => {
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
  it("returns zero clips when the judge says none stand alone, with reasons", async () => {
    const noStandalone: JudgeHandler = (_p, system) =>
      judgement(system, (id) => (id === "standalone" ? "no" : "yes"))
    const { clips, rejected } = await selectClips(
      mockClient(twoPerChunk, [], undefined, [], noStandalone),
      words,
      sentences,
    )
    expect(clips).toHaveLength(0)
    expect(rejected.length).toBeGreaterThan(0)
    expect(rejected[0]!.reasons).toContain("fails standalone")
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

    // Not prompts[0]: the classification call now precedes every selection prompt, so the first
    // recorded prompt is the analysis, which contains none of these tokens.
    const prompt = prompts.find((p) => range(p) !== null)!
    // Every hostile token survives exactly as written.
    for (const token of hostile) {
      expect(prompt).toContain(token)
    }
    // "$$" must not have collapsed to "$"...
    expect(prompt).toContain("$$1.4M")
    expect(prompt).not.toContain(" to $1.4M ")
    // ...and "$'" must not have spliced the rest of the template in after the transcript.
    // The template's tail ("List every plausible clip") belongs at the very end, once.
    expect(prompt.match(/List every plausible clip/g) ?? []).toHaveLength(1)
    expect(prompt).not.toMatch(
      /it's fine and left\.[\s\S]*List every plausible clip[\s\S]*List every plausible clip/,
    )
    // The real placeholders were still substituted — spoken "{{MIN_SEC}}" must not become "15".
    expect(prompt).toContain("roughly 15")
    expect(prompt).toContain("The minimum is {{MIN_SEC}} seconds flat.")
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

// ─── Selection trace (#97) ──────────────────────────────────────────────────
// The trace exists so a run can be diagnosed after the fact. The property that makes it
// trustworthy is exhaustiveness: a candidate that silently vanishes from the trace is a
// candidate the report claims was never proposed, which is the exact misreading #97 was filed to
// prevent. Every test below is about coverage, not about any particular field's value.
describe("selection trace (#97)", () => {
  it("records one entry per candidate the model returned, in ranked order", async () => {
    const result = await selectClips(mockClient(twoPerChunk), words, sentences)
    const trace = result.trace!
    // twoPerChunk returns 2 candidates per chunk; the trace must account for every one.
    expect(trace.candidates).toHaveLength(trace.chunks.length * 2)
    expect(trace.sentenceCount).toBe(sentences.length)
    expect(trace.temperature).toBe(0)
  })

  it("accounts for every candidate: kept, or dropped with a named reason", async () => {
    const result = await selectClips(mockClient(twoPerChunk), words, sentences)
    const { candidates } = result.trace!
    const kept = candidates.filter((c) => c.outcome === "kept")

    // This is the invariant the whole report rests on.
    expect(kept).toHaveLength(result.clips.length)
    expect(candidates).toHaveLength(
      kept.length + result.rejected.length + dropWithoutRejection(candidates),
    )
  })

  it("gives every kept candidate a rank that matches its position in the output", async () => {
    const result = await selectClips(mockClient(twoPerChunk), words, sentences)
    // The trace lists candidates in generation order; ranks are positions in the ranked output.
    const kept = result
      .trace!.candidates.filter((c) => c.outcome === "kept")
      .sort((a, b) => a.finalRank! - b.finalRank!)
    expect(kept.map((c) => c.finalRank)).toEqual(kept.map((_, i) => i))
    // And the ranks point at the same clips, so the report's ranked table cannot drift from
    // what selectClips actually returned.
    expect(kept.map((c) => c.title)).toEqual(result.clips.map((c) => c.title))
  })

  it("records the transcript text inside the final boundary, not the requested sentence range", async () => {
    const result = await selectClips(mockClient(twoPerChunk), words, sentences)
    for (const c of result.trace!.candidates.filter((c) => c.outcome === "kept")) {
      expect(c.text).toBeTruthy()
      expect(c.text!.length).toBeGreaterThan(0)
      // Every word of the clip text must fall inside the boundary that was recorded for it.
      const wordsInClip = words.filter((w) => w.startMs >= c.startMs! && w.endMs <= c.endMs!)
      expect(c.text).toBe(wordsInClip.map((w) => w.text).join(" "))
    }
  })

  it("records judge rejections with the verdict, the answers and the boundary", async () => {
    const noPayoff: JudgeHandler = (_p, system) =>
      judgement(system, (id) => (id === "payoff" ? "no" : "yes"))
    const result = await selectClips(
      mockClient(twoPerChunk, [], undefined, [], noPayoff),
      words,
      sentences,
    )
    expect(result.clips).toHaveLength(0)
    const judged = result.trace!.candidates.filter((c) => c.outcome === "judge-rejected")
    expect(judged.length).toBeGreaterThan(0)
    // These are the fields that make "why was nothing kept" answerable.
    for (const c of judged) {
      expect(c.judgeReasons).toContain("fails payoff")
      expect(c.judge?.answers.payoff).toBe("no")
      expect(c.gate.passed).toBe(true)
      expect(c.boundary).not.toBeNull()
      expect(c.startTimecode).toMatch(/^\d+:\d{2}$/)
      expect(c.text).toBeTruthy()
      expect(c.finalRank).toBeNull()
    }
  })

  it("names the clip a duplicate was dropped against", async () => {
    // Chunk overlap deliberately produces duplicates at the seams. Before #97 these were a bare
    // `continue` — a candidate that passed the gate and was then discarded left no record at all,
    // so "the model proposed N clips" was unrecoverable.
    const result = await selectClips(mockClient(twoPerChunk), words, sentences)
    const dupes = result.trace!.candidates.filter((c) => c.outcome === "duplicate")
    for (const d of dupes) {
      expect(d.duplicateOf).toBeTruthy()
      expect(d.gate.passed).toBe(true)
      // The clip it lost to is a survivor, and appears before it in the ranked output.
      expect(result.clips.find((c) => c.title === d.duplicateOf)).toBeDefined()
    }
  })

  it("records the chunk layout and each chunk's candidate count", async () => {
    const result = await selectClips(mockClient(twoPerChunk), words, sentences)
    const { chunks, candidates } = result.trace!
    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i)
      expect(c.lastSentence).toBeGreaterThanOrEqual(c.firstSentence)
    })
    // Chunk candidate counts must sum to the trace total — a chunk that returned candidates the
    // trace never mentions would make the report internally inconsistent.
    expect(chunks.reduce((n, c) => n + c.candidateCount, 0)).toBe(candidates.length)
  })

  it("records over-budget candidates instead of silently stopping at the clip cap", async () => {
    // The loop used to `break` at maxClips, so the remaining ranked candidates were never
    // examined. They are now recorded, which is what distinguishes "the model didn't propose it"
    // from "we had already filled the quota".
    const short = transcript(200)
    const result = await selectClips(mockClient(twoPerChunk), short, buildSentences(short), [], 2)
    expect(result.clips.length).toBeLessThanOrEqual(2)
    const over = result.trace!.candidates.filter((c) => c.outcome === "over-budget")
    for (const c of over) {
      expect(c.finalRank).toBeNull()
      expect(c.duplicateOf).toBeNull()
    }
  })

  it("still reports on an empty transcript, rather than omitting the trace entirely", async () => {
    const result = await selectClips(
      mockClient(() => ({ clips: [] })),
      [],
      [],
    )
    expect(result.trace).toEqual({
      temperature: 0,
      sentenceCount: 0,
      chunks: [],
      candidates: [],
      judgeQuestions: expect.any(Array),
    })
  })

  it("keeps the trace optional in the type but always present at runtime", async () => {
    // ClipSelectionResult.trace is `?` so existing callers that only want clips compile
    // unchanged — but selectClips must never actually omit it, or a report would quietly lose
    // its entire candidate table.
    const result = await selectClips(mockClient(twoPerChunk), words, sentences)
    expect(result.trace).toBeDefined()
  })

  it("hashes the temperature, so runs differing only in it cannot share a fingerprint", async () => {
    // The half of #90 that #97 owns. Before this, temperature was never sent and never hashed:
    // two runs could differ purely by sampling noise and still be filed under one hash, which
    // makes a stored clip's behaviour unattributable — the one thing the hash exists to prevent.
    expect(CLIP_SELECTION_TEMPERATURE).toBe(0)
    // The default parameter is the constant the client sends, so the exported fingerprint and the
    // live call cannot drift apart.
    expect(computePipelineFingerprint(10)).toBe(PIPELINE_FINGERPRINT)
    expect(computePipelineFingerprint(10, CLIP_SELECTION_TEMPERATURE)).toBe(PIPELINE_FINGERPRINT)
    // And moving it moves the digest.
    expect(computePipelineFingerprint(10, 0.7)).not.toBe(PIPELINE_FINGERPRINT)
  })
})

/** Candidates that left without a `rejected` entry: duplicates and over-budget. */
function dropWithoutRejection(candidates: TraceEntry[]): number {
  return candidates.filter(
    (c) =>
      c.outcome !== "kept" &&
      c.outcome !== "gate-rejected" &&
      c.outcome !== "invalid-range" &&
      c.outcome !== "judge-rejected" &&
      c.outcome !== "judge-failed",
  ).length
}

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
// A chunk whose model call never succeeds. This is the shape every real API outage takes at the
// loop level — a bad key, a rate limit, a dropped connection, a misspelled CLIP_MODEL — and it is
// the case that used to be indistinguishable from a legitimately empty selection.
describe("chunk failure is not an empty selection (#97)", () => {
  const alwaysFails: Handler = () => {
    throw new Error("429 rate limit reached")
  }

  it("throws when every chunk failed, rather than returning zero clips", async () => {
    // The whole point: a caller that swaps the user's clips for this result would wipe them,
    // and report success. Failing loudly is what makes the run a no-op instead.
    await expect(
      selectClips(mockClient(alwaysFails), words, sentences, [], 10, [], null, noSleep),
    ).rejects.toThrow(/all \d+ chunk\(s\)/)
  })

  it("says what actually went wrong, so the error is diagnosable", async () => {
    await expect(
      selectClips(mockClient(alwaysFails), words, sentences, [], 10, [], null, noSleep),
    ).rejects.toThrow(/rate limit/)
  })

  it("does not mistake a genuinely empty answer for a failure", async () => {
    // The model answering "nothing here" is a real result, and an over-eager guard would turn a
    // quiet video into an error the user cannot act on.
    const nothing: Handler = (prompt) => (range(prompt) ? { clips: [] } : { ranking: [] })
    const result = await selectClips(mockClient(nothing), words, sentences)
    expect(result.clips).toEqual([])
    expect(result.trace!.chunks.length).toBeGreaterThan(0)
    expect(result.trace!.chunks.every((c) => !c.failed)).toBe(true)
  })

  it("succeeds when only some chunks failed, keeping the chunks that answered", async () => {
    const seen: number[] = []
    const flaky: Handler = (prompt) => {
      const r = range(prompt)
      if (!r) return { ranking: [] }
      seen.push(r[0])
      if (seen.length % 2 === 0) throw new Error("504 gateway timeout")
      return twoPerChunk(prompt)
    }
    const result = await selectClips(mockClient(flaky), words, sentences)
    // Partial failure is not failure — the clips that came back are real.
    expect(result.clips.length).toBeGreaterThan(0)
    const trace = result.trace!
    expect(trace.chunks.some((c) => c.failed)).toBe(true)
    expect(trace.chunks.some((c) => !c.failed)).toBe(true)
    // Every failed chunk records why, and every successful one records that it did not fail.
    for (const c of trace.chunks) {
      expect(typeof c.failed).toBe("boolean")
      if (c.failed) expect(c.error).toMatch(/timeout/)
    }
  })

  it("distinguishes a failed chunk from an empty one in the trace", async () => {
    // Both look like candidateCount: 0. Without the flag the report cannot answer "why did the
    // long video yield two clips", which is the question the report exists for.
    const flaky: Handler = (prompt) => {
      const r = range(prompt)
      if (!r) return { ranking: [] }
      if (r[0] === 0) throw new Error("invalid api key")
      return { clips: [] } // answered, with nothing
    }
    const result = await selectClips(mockClient(flaky), words, sentences)
    const chunks = result.trace!.chunks
    expect(chunks.find((c) => c.firstSentence === 0)?.failed).toBe(true)
    expect(chunks.find((c) => c.firstSentence !== 0)?.failed).toBe(false)
  })
})

describe("pipeline provenance (#89)", () => {
  // Answers the classification call like mockClient does, so a test that only cares about
  // provenance does not also have to be a test of analyzeVideo.
  const stubClient = (structuredModel = "test/model") =>
    ({
      provider: "groq",
      textModel: "test/model",
      structuredModel,
      temperature: CLIP_SELECTION_TEMPERATURE,
      complete: async () => "",
      generateObject: async ({ prompt }: { prompt: string }) =>
        prompt.startsWith("TRANSCRIPT") ? defaultAnalysis : { clips: [] },
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
    // #98 — no transcript means no classification, so the profile is the documented fallback and
    // says so. Silently reporting a profile the model never chose would be indistinguishable from
    // a real detection in both this result and the report.
    expect(result.contentType).toBe("solo_opinion")
    expect(result.analysis.fallback).toBe(true)
    expect(result.contentTypeOverridden).toBe(false)
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

  it("takes the profile from the classifier, not from wording in the transcript (#98)", async () => {
    // This transcript is the exact input that motivated the issue: it is full of "step one" and
    // "how to", so the old regex detector called it educational and applied the tutorial rubric —
    // whose "never clip a partial step" rule suppresses exactly the beats worth clipping.
    //
    // The assertion is deliberately inverted: given step-by-step *wording*, the profile must still
    // be whatever the classifier said. If someone reintroduced keyword detection over the
    // transcript, this fails, which is the point.
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

    const result = await selectClips(
      mockClient(twoPerChunk, [], () => ({
        ...defaultAnalysis,
        profile: "conversation",
        confidence: "medium",
      })),
      words,
      buildSentences(words),
    )
    expect(result.contentType).toBe("conversation")
    expect(result.analysis.profile).toBe("conversation")
    expect(result.contentTypeOverridden).toBe(false)
  })

  it("reports the override as an override rather than as the model's answer (#98)", async () => {
    const words = transcript(120)
    const sentences = buildSentences(words)
    const result = await selectClips(
      mockClient(twoPerChunk),
      words,
      sentences,
      [],
      10,
      [],
      "comedy",
    )
    // The stored analysis still records what the classifier detected; only the effective profile
    // changes. A report or UI that read the analysis alone would tell the user the wrong reason
    // for the clips on screen.
    expect(result.contentType).toBe("comedy")
    expect(result.analysis.profile).toBe("solo_opinion")
    expect(result.contentTypeOverridden).toBe(true)
  })

  it("falls back to solo_opinion without failing the run when classification throws (#98)", async () => {
    const words = transcript(120)
    const sentences = buildSentences(words)
    const result = await selectClips(
      mockClient(twoPerChunk, [], () => {
        throw new Error("model unavailable")
      }),
      words,
      sentences,
      [],
      10,
      [],
    )
    // The point of the fallback: one failed call must not cost the user their whole selection run.
    expect(result.contentType).toBe("solo_opinion")
    expect(result.analysis.fallback).toBe(true)
    expect(result.analysis.confidence).toBe("low")
    expect(result.contentTypeOverridden).toBe(false)
  })

  it("prepends the video context to every selection prompt (#98)", async () => {
    const prompts: string[] = []
    await selectClips(mockClient(twoPerChunk, prompts), words, sentences, [], 10)
    const selectionPrompts = prompts.filter((p) => range(p) !== null)
    expect(selectionPrompts.length).toBeGreaterThan(1)
    for (const prompt of selectionPrompts) {
      expect(prompt).toContain("VIDEO CONTEXT")
      expect(prompt).toContain("A single speaker argues a case to camera.")
    }
  })

  it("appends the effective profile's rubric to the selection system prompt (#98)", async () => {
    const prompts: string[] = []
    const systems: string[] = []
    await selectClips(
      mockClient(twoPerChunk, prompts, undefined, systems),
      words,
      sentences,
      [],
      10,
    )
    const rubric = CLIP_PROFILES.solo_opinion.rubric
    const selectionSystems = systems.filter((s) => s.includes(rubric))
    // The rubric is what actually changes selection behaviour, so its presence is the assertion —
    // not merely that *some* profile block was attached. One system prompt per chunk.
    expect(selectionSystems.length).toBe(prompts.filter((p) => range(p) !== null).length)
  })

  it("uses the override's rubric, not the detected profile's (#98)", async () => {
    const prompts: string[] = []
    const systems: string[] = []
    await selectClips(
      mockClient(twoPerChunk, prompts, undefined, systems),
      words,
      sentences,
      [],
      10,
      [],
      "comedy",
    )
    // Counted against the selection prompts, so "one rubric per chunk" is checked rather than
    // merely "the right rubric appears somewhere in the run".
    const chunkCount = prompts.filter((p) => range(p) !== null).length
    const selectionSystems = systems.filter((s) => s.includes(CLIP_PROFILES.comedy.rubric))
    expect(selectionSystems.length).toBe(chunkCount)
    for (const system of selectionSystems) {
      // The detected profile's rubric must be absent, not merely unmentioned: a prompt carrying
      // both would be the two-rubric blend the issue explicitly ruled out.
      expect(system).not.toContain(CLIP_PROFILES.solo_opinion.rubric)
    }
  })

  it("changes the fingerprint when a rubric changes (#98)", () => {
    // Two runs are only comparable if a rubric edit moves the hash. Profiles are passed by
    // reference, so mutating the table's copy is enough to prove the rubrics are hashed at all.
    const original = CLIP_PROFILES.solo_opinion.rubric
    try {
      CLIP_PROFILES.solo_opinion.rubric = "a different rubric entirely"
      expect(computePipelineFingerprint(10)).not.toBe(PIPELINE_FINGERPRINT)
    } finally {
      CLIP_PROFILES.solo_opinion.rubric = original
    }
  })
})

// ─── Judge, global ranking, failure handling (#99) ───────────────────────────
describe("judging and global ranking (#99)", () => {
  it("ranks clips from all chunks together, not by per-chunk quota", async () => {
    // The judge likes clips late in the video. Round-robin interleaving would have put chunk 0's
    // first pick on top; global ranking puts the best-judged clip on top wherever it sits.
    const lateIsBetter: JudgeHandler = (prompt, system) => {
      const late = clipStart(prompt) > sentences.length * 0.66
      return judgement(system, late ? "yes" : "partly")
    }
    const { clips, trace } = await selectClips(
      mockClient(twoPerChunk, [], undefined, [], lateIsBetter),
      words,
      sentences,
    )
    expect(clips.length).toBeGreaterThan(2)
    expect(clips[0]!.score).toBe(1)
    // The best clips are late ones, several of them, ahead of every early clip.
    const lastFirstEarly = clips.findIndex((c) => c.score < 1)
    expect(lastFirstEarly).toBeGreaterThan(1)
    expect(clips[0]!.startMs).toBeGreaterThan(words[Math.floor(words.length * 0.5)]!.startMs)
    // And each kept candidate's finalRank is its position in the returned list.
    const kept = trace!.candidates
      .filter((c) => c.outcome === "kept")
      .sort((a, b) => a.finalRank! - b.finalRank!)
    expect(kept.map((c) => c.title)).toEqual(clips.map((c) => c.title))
  })

  it("rejects a clip that fails a hard question even when everything else is perfect", async () => {
    const result = await selectClips(
      mockClient(twoPerChunk, [], undefined, [], (_p, system) =>
        judgement(system, (id) => (id === "payoff" ? "no" : "yes")),
      ),
      words,
      sentences,
    )
    expect(result.clips).toHaveLength(0)
    expect(result.rejected.every((r) => r.reasons.includes("fails payoff"))).toBe(true)
  })

  it("lets a hard question that is only 'partly' through", async () => {
    const result = await selectClips(
      mockClient(twoPerChunk, [], undefined, [], (_p, system) =>
        judgement(system, (id) => (id === "payoff" ? "partly" : "yes")),
      ),
      words,
      sentences,
    )
    expect(result.clips.length).toBeGreaterThan(0)
    expect(result.clips[0]!.score).toBeLessThan(1)
  })

  it("keeps the higher-scored clip of two overlapping ones, whichever the model listed first", async () => {
    // Two overlapping ranges in one short video. The model lists the weaker one first.
    const short = transcript(120)
    const shortSentences = buildSentences(short)
    const overlapping: Handler = () => ({
      clips: [
        { startSentence: 0, endSentence: 14, title: "weaker", reason: "r", platform: "shorts" },
        { startSentence: 6, endSentence: 20, title: "stronger", reason: "r", platform: "shorts" },
      ],
    })
    const prefersSecond: JudgeHandler = (prompt, system) =>
      judgement(system, clipStart(prompt) <= 3 ? "partly" : "yes")
    const { clips, trace } = await selectClips(
      mockClient(overlapping, [], undefined, [], prefersSecond),
      short,
      shortSentences,
    )
    expect(clips.map((c) => c.title)).toEqual(["stronger"])
    const weaker = trace!.candidates.find((c) => c.title === "weaker")!
    expect(weaker.outcome).toBe("duplicate")
    expect(weaker.duplicateOf).toBe("stronger")
  })

  it("shows the judge the exported text, with the lead-in fenced off", async () => {
    const prompts: string[] = []
    const result = await selectClips(mockClient(twoPerChunk, prompts), words, sentences)
    const judgePrompts = prompts.filter((p) => p.includes("[CLIP STARTS]"))
    expect(judgePrompts.length).toBeGreaterThan(0)
    const first = judgePrompts[0]!
    expect(first).toContain("[BEFORE CLIP — the viewer does NOT see this]")
    expect(first).toContain("VIDEO CONTEXT")
    // The clip block is the words inside the final boundary — compare against the trace's text.
    const clipBlock = first.split("[CLIP STARTS]\n")[1]!.split("\n[CLIP ENDS]")[0]!
    const flat = clipBlock
      .split("\n")
      .map((l) => l.replace(/^#\d+ /, ""))
      .join(" ")
    const entry = result.trace!.candidates.find((c) => c.text === flat)
    expect(entry).toBeDefined()
  })

  it("asks the effective profile's questions, not just the universal set", async () => {
    const systems: string[] = []
    const { trace } = await selectClips(
      mockClient(twoPerChunk, [], undefined, systems),
      words,
      sentences,
      [],
      10,
      [],
      "comedy",
    )
    const ids = trace!.judgeQuestions.map((q) => q.id)
    expect(ids).toEqual(expect.arrayContaining(UNIVERSAL_JUDGE_QUESTIONS.map((q) => q.id)))
    expect(ids.filter((id) => id.startsWith("comedy_"))).toHaveLength(
      CLIP_PROFILES.comedy.judgeQuestions.length,
    )
    expect(systems.some((s) => s.includes("comedy_1"))).toBe(true)
  })

  it("never uses randomness in the selection path", async () => {
    const random = vi.spyOn(Math, "random")
    await selectClips(mockClient(twoPerChunk), words, sentences)
    expect(random).not.toHaveBeenCalled()
    random.mockRestore()
  })

  it("is deterministic: the same answers produce the same ranking on every run", async () => {
    const a = await selectClips(mockClient(twoPerChunk), words, sentences)
    const b = await selectClips(mockClient(twoPerChunk), words, sentences)
    expect(a.clips.map((c) => [c.title, c.startMs, c.score])).toEqual(
      b.clips.map((c) => [c.title, c.startMs, c.score]),
    )
  })
})

describe("judge failure handling (#99)", () => {
  it("retries a rate-limited judge call and keeps the clip", async () => {
    let limited = 0
    const flaky: JudgeHandler = (_p, system) => {
      if (limited++ === 0) throw Object.assign(new Error("Too Many Requests"), { statusCode: 429 })
      return judgement(system, "yes")
    }
    const result = await selectClips(
      mockClient(twoPerChunk, [], undefined, [], flaky),
      words,
      sentences,
      [],
      10,
      [],
      null,
      noSleep,
    )
    expect(result.trace!.candidates.some((c) => c.outcome === "judge-failed")).toBe(false)
    expect(result.clips.length).toBeGreaterThan(0)
  })

  it("rejects only the candidate whose judge call keeps failing", async () => {
    const seen = new Set<number>()
    const oneBad: JudgeHandler = (prompt, system) => {
      const start = clipStart(prompt)
      if (seen.size === 0) seen.add(start)
      if (seen.has(start)) throw new Error("model exploded")
      return judgement(system, "yes")
    }
    const result = await selectClips(
      mockClient(twoPerChunk, [], undefined, [], oneBad),
      words,
      sentences,
      [],
      10,
      [],
      null,
      noSleep,
    )
    const failed = result.trace!.candidates.filter((c) => c.outcome === "judge-failed")
    expect(failed.length).toBeGreaterThan(0)
    expect(failed[0]!.judgeReasons[0]).toMatch(/model exploded/)
    expect(failed[0]!.judge).toBeNull()
    expect(result.clips.length).toBeGreaterThan(0)
  })

  it("throws when most judge calls fail, so a re-run keeps the previous suggestions", async () => {
    const alwaysBad: JudgeHandler = () => {
      throw new Error("judge model unavailable")
    }
    await expect(
      selectClips(
        mockClient(twoPerChunk, [], undefined, [], alwaysBad),
        words,
        sentences,
        [],
        10,
        [],
        null,
        noSleep,
      ),
    ).rejects.toThrow(/judging failed/i)
  })

  it("retries 429s on chunk generation too", async () => {
    let first = true
    const limitedOnce: Handler = (prompt) => {
      if (first && range(prompt)) {
        first = false
        throw Object.assign(new Error("rate limit"), { statusCode: 429 })
      }
      return twoPerChunk(prompt)
    }
    const result = await selectClips(
      mockClient(limitedOnce),
      words,
      sentences,
      [],
      10,
      [],
      null,
      noSleep,
    )
    expect(result.trace!.chunks.every((c) => !c.failed)).toBe(true)
  })
})

describe("pipeline fingerprint covers the judge (#99)", () => {
  it("moves when a profile's judge question changes", () => {
    const changed = {
      ...CLIP_PROFILES,
      comedy: {
        ...CLIP_PROFILES.comedy,
        judgeQuestions: [...CLIP_PROFILES.comedy.judgeQuestions, "Is it funny?"],
      },
    }
    expect(computePipelineFingerprint(10, 0, changed)).not.toBe(computePipelineFingerprint(10, 0))
  })
})
