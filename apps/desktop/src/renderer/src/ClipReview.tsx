import { useState, useEffect, useCallback } from "react"
import type { Clip, ClipJudgeRecord, ClipProfileId, JudgeGrade } from "@video-editor/types"
import {
  CLIP_PROFILE_DISPLAY,
  CLIP_PROFILE_IDS,
  describeClipProfile,
  parseClipJudge,
} from "@video-editor/types"
import type { CaptionStyle } from "@video-editor/types"
import { Spinner, Badge, Progress, Button } from "@video-editor/ui"

interface ExportSettings {
  outputDir: string
  burnSubtitles: boolean
  reframe: boolean
  blurBg?: boolean
  removeFillers: boolean
  captionStyle?: CaptionStyle
}

interface ClipReviewProps {
  projectId: string
  onSelectClip: (clip: Clip) => void
  exportSettings: ExportSettings
  refreshTrigger?: number
  /** True once the pipeline has finished — distinguishes "not run yet" from "found nothing". */
  analysisComplete?: boolean
  /**
   * Set while a pipeline run is active for this project. Gates the re-run button, because
   * `clip:reselect` refuses to run alongside a transcription and the user should not have to
   * discover that by reading an error.
   */
  pipelineRunning?: boolean
  /**
   * Bumped by the parent when a run completes, so this panel reloads clips after a re-selection
   * it did not itself trigger.
   */
  onReselectComplete?: () => void
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

/** Short chip labels for the universal judge questions; profile questions are labelled by number. */
const JUDGE_LABELS: Record<string, string> = {
  hook: "Hook",
  standalone: "Standalone",
  payoff: "Payoff",
  oneIdea: "One idea",
  postable: "Postable",
}

function judgeLabel(id: string): string {
  const known = JUDGE_LABELS[id]
  if (known) return known
  // Profile questions are stored as `<profile>_<n>`; the full text is in the chip's tooltip.
  const n = id.match(/_(\d+)$/)?.[1]
  return n ? `Genre ${n}` : id
}

const GRADE_MARK: Record<JudgeGrade, string> = { yes: "✓", partly: "~", no: "✗" }
const GRADE_STYLE: Record<JudgeGrade, string> = {
  yes: "bg-green-500/10 text-green-400",
  partly: "bg-yellow-500/10 text-yellow-400",
  no: "bg-red-500/10 text-red-400",
}

/** Pass/fail chips for the judge's answers, plus its one-line note. Nothing for an unjudged clip. */
function JudgeSummary({ judge }: { judge: ClipJudgeRecord }): React.ReactElement {
  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap gap-1">
        {judge.questions.map((q) => {
          const grade = judge.answers[q.id] ?? "no"
          return (
            <span
              key={q.id}
              title={`${q.text}${q.hard ? " (required)" : ""}`}
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${GRADE_STYLE[grade]}`}
            >
              {GRADE_MARK[grade]} {judgeLabel(q.id)}
            </span>
          )
        })}
      </div>
      {judge.note && <p className="text-xs text-neutral-400 line-clamp-2">{judge.note}</p>}
    </div>
  )
}

function cropLabel(cropX: number): "L" | "C" | "R" {
  if (cropX < 0.33) return "L"
  if (cropX > 0.67) return "R"
  return "C"
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
  exportSettings,
  refreshTrigger,
  analysisComplete,
  pipelineRunning,
  onReselectComplete,
}: ClipReviewProps): React.ReactElement | null {
  const [clips, setClips] = useState<Clip[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [exportingIds, setExportingIds] = useState<Set<string>>(new Set())
  const [clipProgress, setClipProgress] = useState<Record<string, number>>({})
  const [reselecting, setReselecting] = useState(false)
  const [lastReportPath, setLastReportPath] = useState<string | null>(null)
  const [reselectError, setReselectError] = useState<string | null>(null)
  const [progressMessage, setProgressMessage] = useState<string | null>(null)
  const [profileInfo, setProfileInfo] = useState<{
    analysis: Parameters<typeof describeClipProfile>[0]["analysis"]
    override: ClipProfileId | null
  } | null>(null)

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
  }, [loadClips, refreshTrigger])

  useEffect(() => {
    return window.api.on("export:progress", (data) => {
      if (data.projectId !== projectId || data.stage !== "clips" || !data.clipId) return
      setClipProgress((p) => ({ ...p, [data.clipId!]: data.progress }))
    })
  }, [projectId])

  // Reuse the pipeline's progress events rather than inventing a second channel: the messages
  // ("Analyzing transcript for clips") are already written for this stage, and a separate event
  // would be a second thing to keep in sync with the main-process flow.
  useEffect(() => {
    return window.api.on("pipeline:progress", (data) => {
      if (data.projectId !== projectId) return
      setProgressMessage(data.message ?? null)
    })
  }, [projectId])

  const loadLastReport = useCallback(async () => {
    try {
      setLastReportPath(await window.api.invoke("clip:last-report", { projectId }))
    } catch {
      setLastReportPath(null)
    }
  }, [projectId])

  useEffect(() => {
    loadLastReport()
  }, [loadLastReport])

  // The stored analysis and override. Reloaded after every run, failed ones included: a failed
  // override change is rolled back in the main process, and the control must show what is stored
  // rather than what was asked for.
  const loadProfile = useCallback(async () => {
    try {
      const { analysis, override } = await window.api.invoke("project:get-clip-profile", {
        projectId,
      })
      setProfileInfo({ analysis, override })
    } catch (err) {
      console.error("Failed to load clip profile:", err)
    }
  }, [projectId])

  useEffect(() => {
    void loadProfile()
  }, [loadProfile, refreshTrigger])

  // One path for both ways of re-running — the plain button and a genre change — so the busy
  // state, the error text and the reloads cannot drift apart.
  const runSelection = useCallback(
    async (run: () => Promise<{ reportMarkdownPath: string }>) => {
      setReselecting(true)
      setReselectError(null)
      try {
        const result = await run()
        setLastReportPath(result.reportMarkdownPath)
        // Reload from the DB rather than trusting the returned count — approved/exported clips
        // survive the replace, so the visible list is not only the new suggestions.
        await loadClips()
        onReselectComplete?.()
      } catch (err) {
        setReselectError(err instanceof Error ? err.message : String(err))
      } finally {
        await loadProfile()
        setReselecting(false)
        setProgressMessage(null)
      }
    },
    [loadClips, loadProfile, onReselectComplete],
  )

  const handleReselect = useCallback(
    () => runSelection(() => window.api.invoke("clip:reselect", { projectId })),
    [runSelection, projectId],
  )

  const handleProfileChange = useCallback(
    (override: ClipProfileId | null) =>
      runSelection(() => window.api.invoke("project:set-clip-profile", { projectId, override })),
    [runSelection, projectId],
  )

  const handleOpenReport = useCallback(async () => {
    if (!lastReportPath) return
    try {
      await window.api.invoke("shell:show-item", { path: lastReportPath })
    } catch (err) {
      console.error("Failed to open selection report:", err)
    }
  }, [lastReportPath])

  const handleSelect = useCallback(
    (clip: Clip) => {
      setSelectedId(clip.id)
      onSelectClip(clip)
    },
    [onSelectClip],
  )

  const handleSetStatus = useCallback(
    async (clipId: string, current: Clip["status"], target: "approved" | "rejected") => {
      const newStatus = current === target ? "suggested" : target
      try {
        await window.api.invoke("clip:update-status", { clipId, status: newStatus })
        setClips((prev) =>
          prev ? prev.map((c) => (c.id === clipId ? { ...c, status: newStatus } : c)) : null,
        )
      } catch (err) {
        console.error("Failed to update clip status:", err)
      }
    },
    [],
  )

  const handleExport = useCallback(
    async (clipId: string) => {
      setExportingIds((prev) => new Set(prev).add(clipId))
      try {
        const paths = await window.api.invoke("export:clips", {
          projectId,
          clipIds: [clipId],
          ...(exportSettings.outputDir ? { outputDir: exportSettings.outputDir } : {}),
          burnSubtitles: exportSettings.burnSubtitles,
          reframe: exportSettings.reframe,
          removeFillers: exportSettings.removeFillers,
          ...(exportSettings.blurBg ? { blurBg: true } : {}),
          ...(exportSettings.burnSubtitles && exportSettings.captionStyle
            ? { captionStyle: exportSettings.captionStyle }
            : {}),
        })
        setClips((prev) =>
          prev
            ? prev.map((c) => (c.id === clipId ? { ...c, status: "exported" as const } : c))
            : null,
        )
        if (paths[0]) {
          await window.api.invoke("shell:show-item", { path: paths[0] })
        }
      } catch (err) {
        console.error("Failed to export clip:", err)
      } finally {
        setExportingIds((prev) => {
          const next = new Set(prev)
          next.delete(clipId)
          return next
        })
        setClipProgress((p) => {
          const next = { ...p }
          delete next[clipId]
          return next
        })
      }
    },
    [projectId, exportSettings],
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size={20} />
      </div>
    )
  }

  const reselectDisabled = reselecting || loading || Boolean(pipelineRunning)

  // Rendered above both the empty and populated states: a project that found no clips is exactly
  // the case where re-running is most worth trying, so hiding the button there would remove the
  // only control that can act on it.
  const profile = describeClipProfile({
    analysis: profileInfo?.analysis ?? null,
    override: profileInfo?.override ?? null,
  })

  const toolbar = (
    <div className="space-y-1.5">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="clip-genre" className="text-[11px] text-neutral-500">
            Genre
          </label>
          <select
            id="clip-genre"
            value={profileInfo?.override ?? "auto"}
            // Nothing to re-run before the first selection: `project:set-clip-profile` refuses a
            // project with no transcript, so offering it would only produce an error.
            // (Choosing the genre before the first run is #108.)
            disabled={
              reselectDisabled ||
              profileInfo === null ||
              (profile.state === "none" && !analysisComplete)
            }
            onChange={(e) =>
              void handleProfileChange(
                e.target.value === "auto" ? null : (e.target.value as ClipProfileId),
              )
            }
            title={
              pipelineRunning
                ? "Wait for the current pipeline run to finish"
                : "Changing the genre re-runs clip selection from the stored transcript"
            }
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 disabled:opacity-50"
          >
            <option value="auto">Auto (detect)</option>
            {CLIP_PROFILE_IDS.map((id) => (
              <option key={id} value={id}>
                {CLIP_PROFILE_DISPLAY[id].label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-neutral-400">{profile.headline}</span>
        </div>
        {profile.lookingFor && (
          <p className="text-[11px] text-neutral-500">Looking for: {profile.lookingFor}</p>
        )}
        {profile.alsoLooksLike && (
          <p className="text-[11px] text-neutral-500">Also looks like: {profile.alsoLooksLike}</p>
        )}
        {profile.lowConfidence && (
          <p className="text-[11px] text-yellow-500/80">
            The detector was unsure. If this is wrong, pick the genre above to re-run.
          </p>
        )}
        {profile.visualWarning && (
          <p className="text-[11px] text-yellow-500/80">
            Visual videos are mostly decided by what is on screen. Clips are chosen from the spoken
            words only, so expect weaker picks.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={reselectDisabled}
          loading={reselecting}
          onClick={() => void handleReselect()}
          title={
            pipelineRunning
              ? "Wait for the current pipeline run to finish"
              : "Re-run clip selection from the stored transcript, without transcribing again"
          }
        >
          {reselecting ? "Re-running..." : "Re-run clip selection"}
        </Button>
        {lastReportPath && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleOpenReport()}
            title={lastReportPath}
          >
            Open last report
          </Button>
        )}
      </div>
      {reselecting && progressMessage && (
        <p className="text-[11px] text-neutral-500">{progressMessage}…</p>
      )}
      {reselectError && (
        <p className="text-[11px] text-red-400">
          Re-run failed: {reselectError}. Your existing suggestions were left unchanged.
        </p>
      )}
    </div>
  )

  if (!clips || clips.length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
          Suggested Clips
        </h3>
        {toolbar}
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 text-center">
          {analysisComplete ? (
            <>
              <p className="text-sm text-neutral-500">No strong moments found</p>
              <p className="text-xs text-neutral-600 mt-1">
                Nothing in this video met the quality bar. Returning weak clips would waste your
                time.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-neutral-500">No clips generated yet</p>
              <p className="text-xs text-neutral-600 mt-1">
                AI analysis needs a GROQ_API_KEY in your .env file at the project root.
              </p>
            </>
          )}
        </div>
      </div>
    )
  }

  const sorted = [...clips].sort((a, b) => a.startMs - b.startMs)

  return (
    <div className="space-y-3">
      {toolbar}
      <div className="space-y-2">
        {sorted.map((clip) => {
          const isSelected = clip.id === selectedId
          const isExporting = exportingIds.has(clip.id)
          const isExported = clip.status === "exported"
          const progress = clipProgress[clip.id]
          const judge = parseClipJudge(clip.judgeJson)

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
                    <Badge color="neutral">{cropLabel(clip.cropX)}</Badge>
                  </div>

                  {clip.aiReason && (
                    <p className="text-xs text-neutral-500 line-clamp-2">{clip.aiReason}</p>
                  )}
                  {judge && <JudgeSummary judge={judge} />}
                </div>

                {clip.status !== "suggested" && (
                  <Badge color={statusBadgeColor(clip.status)}>{clip.status}</Badge>
                )}
              </div>

              {isExporting && progress !== undefined && (
                <div className="mt-2 space-y-1">
                  <Progress value={progress} />
                  <p className="text-[10px] text-neutral-500 text-right">
                    {Math.round(progress * 100)}%
                  </p>
                </div>
              )}

              <div className="flex gap-2 mt-2">
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!isExported) handleSetStatus(clip.id, clip.status, "approved")
                  }}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
                    clip.status === "approved"
                      ? "bg-green-600 text-white hover:bg-green-700"
                      : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                  } ${isExported ? "opacity-50 pointer-events-none" : ""}`}
                  title={clip.status === "approved" ? "Click to undo" : undefined}
                >
                  {clip.status === "approved" ? "✓ Approved" : "Approve"}
                </span>
                <span
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!isExported) handleSetStatus(clip.id, clip.status, "rejected")
                  }}
                  className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
                    clip.status === "rejected"
                      ? "bg-red-600 text-white hover:bg-red-700"
                      : "bg-neutral-800 text-neutral-400 hover:bg-neutral-700 hover:text-red-400"
                  } ${isExported ? "opacity-50 pointer-events-none" : ""}`}
                  title={clip.status === "rejected" ? "Click to undo" : undefined}
                >
                  {clip.status === "rejected" ? "✕ Rejected" : "Reject"}
                </span>
                {(clip.status === "approved" || clip.status === "exported") && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation()
                      if (!isExporting) handleExport(clip.id)
                    }}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors cursor-pointer ${
                      isExporting
                        ? "bg-neutral-800 text-neutral-500 pointer-events-none"
                        : clip.status === "exported"
                          ? "bg-neutral-700 text-neutral-400 hover:bg-violet-700 hover:text-white"
                          : "bg-violet-700 text-white hover:bg-violet-600"
                    }`}
                  >
                    {isExporting
                      ? "Exporting..."
                      : clip.status === "exported"
                        ? "Re-export"
                        : "Export"}
                  </span>
                )}
              </div>

              {isExporting && progress !== undefined && (
                <div className="mt-2 space-y-1">
                  <Progress value={progress} />
                  <p className="text-[10px] text-neutral-500 text-right">
                    {Math.round(progress * 100)}%
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
