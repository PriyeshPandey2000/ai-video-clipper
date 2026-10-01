import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { z } from "zod"

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }))

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return { ...actual, generateText: generateTextMock }
})

// createAiClient throws without a key unless one is passed explicitly in config, so every test
// below passes apiKey directly rather than relying on GROQ_API_KEY being set in the environment.
import { createAiClient, CLIP_SELECTION_TEMPERATURE } from "./client"

describe("generateObject retry", () => {
  beforeEach(() => {
    generateTextMock.mockReset()
  })

  it("retries a malformed/failed response and succeeds once the model recovers", async () => {
    generateTextMock
      .mockRejectedValueOnce(new Error("malformed JSON"))
      .mockRejectedValueOnce(new Error("malformed JSON"))
      .mockResolvedValueOnce({ output: { ok: true } })

    const client = createAiClient({ apiKey: "test-key" })
    const result = await client.generateObject({
      prompt: "p",
      schema: z.object({ ok: z.boolean() }),
    })

    expect(result).toEqual({ ok: true })
    expect(generateTextMock).toHaveBeenCalledTimes(3)
  })

  it("throws the last error once every retry attempt is exhausted", async () => {
    generateTextMock.mockRejectedValue(new Error("persistently malformed"))

    const client = createAiClient({ apiKey: "test-key" })
    await expect(
      client.generateObject({ prompt: "p", schema: z.object({ ok: z.boolean() }) }),
    ).rejects.toThrow("persistently malformed")
    // 3 attempts total (initial + 2 retries), not unbounded and not a single shot.
    expect(generateTextMock).toHaveBeenCalledTimes(3)
  })

  it("does not retry at all on the first successful call", async () => {
    generateTextMock.mockResolvedValueOnce({ output: { ok: true } })

    const client = createAiClient({ apiKey: "test-key" })
    await client.generateObject({ prompt: "p", schema: z.object({ ok: z.boolean() }) })

    expect(generateTextMock).toHaveBeenCalledTimes(1)
  })
})

describe("clip-selection determinism (#97/#90)", () => {
  beforeEach(() => {
    generateTextMock.mockReset()
  })

  it("pins temperature on every structured call instead of letting the provider choose", async () => {
    // Unpinned temperature is why two runs over the same transcript were not comparable: the
    // provider picked, so a report could never tell a config change from sampling noise.
    generateTextMock.mockResolvedValue({ output: { ok: true } })

    const client = createAiClient({ apiKey: "test-key" })
    expect(client.temperature).toBe(CLIP_SELECTION_TEMPERATURE)
    await client.generateObject({ prompt: "p", schema: z.object({ ok: z.boolean() }) })

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: CLIP_SELECTION_TEMPERATURE }),
    )
  })
})

describe("CLIP_MODEL override (#97)", () => {
  const original = process.env["CLIP_MODEL"]
  afterEach(() => {
    if (original === undefined) delete process.env["CLIP_MODEL"]
    else process.env["CLIP_MODEL"] = original
  })

  it("switches the structured model from the environment, with no code edit", async () => {
    // The 5-video comparison in #97 switches models by restarting the app; a rebuild per model
    // would defeat the point of having a comparable report at all.
    process.env["CLIP_MODEL"] = "llama-3.3-70b-versatile"
    const client = createAiClient({ apiKey: "test-key" })
    expect(client.structuredModel).toBe("llama-3.3-70b-versatile")
  })

  it("prefers explicit config over the environment", async () => {
    // Precedence has to be unambiguous, or a test run with CLIP_MODEL set could silently test a
    // different model than the caller asked for.
    process.env["CLIP_MODEL"] = "from-env"
    const client = createAiClient({ apiKey: "test-key", structuredModel: "from-config" })
    expect(client.structuredModel).toBe("from-config")
  })

  it("falls back to the default when neither is set", () => {
    delete process.env["CLIP_MODEL"]
    const client = createAiClient({ apiKey: "test-key" })
    expect(client.structuredModel).toBe("openai/gpt-oss-120b")
  })

  it("falls back to the default when the variable is set but empty", () => {
    // `CLIP_MODEL=` with no value is a typo, not an instruction to use the empty model. With
    // `??` the blank name was passed through and every call failed, which — before the
    // all-chunks-failed fix — meant an API error silently replaced the user's suggestions.
    process.env["CLIP_MODEL"] = ""
    const client = createAiClient({ apiKey: "test-key" })
    expect(client.structuredModel).toBe("openai/gpt-oss-120b")
  })

  it("does not let a blank CLIP_MODEL win over explicit config", () => {
    process.env["CLIP_MODEL"] = ""
    const client = createAiClient({ apiKey: "test-key", structuredModel: "from-config" })
    expect(client.structuredModel).toBe("from-config")
  })
})
