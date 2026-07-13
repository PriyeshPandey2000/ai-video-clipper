import { useState, useEffect, RefObject } from "react"

export interface VideoDisplayRect {
  x: number // px from container left edge
  y: number // px from container top edge
  width: number
  height: number
}

/**
 * Returns the actual pixel bounds of the video image inside its container,
 * accounting for letterbox (bars top/bottom) and pillarbox (bars left/right)
 * caused by object-fit: contain. Updates on resize and on video metadata load.
 * Future overlays (captions, watermark) can reuse this hook.
 */
export function useVideoDisplayRect(
  containerRef: RefObject<HTMLDivElement | null>,
  videoRef: RefObject<HTMLVideoElement | null>,
): VideoDisplayRect | null {
  const [rect, setRect] = useState<VideoDisplayRect | null>(null)

  useEffect(() => {
    const compute = () => {
      const container = containerRef.current
      const video = videoRef.current
      if (!container || !video || !video.videoWidth || !video.videoHeight) return

      const cw = container.offsetWidth
      const ch = container.offsetHeight
      const vAspect = video.videoWidth / video.videoHeight
      const cAspect = cw / ch

      let w: number, h: number, x: number, y: number
      if (vAspect > cAspect) {
        // letterbox: video fills width, black bars top/bottom
        w = cw
        h = cw / vAspect
        x = 0
        y = (ch - h) / 2
      } else {
        // pillarbox: video fills height, black bars left/right
        h = ch
        w = ch * vAspect
        x = (cw - w) / 2
        y = 0
      }
      setRect({ x, y, width: w, height: h })
    }

    const video = videoRef.current
    video?.addEventListener("loadedmetadata", compute)
    video?.addEventListener("resize", compute)

    const ro = new ResizeObserver(compute)
    if (containerRef.current) ro.observe(containerRef.current)

    compute()

    return () => {
      video?.removeEventListener("loadedmetadata", compute)
      video?.removeEventListener("resize", compute)
      ro.disconnect()
    }
  }, [containerRef, videoRef])

  return rect
}
