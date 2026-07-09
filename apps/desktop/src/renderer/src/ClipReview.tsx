import { useState, useEffect, useCallback } from "react"
import type { Clip } from "@video-editor/types"
import { Spinner, Badge } from "@video-editor/ui"

interface ClipReviewProps {
  projectId: string
  onSelectClip: (startMs: number, endMs: number) => void
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

function scoreColor(score: number | null): "green" | "yellow" | "red" | "neutral" {
  if (score === null) return "neutral"
  if (score >= 0.7) return "green"
  if (score >= 0.4) return "yellow"
  return "red"
}

function statusBadgeColor(
  status: Clip["status"],
): "violet" | "green" | "yellow" | "red" | "neutral" {
  switch (status) {
    case "suggested":
      return "violet"
    case "approved":
      return "green"
    case "rejected":
      return "red"
    case "exported":
      return "neutral"
  }
}

export function ClipReview({
  projectId,
  onSelectClip,
}: ClipReviewProps): React.ReactElement | null {
  const [clips, setClips] = useState<Clip[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const loadClips = useCallback(async () => {
    try {
      const result = await window.api.invoke("clip:list", { projectId })
      setClips(result)
    } catch (err) {
      console.error("Failed to load clips:", err)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    loadClips()
  }, [loadClips])

  const handleSelect = useCallback(
    (clip: Clip) => {
      setSelectedId(clip.id)
      onSelectClip(clip.startMs, clip.endMs)
    },
    [onSelectClip],
  )

  const handleApprove = useCallback(async (clipId: string) => {
    try {
      await window.api.invoke("clip:update-status", {
        clipId,
        status: "approved",
      })
      setClips((prev) =>
        prev
          ? prev.map((c) => (c.id === clipId ? { ...c, status: "approved" as const } : c))
          : null,
      )
    } catch (err) {
      console.error("Failed to approve clip:", err)
    }
  }, [])

  const handleReject = useCallback(async (clipId: string) => {
    try {
      await window.api.invoke("clip:update-status", {
        clipId,
        status: "rejected",
      })
      setClips((prev) =>
        prev
          ? prev.map((c) => (c.id === clipId ? { ...c, status: "rejected" as const } : c))
          : null,
      )
    } catch (err) {
      console.error("Failed to reject clip:", err)
    }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size={20} />
      </div>
    )
  }

  if (!clips || clips.length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
          Suggested Clips
        </h3>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 text-center">
          <p className="text-sm text-neutral-500">No clips generated yet</p>
          <p className="text-xs text-neutral-600 mt-1">
            AI analysis needs a GROQ_API_KEY in your .env file at the project root.
          </p>
        </div>
      </div>
    )
  }

  const sorted = [...clips].sort((a, b) => a.startMs - b.startMs)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
          Suggested Clips
        </h3>
        <span className="text-[11px] text-neutral-600">{clips.length} clips</span>
      </div>

      <div className="space-y-2">
        {sorted.map((clip) => {
          const isSelected = clip.id === selectedId
          const isDecided = clip.status === "approved" || clip.status === "rejected"

          return (
            <div
              key={clip.id}
              onClick={() => handleSelect(clip)}
              className={`rounded-lg border p-3 cursor-pointer transition-colors ${
                isSelected
                  ? "border-violet-500/50 bg-violet-500/5"
                  : "border-neutral-800 bg-neutral-900/50 hover:border-neutral-700"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-neutral-200 truncate">
                      {clip.title}
                    </span>
                    <Badge color={scoreColor(clip.aiScore)}>
                      {clip.aiScore !== null ? `${Math.round(clip.aiScore * 10)}/10` : "—"}
                    </Badge>
                    <span className="text-[11px] text-neutral-500 whitespace-nowrap font-mono">
                      {formatDuration(clip.endMs - clip.startMs)}
                    </span>
                  </div>

                  {clip.aiReason && (
                    <p className="text-xs text-neutral-500 line-clamp-2">{clip.aiReason}</p>
                  )}
                </div>

                <Badge color={statusBadgeColor(clip.status)}>{clip.status}</Badge>
              </div>

              <div className="flex gap-2 mt-2">
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    if (clip.status !== "exported") handleApprove(clip.id)
                  }}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
                    clip.status === "approved"
                      ? "bg-green-600 text-white"
                      : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                  } ${clip.status === "exported" ? "opacity-50 pointer-events-none" : ""}`}
                >
                  {clip.status === "approved" ? "Approved" : "Approve"}
                </span>
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!isDecided) handleReject(clip.id)
                  }}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
                    clip.status === "rejected"
                      ? "bg-red-600 text-white"
                      : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-red-400"
                  } ${isDecided ? "opacity-50 pointer-events-none" : ""}`}
                >
                  {clip.status === "rejected" ? "Rejected" : "Reject"}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
