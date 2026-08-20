import { describe, it, expect, vi, beforeEach } from "vitest"
import { z } from "zod"

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }))

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>()
  return { ...actual, generateText: generateTextMock }
})

// createAiClient throws without a key unless one is passed explicitly in config, so every test
// below passes apiKey directly rather than relying on GROQ_API_KEY being set in the environment.
import { createAiClient } from "./client"

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
