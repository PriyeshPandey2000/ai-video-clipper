import { useRef, useState, useEffect } from "react"
import type { Clip } from "@video-editor/types"

interface TrimStripProps {
  clip: Clip
  durationMs: number
  onSeek: (ms: number) => void
  onSaved: () => void
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

export function TrimStrip({
  clip,
  durationMs,
  onSeek,
  onSaved,
}: TrimStripProps): React.ReactElement {
  const [startMs, setStartMs] = useState(clip.startMs)
  const [endMs, setEndMs] = useState(clip.endMs)
  const [saving, setSaving] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<"start" | "end" | null>(null)

  // Keep latest values accessible in stable event handlers without re-registering listeners
  const stateRef = useRef({ startMs, endMs, durationMs, onSeek, onSaved, clipId: clip.id })
  stateRef.current = { startMs, endMs, durationMs, onSeek, onSaved, clipId: clip.id }

  useEffect(() => {
    setStartMs(clip.startMs)
    setEndMs(clip.endMs)
  }, [clip.id, clip.startMs, clip.endMs])

  // Stable listeners — registered once, read latest state via ref
  useEffect(() => {
    const msFromEvent = (e: MouseEvent): number => {
      if (!barRef.current) return 0
      const rect = barRef.current.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      return Math.round(frac * stateRef.current.durationMs)
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const { startMs, endMs, onSeek } = stateRef.current
      const ms = msFromEvent(e)
      if (dragging.current === "start") {
        const next = Math.min(ms, endMs - 1000)
        setStartMs(next)
        onSeek(next)
      } else {
        setEndMs(Math.max(ms, startMs + 1000))
      }
    }

    const onMouseUp = async () => {
      if (!dragging.current) return
      dragging.current = null
      const { clipId, startMs, endMs, onSaved } = stateRef.current
      setSaving(true)
      try {
        await window.api.invoke("clip:update-times", { clipId, startMs, endMs })
        onSaved()
      } catch (err) {
        console.error("Failed to save trim:", err)
      } finally {
        setSaving(false)
      }
    }

    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
    return () => {
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
    }
  }, []) // stable — never re-registers

  const startPct = (startMs / durationMs) * 100
  const endPct = (endMs / durationMs) * 100

  return (
    <div className="space-y-1.5 select-none">
      <div className="flex items-center justify-between text-[11px] font-mono">
        <span className="text-violet-400">{formatMs(startMs)}</span>
        <span className="text-neutral-600 text-[10px]">
          {saving ? "Saving…" : `${Math.round((endMs - startMs) / 1000)}s — drag handles to trim`}
        </span>
        <span className="text-violet-400">{formatMs(endMs)}</span>
      </div>

      <div ref={barRef} className="relative h-7 bg-neutral-800 rounded cursor-default">
        {/* Dimmed outside left */}
        <div
          className="absolute inset-y-0 left-0 bg-neutral-900/60 rounded-l"
          style={{ width: `${startPct}%` }}
        />
        {/* Violet active region */}
        <div
          className="absolute inset-y-0 bg-violet-600/25 border-t border-b border-violet-500/40"
          style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
        />
        {/* Dimmed outside right */}
        <div
          className="absolute inset-y-0 right-0 bg-neutral-900/60 rounded-r"
          style={{ width: `${100 - endPct}%` }}
        />

        {/* Left handle */}
        <div
          className="absolute inset-y-0 w-1 bg-violet-500 rounded-sm cursor-ew-resize hover:bg-violet-400 transition-colors"
          style={{ left: `${startPct}%`, transform: "translateX(-50%)" }}
          onMouseDown={(e) => {
            e.preventDefault()
            dragging.current = "start"
          }}
        />

        {/* Right handle */}
        <div
          className="absolute inset-y-0 w-1 bg-violet-500 rounded-sm cursor-ew-resize hover:bg-violet-400 transition-colors"
          style={{ left: `${endPct}%`, transform: "translateX(-50%)" }}
          onMouseDown={(e) => {
            e.preventDefault()
            dragging.current = "end"
          }}
        />
      </div>
    </div>
  )
}
