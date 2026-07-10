import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import type {
  Project,
  PipelineProgress,
  PipelineStage,
  WhisperModel,
  Clip,
} from "@video-editor/types"
import { Button } from "@video-editor/ui"
import { Progress } from "@video-editor/ui"
import { Spinner } from "@video-editor/ui"
import { Badge } from "@video-editor/ui"
import { Card } from "@video-editor/ui"
import { Search, Settings, X, Plus } from "lucide-react"
import { TranscriptViewer } from "./TranscriptViewer"
import { ClipReview } from "./ClipReview"
import { CaptionsPanel } from "./CaptionsPanel"
import { TrimStrip } from "./TrimStrip"

type View = "empty" | "projects" | "project"

const VIDEO_EXTS = new Set([
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "m4v",
  "wmv",
  "flv",
  "ts",
  "mts",
  "m2ts",
  "3gp",
  "ogv",
])

const MODEL_SIZES: { key: WhisperModel; label: string; size: string }[] = [
  { key: "tiny", label: "Tiny", size: "~75 MB" },
  { key: "base", label: "Base", size: "~142 MB" },
  { key: "small", label: "Small", size: "~466 MB" },
  { key: "medium", label: "Medium", size: "~1.5 GB" },
  { key: "large", label: "Large", size: "~3.1 GB" },
]

function statusColor(status: Project["status"]): "violet" | "green" | "yellow" | "red" | "neutral" {
  switch (status) {
    case "ready":
      return "green"
    case "transcribing":
    case "analyzing":
      return "yellow"
    case "error":
      return "red"
    default:
      return "neutral"
  }
}

