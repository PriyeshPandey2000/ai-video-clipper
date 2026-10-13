import { describe, it, expect } from "vitest"
import {
  scoreAnswers,
  failedHardQuestions,
  judgeQuestionsFor,
  renderJudgePrompt,
  aggregateJudgements,
  isClearlyDead,
  disagreementCounts,
  UNIVERSAL_JUDGE_QUESTIONS,
  type ClipJudgement,
  type JudgeGrade,
} from "./clip-judge"
import { parseClipJudge } from "@video-editor/types"
import { toJudgeRecord } from "./clip-judge"
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

  it("honours an HTTP-date retry-after, and falls back when the date is past or unparseable", async () => {
    const future = new Date(Date.now() + 7_000).toUTCString()
    const past = new Date(Date.now() - 60_000).toUTCString()

    const waitFor = async (value: string): Promise<number> => {
      const waits: number[] = []
      let calls = 0
      await withRateLimitRetry(
        async () => {
          if (calls++ === 0) {
            throw Object.assign(new Error("429"), {
              statusCode: 429,
              responseHeaders: { "retry-after": value },
            })
          }
          return "ok"
        },
        async (ms) => {
          waits.push(ms)
        },
      )
      return waits[0]!
    }

    // A future HTTP-date is honoured, landing just under the 7s it asked for.
    expect(await waitFor(future)).toBeGreaterThan(5_000)
    expect(await waitFor(future)).toBeLessThanOrEqual(7_000)
    // Past and unparseable dates get the default backoff, not a wait derived from garbage.
    expect(await waitFor(past)).toBe(RATE_LIMIT_POLICY.baseWaitMs)
    expect(await waitFor("not-a-date")).toBe(RATE_LIMIT_POLICY.baseWaitMs)
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

  it("tolerates a model echoing the '#N' label or leaving the '#' on", async () => {
    const { judgeClip } = await import("./clip-judge")
    const base = {
      questions,
      context: "ctx",
      words: [],
      sentences: [],
      boundary: { startMs: 0, endMs: 20000, startSentenceIndex: 4, endSentenceIndex: 9 },
    }
    const judge = async (bestOpeningSentence: unknown) =>
      judgeClip({
        ...base,
        client: {
          generateObject: async () =>
            ({
              answers: Object.fromEntries(questions.map((q) => [q.id, "yes"])),
              note: "n",
              bestOpeningSentence,
            }) as never,
        } as never,
      })

    expect((await judge("#7")).bestOpeningSentence).toBe(7)
    expect((await judge("7")).bestOpeningSentence).toBe(7)
    expect((await judge("# 8")).bestOpeningSentence).toBe(8)
    // Out-of-range and unparseable labels still become null, never a hallucinated opening.
    expect((await judge("#400")).bestOpeningSentence).toBeNull()
    expect((await judge("#2")).bestOpeningSentence).toBeNull()
    expect((await judge("second")).bestOpeningSentence).toBeNull()
    expect((await judge(true)).bestOpeningSentence).toBeNull()
  })
})

describe("stored judgement (#99)", () => {
  const record = toJudgeRecord(
    { answers: { hook: "yes", payoff: "no" }, note: "n", bestOpeningSentence: 7, score: 0.6 },
    questions.slice(0, 3),
  )

  it("copies the questions in, so a stored clip survives a change to the question set", () => {
    expect(record.questions).toEqual(
      questions.slice(0, 3).map((q) => ({ id: q.id, text: q.text, hard: q.hard })),
    )
  })

  it("round-trips through JSON", () => {
    expect(parseClipJudge(JSON.stringify(record))).toEqual(record)
  })

  it("returns null for a clip with no judgement instead of inventing one", () => {
    expect(parseClipJudge(null)).toBeNull()
    expect(parseClipJudge(undefined)).toBeNull()
    expect(parseClipJudge("")).toBeNull()
  })

  it("degrades unreadable or wrongly-shaped blobs to null, never throwing into the UI", () => {
    expect(parseClipJudge("{not json")).toBeNull()
    expect(parseClipJudge("null")).toBeNull()
    expect(parseClipJudge(JSON.stringify({ score: "high", answers: {}, questions: [] }))).toBeNull()
    expect(parseClipJudge(JSON.stringify({ score: 1, answers: {} }))).toBeNull()
  })

  it("tolerates a missing note or opening sentence", () => {
    const parsed = parseClipJudge(JSON.stringify({ score: 1, answers: {}, questions: [] }))
    expect(parsed?.note).toBe("")
    expect(parsed?.bestOpeningSentence).toBeNull()
  })
})

// ─── Voted judging (#125) — pure aggregation, no model calls ────────────────
const sample = (
  answers: Record<string, JudgeGrade>,
  score: number,
  note = "note",
  bestOpeningSentence: number | null = null,
): ClipJudgement => ({ answers, note, bestOpeningSentence, score })

