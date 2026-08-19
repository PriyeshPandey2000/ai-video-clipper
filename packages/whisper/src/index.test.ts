import { describe, it, expect } from "vitest"
import { createProgressParser } from "./index"

describe("createProgressParser", () => {
  it("reports a single progress line", () => {
    const values: number[] = []
    const parse = createProgressParser((p) => values.push(p))
    parse("whisper_print_progress_callback: progress =  10%\n")
    expect(values).toEqual([0.1])
  })

  it("reports every line when several land in one chunk", () => {
    // Node's stream `data` event has no line-framing guarantee — a burst of fast writes can
    // arrive as a single chunk containing multiple complete lines.
    const values: number[] = []
    const parse = createProgressParser((p) => values.push(p))
    parse("progress = 10%\nprogress = 20%\nprogress = 30%\n")
    expect(values).toEqual([0.1, 0.2, 0.3])
  })

  it("reports a progress line split across two chunks", () => {
    const values: number[] = []
    const parse = createProgressParser((p) => values.push(p))
    parse("progress = 3")
    parse("0%\n")
    expect(values).toEqual([0.3])
  })

  it("reports correctly when a split line is followed by more complete lines", () => {
    const values: number[] = []
    const parse = createProgressParser((p) => values.push(p))
    parse("progress = 10%\nprogress = ")
    parse("20%\nprogress = 30%\n")
    expect(values).toEqual([0.1, 0.2, 0.3])
  })

  it("does not report a trailing line with no newline yet", () => {
    const values: number[] = []
    const parse = createProgressParser((p) => values.push(p))
    parse("progress = 10%\nprogress = 5")
    expect(values).toEqual([0.1])
    parse("0%\n")
    expect(values).toEqual([0.1, 0.5])
  })

  it("ignores unrelated stderr lines mixed in with progress lines", () => {
    const values: number[] = []
    const parse = createProgressParser((p) => values.push(p))
    parse(
      "whisper_model_load: n_vocab = 51865\nprogress = 10%\nsome other log line\nprogress = 20%\n",
    )
    expect(values).toEqual([0.1, 0.2])
  })

  it("handles \\r\\n line endings", () => {
    const values: number[] = []
    const parse = createProgressParser((p) => values.push(p))
    parse("progress = 10%\r\nprogress = 20%\r\n")
    expect(values).toEqual([0.1, 0.2])
  })
})