const STAGE_TO_STATUS: Record<PipelineStage, Project["status"]> = {
  transcribing: "transcribing",
  analyzing: "analyzing",
  generating_clips: "analyzing",
  generating_content: "analyzing",
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return "just now"
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export default function App(): React.ReactElement {
  const [view, setView] = useState<View>("empty")
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pipelineProgress, setPipelineProgress] = useState<PipelineProgress | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState(0)
  const [importMessage, setImportMessage] = useState("")
  const [importError, setImportError] = useState<string | null>(null)
  const [selectedModel, setSelectedModel] = useState<WhisperModel>("medium")
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [search, setSearch] = useState("")
  const fileInputRef = useRef<HTMLInputElement>(null)

  const progressRef = useRef(pipelineProgress)
  progressRef.current = pipelineProgress
  const initialLoadDone = useRef(false)

  const liveProjects = useMemo(() => {
    if (!pipelineProgress) return projects
    return projects.map((p) =>
      p.id === pipelineProgress.projectId
        ? { ...p, status: STAGE_TO_STATUS[pipelineProgress.stage] ?? p.status }
        : p,
    )
  }, [projects, pipelineProgress])

  const selectedProject = liveProjects.find((p) => p.id === selectedId) ?? null

  const loadProjects = useCallback(async () => {
    try {
      const list = await window.api.invoke("project:list")
      setProjects(list)
      if (!initialLoadDone.current && list.length > 0) {
        initialLoadDone.current = true
        setSelectedId(list[0]!.id)
        setView("project")
      }
    } catch {
      console.error("Failed to load projects")
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    const unsubProgress = window.api.on("pipeline:progress", (data) => {
      setPipelineProgress(data)
    })
    const unsubComplete = window.api.on("pipeline:complete", ({ projectId }) => {
      if (progressRef.current?.projectId === projectId) {
        setPipelineProgress(null)
      }
      loadProjects()
    })
    const unsubError = window.api.on("pipeline:error", ({ projectId, error }) => {
      console.error("Pipeline error:", error)
      if (progressRef.current?.projectId === projectId) {
        setPipelineProgress(null)
      }
      loadProjects()
    })
    return () => {
      unsubProgress()
      unsubComplete()
      unsubError()
    }
  }, [loadProjects])

  const handleFileDrop = useCallback(
    async (filePath: string) => {
      const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
      if (!VIDEO_EXTS.has(ext)) {
        setImportError(
          `"${filePath.split("/").pop()}" is not a supported video file.\nSupported: MP4, MOV, MKV, AVI, WebM and more.`,
        )
        return
      }
      setImportError(null)
      setImporting(true)
      setImportProgress(0)
      setImportMessage("Creating project...")

      try {
        const proj = await window.api.invoke("project:create", {
          name:
            filePath
              .split("/")
              .pop()
              ?.replace(/\.[^.]+$/, "") ?? "Untitled",
          mediaPath: filePath,
        })

        setImportProgress(1)
        setImportMessage("Project created!")

        if (proj) {
          setPipelineProgress(null)
          await loadProjects()
          setSelectedId(proj.id)
          setView("project")
          setShowImportDialog(false)
        }
      } catch (err) {
        console.error("Import failed:", err)
        const msg = err instanceof Error ? err.message : String(err)
        setImportMessage(`Import failed: ${msg}`)
        return
      } finally {
        setImporting(false)
      }
    },
    [loadProjects],
  )

  const handleStartPipeline = useCallback(async () => {
    if (!selectedId) return
    try {
      await window.api.invoke("pipeline:start", { projectId: selectedId, model: selectedModel })
      loadProjects()
    } catch (err) {
      console.error("Pipeline failed:", err)
    }
  }, [selectedId, selectedModel, loadProjects])

  const handleSelectProject = useCallback((id: string) => {
    setSelectedId(id)
    setView("project")
  }, [])

  const handleNewProject = useCallback(() => {
    setImportError(null)
    setShowImportDialog(true)
  }, [])

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <div className="flex h-10 items-center drag-region">
        <div className="w-64 flex items-center justify-center">
          <button
            className="no-drag text-sm font-bold text-white hover:text-neutral-300 transition-colors cursor-pointer"
            onClick={() => {
              setSelectedId(null)
              setView("empty")
            }}
          >
            Clipper
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-64 border-r border-neutral-800 flex flex-col">
          <div className="px-3 pt-3 pb-2 flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5">
              <Search size={12} className="text-neutral-600 shrink-0" />
              <input
                type="text"
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 bg-transparent text-xs text-neutral-300 placeholder:text-neutral-600 outline-none"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="text-neutral-600 hover:text-neutral-400 cursor-pointer"
                >
                  <X size={10} />
                </button>
              )}
            </div>
            <button
              onClick={handleNewProject}
              title="New Project"
              className="shrink-0 rounded-md border border-neutral-800 bg-neutral-900 p-1.5 text-neutral-500 hover:text-neutral-200 hover:border-neutral-700 transition-colors cursor-pointer"
            >
              <Plus size={13} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-2 divide-y divide-neutral-800/60">
            {liveProjects
              .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
              .map((proj) => (
                <button
                  key={proj.id}
                  onClick={() => handleSelectProject(proj.id)}
                  className={`w-full text-left rounded-lg px-2 py-2.5 transition-colors cursor-pointer ${
                    selectedId === proj.id ? "bg-neutral-800" : "hover:bg-neutral-800/50"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                        proj.status === "ready"
                          ? "bg-green-500"
                          : proj.status === "transcribing" || proj.status === "analyzing"
                            ? "bg-yellow-500"
                            : proj.status === "error"
                              ? "bg-red-500"
                              : "bg-neutral-600"
                      }`}
                    />
                    <span className="text-sm font-medium truncate">{proj.name}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 pl-3.5">
                    <span className="text-xs text-neutral-500">{timeAgo(proj.createdAt)}</span>
                  </div>
                </button>
              ))}
          </div>

          <div className="border-t border-neutral-800 p-3">
            <button className="flex items-center gap-2 text-xs text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer w-full">
              <Settings size={13} />
              <span>Settings</span>
            </button>
          </div>
        </aside>

        <main className="flex-1 flex flex-col">
          {view === "project" && selectedProject ? (
            <ProjectView
              project={selectedProject}
              pipelineProgress={
                pipelineProgress?.projectId === selectedProject.id ? pipelineProgress : null
              }
              selectedModel={selectedModel}
              onTranscribe={handleStartPipeline}
              onModelChange={setSelectedModel}
            />
          ) : (
            <HomePage
              recentProjects={liveProjects.slice(0, 3)}
              onSelectProject={handleSelectProject}
              dragOver={dragOver}
              onDragOver={setDragOver}
              onDrop={handleFileDrop}
              onBrowse={() => fileInputRef.current?.click()}
              importing={importing}
              importProgress={importProgress}
              importMessage={importMessage}
              error={importError}
              onClearError={() => setImportError(null)}
            />
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) handleFileDrop(window.api.getFilePath(file))
              e.target.value = ""
            }}
          />
        </main>
      </div>

      {showImportDialog && (
        <ImportDialog
          selectedModel={selectedModel}
          onModelChange={setSelectedModel}
          importing={importing}
          importProgress={importProgress}
          importMessage={importMessage}
          error={importError}
          onClearError={() => setImportError(null)}
          onDrop={handleFileDrop}
          onBrowse={() => fileInputRef.current?.click()}
          onClose={() => {
            setShowImportDialog(false)
            setImportError(null)
          }}
        />
      )}
    </div>
  )
}

