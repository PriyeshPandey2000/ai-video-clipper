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

/** One graded answer from the clip judge (#99). */
export type JudgeGrade = "yes" | "partly" | "no"

/**
 * What the judge said about a clip, as stored in `clips.judge_json` (#99).
 *
 * Self-describing on purpose: `questions` is copied in with the answers, so a clip written under
 * one set of questions still renders correctly after the set changes, and the UI needs no access to
 * the pipeline's question tables to label its chips.
 */
export interface ClipJudgeRecord {
  /** 0–1, the weighted share of yes answers. Same number as `Clip.aiScore`. */
  score: number
  /** One sentence for the editor. */
  note: string
  answers: Record<string, JudgeGrade>
  /** Global sentence index the judge preferred as the opening, or null. Consumed by #100. */
  bestOpeningSentence: number | null
  /** The questions that were asked, in order. `hard` ones reject a clip on a clear "no". */
  questions: { id: string; text: string; hard: boolean }[]
}

/**
 * Parses `clips.judge_json`. Null for a clip with no judgement (written before #99, or by the user)
 * and for anything unreadable — a bad blob must degrade to "no chips", never throw into the UI.
 */
export function parseClipJudge(json: string | null | undefined): ClipJudgeRecord | null {
  if (!json) return null
  try {
    const v = JSON.parse(json) as Partial<ClipJudgeRecord> | null
    if (
      !v ||
      typeof v.score !== "number" ||
      typeof v.answers !== "object" ||
      v.answers === null ||
      !Array.isArray(v.questions)
    ) {
      return null
    }
    return {
      score: v.score,
      note: typeof v.note === "string" ? v.note : "",
      answers: v.answers as Record<string, JudgeGrade>,
      bestOpeningSentence: typeof v.bestOpeningSentence === "number" ? v.bestOpeningSentence : null,
      questions: v.questions,
    }
  } catch {
    return null
  }
}

export interface Clip {
  id: string
  projectId: string
  title: string
  startMs: number
  endMs: number
  aiScore: number | null
  aiReason: string | null
  /** The judge's verdict as JSON (#99); parse with `parseClipJudge`. Null when there is none. */
  judgeJson: string | null
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
  type: "blog_post" | "social_caption" | "timestamps" | "chapter_markers" | "video_analysis"
  content: string
  createdAt: number
}

export type PipelineStage = "transcribing" | "analyzing" | "generating_clips" | "generating_content"

// ─── Clip profiles (#98) ────────────────────────────────────────────────────
// What kind of video this is, decided by one LLM call before selection rather than by a regex
// over the transcript. Lives here rather than in @video-editor/ai because it crosses three
// packages: the AI package picks the rubric, the database stores it, and the renderer offers it
// as a dropdown. @video-editor/ai depends on this package, so a definition there could not be
// read by the others.

export const CLIP_PROFILE_IDS = [
  "conversation",
  "solo_opinion",
  "educational",
  "story",
  "comedy",
  "visual",
] as const

export type ClipProfileId = (typeof CLIP_PROFILE_IDS)[number]

/**
 * How sure the classifier is. Deliberately closed and coarse: a numeric score would invite
 * comparisons the model's calibration cannot support, and "low" is what the fallback path
 * reports, so the two cases stay visibly different.
 */
export type AnalysisConfidence = "high" | "medium" | "low"

export interface VideoAnalysisSpeaker {
  /**
   * `host`, `guest`, a name the transcript states, or an empty string when the text does not
   * establish it. Diarization is a separate later issue, so this is the model's inference from
   * what was said rather than anything measured.
   */
  role: string
}

export interface VideoAnalysis {
  profile: ClipProfileId
  confidence: AnalysisConfidence
  /**
   * A second profile when the video genuinely mixes two — a webinar with Q&A, a story that turns
   * into a lecture. Recorded but not acted on: per-segment profiles are explicitly out of scope
   * for now, and blending two rubrics on a guess would be worse than picking the primary.
   */
  secondaryProfile?: ClipProfileId
  /** 2–3 sentences on what the video is about. Prepended to every selection prompt. */
  summary: string
  speakers: VideoAnalysisSpeaker[]
  /** Up to 6 short topic strings. */
  mainTopics: string[]
  /**
   * True when the structured call failed (or there was no transcript) and these values are the
   * documented defaults rather than the model's answer. Selection never aborts on a failed
   * analysis, so this flag is the only way to tell "we asked and it said solo_opinion" from
   * "we never found out".
   */
  fallback: boolean
}

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
  /**
   * Which entry point started this run. Absent means the transcription pipeline.
   *
   * "reselection" matters to the renderer: a re-run re-reads a transcript that is already
   * complete, so the project must not be treated as returning to "analyzing". Doing that unmounts
   * the clip panel that is displaying the progress, which discards its state — including the
   * failure message, since a rejected run is the case where the user most needs to read it.
   */
  run?: "transcription" | "reselection"
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
  /**
   * Re-runs only the AI stage on an already-transcribed project (#97). Swaps this project's
   * `suggested`/`rejected` clips for a fresh set; `approved`/`exported` are left alone.
   *
   * Returns the paths of the debug report written for the run so the renderer can offer to open
   * it. Non-null on success: a run that could not write a report does not count as a run.
   */
  "clip:reselect": {
    args: { projectId: string }
    result: { reportJsonPath: string; reportMarkdownPath: string; clipCount: number }
  }
  /** Most recent selection report for this project, or null if it has never been re-run. */
  "clip:last-report": { args: { projectId: string }; result: string | null }
  /**
   * The stored video analysis for this project, plus the user's override (#98).
   *
   * `effective` is the profile the next run will actually use: the override when set, otherwise
   * the detected one. The renderer shows all three because "Detected: Educational" over a
   * dropdown reading "Conversation" is only explicable if both are on screen.
   *
   * `analysis` is null when this project has never been analyzed — which, before #98, meant
   * every video, since the analysis is only written by a selection run.
   */
  "project:get-clip-profile": {
    args: { projectId: string }
    result: {
      analysis: VideoAnalysis | null
      override: ClipProfileId | null
      effective: ClipProfileId | null
    }
  }
  /**
   * Overrides (or clears, with `override: null`) the detected clip profile and re-runs selection
   * through #97's path in the same call (#98).
   *
   * Deliberately one channel rather than a write followed by a separate `clip:reselect`: the
   * override is only meaningful if the suggestions it governs are the ones on screen, and two
   * round trips leave a window where the stored profile and the stored clips disagree. Returns
   * the same shape as `clip:reselect` for the same reason.
   */
  "project:set-clip-profile": {
    args: { projectId: string; override: ClipProfileId | null }
    result: { reportJsonPath: string; reportMarkdownPath: string; clipCount: number }
  }
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
