import React, { useRef, useEffect, forwardRef, useImperativeHandle } from "react"

export interface VideoPlayerProps {
  src: string
  startMs?: number
  endMs?: number
  className?: string
  onTimeUpdate?: (currentMs: number) => void
}

export interface VideoPlayerHandle {
  seek(ms: number): void
  play(): void
  pause(): void
}

export const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ src, startMs = 0, endMs, className, onTimeUpdate }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null)

    useImperativeHandle(ref, () => ({
      seek(ms) {
        if (videoRef.current) videoRef.current.currentTime = ms / 1000
      },
      play() {
        void videoRef.current?.play()
      },
      pause() {
        videoRef.current?.pause()
      },
    }))

    useEffect(() => {
      if (videoRef.current) videoRef.current.currentTime = startMs / 1000
    }, [src, startMs])

    function handleTimeUpdate(): void {
      const v = videoRef.current
      if (!v) return
      const currentMs = v.currentTime * 1000
      onTimeUpdate?.(currentMs)
      if (endMs !== undefined && currentMs >= endMs) {
        v.pause()
        v.currentTime = startMs / 1000
      }
    }

    return (
      <video
        ref={videoRef}
        src={src}
        className={className}
        onTimeUpdate={handleTimeUpdate}
        controls={false}
        playsInline
      />
    )
  },
)

VideoPlayer.displayName = "VideoPlayer"
