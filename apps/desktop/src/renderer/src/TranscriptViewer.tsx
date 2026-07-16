import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import type { Word } from "@video-editor/types"
import { Spinner } from "@video-editor/ui"

const SILENCE_GAP_THRESHOLD_MS = 1000
const WORDS_PER_PAGE = 500

interface TranscriptViewerProps {
  projectId: string
  onSeekWord: (startMs: number) => void
  highlightRange?: { startMs: number; endMs: number } | null
  fillerWords: string[]
}

export function TranscriptViewer({
  projectId,
  onSeekWord,
  highlightRange,
  fillerWords,
}: TranscriptViewerProps): React.ReactElement {
  const [words, setWords] = useState<Word[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [visibleEnd, setVisibleEnd] = useState(WORDS_PER_PAGE)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const loadingMore = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api
      .invoke("project:get-words", { projectId })
      .then((result) => {
        if (!cancelled) {
          setWords(result)
          setLoading(false)
        }
      })
      .catch((err) => {
        console.error("Failed to load words:", err)
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const fillerSet = useMemo(() => new Set(fillerWords), [fillerWords])

  const isFiller = useCallback(
    (text: string): boolean => fillerSet.has(text.toLowerCase().replace(/[.,!?]$/, "")),
    [fillerSet],
  )

  const isInRange = useCallback(
    (startMs: number, endMs: number): boolean => {
      if (!highlightRange) return false
      return startMs >= highlightRange.startMs && endMs <= highlightRange.endMs
    },
    [highlightRange],
  )

  const visibleWords = useMemo(() => {
    if (!words) return []
    return words.slice(0, visibleEnd)
  }, [words, visibleEnd])

  useEffect(() => {
    if (!highlightRange || !words) return
    const firstInRange = words.findIndex(
      (w) => w.startMs >= highlightRange.startMs && w.endMs <= highlightRange.endMs,
    )
    if (firstInRange >= 0 && firstInRange >= visibleEnd) {
      setVisibleEnd(firstInRange + WORDS_PER_PAGE)
    }
  }, [highlightRange, visibleEnd, words])

  useEffect(() => {
    if (!highlightRange) return
    const el = scrollerRef.current?.querySelector("[data-highlighted]")
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [highlightRange, visibleEnd])

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el || !words || loadingMore.current) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 400
    if (nearBottom && visibleEnd < words.length) {
      loadingMore.current = true
      setVisibleEnd((prev) => {
        const next = Math.min(prev + WORDS_PER_PAGE, words.length)
        if (next === prev) loadingMore.current = false
        return next
      })
      loadingMore.current = false
    }
  }, [words, visibleEnd])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size={20} />
      </div>
    )
  }

  if (!words || words.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-neutral-500">
        No transcript available. Click Transcribe to generate one.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
          Transcript
        </h3>
        <span className="text-[11px] text-neutral-600">{words.length} words</span>
      </div>

      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/50 p-4"
        style={{ maxHeight: "320px" }}
      >
        <div className="space-y-3 text-left">
          {visibleWords
            .reduce<{ words: typeof visibleWords; key: string }[]>((paras, w, i) => {
              const prev = i > 0 ? visibleWords[i - 1] : null
              const gap = prev ? w.startMs - prev.endMs : 0
              if (i === 0 || gap >= SILENCE_GAP_THRESHOLD_MS) {
                paras.push({ words: [w], key: String(w.id) })
              } else {
                paras[paras.length - 1]!.words.push(w)
              }
              return paras
            }, [])
            .map((para) => (
              <p
                key={para.key}
                className="text-sm leading-7 text-neutral-300 text-left"
                style={{ textAlign: "left" }}
              >
                {para.words.map((w) => (
                  <span
                    key={w.id}
                    onClick={() => onSeekWord(w.startMs)}
                    data-start-ms={w.startMs}
                    data-highlighted={isInRange(w.startMs, w.endMs) ? true : undefined}
                    className={`cursor-pointer rounded-sm px-0.5 transition-colors hover:text-white ${
                      isInRange(w.startMs, w.endMs)
                        ? "bg-violet-500/20 text-violet-200"
                        : isFiller(w.text)
                          ? "text-neutral-600"
                          : "text-neutral-300"
                    }`}
                    title={isFiller(w.text) ? "filler word" : `[${(w.startMs / 1000).toFixed(1)}s]`}
                  >
                    {w.text}{" "}
                  </span>
                ))}
              </p>
            ))}
        </div>

        {visibleEnd < words.length && (
          <div className="flex justify-center py-3">
            <span className="text-xs text-neutral-600">Scroll for more...</span>
          </div>
        )}
      </div>
    </div>
  )
}
