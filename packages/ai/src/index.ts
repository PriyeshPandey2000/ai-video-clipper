export { createAiClient, SUPPORTED_PROVIDERS, CLIP_SELECTION_TEMPERATURE } from "./client"
export type { AiClient, AiClientConfig, AiProvider } from "./client"
export {
  selectClips,
  computePipelineFingerprint,
  PIPELINE_VERSION,
  PIPELINE_FINGERPRINT,
} from "./clip-selector"
export type {
  ClipSuggestion,
  ClipSelectionResult,
  ClipSelectionProvenance,
  ClipSelectionTrace,
  ClipRejection,
  TraceCandidate,
  TraceEntry,
  TraceChunk,
  TraceOutcome,
} from "./clip-selector"
export { generateBlogPost } from "./blog-generator"
export { generateSocialCaptions } from "./caption-generator"
export type { SocialCaption } from "./caption-generator"
export {
  analyzeVideo,
  renderVideoContext,
  buildAnalysisInput,
  fallbackAnalysis,
  ANALYSIS_PROMPT,
} from "./video-analysis"
export type { AnalysisInput, VideoContextOptions } from "./video-analysis"
export { CLIP_PROFILES, getClipProfile, isClipProfileId } from "./profiles"
export type { ClipProfile } from "./profiles"
export {
  judgeClip,
  judgeQuestionsFor,
  scoreAnswers,
  failedHardQuestions,
  toJudgeRecord,
  UNIVERSAL_JUDGE_QUESTIONS,
} from "./clip-judge"
export type { ClipJudgement, JudgeGrade, JudgeQuestion } from "./clip-judge"
