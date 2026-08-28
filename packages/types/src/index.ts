// ─── Whisper types ─────────────────────────────────────────────────────────

export interface WhisperWord {
  word: string
  start: number
  end: number
  probability: number
}

export interface WhisperSegment {
  id: number
  start: number
  end: number
  text: string
  words: WhisperWord[]
}

export interface WhisperTranscriptionResult {
  segments: WhisperSegment[]
  language: string
}

// ─── Domain types ──────────────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  mediaPath: string
  proxyPath: string | null
  durationMs: number
  status: "idle" | "transcribing" | "analyzing" | "ready" | "error"
  createdAt: number
  updatedAt: number
}

export interface Word {
  id: string
  projectId: string
  text: string
  startMs: number
  endMs: number
  confidence: number
  speakerLabel: string | null
}

export interface Sentence {
  index: number
  startMs: number
  endMs: number
  text: string
  firstWordIndex: number
  lastWordIndex: number
  /** Ends on `.`/`!`/`?` rather than being split by a pause or the length cap. */
  endsWithTerminator: boolean
}

export interface Clip {
  id: string
  projectId: string
  title: string
  startMs: number
  endMs: number
  aiScore: number | null
  aiReason: string | null
  status: "suggested" | "approved" | "rejected" | "exported"
  platform: "tiktok" | "reels" | "shorts" | "generic" | null
  cropX: number
  createdAt: number
}

export interface Segment {
  id: string
  projectId: string
  type: "filler" | "silence"
  startMs: number
  endMs: number
}

export interface AiOutput {
  id: string
  projectId: string
  type: "blog_post" | "social_caption" | "timestamps" | "chapter_markers"
  content: string
  createdAt: number
}

export type PipelineStage = "transcribing" | "analyzing" | "generating_clips" | "generating_content"

export type WhisperModel = "tiny" | "base" | "small" | "medium" | "large"

export const WHISPER_MODELS: WhisperModel[] = ["tiny", "base", "small", "medium", "large"]

// Single source for display metadata — was previously hand-copied across the whisper
// package, the model picker, and Settings, and had already drifted (whisper's own copy
// was unused dead code).
export const WHISPER_MODEL_INFO: Record<WhisperModel, { label: string; sizeLabel: string }> = {
  tiny: { label: "Tiny", sizeLabel: "~75 MB" },
  base: { label: "Base", sizeLabel: "~142 MB" },
  small: { label: "Small", sizeLabel: "~466 MB" },
  medium: { label: "Medium", sizeLabel: "~1.5 GB" },
  large: { label: "Large", sizeLabel: "~3.1 GB" },
}

export interface PipelineProgress {
  projectId: string
  stage: PipelineStage
  progress: number // 0–1
  message?: string
}

export interface ModelInfo {
  model: WhisperModel
  downloaded: boolean
  sizeOnDisk: number | null
}

// Mirrors the events fired over IpcEventChannels below, plus "idle" for before anything has
// happened — lets a late-mounting subscriber (e.g. UpdateToast after a fast update-available)
// catch up on whatever it missed via updater:get-state, rather than relying on
// webContents.send() to a not-yet-listening renderer (which just silently drops the message).
export type UpdaterState =
  | { kind: "idle" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; percent: number }
  | { kind: "downloaded"; readyToInstall: boolean }
  | { kind: "error"; message: string }

// ─── IPC channel type map ──────────────────────────────────────────────────
// Renderer → main (invoke): { args, result }
// Main → renderer (on): payload only

export interface CaptionStyle {
  preset: "hormozi" | "wordpop" | "none"
  accentColor: string
  textColor: string
  position: "bottom" | "top"
  size: "S" | "M" | "L"
  allCaps: boolean
  showKeywords: boolean
}

export interface IpcInvokeChannels {
  "project:list": { args: void; result: Project[] }
  "project:create": { args: { name: string; mediaPath: string }; result: Project }
  "project:get": { args: { id: string }; result: Project | null }
  "project:get-words": { args: { projectId: string }; result: Word[] }
  "project:get-ai-outputs": { args: { projectId: string }; result: AiOutput[] }
  "pipeline:start": { args: { projectId: string; model: WhisperModel }; result: void }
  "clip:list": { args: { projectId: string }; result: Clip[] }
  "clip:update-status": { args: { clipId: string; status: Clip["status"] }; result: void }
  "clip:update-times": { args: { clipId: string; startMs: number; endMs: number }; result: void }
  "clip:update-crop-x": { args: { clipId: string; cropX: number }; result: void }
  "export:clips": {
    args: {
      projectId: string
      clipIds: string[]
      outputDir?: string
      burnSubtitles?: boolean
      reframe?: boolean
      blurBg?: boolean
      removeFillers?: boolean
      captionStyle?: CaptionStyle
    }
    result: string[]
  }
  "export:full": {
    args: {
      projectId: string
      outputDir?: string
      burnSubtitles?: boolean
      reframe?: boolean
      cropX?: number
      blurBg?: boolean
    }
    result: string
  }
  "export:srt": { args: { projectId: string; outputDir?: string }; result: string }
  "dialog:pick-folder": { args: { defaultPath?: string }; result: string | null }
  "ffmpeg:has-subtitles-filter": { args: void; result: boolean }
  "shell:show-item": { args: { path: string }; result: void }
  "shell:open-logs": { args: void; result: void }
  "log:report-error": {
    args: { message: string; stack?: string; source: string }
    result: void
  }
  "project:save-caption-style": {
    args: { projectId: string; captionStyle: CaptionStyle }
    result: void
  }
  "project:load-caption-style": { args: { projectId: string }; result: CaptionStyle | null }
  "get-font-url": { args: void; result: string }
  "project:get-filler-words": { args: { projectId: string }; result: string[] }
  "project:set-filler-words": { args: { projectId: string; fillerList: string[] }; result: void }
  "models:list": { args: void; result: ModelInfo[] }
  "models:delete": { args: { model: WhisperModel }; result: void }
  "models:download": { args: { model: WhisperModel }; result: void }
  "settings:get-api-key": { args: void; result: { configured: boolean; preview: string | null } }
  "settings:set-api-key": { args: { groqApiKey: string }; result: void }
  "updater:download": { args: void; result: void }
  "updater:restart-now": { args: void; result: void }
  "updater:get-state": { args: void; result: UpdaterState }
}

// Main → renderer (send/on): payload only, no args/result envelope.
export interface IpcEventChannels {
  "models:download-progress": { model: WhisperModel; progress: number }
  "pipeline:progress": PipelineProgress
  "pipeline:complete": { projectId: string }
  "pipeline:error": { projectId: string; error: string }
  "export:progress": {
    projectId: string
    stage: "clips" | "episode"
    clipIndex: number
    clipTotal: number
    clipId?: string
    progress: number
  }
  "updater:available": { version: string }
  "updater:progress": { percent: number }
  "updater:downloaded": { readyToInstall: boolean }
  "updater:error": { message: string }
}
