import { useEffect, useRef, useMemo } from "react"
import type { CaptionStyle } from "@video-editor/types"
import { drawCaptionFrame, buildCaptionAccentSet } from "./draw"

interface Word {
  text: string
  startMs: number
  endMs: number
}

interface Props {
  videoRef: React.RefObject<HTMLVideoElement | null>
  words: Word[]
  style: CaptionStyle
  fontLoaded: boolean
  popAmount: number
}

const POP_DURATION_MS = 130

export function CaptionCanvas({
  videoRef,
  words,
  style,
  fontLoaded,
  popAmount,
}: Props): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const logicalSize = useRef({ w: 0, h: 0 })
  const lastWordIdx = useRef(-1)
  const wordChangeAt = useRef(0)

  const accentSet = useMemo(() => buildCaptionAccentSet(words), [words])
  const popAmountRef = useRef(popAmount)
  popAmountRef.current = popAmount

  // Canonical HiDPI canvas setup:
  // - set explicit CSS width/height so display size is known
  // - set backing buffer to CSS size × dpr
  // - call ctx.scale(dpr, dpr) once after each resize (resets with canvas.width change)
  useEffect(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return

    const dpr = window.devicePixelRatio || 1

    const sync = () => {
      const w = video.clientWidth
      const h = video.clientHeight
      logicalSize.current = { w, h }
      // Explicit CSS size — don't rely on inset-0 layout computation
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      // Backing buffer at physical resolution
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      // Scale once here — this is reset whenever canvas.width is set
      const ctx = canvas.getContext("2d")
      if (ctx) ctx.scale(dpr, dpr)
    }

    sync()
    const obs = new ResizeObserver(sync)
    obs.observe(video)
    return () => obs.disconnect()
  }, [videoRef])

  // Render loop — uses logical coords (ctx already scaled by resize effect)
  useEffect(() => {
    if (!fontLoaded) return
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let rafId = 0
    let vfcHandle = 0
    const vid = video as any // eslint-disable-line @typescript-eslint/no-explicit-any

    const render = (timeMs: number) => {
      const { w, h } = logicalSize.current
      if (!w || !h) return

      const idx = words.findIndex((wd) => timeMs >= wd.startMs && timeMs < wd.endMs)
      if (idx !== lastWordIdx.current) {
        lastWordIdx.current = idx
        if (idx >= 0 && popAmountRef.current > 0) wordChangeAt.current = performance.now()
      }

      const word =
        idx >= 0
          ? { text: words[idx]!.text, isAccent: style.showKeywords && accentSet.has(idx) }
          : null

      let wordScale = 1
      const pop = popAmountRef.current
      if (pop > 0 && idx >= 0 && wordChangeAt.current > 0) {
        const elapsed = performance.now() - wordChangeAt.current
        const progress = Math.min(elapsed / POP_DURATION_MS, 1)
        const eased = 1 - Math.pow(1 - progress, 2)
        const minScale = 1 - pop * 0.4
        wordScale = minScale + (1 - minScale) * eased
      }

      drawCaptionFrame(ctx, word, style, w, h, wordScale)
    }

    if ("requestVideoFrameCallback" in video) {
      const onFrame = (_: number, info: { mediaTime: number }) => {
        render(info.mediaTime * 1000)
        vfcHandle = vid.requestVideoFrameCallback(onFrame)
      }
      vfcHandle = vid.requestVideoFrameCallback(onFrame)
    } else {
      const loop = () => {
        render(vid.currentTime * 1000)
        rafId = requestAnimationFrame(loop)
      }
      rafId = requestAnimationFrame(loop)
    }

    return () => {
      if (vfcHandle) vid.cancelVideoFrameCallback(vfcHandle)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [fontLoaded, words, style, accentSet, videoRef])

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0 pointer-events-none"
      style={{ zIndex: 5 }}
    />
  )
}
