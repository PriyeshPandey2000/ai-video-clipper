import { describe, it, expect } from "vitest"
import {
  scoreAnswers,
  failedHardQuestions,
  judgeQuestionsFor,
  renderJudgePrompt,
  UNIVERSAL_JUDGE_QUESTIONS,
  type JudgeGrade,
} from "./clip-judge"
import { mapPool, isRateLimitError, withRateLimitRetry, RATE_LIMIT_POLICY } from "./concurrency"

const questions = UNIVERSAL_JUDGE_QUESTIONS
const all = (grade: JudgeGrade) => Object.fromEntries(questions.map((q) => [q.id, grade]))

describe("scoreAnswers", () => {
  it("is 1 for all yes, 0 for all no, 0.5 for all partly", () => {
    expect(scoreAnswers(all("yes"), questions)).toBe(1)
    expect(scoreAnswers(all("no"), questions)).toBe(0)
    expect(scoreAnswers(all("partly"), questions)).toBe(0.5)
  })

  it("weights hook and postable above oneIdea", () => {
    const loseOneIdea = { ...all("yes"), oneIdea: "no" as const }
    const loseHook = { ...all("yes"), hook: "no" as const }
    expect(scoreAnswers(loseHook, questions)).toBeLessThan(scoreAnswers(loseOneIdea, questions))
  })

  it("treats a missing answer as no", () => {
    expect(scoreAnswers({}, questions)).toBe(0)
  })

  it("puts 'partly' strictly between yes and no, so scores separate more finely than booleans", () => {
    const yes = scoreAnswers(all("yes"), questions)
    const partly = scoreAnswers({ ...all("yes"), hook: "partly" }, questions)
    const no = scoreAnswers({ ...all("yes"), hook: "no" }, questions)
    expect(no).toBeLessThan(partly)
    expect(partly).toBeLessThan(yes)
  })
})

describe("failedHardQuestions", () => {
  it("rejects on a clear no, not on partly", () => {
    expect(failedHardQuestions({ ...all("yes"), payoff: "no" }, questions)).toEqual(["payoff"])
    expect(failedHardQuestions({ ...all("yes"), payoff: "partly" }, questions)).toEqual([])
    expect(failedHardQuestions({ ...all("no"), hook: "no" }, questions).sort()).toEqual([
      "payoff",
      "standalone",
    ])
  })
})

describe("judgeQuestionsFor", () => {
  it("appends the profile's questions with positional ids", () => {
    const qs = judgeQuestionsFor({ id: "comedy", judgeQuestions: ["A?", "B?"] })
    expect(qs.slice(-2).map((q) => q.id)).toEqual(["comedy_1", "comedy_2"])
    expect(qs.slice(-2).every((q) => !q.hard)).toBe(true)
  })
})

describe("renderJudgePrompt", () => {
  it("keeps $ patterns and placeholder-looking text in spoken words literal", () => {
    const prompt = renderJudgePrompt({
      context: "Summary: it costs $$5 and {{CLIP}} is a word",
      seconds: 30,
      before: "earlier $' text {{BEFORE}}",
      clip: "#4 Revenue went to $$1.4M and {{SECONDS}} stayed",
    })
    expect(prompt).toContain("$$5 and {{CLIP}} is a word")
    expect(prompt).toContain("earlier $' text {{BEFORE}}")
    expect(prompt).toContain("Revenue went to $$1.4M and {{SECONDS}} stayed")
    expect(prompt.match(/\[CLIP STARTS\]/g)).toHaveLength(1)
    expect(prompt).toContain("Clip length: 30 seconds.")
  })
})

describe("mapPool", () => {
  it("returns results in input order regardless of finish order", async () => {
    const out = await mapPool([30, 1, 15], 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    expect(out).toEqual([30, 1, 15])
  })

  it("never runs more than the limit at once", async () => {
    let active = 0
    let peak = 0
    await mapPool(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 2))
        active--
      },
    )
    expect(peak).toBe(3)
  })
})

describe("rate limits", () => {
  it("recognises 429s however they are reported", () => {
    expect(isRateLimitError({ statusCode: 429 })).toBe(true)
    expect(isRateLimitError(new Error("Rate limit reached for model"))).toBe(true)
    expect(isRateLimitError({ message: "wrapped", cause: { status: 429 } })).toBe(true)
    expect(isRateLimitError(new Error("invalid api key"))).toBe(false)
  })

  it("honours retry-after and caps the wait", async () => {
    const waits: number[] = []
    let calls = 0
    const result = await withRateLimitRetry(
      async () => {
        if (calls++ < 2) {
          throw Object.assign(new Error("429"), {
            statusCode: 429,
            responseHeaders: { "retry-after": calls === 1 ? "3" : "999" },
          })
        }
        return "ok"
      },
      async (ms) => {
        waits.push(ms)
      },
    )
    expect(result).toBe("ok")
    expect(waits).toEqual([3000, RATE_LIMIT_POLICY.maxWaitMs])
  })

  it("backs off exponentially without a hint, and gives up after the attempt limit", async () => {
    const waits: number[] = []
    await expect(
      withRateLimitRetry(
        async () => {
          throw Object.assign(new Error("429"), { statusCode: 429 })
        },
        async (ms) => {
          waits.push(ms)
        },
      ),
    ).rejects.toThrow("429")
    expect(waits).toEqual([1000, 2000, 4000])
  })

  it("does not retry errors that are not rate limits", async () => {
    let calls = 0
    await expect(
      withRateLimitRetry(async () => {
        calls++
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(calls).toBe(1)
  })
})

describe("judge output tolerance", () => {
  it("accepts a null or hallucinated bestOpeningSentence without failing the judgement", async () => {
    const { judgeClip } = await import("./clip-judge")
    const base = {
      client: {
        generateObject: async () =>
          ({
            answers: Object.fromEntries(questions.map((q) => [q.id, "yes"])),
            note: " fine ",
            bestOpeningSentence: null,
          }) as never,
      } as never,
      questions,
      context: "ctx",
      words: [],
      sentences: [],
      boundary: { startMs: 0, endMs: 20000, startSentenceIndex: 4, endSentenceIndex: 9 },
    }
    const nullCase = await judgeClip(base)
    expect(nullCase.bestOpeningSentence).toBeNull()
    expect(nullCase.note).toBe("fine")

    const outside = await judgeClip({
      ...base,
      client: {
        generateObject: async () =>
          ({
            answers: Object.fromEntries(questions.map((q) => [q.id, "yes"])),
            note: "n",
            bestOpeningSentence: 400,
          }) as never,
      } as never,
    })
    expect(outside.bestOpeningSentence).toBeNull()
  })
})
