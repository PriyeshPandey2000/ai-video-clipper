import { msToSrtTimecode } from "@video-editor/utils"

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

export function buildSrt(
  wordRows: Array<{ text: string; startMs: number; endMs: number }>,
): string {
  if (wordRows.length === 0) return ""
  const MAX_WORDS = 8
  const MAX_DURATION_MS = 4000
  const lines: Array<{ start: number; end: number; text: string }> = []
  let i = 0
  while (i < wordRows.length) {
    const lineStart = wordRows[i]!.startMs
    const lineWords: string[] = []
    let lineEnd = lineStart
    while (i < wordRows.length && lineWords.length < MAX_WORDS) {
      const word = wordRows[i]!
      if (
        lineWords.length > 0 &&
        (word.startMs - lineEnd > 1000 || word.endMs - lineStart > MAX_DURATION_MS)
      ) {
        break
      }
      lineWords.push(word.text.trim())
      lineEnd = word.endMs
      i++
    }
    if (lineWords.length > 0) {
      lines.push({ start: lineStart, end: lineEnd, text: lineWords.join(" ") })
    }
  }
  return lines
    .map(
      (line, idx) =>
        `${idx + 1}\n${msToSrtTimecode(line.start)} --> ${msToSrtTimecode(line.end)}\n${line.text}\n`,
    )
    .join("\n")
}

/**
 * Remaps word timestamps from the original media timeline onto the output timeline produced
 * by concatenating `keepIntervals` back to back (with any gaps between them removed) — used
 * for burning subtitles into an episode/clip export where filler/silence segments were cut.
 * Words that fall entirely inside a removed segment are dropped.
 */
export function remapWordsToEpisodeTimeline(
  wordRows: Array<{ text: string; startMs: number; endMs: number }>,
  keepIntervals: Array<{ startMs: number; endMs: number }>,
): Array<{ text: string; startMs: number; endMs: number }> {
  const intervalOutputStarts: number[] = []
  let cumulative = 0
  for (const interval of keepIntervals) {
    intervalOutputStarts.push(cumulative)
    cumulative += interval.endMs - interval.startMs
  }

  const remapped: Array<{ text: string; startMs: number; endMs: number }> = []
  for (const word of wordRows) {
    for (let i = 0; i < keepIntervals.length; i++) {
      const interval = keepIntervals[i]!
      if (word.startMs >= interval.startMs && word.startMs < interval.endMs) {
        const offset = intervalOutputStarts[i]!
        remapped.push({
          ...word,
          startMs: word.startMs - interval.startMs + offset,
          endMs: Math.min(word.endMs, interval.endMs) - interval.startMs + offset,
        })
        break
      }
    }
    // words starting in removed segments are dropped
  }
  return remapped
}
