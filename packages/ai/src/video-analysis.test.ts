import { describe, it, expect, vi } from "vitest"
import type { Sentence } from "@video-editor/types"
import type { TopicSegment } from "@video-editor/transcript"
import type { AiClient } from "./client"
import {
  analyzeVideo,
  buildAnalysisInput,
  fallbackAnalysis,
  renderVideoContext,
  videoContextSample,
} from "./video-analysis"
import { CLIP_PROFILES } from "./profiles"

/** Sentences at a fixed 2s stride, so time-window assertions are arithmetic rather than measured. */
function sentencesOver(minutes: number): Sentence[] {
  const out: Sentence[] = []
  for (let i = 0; i < minutes * 30; i++) {
    out.push({
      index: i,
      text: `sentence ${i}`,
      startMs: i * 2000,
      endMs: i * 2000 + 1500,
      words: [],
    } as unknown as Sentence)
  }
  return out
}

/**
 * A transcript long enough to force the excerpt path: the budget is 60k tokens at 4 chars per
 * token, so a full render has to exceed 240k characters before anything is dropped.
 *
 * 600 minutes at a 2s stride is 18,000 sentences, comfortably past that. The windows then land on
 * known indices — 5 min is sentence 150, and the 3-min tail is sentence 17,909 — so the assertions
 * below are arithmetic rather than measured.
 */
function longSentences(): Sentence[] {
  return sentencesOver(600)
}

function clientReturning(value: unknown): AiClient {
  return {
    provider: "groq",
    textModel: "mock",
    structuredModel: "mock",
    temperature: 0,
    complete: async () => "",
    // Validated against the schema the caller passed, as the real client is. Returning the raw
    // object instead would let a test pass on an answer the pipeline would reject — which is
    // precisely how the speaker/secondaryProfile bugs survived: every test supplied an answer that
    // happened to satisfy the schema, and nothing checked the shapes the model actually emits.
    generateObject: async ({ schema }: { schema: z.ZodType<unknown> }) =>
      schema.parse(value) as never,
  } as unknown as AiClient
}

describe("buildAnalysisInput", () => {
  it("passes a short transcript through whole", () => {
    const input = buildAnalysisInput(sentencesOver(2))
    expect(input.excerpted).toBe(false)
    expect(input.text).toContain("sentence 0")
    expect(input.text).toContain("sentence 58")
  })

  it("keeps the opening five minutes of a long transcript", () => {
    const input = buildAnalysisInput(longSentences())
    expect(input.excerpted).toBe(true)
    // 5 min at a 2s stride is sentence 150; the opening is kept, and well past it is dropped
    // unless the tail window or a topic sample reaches it.
    expect(input.text).toContain("sentence 0")
    expect(input.text).toMatch(/\bsentence 149\b/)
    expect(input.text).not.toMatch(/\bsentence 400\b/)
  })

  it("keeps the closing three minutes of a long transcript", () => {
    const input = buildAnalysisInput(longSentences())
    expect(input.text).toMatch(/\bsentence 17999\b/)
    expect(input.text).toMatch(/\bsentence 17910\b/)
    expect(input.text).not.toMatch(/\bsentence 17800\b/)
  })

  it("marks every omission so the model does not read across a gap as continuous speech", () => {
    const input = buildAnalysisInput(longSentences())
    const omissions = input.text.match(/\[\.\.\. transcript omitted here \.\.\.\]/g) ?? []
    // Without a marker, an unmarked jump from the opening to the closing reads as one continuous
    // argument — the classifier would judge continuity that does not exist.
    expect(omissions.length).toBeGreaterThanOrEqual(2)
    expect(input.text).toContain("EXCERPT")
  })

  it("marks a gap between kept sentences even when it is shorter than the tail window", () => {
    const sentences = longSentences()
    // Two topics a minute apart (30 sentences at a 2s stride), far from the head and tail. Each
    // contributes only its first three sentences, so sentences 1503..1529 are skipped between them.
    const topic = (from: number): TopicSegment => {
      const seg = sentences.slice(from, from + 30)
      return {
        sentences: seg,
        startMs: seg[0]!.startMs,
        endMs: seg[seg.length - 1]!.endMs,
        title: "t",
        keywords: [],
      } as unknown as TopicSegment
    }
    const input = buildAnalysisInput(sentences, [topic(1500), topic(1530)])
    const between = input.text.slice(
      input.text.indexOf("sentence 1502"),
      input.text.indexOf("sentence 1530"),
    )
    expect(between).toContain("[... transcript omitted here ...]")
  })

  it("samples the first three sentences of each topic, not the whole segment", () => {
    const sentences = longSentences()
    // A topic in the middle of the video, far from both the head and tail windows.
    const mid = sentences.slice(1500, 1530)
    const topics: TopicSegment[] = [
      {
        sentences: mid,
        startMs: mid[0]!.startMs,
        endMs: mid[mid.length - 1]!.endMs,
        title: "a middle topic",
        keywords: ["middle"],
      } as unknown as TopicSegment,
    ]
    const input = buildAnalysisInput(sentences, topics)
    expect(input.text).toContain("sentence 1500")
    expect(input.text).toContain("sentence 1502")
    expect(input.text).not.toContain("sentence 1503")
  })

  it("reports the character count it actually sent", () => {
    const input = buildAnalysisInput(longSentences())
    expect(input.charCount).toBe(input.text.length)
  })
})

