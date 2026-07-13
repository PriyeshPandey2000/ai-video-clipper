import { useRef, useEffect, type RefObject } from "react"
import { useVideoDisplayRect } from "./useVideoDisplayRect"

// 9:16 crop box width as fraction of 16:9 video width: (9/16) / (16/9) = 81/256
const CROP_WIDTH_RATIO = 81 / 256

interface CropOverlayProps {
  containerRef: RefObject<HTMLDivElement | null>
  videoRef: RefObject<HTMLVideoElement | null>
  cropX: number // 0 (left) – 1 (right)
  onChange: (x: number) => void // live update during drag
  onCommit: (x: number) => void // save on mouse up
}

export function CropOverlay({
  containerRef,
  videoRef,
  cropX,
  onChange,
  onCommit,
}: CropOverlayProps): React.ReactElement | null {
  const displayRect = useVideoDisplayRect(containerRef, videoRef)
  const dragging = useRef(false)

  // Keep latest values accessible in stable drag handlers
  const stateRef = useRef({ cropX, onChange, onCommit, displayRect })
  stateRef.current = { cropX, onChange, onCommit, displayRect }

  // Stable drag listeners — registered once
  useEffect(() => {
    const getCropX = (clientX: number): number => {
      const { displayRect } = stateRef.current
      if (!displayRect || !containerRef.current) return stateRef.current.cropX
      const containerBRect = containerRef.current.getBoundingClientRect()
      const videoLeft = containerBRect.left + displayRect.x
      const cropWidth = displayRect.width * CROP_WIDTH_RATIO
      const maxOffset = displayRect.width - cropWidth
      if (maxOffset <= 0) return 0.5
      return Math.max(0, Math.min(1, (clientX - videoLeft - cropWidth / 2) / maxOffset))
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return
      stateRef.current.onChange(getCropX(e.clientX))
    }

    const onMouseUp = (e: MouseEvent) => {
      if (!dragging.current) return
      dragging.current = false
      stateRef.current.onCommit(getCropX(e.clientX))
    }

    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
    return () => {
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
    }
  }, [containerRef]) // stable — never re-registers

  if (!displayRect) return null

  const cropWidth = displayRect.width * CROP_WIDTH_RATIO
  const maxOffset = displayRect.width - cropWidth
  const cropLeft = displayRect.x + maxOffset * cropX
  const cropRight = cropLeft + cropWidth

  const panelStyle = (left: number, width: number) => ({
    position: "absolute" as const,
    left,
    top: displayRect.y,
    width,
    height: displayRect.height,
    background: "rgba(0,0,0,0.65)",
    pointerEvents: "none" as const,
  })

  return (
    <>
      {/* Left dark panel */}
      <div style={panelStyle(displayRect.x, cropLeft - displayRect.x)} />

      {/* Right dark panel */}
      <div style={panelStyle(cropRight, displayRect.x + displayRect.width - cropRight)} />

      {/* Crop zone — draggable */}
      <div
        style={{
          position: "absolute",
          left: cropLeft,
          top: displayRect.y,
          width: cropWidth,
          height: displayRect.height,
          border: "1.5px solid rgba(255,255,255,0.5)",
          boxSizing: "border-box",
          cursor: "ew-resize",
        }}
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation() // prevent play/pause toggle
          dragging.current = true
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Center drag hint */}
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(0,0,0,0.5)",
            borderRadius: 4,
            padding: "2px 6px",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
          className="text-[10px] text-white/70"
        >
          ← drag →
        </div>
      </div>
    </>
  )
}
