import { randomUUID } from "node:crypto"

export function generateId(): string {
  return randomUUID()
}

export function msToTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

export function msToSrtTimecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const millis = ms % 1000
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(millis).padStart(3, "0")}`
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function now(): number {
  return Date.now()
}

// Longest word (>=5 chars) per GROUP-word window gets accent highlight.
// Used by both the ASS builder (main process) and Canvas renderer (browser).
const ACCENT_GROUP = 4
export function buildCaptionAccentSet(words: Array<{ text: string }>): Set<number> {
  const accents = new Set<number>()
  for (let i = 0; i < words.length; i += ACCENT_GROUP) {
    let bestIdx = -1
    let bestLen = 4
    words.slice(i, i + ACCENT_GROUP).forEach((w, j) => {
      const len = w.text.replace(/[^a-zA-Z]/g, "").length
      if (len > bestLen) {
        bestLen = len
        bestIdx = j
      }
    })
    if (bestIdx >= 0) accents.add(i + bestIdx)
  }
  return accents
}
