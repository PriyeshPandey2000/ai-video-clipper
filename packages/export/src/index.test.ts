import { describe, it, expect } from "vitest"
import { buildSrt, remapWordsToEpisodeTimeline, sanitizeName } from "./index"

describe("sanitizeName", () => {
  it("replaces anything outside alnum/underscore/dash with underscore", () => {
    expect(sanitizeName("My Clip: Part 1!")).toBe("My_Clip__Part_1_")
  })
})

describe("buildSrt", () => {
  it("returns an empty string for no words", () => {
    expect(buildSrt([])).toBe("")
  })

  it("groups words into lines by word count and formats SRT timecodes", () => {
    const words = Array.from({ length: 3 }, (_, i) => ({
      text: `word${i}`,
      startMs: i * 500,
      endMs: i * 500 + 400,
    }))
    const srt = buildSrt(words)
    expect(srt).toContain("00:00:00,000 --> 00:00:01,400")
    expect(srt).toContain("word0 word1 word2")
  })

  it("breaks a line when the gap since the last word exceeds 1s", () => {
    const words = [
      { text: "a", startMs: 0, endMs: 300 },
      { text: "b", startMs: 2000, endMs: 2300 }, // 1.7s gap
    ]
    const srt = buildSrt(words)
    expect(srt).toContain("1\n")
    expect(srt).toContain("2\n")
    expect(srt.split("\n\n").filter(Boolean)).toHaveLength(2)
  })
})

describe("remapWordsToEpisodeTimeline", () => {
  it("shifts words into the concatenated-output timeline, dropping gaps", () => {
    // Original timeline: [0-1000] kept, [1000-2000] removed, [2000-3000] kept
    const keepIntervals = [
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ]
    const words = [
      { text: "a", startMs: 500, endMs: 700 }, // inside first kept interval
      { text: "b", startMs: 1500, endMs: 1700 }, // inside the removed gap
      { text: "c", startMs: 2500, endMs: 2700 }, // inside second kept interval
    ]
    const remapped = remapWordsToEpisodeTimeline(words, keepIntervals)
    expect(remapped).toHaveLength(2)
    expect(remapped[0]).toMatchObject({ text: "a", startMs: 500, endMs: 700 })
    // Second kept interval starts at output offset 1000 (length of the first interval)
    expect(remapped[1]).toMatchObject({ text: "c", startMs: 1500, endMs: 1700 })
  })

  it("clamps a word that starts in a removed segment but ends inside the next kept one", () => {
    // Removed: [1000-1200]. Word spans the cut, starting in the removed gap.
    const keepIntervals = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1200, endMs: 2000 },
    ]
    const words = [{ text: "straddle", startMs: 1150, endMs: 1250 }]
    const remapped = remapWordsToEpisodeTimeline(words, keepIntervals)
    expect(remapped).toHaveLength(1)
    // Clamped to the kept interval's start (1200), output-offset by the first interval's
    // length (1000) — so 1200 -> 1000, 1250 -> 1050. The word displays for its surviving
    // audio only; better than dropping it entirely.
    expect(remapped[0]).toMatchObject({ text: "straddle", startMs: 1000, endMs: 1050 })
  })

  it("returns nothing when every word falls in a removed segment", () => {
    const remapped = remapWordsToEpisodeTimeline(
      [{ text: "a", startMs: 1200, endMs: 1300 }],
      [
        { startMs: 0, endMs: 1000 },
        { startMs: 2000, endMs: 3000 },
      ],
    )
    expect(remapped).toHaveLength(0)
  })
})
