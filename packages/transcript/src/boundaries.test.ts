import { describe, it, expect } from "vitest"
import type { Word } from "@video-editor/types"
import { buildSentences } from "./sentences"
import {
  refineClipBoundaries,
  passesQualityGate,
  startsWithDanglingReference,
  MIN_CLIP_MS,
  MAX_CLIP_MS,
} from "./boundaries"

/** Builds a word stream. `gapAfter` is the silence appended after the phrase. */
function transcript(phrases: Array<[string, number?]>): Word[] {
  const words: Word[] = []
  let ms = 0
  for (const [text, gapAfter = 300] of phrases) {
    for (const token of text.split(" ")) {
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
    ms += gapAfter
  }
  return words
}

const FIXTURE: Array<[string, number?]> = [
  ["Welcome to the show."],
  ["So I started the company in 2019."],
  ["That's why nobody talks about this."],
  ["He told me it would never work", 700], // no terminator, split by pause
  ["and then the whole thing collapsed."],
  ["I lost everything that year.", 1200],
  ["Anyway here is the lesson."],
]
for (let i = 0; i < 40; i++) FIXTURE.push([`Revenue tripled after change number ${i}.`])

const words = transcript(FIXTURE)
const sentences = buildSentences(words)

describe("buildSentences", () => {
  it("splits on terminators and keeps punctuation", () => {
    expect(sentences[0]!.text).toBe("Welcome to the show.")
    expect(sentences[0]!.endsWithTerminator).toBe(true)
  })

  it("splits on a long pause without a terminator", () => {
    const noTerminator = sentences.find((s) => s.text.startsWith("He told me"))
    expect(noTerminator?.endsWithTerminator).toBe(false)
  })

  it("keeps indices sequential and word indices resolvable", () => {
    expect(sentences.every((s, i) => s.index === i)).toBe(true)
    expect(words[sentences[1]!.firstWordIndex]!.text).toBe("So")
  })

  it("returns empty for empty input", () => {
    expect(buildSentences([])).toEqual([])
  })

  it("covers every word exactly once when the cap breaks early", () => {
    // Regression: after an early cap break the loop did not rewind, so the next 40-word window
    // was measured from a stale position and emitted short, arbitrarily-split sentences.
    const phrases: Array<[string, number?]> = []
    for (let i = 0; i < 11; i++) phrases.push([`alpha${i}`, 100])
    phrases.push(["comma,", 100])
    for (let i = 0; i < 60; i++) phrases.push([`beta${i}`, 100])
    phrases.push(["end."])

    const w = transcript(phrases)
    const s = buildSentences(w)

    const covered = new Array(w.length).fill(0)
    for (const sentence of s) {
      for (let i = sentence.firstWordIndex; i <= sentence.lastWordIndex; i++) covered[i]++
    }
    expect(covered.every((c) => c === 1)).toBe(true)
    expect(s.map((x) => x.text).join(" ")).toBe(w.map((x) => x.text).join(" "))

    // No sentence should be a stub produced by a stale window.
    const wordCounts = s.map((x) => x.lastWordIndex - x.firstWordIndex + 1)
    expect(Math.min(...wordCounts.slice(0, -1))).toBeGreaterThan(11)
  })
})

describe("startsWithDanglingReference", () => {
  it("flags connectives and bare pronouns", () => {
    expect(startsWithDanglingReference(sentences[1]!)).toBe(true) // "So ..."
    expect(startsWithDanglingReference(sentences[3]!)).toBe(true) // "He told me ..."
  })

  it("does not flag contractions that open a real hook", () => {
    // Regression: "That's why ..." must survive — blacklisting it costs real clips.
    expect(startsWithDanglingReference(sentences[2]!)).toBe(false)
  })
})

describe("refineClipBoundaries", () => {
  it("D2: expands backwards off a dangling opener", () => {
    const r = refineClipBoundaries(words, sentences, 3, 8)!
    expect(r.startSentenceIndex).toBeLessThan(3)
    expect(r.danglingUnresolved).toBe(false)
  })

  it("D2: leaves a self-contained opener alone", () => {
    const r = refineClipBoundaries(words, sentences, 2, 8)!
    expect(r.startSentenceIndex).toBe(2)
  })

  it("D4: extends forward to a complete thought", () => {
    const r = refineClipBoundaries(words, sentences, 0, 3)!
    expect(r.endSentenceIndex).toBeGreaterThan(3)
    expect(r.endedOnCompleteThought).toBe(true)
  })

  it("D6: never exceeds the platform maximum", () => {
    const r = refineClipBoundaries(words, sentences, 0, sentences.length - 1)!
    expect(r.durationMs).toBeLessThanOrEqual(MAX_CLIP_MS)
  })

  it("D3: pads into the pause but never past its midpoint", () => {
    const r = refineClipBoundaries(words, sentences, 10, 20)!
    const first = words[sentences[r.startSentenceIndex]!.firstWordIndex]!
    const prev = words[sentences[r.startSentenceIndex]!.firstWordIndex - 1]!
    expect(r.startMs).toBeLessThan(first.startMs)
    expect(r.startMs).toBeGreaterThanOrEqual(prev.endMs)
    expect(r.startMs).toBeGreaterThanOrEqual(
      prev.endMs + Math.floor((first.startMs - prev.endMs) / 2),
    )
  })

  it("normalizes reversed and out-of-range indices", () => {
    expect(refineClipBoundaries(words, sentences, 12, 5)!.startSentenceIndex).toBeLessThanOrEqual(5)

    // Clamped into range, then trimmed further by the D6 length cap.
    const oob = refineClipBoundaries(words, sentences, 0, 99999)!
    expect(oob.endSentenceIndex).toBeLessThanOrEqual(sentences.length - 1)
    expect(oob.durationMs).toBeLessThanOrEqual(MAX_CLIP_MS)
  })

  it("returns null for empty input", () => {
    expect(refineClipBoundaries([], [], 0, 0)).toBeNull()
  })

  it("reports the ending of the FINAL boundary, not the pre-clamp one", () => {
    // Regression: `endedOnCompleteThought` used to be captured before D6 could extend `endIdx`,
    // so a short complete clip grown onto an unterminated sentence still claimed a clean ending
    // and passed the quality gate.
    const w = transcript([
      ["Short complete thought here.", 800],
      ["This next part runs on with no terminator at all", 300],
      ["and keeps going even further without stopping", 300],
      ["final wrap up sentence."],
    ])
    const s = buildSentences(w)
    const r = refineClipBoundaries(w, s, 0, 0)!

    if (!s[r.endSentenceIndex]!.endsWithTerminator) {
      expect(r.endedOnCompleteThought).toBe(false)
      expect(passesQualityGate(r, true).passed).toBe(false)
    }
  })

  it("keeps the end on a word edge even when clamping an over-long sentence", () => {
    // One sentence far longer than MAX_CLIP_MS: the clamp must land on a real word end rather
    // than an arbitrary millisecond, or the export cuts mid-word.
    const w: Word[] = []
    let ms = 0
    for (let i = 0; i < 39; i++) {
      w.push({
        id: `w${i}`,
        projectId: "p",
        text: `word${i}`,
        startMs: ms,
        endMs: ms + 2000,
        confidence: 0.9,
        speakerLabel: null,
      })
      ms += 2500
    }
    w.push({
      id: "wend",
      projectId: "p",
      text: "end.",
      startMs: ms,
      endMs: ms + 2000,
      confidence: 0.9,
      speakerLabel: null,
    })

    const s = buildSentences(w)
    const r = refineClipBoundaries(w, s, 0, s.length - 1)!
    expect(r.durationMs).toBeLessThanOrEqual(MAX_CLIP_MS)
    expect(w.some((word) => word.endMs === r.endMs || word.endMs < r.endMs)).toBe(true)
    // endMs must not fall strictly inside a word.
    const straddled = w.some((word) => r.endMs > word.startMs && r.endMs < word.endMs)
    expect(straddled).toBe(false)
  })

  it("drops the candidate when not even one word fits the maximum", () => {
    // Regression: a single word longer than MAX_CLIP_MS used to emit a clip of that word's full
    // length — a 300s "short" that passed the quality gate untouched.
    const w: Word[] = [
      {
        id: "w0",
        projectId: "p",
        text: "Marathon.",
        startMs: 0,
        endMs: 300_000,
        confidence: 0.9,
        speakerLabel: null,
      },
    ]
    const s = buildSentences(w)
    expect(refineClipBoundaries(w, s, 0, 0)).toBeNull()
  })

  it("never exceeds the maximum when growing to reach the minimum", () => {
    // The minimum-duration loop must not push the range back over MAX_CLIP_MS.
    const w: Word[] = [
      {
        id: "a",
        projectId: "p",
        text: "Short.",
        startMs: 0,
        endMs: 500,
        confidence: 0.9,
        speakerLabel: null,
      },
      {
        id: "b",
        projectId: "p",
        text: "Then",
        startMs: 1500,
        endMs: 2000,
        confidence: 0.9,
        speakerLabel: null,
      },
      {
        id: "c",
        projectId: "p",
        text: "long",
        startMs: 2000,
        endMs: 200_000,
        confidence: 0.9,
        speakerLabel: null,
      },
      {
        id: "d",
        projectId: "p",
        text: "run.",
        startMs: 200_000,
        endMs: 200_500,
        confidence: 0.9,
        speakerLabel: null,
      },
    ]
    const s = buildSentences(w)
    const r = refineClipBoundaries(w, s, 0, 0)
    if (r) expect(r.durationMs).toBeLessThanOrEqual(MAX_CLIP_MS)
  })

  it("D6: grows backwards to reach the minimum, so the setup leads the payoff", () => {
    // The regression this guards: the generator proposes the *moment*, so a mid-transcript pick is
    // routinely under MIN_CLIP_MS. Growing forward-only appended post-payload material and the judge
    // called the result disjointed. The clip must reach the minimum by extending its start.
    const r = refineClipBoundaries(words, sentences, 20, 20)
    expect(r).not.toBeNull()
    // Grew backwards…
    expect(r!.startSentenceIndex).toBeLessThan(20)
    // …and did NOT reach for trailing material to get there.
    expect(r!.endSentenceIndex).toBe(20)
    expect(r!.durationMs).toBeGreaterThanOrEqual(MIN_CLIP_MS)
  })

  it("D6: still grows forwards when the candidate already starts the transcript", () => {
    const r = refineClipBoundaries(words, sentences, 0, 0)
    expect(r).not.toBeNull()
    expect(r!.startSentenceIndex).toBe(0)
    expect(r!.endSentenceIndex).toBeGreaterThan(0)
    expect(r!.durationMs).toBeGreaterThanOrEqual(MIN_CLIP_MS)
  })

  it("D6: backward growth does not push the range over the maximum", () => {
    const w: Word[] = [
      {
        id: "a",
        projectId: "p",
        text: "Long.",
        startMs: 0,
        endMs: 200_000,
        confidence: 0.9,
        speakerLabel: null,
      },
      {
        id: "b",
        projectId: "p",
        text: "Now.",
        startMs: 200_000,
        endMs: 200_500,
        confidence: 0.9,
        speakerLabel: null,
      },
      {
        id: "c",
        projectId: "p",
        text: "Then.",
        startMs: 201_000,
        endMs: 202_000,
        confidence: 0.9,
        speakerLabel: null,
      },
    ]
    const s = buildSentences(w)
    const r = refineClipBoundaries(w, s, 1, 1)
    // The preceding sentence is 200s, so backward growth must be refused rather than blow the cap.
    expect(r!.startSentenceIndex).toBe(1)
    expect(r!.durationMs).toBeLessThanOrEqual(MAX_CLIP_MS)
  })

  it("reports the dangling flag for the start the clip actually has", () => {
    // Sentence 20 opens with "Revenue", which is not a dangling opener, and backward growth only
    // moves to earlier sentences, so the flag must stay false for the final boundary.
    const r = refineClipBoundaries(words, sentences, 20, 20)
    expect(r!.danglingUnresolved).toBe(false)
  })

  it("D6: repairs a dangling opener that length growth introduced", () => {
    // Growth moves the start, and the first D2 pass only ran against the *proposed* start. Here the
    // proposed start ("The launch failed") is a clean sentence, so D2 correctly does nothing — then
    // backward growth lands on "And nobody told me", which the model never chose. Without a second
    // D2 pass the clip opens mid-thought while the referent sits one sentence earlier.
    //
    // Timings are explicit so the growth loop stops exactly where intended: s1+s2 already exceed
    // MIN_CLIP_MS, so growth takes the start to s1 and halts on the length check rather than
    // running past the dangling sentence on its own.
    const w: Word[] = []
    let ms = 0
    const addSentence = (text: string, spanMs: number) => {
      const tokens = text.split(" ")
      const step = Math.floor(spanMs / tokens.length)
      for (const token of tokens) {
        w.push({
          id: `w${w.length}`,
          projectId: "p",
          text: token,
          startMs: ms,
          endMs: ms + step,
          confidence: 0.9,
          speakerLabel: null,
        })
        ms += step
      }
    }
    addSentence("We lost the account that spring.", 5_000)
    addSentence("And nobody told me until the renewal came up.", 9_000)
    addSentence("The launch failed in the first ten minutes of it.", 9_000)
    const s = buildSentences(w)
    expect(s).toHaveLength(3)
    expect(startsWithDanglingReference(s[1]!)).toBe(true)
    expect(startsWithDanglingReference(s[2]!)).toBe(false)

    const r = refineClipBoundaries(w, s, 2, 2)
    expect(r).not.toBeNull()
    // Growth moved the start onto the dangling opener at #1, then the post-growth D2 pass resolved
    // it by taking in #0. Ending on #0 also means the clip no longer opens mid-thought, which is the
    // whole point: `danglingUnresolved` describes the boundary the viewer sees, not the one the
    // model proposed.
    expect(r!.startSentenceIndex).toBe(0)
    expect(r!.danglingUnresolved).toBe(false)
    expect(r!.durationMs).toBeGreaterThanOrEqual(MIN_CLIP_MS)
  })

  it("D6: does not cross a long silence just to reach the minimum", () => {
    // A 55-second gap satisfies `minMs` if the guard is only `maxMs` — the duration is met while
    // the clip is mostly silence. Forward growth is the better repair, so the start must not move
    // across the pause.
    const phrases: Array<[string, number?]> = []
    for (let i = 0; i < 12; i++) phrases.push([`Setup line number ${i} about the business.`])
    phrases.push(["That is the whole story so far.", 55_000])
    phrases.push(["The moment everyone remembers."])
    // Room after the candidate on purpose: forward growth is the repair being asserted, so the
    // clip has to be able to fill that way instead of crossing the pause.
    for (let i = 0; i < 12; i++) phrases.push([`Aftermath line number ${i} of the fallout.`])
    const w = transcript(phrases)
    const s = buildSentences(w)
    const moment = s.findIndex((x) => x.text.startsWith("The moment everyone"))
    expect(moment).toBeGreaterThan(12)

    const r = refineClipBoundaries(w, s, moment, moment)
    expect(r).not.toBeNull()
    // Did not jump back across the 55s pause to the sentence before it.
    expect(r!.startSentenceIndex).toBe(moment)
    // …and reached the floor the other way, which is what makes this a real choice rather than a
    // clip that simply ran out of room.
    expect(r!.endSentenceIndex).toBeGreaterThan(moment)
    expect(r!.durationMs).toBeGreaterThanOrEqual(MIN_CLIP_MS)
  })

  it("D6: a long silence blocks the post-growth dangling repair too", () => {
    // Same guard, applied to the second D2 pass: a dangling opener whose referent is behind a long
    // pause is worse to include than to leave, so the repair stops and the flag reports it.
    const phrases: Array<[string, number?]> = []
    for (let i = 0; i < 12; i++) phrases.push([`Setup line number ${i} about the business.`])
    phrases.push(["The demo got cancelled.", 30_000])
    phrases.push(["And nobody told me."])
    phrases.push(["I shipped it anyway."])
    for (let i = 0; i < 12; i++) phrases.push([`Aftermath line number ${i} of the fallout.`])
    const w = transcript(phrases)
    const s = buildSentences(w)
    const dangling = s.findIndex((x) => x.text.startsWith("And nobody"))
    expect(dangling).toBeGreaterThan(12)

    // The candidate is the sentence *after* the dangling one, so growth has to step onto "And
    // nobody told me" first — which is the only way the post-growth D2 pass gets exercised at all.
    const r = refineClipBoundaries(w, s, dangling + 1, dangling + 1)
    expect(r).not.toBeNull()
    // Growth may land on the opener, but the repair must not cross the 30s pause to resolve it.
    expect(r!.startSentenceIndex).toBe(dangling)
    expect(r!.danglingUnresolved).toBe(true)
  })
})

describe("passesQualityGate", () => {
  const good = refineClipBoundaries(words, sentences, 10, 20)!

  it("passes a clean clip", () => {
    expect(passesQualityGate(good).passed).toBe(true)
  })

  it("blocks a clip that does not end on a complete thought", () => {
    const gate = passesQualityGate({ ...good, endedOnCompleteThought: false })
    expect(gate.passed).toBe(false)
    expect(gate.reasons).toContain("does not end on a complete thought")
  })

  it(`blocks clips under ${MIN_CLIP_MS}ms`, () => {
    const oneSentence = buildSentences(words.slice(0, 4))
    const tiny = refineClipBoundaries(words.slice(0, 4), oneSentence, 0, 0)!
    expect(passesQualityGate(tiny).passed).toBe(false)
  })

  it("warns on a cold open instead of dropping the clip", () => {
    // Sentence 0 has nothing to expand into, so the repair cannot resolve it.
    const coldOpen = refineClipBoundaries(words, sentences, 1, 12)!
    const gate = passesQualityGate({ ...coldOpen, danglingUnresolved: true })
    expect(gate.passed).toBe(true)
    expect(gate.warnings.length).toBeGreaterThan(0)
  })
})
