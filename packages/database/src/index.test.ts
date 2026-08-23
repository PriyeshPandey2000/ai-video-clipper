import { describe, it, expect, vi } from "vitest"
import { insertBatched } from "./index"

describe("insertBatched", () => {
  it("does nothing for an empty array", () => {
    const insertFn = vi.fn()
    insertBatched(insertFn, [], 7)
    expect(insertFn).not.toHaveBeenCalled()
  })

  it("inserts everything in one call when under the limit", () => {
    const insertFn = vi.fn()
    const rows = Array.from({ length: 50 }, (_, i) => i)
    insertBatched(insertFn, rows, 7)
    expect(insertFn).toHaveBeenCalledTimes(1)
    expect(insertFn).toHaveBeenCalledWith(rows)
  })

  it("splits into batches that stay under 999 bound parameters", () => {
    const insertFn = vi.fn()
    // 7 columns/row -> batch size floor(999/7) = 142
    const rows = Array.from({ length: 6300 }, (_, i) => i)
    insertBatched(insertFn, rows, 7)

    const batches = insertFn.mock.calls.map((call) => call[0] as number[])
    for (const batch of batches) {
      expect(batch.length * 7).toBeLessThanOrEqual(999)
    }
    // Every row appears exactly once, in order, across all batches.
    expect(batches.flat()).toEqual(rows)
  })
})