interface HomePageProps extends DropZoneProps {
  recentProjects: Project[]
  onSelectProject: (id: string) => void
}

function HomePage({
  recentProjects,
  onSelectProject,
  dragOver,
  onDragOver,
  onDrop,
  onBrowse,
  importing,
  importProgress,
  importMessage,
  error,
  onClearError,
}: HomePageProps): React.ReactElement {
  return (
    <div className="flex-1 overflow-y-auto p-8 space-y-8">
      {recentProjects.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">Recent</h2>
          <div className="grid grid-cols-3 gap-3">
            {recentProjects.map((proj) => (
              <button
                key={proj.id}
                onClick={() => onSelectProject(proj.id)}
                className="text-left rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 hover:border-neutral-700 transition-colors cursor-pointer"
              >
                <div className="text-sm font-medium truncate mb-2">{proj.name}</div>
                <div className="flex items-center gap-2">
                  <Badge color={statusColor(proj.status)}>{proj.status}</Badge>
                  <span className="text-xs text-neutral-500">{timeAgo(proj.createdAt)}</span>
                </div>
                {proj.durationMs > 0 && (
                  <div className="text-xs text-neutral-600 mt-1">
                    {Math.round(proj.durationMs / 1000)}s
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3 mt-6">
        <h2 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
          New Project
        </h2>
        <DropZone
          dragOver={dragOver}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onBrowse={onBrowse}
          importing={importing}
          importProgress={importProgress}
          importMessage={importMessage}
          error={error}
          onClearError={onClearError}
        />
      </div>
    </div>
  )
}

interface DropZoneProps {
  dragOver: boolean
  onDragOver: (v: boolean) => void
  onDrop: (path: string) => void
  onBrowse: () => void
  importing: boolean
  importProgress: number
  importMessage: string
  error: string | null
  onClearError: () => void
}

function DropZone({
  dragOver,
  onDragOver,
  onDrop,
  onBrowse,
  importing,
  importProgress,
  importMessage,
  error,
  onClearError,
}: DropZoneProps): React.ReactElement {
  return (
    <div
      className="flex items-center justify-center cursor-pointer"
      onClick={importing || error ? undefined : onBrowse}
      onDragOver={(e) => {
        e.preventDefault()
        onDragOver(true)
      }}
      onDragLeave={() => onDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        onDragOver(false)
        const file = e.dataTransfer.files[0]
        if (file) onDrop(window.api.getFilePath(file))
      }}
    >
      {error ? (
        <div className="text-center space-y-4 p-12 rounded-2xl border-2 border-dashed border-red-500/40 bg-red-500/5">
          <p className="text-sm font-medium text-red-400">Unsupported file</p>
          <p className="text-xs text-red-400/70 whitespace-pre-line">{error}</p>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClearError?.()
            }}
            className="text-xs px-3 py-1.5 rounded-md bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
          >
            Try again
          </button>
        </div>
      ) : importing ? (
        <div className="text-center space-y-3">
          <Spinner size={24} />
          <p className="text-sm text-neutral-400">{importMessage}</p>
          <div className="w-64">
            <Progress value={importProgress} />
          </div>
        </div>
      ) : (
        <div
          className={`text-center space-y-4 p-12 rounded-2xl border-2 border-dashed transition-colors cursor-pointer ${
            dragOver ? "border-violet-500 bg-violet-500/5" : "border-neutral-700"
          }`}
        >
          <p className="text-neutral-400 text-sm">
            {dragOver ? "Drop your video here" : "Drop a video to get started"}
          </p>
          <p className="text-neutral-600 text-xs">or</p>
          <Button variant="secondary" size="sm" onClick={onBrowse}>
            Browse Files
          </Button>
        </div>
      )}
    </div>
  )
}

interface ProjectViewProps {
  project: Project
  pipelineProgress: PipelineProgress | null
  selectedModel: WhisperModel
  onTranscribe: () => void
  onModelChange: (m: WhisperModel) => void
}

function ProjectView({
  project,
  pipelineProgress,
  selectedModel,
  onTranscribe,
  onModelChange,
}: ProjectViewProps): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [highlightRange, setHighlightRange] = useState<{
    startMs: number
    endMs: number
  } | null>(null)
  const [selectedClip, setSelectedClip] = useState<Clip | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [exportingEpisode, setExportingEpisode] = useState(false)
  const [exportingAllClips, setExportingAllClips] = useState(false)
  const [clipRefreshTrigger, setClipRefreshTrigger] = useState(0)
  const [exportingSrt, setExportingSrt] = useState(false)
  const [outputDir, setOutputDir] = useState("")
  const [burnSubtitles, setBurnSubtitles] = useState(true)
  const [subtitlesSupported, setSubtitlesSupported] = useState<boolean | null>(null)
  const [aiTab, setAiTab] = useState<"clips" | "captions">("clips")

  useEffect(() => {
    window.api.invoke("ffmpeg:has-subtitles-filter").then((supported) => {
      setSubtitlesSupported(supported)
      if (!supported) setBurnSubtitles(false)
    })
  }, [])

  useEffect(() => {
    setSelectedClip(null)
    setHighlightRange(null)
    setIsPlaying(false)
  }, [project.id])

  useEffect(() => {
    setIsPlaying(false)
    const vid = videoRef.current
    if (!vid) return
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    vid.addEventListener("play", onPlay)
    vid.addEventListener("pause", onPause)
    return () => {
      vid.removeEventListener("play", onPlay)
      vid.removeEventListener("pause", onPause)
    }
  }, [project.proxyPath])

  const seekTo = useCallback((startMs: number, autoPlay = false) => {
    const vid = videoRef.current
    if (!vid) return
    vid.currentTime = startMs / 1000
    if (autoPlay) vid.play().catch(() => {})
  }, [])

  const handleTogglePlay = useCallback(() => {
    const vid = videoRef.current
    if (!vid) return
    if (vid.paused) vid.play().catch(() => {})
    else vid.pause()
  }, [])

  const handleSeekWord = useCallback(
    (startMs: number) => {
      setHighlightRange(null)
      seekTo(startMs, true)
    },
    [seekTo],
  )

  const handleSelectClip = useCallback(
    (clip: Clip) => {
      setSelectedClip(clip)
      setHighlightRange({ startMs: clip.startMs, endMs: clip.endMs })
      seekTo(clip.startMs, false)
    },
    [seekTo],
  )

  const handleExportEpisode = useCallback(async () => {
    setExportingEpisode(true)
    try {
      const outPath = await window.api.invoke("export:full", {
        projectId: project.id,
        ...(outputDir ? { outputDir } : {}),
        burnSubtitles,
      })
      if (outPath) await window.api.invoke("shell:show-item", { path: outPath })
    } catch (err) {
      console.error("Export episode failed:", err)
    } finally {
      setExportingEpisode(false)
    }
  }, [project.id, outputDir, burnSubtitles])

  const handleExportAllClips = useCallback(async () => {
    setExportingAllClips(true)
    try {
      const allClips = await window.api.invoke("clip:list", { projectId: project.id })
      const approvedIds = allClips.filter((c) => c.status === "approved").map((c) => c.id)
      if (approvedIds.length === 0) return
      const paths = await window.api.invoke("export:clips", {
        projectId: project.id,
        clipIds: approvedIds,
        ...(outputDir ? { outputDir } : {}),
        burnSubtitles,
      })
      setClipRefreshTrigger((n) => n + 1)
      if (paths[0]) await window.api.invoke("shell:show-item", { path: paths[0] })
    } catch (err) {
      console.error("Export clips failed:", err)
    } finally {
      setExportingAllClips(false)
    }
  }, [project.id, outputDir, burnSubtitles])

  const handleExportSrt = useCallback(async () => {
    setExportingSrt(true)
    try {
      const outPath = await window.api.invoke("export:srt", {
        projectId: project.id,
        ...(outputDir ? { outputDir } : {}),
      })
      if (outPath) await window.api.invoke("shell:show-item", { path: outPath })
    } catch (err) {
      console.error("Export SRT failed:", err)
    } finally {
      setExportingSrt(false)
    }
  }, [project.id, outputDir])

  const handlePickFolder = useCallback(async () => {
    const picked = await window.api.invoke("dialog:pick-folder", {
      ...(outputDir ? { defaultPath: outputDir } : {}),
    })
    if (picked) setOutputDir(picked)
  }, [outputDir])

  return (
    <div className="flex-1 p-6 space-y-6 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-medium">{project.name}</h1>
          <p className="text-xs text-neutral-500 mt-0.5">
            {project.durationMs > 0
              ? `${Math.round(project.durationMs / 1000)}s`
              : "Unknown duration"}
            {" · "}
            <Badge color={statusColor(project.status)}>{project.status}</Badge>
          </p>
        </div>

        <div className="flex items-center gap-2">
          {project.status === "ready" && (
            <>
              <button
                onClick={handleExportAllClips}
                disabled={exportingAllClips}
                title="Export all approved clips as separate video files"
                className="rounded-md border border-violet-700 bg-violet-900/40 px-3 py-1.5 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-800/60 hover:text-violet-100 disabled:opacity-50 disabled:pointer-events-none cursor-pointer disabled:cursor-default"
              >
                {exportingAllClips ? "Exporting..." : "Export Clips"}
              </button>
              <button
                onClick={handleExportEpisode}
                disabled={exportingEpisode}
                title="Export full video with fillers and silences removed"
                className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50 disabled:pointer-events-none cursor-pointer disabled:cursor-default"
              >
                {exportingEpisode ? "Exporting..." : "Export Episode"}
              </button>
            </>
          )}
          {(project.status === "idle" || project.status === "error") && (
            <>
              <div className="flex rounded-lg border border-neutral-700 overflow-hidden text-xs">
                {MODEL_SIZES.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => onModelChange(m.key)}
                    className={`px-2 py-1 font-medium transition-colors cursor-pointer ${
                      selectedModel === m.key
                        ? "bg-violet-600 text-white"
                        : "bg-neutral-800 text-neutral-400 hover:text-neutral-200"
                    }`}
                    title={m.size}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <Button size="sm" onClick={onTranscribe}>
                {project.status === "error" ? "Retry Transcribe" : "Transcribe"}
              </Button>
            </>
          )}
        </div>
      </div>

      {project.status === "ready" && (
        <div className="flex items-center gap-4 -mt-2">
          <label
            className={`flex items-center gap-2 select-none ${subtitlesSupported === false ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
            title={
              subtitlesSupported === false
                ? "Your FFmpeg build lacks libass — run: bash scripts/setup-ffmpeg.sh"
                : "Burn subtitles into exported video"
            }
          >
            <div
              onClick={subtitlesSupported === false ? undefined : () => setBurnSubtitles((v) => !v)}
              className={`relative w-7 h-4 rounded-full transition-colors cursor-pointer ${burnSubtitles ? "bg-violet-600" : "bg-neutral-700"}`}
            >
              <div
                className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${burnSubtitles ? "translate-x-3.5" : "translate-x-0.5"}`}
              />
            </div>
            <span className="text-xs text-neutral-400">Subtitles</span>
          </label>

          <button
            onClick={handlePickFolder}
            className="flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-300 transition-colors cursor-pointer"
            title={outputDir || "Output to ~/Downloads"}
          >
            <span>{outputDir ? `Save to ${outputDir.split("/").pop()}` : "Save to Downloads"}</span>
            <span className="text-neutral-600">▾</span>
          </button>

          <button
            onClick={handleExportSrt}
            disabled={exportingSrt}
            className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors disabled:opacity-40 cursor-pointer disabled:cursor-default"
          >
            {exportingSrt ? "Exporting..." : "Export SRT"}
          </button>
        </div>
      )}

      {pipelineProgress && (
        <Card className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium capitalize">{pipelineProgress.stage}</span>
            <span className="text-xs text-neutral-500">
              {Math.round(pipelineProgress.progress * 100)}%
            </span>
          </div>
          <Progress value={pipelineProgress.progress} />
          {pipelineProgress.message && (
            <p className="text-xs text-neutral-400">{pipelineProgress.message}</p>
          )}
        </Card>
      )}

      {!project.proxyPath && project.status !== "error" ? (
        <div className="aspect-video bg-neutral-900 rounded-xl flex flex-col items-center justify-center gap-3">
          <Spinner size={24} />
          <p className="text-sm text-neutral-500">
            {pipelineProgress?.message ?? "Preparing video..."}
          </p>
        </div>
      ) : project.proxyPath ? (
        <div className="space-y-2">
          <div
            className="relative aspect-video bg-neutral-900 rounded-xl overflow-hidden group cursor-pointer"
            onClick={handleTogglePlay}
          >
            <video
              ref={videoRef}
              src={`file://${project.proxyPath}`}
              className="w-full h-full object-contain"
              playsInline
            />
            {!isPlaying && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-12 h-12 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <svg
                    className="w-5 h-5 text-white ml-0.5"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            )}
          </div>

          {selectedClip && project.durationMs > 0 && (
            <TrimStrip
              clip={selectedClip}
              durationMs={project.durationMs}
              onSeek={(ms) => seekTo(ms, false)}
              onSaved={() => {
                setClipRefreshTrigger((n) => n + 1)
              }}
            />
          )}
        </div>
      ) : null}

      {project.status === "ready" && (
        <>
          <TranscriptViewer
            projectId={project.id}
            onSeekWord={handleSeekWord}
            highlightRange={highlightRange}
          />

          <div>
            <div className="flex gap-1 border-b border-neutral-800 mb-4">
              {(["clips", "captions"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setAiTab(tab)}
                  className={`px-3 py-1.5 text-xs font-medium capitalize transition-colors border-b-2 -mb-px cursor-pointer ${
                    aiTab === tab
                      ? "border-violet-500 text-violet-300"
                      : "border-transparent text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  {tab === "clips" ? "Suggested Clips" : "Social Captions"}
                </button>
              ))}
            </div>

            {aiTab === "clips" ? (
              <ClipReview
                projectId={project.id}
                onSelectClip={handleSelectClip}
                exportSettings={{ outputDir, burnSubtitles }}
                refreshTrigger={clipRefreshTrigger}
              />
            ) : (
              <CaptionsPanel projectId={project.id} />
            )}
          </div>
        </>
      )}
    </div>
  )
}

interface ImportDialogProps {
  selectedModel: WhisperModel
  onModelChange: (m: WhisperModel) => void
  importing: boolean
  importProgress: number
  importMessage: string
  error?: string | null
  onClearError?: () => void
  onDrop: (path: string) => void
  onBrowse: () => void
  onClose: () => void
}

function ImportDialog({
  selectedModel,
  onModelChange,
  importing,
  importProgress,
  importMessage,
  error,
  onClearError,
  onDrop,
  onBrowse,
  onClose,
}: ImportDialogProps): React.ReactElement {
  const [dragOver, setDragOver] = useState(false)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <Card className="w-full max-w-md mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium">Import Video</h2>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-sm cursor-pointer"
          >
            ✕
          </button>
        </div>

        {error ? (
          <div className="rounded-xl border-2 border-dashed border-red-500/40 bg-red-500/5 p-8 text-center space-y-3">
            <p className="text-sm font-medium text-red-400">Unsupported file</p>
            <p className="text-xs text-red-400/70 whitespace-pre-line">{error}</p>
            <button
              onClick={onClearError}
              className="text-xs px-3 py-1.5 rounded-md bg-neutral-800 text-neutral-300 hover:bg-neutral-700 transition-colors"
            >
              Try again
            </button>
          </div>
        ) : (
          <div
            className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors cursor-pointer ${
              dragOver ? "border-violet-500 bg-violet-500/5" : "border-neutral-700"
            }`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const file = e.dataTransfer.files[0]
              if (file) onDrop(window.api.getFilePath(file))
            }}
          >
            {importing ? (
              <div className="space-y-3">
                <Spinner size={20} />
                <p className="text-xs text-neutral-400">{importMessage}</p>
                <Progress value={importProgress} />
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-neutral-400">Drop a video file here</p>
                <Button variant="secondary" size="sm" onClick={onBrowse}>
                  Browse Files
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="mt-4">
          <p className="text-xs text-neutral-500 mb-2">Whisper Model (for transcription)</p>
          <div className="grid grid-cols-2 gap-2">
            {MODEL_SIZES.map((m) => (
              <button
                key={m.key}
                onClick={() => onModelChange(m.key)}
                className={`text-left p-2 rounded-lg border text-xs transition-colors ${
                  selectedModel === m.key
                    ? "border-violet-500 bg-violet-500/10 text-violet-300"
                    : "border-neutral-700 text-neutral-400 hover:border-neutral-600"
                }`}
              >
                <div className="font-medium">{m.label}</div>
                <div className="text-neutral-500">{m.size}</div>
              </button>
            ))}
          </div>
        </div>
      </Card>
    </div>
  )
}
