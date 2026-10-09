/**
 * #91. `recall-ablation` used to carry its own copy of SYSTEM_PROMPT — no signal tags, no context
 * block, no profile rubric, and a `strong` field the pipeline dropped in v3 — while its header
 * claimed it mirrored the pipeline "exactly". Every recall number it printed therefore described a
 * prompt that no longer shipped.
 *
 * These tests compare the strings the script builds against the strings `selectClips` actually put
 * on the wire for the same inputs. Either side changing on its own fails here, which is the only
 * thing that keeps the script honest — a comment cannot.
 */

import { describe, it, expect } from "vitest"
import type { AiClient } from "@video-editor/ai"
import { CLIP_PROFILES, CLIP_SELECTION_TEMPERATURE, selectClips } from "@video-editor/ai"
import { buildSentences } from "@video-editor/transcript"
import type { VideoAnalysis, Word } from "@video-editor/types"
import { buildReferencePrompt } from "./recall-ablation"

/** ~2.9s per phrase, so 40 phrases is under two minutes: one chunk, no chunking path. */
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

const words = transcript(40)
const sentences = buildSentences(words)

/**
 * Alternating quiet/loud seconds, so at least one sentence's mean sits well above its rolling
 * baseline and the `{loud}` tag is actually rendered. Without a tag in the output, equality would
 * pass on an empty arousal array and prove nothing about the loud path.
 */
const arousalPerSec = Array.from({ length: 400 }, (_, i) => (i % 10 < 5 ? 0 : 400))

/**
 * The analysis both sides receive. The mock answers with it, `analyzeVideo` strips the `fallback`
 * field its schema does not know and re-adds it, and the resulting object is this one — so feeding
 * it to `selectClips` and to `buildReferencePrompt` compares prompt assembly, not two inputs.
 */
const analysis: VideoAnalysis = {
  profile: "solo_opinion",
  confidence: "high",
  summary: "A single speaker argues a case to camera.",
  speakers: [{ role: "Host" }],
  mainTopics: ["hooks"],
  fallback: false,
}

interface Captured {
  prompt: string
  system: string | undefined
}

/**
 * Answers the classification call from `analysis` and records every selection call, returning a
 * valid empty candidate list — the tests here are about what the model is asked, not what it says.
 */
function captureClient(captured: Captured[]): AiClient {
  return {
    provider: "groq",
    textModel: "mock",
    structuredModel: "mock",
    temperature: CLIP_SELECTION_TEMPERATURE,
    async complete() {
      return ""
    },
    async generateObject({ prompt, system, schema }) {
      // Same routing the pipeline test harness uses: `analyzeVideo` is the only call whose prompt
      // begins with this marker, and handing it a candidate list would fail schema validation.
      // `analysis.fallback` is not part of `VideoAnalysisSchema`, so the parse drops it — which is
      // exactly what the real call returns before `analyzeVideo` re-adds it.
      if (prompt.startsWith("TRANSCRIPT")) return schema.parse(analysis) as never
      captured.push({ prompt, system })
      return schema.parse({ clips: [] }) as never
    },
  }
}

/** The one selection call `selectClips` makes when the transcript fits in a single chunk. */
async function runPipeline(captured: Captured[]): Promise<void> {
  await selectClips(captureClient(captured), words, sentences, [], 10, arousalPerSec, null, {
    sleep: async () => {},
  })
}

describe("recall-ablation prompt parity (#91)", () => {
  it("sends exactly the system and user prompt selectClips sends", async () => {
    const captured: Captured[] = []
    await runPipeline(captured)

    const selection = captured.filter((c) => c.prompt.includes("Sentences #"))
    expect(selection).toHaveLength(1)

    const reference = buildReferencePrompt({
      sentences,
      words,
      analysis,
      profileOverride: null,
      arousalPerSec,
    })

    expect(reference.system).toBe(selection[0]!.system)
    expect(reference.prompt).toBe(selection[0]!.prompt)
  })

  it("carries the parts the old inline copy was missing", () => {
    const reference = buildReferencePrompt({
      sentences,
      words,
      analysis,
      profileOverride: null,
      arousalPerSec,
    })

    // Context block — the old copy sent a bare transcript with no VIDEO CONTEXT line at all.
    expect(reference.prompt).toContain("VIDEO CONTEXT")
    // Profile rubric appended to the base system prompt (#98), what the issue called the
    // content-type suffix.
    expect(reference.system).toContain(CLIP_PROFILES.solo_opinion.rubric)
    // Signal tags in the rendered transcript, which the old copy never emitted. `{loud}` in
    // particular can only appear if the arousal array is threaded all the way through — without
    // it this prompt would silently lose a tag the pipeline sends.
    expect(reference.prompt).toMatch(/#\d+ \[\d+-\d+\]( \{[a-z:,]+\})+ /)
    expect(reference.prompt).toMatch(/\{[^}]*\bloud\b[^}]*\}/)
    // The summary line the old copy never sent, which is what actually distinguishes the two.
    expect(reference.prompt).toContain("Summary: A single speaker argues a case to camera.")
  })

  it("resolves the project's profile override like the pipeline does", async () => {
    const captured: Captured[] = []
    await selectClips(captureClient(captured), words, sentences, [], 10, arousalPerSec, "comedy", {
      sleep: async () => {},
    })
    const selection = captured.find((c) => c.prompt.includes("Sentences #"))!

    const reference = buildReferencePrompt({
      sentences,
      words,
      analysis,
      profileOverride: "comedy",
      arousalPerSec,
    })

    expect(reference.system).toBe(selection.system)
    expect(reference.prompt).toBe(selection.prompt)
    expect(reference.system).toContain(CLIP_PROFILES.comedy.rubric)
  })
})
