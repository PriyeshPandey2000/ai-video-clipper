import type { Word, Sentence } from "@video-editor/types"

/** A pause this long ends a sentence even without punctuation. */
const SENTENCE_GAP_MS = 700

/** Safety cap for run-on speech that arrives with no terminator. */
const MAX_WORDS_PER_SENTENCE = 40

/** Don't break so early that the cap produces fragments. */
const MIN_WORDS_BEFORE_CAP_BREAK = 10

const TERMINATOR = /[.!?]["'”’)\]]*$/
const CLAUSE_BREAK = /[,;:]["'”’)\]]*$/

export function endsSentence(text: string): boolean {
  return TERMINATOR.test(text.trim())
}

/**
 * Picks where to break a run-on that hit the word cap. Breaking at exactly word 40 lands
 * mid-phrase ("...because a lot" / "of people are confused"), and those edges become clip
 * boundaries downstream. Prefer the last clause break, else the longest pause.
 */
function bestCapBreak(words: Word[], from: number, to: number): number {
  for (let i = to; i >= from + MIN_WORDS_BEFORE_CAP_BREAK; i--) {
    if (CLAUSE_BREAK.test(words[i]!.text.trim())) return i
  }

  let bestIndex = to
  let bestGap = -1
  for (let i = from + MIN_WORDS_BEFORE_CAP_BREAK; i < to; i++) {
    const gap = words[i + 1]!.startMs - words[i]!.endMs
    if (gap > bestGap) {
      bestGap = gap
      bestIndex = i
    }
  }
  return bestIndex
}

/**
 * Groups words into sentences. Whisper keeps punctuation attached to the token text, so the
 * terminator test works on the stored word text directly — no extra model needed.
 *
 * Sentences are the atomic unit for clip selection: the LLM reasons over them, and clip
 * boundaries are only ever placed on their edges.
 */
export function buildSentences(words: Word[]): Sentence[] {
  const sentences: Sentence[] = []
  let firstWordIndex = 0

  const flush = (lastWordIndex: number, terminated: boolean): void => {
    const first = words[firstWordIndex]
    const last = words[lastWordIndex]
    if (!first || !last) return
    const text = words
      .slice(firstWordIndex, lastWordIndex + 1)
      .map((w) => w.text)
      .join(" ")
      .trim()
    if (text.length > 0) {
      sentences.push({
        index: sentences.length,
        startMs: first.startMs,
        endMs: last.endMs,
        text,
        firstWordIndex,
        lastWordIndex,
        endsWithTerminator: terminated,
      })
    }
    firstWordIndex = lastWordIndex + 1
  }

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    const next = words[i + 1]
    const terminated = endsSentence(word.text)
    const gapBreak = next !== undefined && next.startMs - word.endMs >= SENTENCE_GAP_MS

    if (terminated || gapBreak || next === undefined) {
      flush(i, terminated)
      continue
    }

    if (i - firstWordIndex + 1 >= MAX_WORDS_PER_SENTENCE) {
      flush(bestCapBreak(words, firstWordIndex, i), false)
    }
  }

  return sentences
}

/**
 * Sentence-level serialization for the LLM prompt (B1). Roughly 3–5x fewer tokens than
 * per-word `[10.50] Hello [10.80] everyone`, and the index is what the model returns instead
 * of a timestamp it would otherwise hallucinate (C1).
 */
export function sentencesToPrompt(sentences: Sentence[]): string {
  return sentences.map((s) => `#${s.index} [${s.startMs}-${s.endMs}] ${s.text}`).join("\n")
}
