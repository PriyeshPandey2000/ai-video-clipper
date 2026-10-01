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
