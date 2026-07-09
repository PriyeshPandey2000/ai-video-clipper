import { useState, useEffect } from "react"
import { Spinner } from "@video-editor/ui"

interface SocialCaption {
  platform: "twitter" | "linkedin" | "instagram"
  caption: string
  hashtags: string[]
}

const PLATFORM_LABEL: Record<SocialCaption["platform"], string> = {
  twitter: "X / Twitter",
  linkedin: "LinkedIn",
  instagram: "Instagram",
}

interface CaptionsPanelProps {
  projectId: string
}

export function CaptionsPanel({ projectId }: CaptionsPanelProps): React.ReactElement | null {
  const [captions, setCaptions] = useState<SocialCaption[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api
      .invoke("project:get-ai-outputs", { projectId })
      .then((outputs) => {
        if (cancelled) return
        const row = outputs.find((o) => o.type === "social_caption")
        if (row) {
          try {
            const parsed: unknown = JSON.parse(row.content)
            const arr = Array.isArray(parsed)
              ? parsed
              : Array.isArray((parsed as Record<string, unknown>)?.captions)
                ? (parsed as Record<string, unknown>).captions
                : null
            setCaptions(arr as SocialCaption[] | null)
          } catch {
            setCaptions(null)
          }
        }
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const handleCopy = (platform: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(platform)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner size={16} />
      </div>
    )
  }

  if (!captions || captions.length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
          Social Captions
        </h3>
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 text-center">
          <p className="text-sm text-neutral-500">No captions generated yet</p>
          <p className="text-xs text-neutral-600 mt-1">
            Requires GROQ_API_KEY and at least one clip suggestion.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
        Social Captions
      </h3>

      <div className="space-y-2">
        {captions.map((c) => {
          const tags = Array.isArray(c.hashtags)
            ? c.hashtags
            : typeof c.hashtags === "string"
              ? (c.hashtags as string).split(/[\s,]+/).filter(Boolean)
              : []
          const tagLine = tags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")
          const fullText = [c.caption, tagLine].filter(Boolean).join("\n\n")
          const isCopied = copied === c.platform

          return (
            <div
              key={c.platform}
              className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3 space-y-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-neutral-400">
                  {PLATFORM_LABEL[c.platform]}
                </span>
                <button
                  onClick={() => handleCopy(c.platform, fullText)}
                  className="text-[11px] px-2 py-0.5 rounded bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-neutral-200 transition-colors"
                >
                  {isCopied ? "Copied!" : "Copy"}
                </button>
              </div>

              <p className="text-sm text-neutral-300 leading-relaxed">{c.caption}</p>

              {tagLine && <p className="text-xs text-violet-400/70">{tagLine}</p>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
