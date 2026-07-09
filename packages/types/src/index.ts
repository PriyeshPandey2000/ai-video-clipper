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

export interface PipelineProgress {
  projectId: string
  stage: PipelineStage
  progress: number // 0–1
  message?: string
}

// ─── IPC channel type map ──────────────────────────────────────────────────
// Renderer → main (invoke): { args, result }
// Main → renderer (on): payload only

export interface IpcChannels {
  // invoke channels
  "project:list": { args: void; result: Project[] }
  "project:create": { args: { name: string; mediaPath: string }; result: Project }
  "project:get": { args: { id: string }; result: Project | null }
  "project:get-words": { args: { projectId: string }; result: Word[] }
  "pipeline:start": { args: { projectId: string; model: WhisperModel }; result: void }
  "clip:list": { args: { projectId: string }; result: Clip[] }
  "clip:update-status": { args: { clipId: string; status: Clip["status"] }; result: void }
  "export:clips": { args: { projectId: string; clipIds: string[] }; result: string[] }
  "export:full": { args: { projectId: string }; result: string }
  // event channels (main → renderer)
  "pipeline:progress": PipelineProgress
  "pipeline:complete": { projectId: string }
  "pipeline:error": { projectId: string; error: string }
}