describe("aggregateJudgements", () => {
  it("returns a single sample unchanged (not-resampled clips stay identical to today)", () => {
    const one = sample(all("yes"), 1)
    expect(aggregateJudgements([one])).toBe(one)
  })

  it("throws on zero samples — a vote needs at least one", () => {
    expect(() => aggregateJudgements([])).toThrow()
  })

  it("takes the median grade per question", () => {
    const out = aggregateJudgements([
      sample({ ...all("no"), hook: "yes" }, 0.2),
      sample({ ...all("no"), hook: "partly" }, 0.1),
      sample({ ...all("no"), hook: "no" }, 0.0),
    ])
    expect(out.answers.hook).toBe("partly") // median of yes, partly, no
  })

  it("scores as the mean of the per-sample scores, to 2dp", () => {
    expect(
      aggregateJudgements([sample(all("yes"), 1), sample(all("no"), 0), sample(all("partly"), 0.5)])
        .score,
    ).toBe(0.5)
    // 0.2, 0.5, 0.9 → 0.5333 → 0.53
    expect(
      aggregateJudgements([
        sample(all("yes"), 0.2),
        sample(all("yes"), 0.5),
        sample(all("yes"), 0.9),
      ]).score,
    ).toBe(0.53)
  })

  it("a hard gate rejects on 2 of 3 no but not on 1 of 3", () => {
    const oneNo = [
      sample({ ...all("yes"), payoff: "no" }, 0.6),
      sample(all("yes"), 1),
      sample(all("yes"), 1),
    ]
    expect(failedHardQuestions(aggregateJudgements(oneNo).answers, questions)).toEqual([])

    const twoNo = [
      sample({ ...all("yes"), payoff: "no" }, 0.4),
      sample({ ...all("yes"), payoff: "no" }, 0.4),
      sample(all("yes"), 1),
    ]
    expect(failedHardQuestions(aggregateJudgements(twoNo).answers, questions)).toEqual(["payoff"])
  })

  it("treats a question missing from some samples as no", () => {
    const out = aggregateJudgements([
      sample({ hook: "yes" }, 0.3), // only hook present
      sample(all("no"), 0),
      sample(all("no"), 0),
    ])
    expect(out.answers.hook).toBe("no") // yes, no, no → median no
    expect(out.answers.payoff).toBe("no") // absent every time → no
  })

  it("picks the modal best opening, ties toward the earlier sentence", () => {
    const out = aggregateJudgements([
      sample(all("yes"), 1, "a", 5),
      sample(all("yes"), 1, "b", 5),
      sample(all("yes"), 1, "c", 9),
    ])
    expect(out.bestOpeningSentence).toBe(5)
  })

  it("is null when no sample proposed an opening", () => {
    const out = aggregateJudgements([
      sample(all("yes"), 1, "a", null),
      sample(all("yes"), 1, "b", null),
      sample(all("yes"), 1, "c", null),
    ])
    expect(out.bestOpeningSentence).toBeNull()
  })

  it("takes the note from the sample closest to the mean score", () => {
    const out = aggregateJudgements([
      sample(all("yes"), 0.2, "low"),
      sample(all("yes"), 0.5, "mid"),
      sample(all("yes"), 0.9, "high"),
    ])
    expect(out.note).toBe("mid")
  })
})

describe("disagreementCounts", () => {
  it("counts, per question, how many voted clips disagreed on the grade", () => {
    const voted1 = [
      sample({ ...all("yes"), payoff: "no" }, 0.6),
      sample(all("yes"), 1),
      sample(all("yes"), 1),
    ]
    const voted2 = [sample(all("yes"), 1), sample(all("yes"), 1), sample(all("yes"), 1)]
    const counts = disagreementCounts([voted1, voted2], questions)
    const payoff = counts.find((c) => c.id === "payoff")!
    expect(payoff).toEqual({ id: "payoff", disagreed: 1, voted: 2 })
    const hook = counts.find((c) => c.id === "hook")!
    expect(hook).toEqual({ id: "hook", disagreed: 0, voted: 2 })
  })

  it("ignores single-sample clips (not voted)", () => {
    const counts = disagreementCounts([[sample(all("yes"), 1)]], questions)
    expect(counts.every((c) => c.voted === 0 && c.disagreed === 0)).toBe(true)
  })
})

describe("isClearlyDead", () => {
  it("is true below the score threshold", () => {
    expect(isClearlyDead(sample(all("no"), 0.1), questions)).toBe(true)
  })

  it("is true when both hard questions are no", () => {
    expect(
      isClearlyDead(sample({ ...all("yes"), standalone: "no", payoff: "no" }, 0.5), questions),
    ).toBe(true)
  })

  it("is false for one hard no at a decent score", () => {
    expect(isClearlyDead(sample({ ...all("yes"), payoff: "no" }, 0.6), questions)).toBe(false)
  })
})
