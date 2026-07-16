import type { Word, Segment, WhisperSegment } from "@video-editor/types"
import { generateId } from "@video-editor/utils"

export const DEFAULT_FILLER_WORDS = [
  "um",
  "uh",
  "uhm",
  "hmm",
  "like",
  "you know",
  "i mean",
  "basically",
  "literally",
  "actually",
  "right",
  "so",
  "yeah",
]

export const FILLER_WORDS = new Set(DEFAULT_FILLER_WORDS)

const SILENCE_GAP_THRESHOLD_MS = 800

export function whisperToWords(segments: WhisperSegment[], projectId: string): Word[] {
  const words: Word[] = []
  for (const seg of segments) {
    for (const w of seg.words) {
      words.push({
        id: generateId(),
        projectId,
        text: w.word.trim(),
        startMs: Math.round(w.start * 1000),
        endMs: Math.round(w.end * 1000),
        confidence: w.probability,
        speakerLabel: null,
      })
    }
  }
  return words
}

export function detectFillerWords(
  words: Word[],
  projectId: string,
  customWords?: Set<string>,
): Segment[] {
  const wordSet = customWords ?? FILLER_WORDS
  return words
    .filter((w) => wordSet.has(w.text.toLowerCase().replace(/[.,!?]$/, "")))
    .map((w) => ({
      id: generateId(),
      projectId,
      type: "filler" as const,
      startMs: w.startMs,
      endMs: w.endMs,
    }))
}

export function detectSilences(words: Word[], projectId: string): Segment[] {
  const silences: Segment[] = []
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1]!
    const curr = words[i]!
    const gap = curr.startMs - prev.endMs
    if (gap >= SILENCE_GAP_THRESHOLD_MS) {
      silences.push({
        id: generateId(),
        projectId,
        type: "silence",
        startMs: prev.endMs,
        endMs: curr.startMs,
      })
    }
  }
  return silences
}

export function wordsToPlainText(words: Word[]): string {
  return words.map((w) => w.text).join(" ")
}

export function wordsToTimestampedText(words: Word[]): string {
  return words.map((w) => `[${(w.startMs / 1000).toFixed(2)}] ${w.text}`).join(" ")
}