describe("analyzeVideo", () => {
  const answer = {
    profile: "conversation",
    confidence: "high",
    summary: "Two founders argue about pricing.",
    speakers: [{ role: "host" }, { role: "guest" }],
    mainTopics: ["pricing", "fundraising"],
  }

  it("returns the classifier's answer", async () => {
    const result = await analyzeVideo(clientReturning(answer), sentencesOver(2))
    expect(result.profile).toBe("conversation")
    expect(result.confidence).toBe("high")
    expect(result.speakers).toHaveLength(2)
    expect(result.fallback).toBe(false)
  })

  it("makes no API call for an empty transcript", async () => {
    // Not just cheaper: `buildAnalysisInput` would render an empty transcript, and a model asked to
    // classify nothing returns something arbitrary rather than the documented default.
    const generateObject = vi.fn()
    const client = { generateObject } as unknown as AiClient
    const result = await analyzeVideo(client, [])
    expect(generateObject).not.toHaveBeenCalled()
    expect(result.fallback).toBe(true)
    expect(result.profile).toBe("solo_opinion")
  })

  it("falls back without throwing when the call fails for a reason a retry cannot fix", async () => {
    const client = {
      generateObject: async () => {
        throw new Error("model not found")
      },
    } as unknown as AiClient
    // Non-fatal is the whole requirement: one failed classification must not cost the user the
    // selection run that depends on it. A non-rate-limit error is rethrown by the retry wrapper at
    // once, so this stays a fast test as well.
    const result = await analyzeVideo(client, sentencesOver(2))
    expect(result.fallback).toBe(true)
    expect(result.confidence).toBe("low")
  })

  it("retries a rate-limit failure rather than silently downgrading the rubric", async () => {
    // Gate 1 regression. The analysis call was the one LLM call in the pipeline with no
    // rate-limit-aware retry, so a single 429 fell straight through to the fallback: the whole run
    // swapped onto `solo_opinion` and the report was marked FALLBACK for a transient window.
    let attempts = 0
    const client = {
      generateObject: async () => {
        attempts++
        if (attempts === 1) throw Object.assign(new Error("rate limit"), { statusCode: 429 })
        return answer as never
      },
    } as unknown as AiClient
    const waits: number[] = []
    const result = await analyzeVideo(client, sentencesOver(2), [], async (ms) => {
      waits.push(ms)
    })
    expect(attempts).toBe(2)
    expect(waits).toHaveLength(1)
    expect(result.fallback).toBe(false)
    expect(result.profile).toBe("conversation")
  })

  it("caps the reported speaker list", async () => {
    const speakers = Array.from({ length: 40 }, (_, i) => ({ role: `speaker ${i}` }))
    const result = await analyzeVideo(clientReturning({ ...answer, speakers }), sentencesOver(2))
    expect(result.speakers).toHaveLength(10)
  })

  it("keeps an optional secondary profile rather than dropping it", async () => {
    const result = await analyzeVideo(
      clientReturning({ ...answer, secondaryProfile: "educational" }),
      sentencesOver(2),
    )
    expect(result.secondaryProfile).toBe("educational")
  })

  // The two schema bugs behind every `fallback: true` report. Each of these is a perfectly correct
  // answer that `.optional()` and a strict object array rejected, so the call failed validation,
  // retried at temperature 0 with the same answer, and the video was silently classified as
  // solo_opinion with no summary.
  it("accepts speakers written as plain strings", async () => {
    const result = await analyzeVideo(
      clientReturning({ ...answer, speakers: ["host", "guest"] }),
      sentencesOver(2),
    )
    expect(result.fallback).toBe(false)
    // Normalised to the object shape, so nothing downstream has to handle both forms.
    expect(result.speakers).toEqual([{ role: "host" }, { role: "guest" }])
  })

  it("accepts a mixed speaker list of strings and objects", async () => {
    const result = await analyzeVideo(
      clientReturning({ ...answer, speakers: [{ role: "host" }, "guest"] }),
      sentencesOver(2),
    )
    expect(result.speakers).toEqual([{ role: "host" }, { role: "guest" }])
  })

  it("treats an explicit null secondary profile as absent", async () => {
    // `null` is the model's other way of saying "no second profile". `.optional()` rejects it while
    // accepting nothing, so a null cost the run its entire classification.
    const result = await analyzeVideo(
      clientReturning({ ...answer, secondaryProfile: null }),
      sentencesOver(2),
    )
    expect(result.fallback).toBe(false)
    expect(result.secondaryProfile).toBeUndefined()
  })

  it("keeps a real secondary profile sent alongside null speakers", async () => {
    const result = await analyzeVideo(
      clientReturning({ ...answer, secondaryProfile: "educational", speakers: [] }),
      sentencesOver(2),
    )
    expect(result.secondaryProfile).toBe("educational")
    expect(result.speakers).toEqual([])
  })

  it("still rejects a profile outside the known set", async () => {
    // The tolerance above is for shape, not for values: an unknown profile would break every
    // profile lookup downstream, so it has to keep failing.
    const client = clientReturning({ ...answer, profile: "documentary" })
    const result = await analyzeVideo(client, sentencesOver(2))
    expect(result.fallback).toBe(true)
  })

  it("shows the prompt an exact JSON answer shape", async () => {
    // The reason the prompt documents speakers as `{ "role": … }` but the model still answers with
    // strings: it was never shown what one looks like. Pinned so the example cannot be dropped.
    let seenSystem = ""
    const client = {
      generateObject: async ({ system }: { system?: string }) => {
        seenSystem = system ?? ""
        return answer as never
      },
    } as unknown as AiClient
    await analyzeVideo(client, sentencesOver(2))
    expect(seenSystem).toContain('"speakers": [{"role": "host"}')
    expect(seenSystem).toContain("secondaryProfile")
  })
})

describe("fallbackAnalysis", () => {
  it("is marked low-confidence and empty, so no prompt states a fact that was never established", () => {
    const result = fallbackAnalysis()
    expect(result).toMatchObject({
      profile: "solo_opinion",
      confidence: "low",
      summary: "",
      speakers: [],
      mainTopics: [],
      fallback: true,
    })
  })
})

describe("renderVideoContext", () => {
  const analysis = {
    profile: "conversation",
    confidence: "high",
    summary: "Two founders argue about pricing.",
    speakers: [{ role: "host" }, { role: "guest" }, { role: "host" }],
    mainTopics: ["pricing"],
    fallback: false,
  }

  it("carries the header, the profile, and the model's own description", () => {
    const block = renderVideoContext(analysis, { profileId: "conversation" })
    expect(block).toContain("VIDEO CONTEXT")
    expect(block).toContain("Conversation")
    expect(block).toContain("Two founders argue about pricing.")
    expect(block).toContain("pricing")
  })

  it("de-duplicates speakers, since a repeated role is one person", () => {
    expect(renderVideoContext(analysis, { profileId: "conversation" })).toContain(
      "Speakers: host, guest",
    )
  })

  it("names the effective profile when an override is in force", () => {
    // The context must describe the rubric that is actually in force, or the model is told to
    // select comedy while reading a conversation profile.
    const block = renderVideoContext(analysis, {
      profileId: "conversation",
      override: "comedy",
    })
    expect(block).toContain(CLIP_PROFILES.comedy.label)
    expect(block).not.toContain(`Profile: ${CLIP_PROFILES.conversation.label}`)
  })

  it("omits absent fields rather than printing empty ones", () => {
    // "Speakers: " reads as a fact about the video. An absent line is absent.
    const block = renderVideoContext(fallbackAnalysis(), { profileId: "solo_opinion" })
    expect(block).not.toContain("Speakers:")
    expect(block).not.toContain("Summary:")
    expect(block).not.toContain("Main topics:")
  })

  it("does not corrupt model-authored text containing replacement patterns", () => {
    // Regression class, same as {{TRANSCRIPT}}: "$$" and "$'" inside a summary must survive.
    const hostile = {
      ...analysis,
      summary: "Revenue went $$1.4M, and $' is not special here.",
    }
    const block = renderVideoContext(hostile, { profileId: "conversation" })
    expect(block).toContain("$$1.4M")
    expect(block).toContain("$' is not special here.")
  })

  it("does not let a summary inject another placeholder", () => {
    const hostile = { ...analysis, summary: "{{CONTEXT}} {{TRANSCRIPT}}" }
    const block = renderVideoContext(hostile, { profileId: "conversation" })
    // Substitution is via a function, so the text is inserted literally rather than re-scanned.
    expect(block).toContain("{{TRANSCRIPT}}")
  })
})

describe("videoContextSample", () => {
  it("renders the whole block so the fingerprint covers the format and not just the fields", () => {
    expect(videoContextSample()).toContain("VIDEO CONTEXT")
    expect(videoContextSample()).toContain("Speakers:")
  })
})
