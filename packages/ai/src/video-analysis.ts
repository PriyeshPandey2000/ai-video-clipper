// Understands the video before choosing clips (#98).
//
// Two defects motivated this file. `detectContentType` ran a regex over the joined transcript, so
// a podcast that said "how to" anywhere in an hour got the tutorial rubric — including its
// "never clip a partial step" rule, which suppresses exactly the story beats and hot takes a
// podcast clip should be. And every chunk went to the model with no idea what the video was, so
// when the rubric asked whether a clip was "self-contained" it had nothing to judge against and
// titles came out generic.
//
// One structured call, then every selection prompt carries the answer.

import type { z } from "zod"
import { z as zod } from "zod"
import { CLIP_PROFILE_IDS, type ClipProfileId, type VideoAnalysis } from "@video-editor/types"
import type { Sentence } from "@video-editor/types"
import type { TopicSegment } from "@video-editor/transcript"
import type { AiClient } from "./client"
import { CLIP_PROFILES } from "./profiles"

// ─── What the classifier is asked for ────────────────────────────────────────

/**
 * System prompt for the analysis call.
 *
 * Each profile is described by the kind of *video* it describes, not by the kind of clip it wants
 * — those are different texts and both exist. `CLIP_PROFILES[x].lookingFor` covers the second;
 * this covers the first. Without the definitions the model is choosing between six plausible
 * labels by vibes, and "conversation" and "solo_opinion" in particular overlap on any monologue
 * that mentions a guest.
 *
 * Hashed into the pipeline fingerprint: this text decides the rubric every selection call then
 * runs under, so it is at least as load-bearing as SYSTEM_PROMPT.
 */
export const ANALYSIS_PROMPT = `You are analysing a video transcript so that a downstream system can choose short clips from it.

You will be given the transcript as numbered sentences. Classify what KIND OF VIDEO this is, and describe it.

PROFILES — pick exactly one. Choose by what dominates the video, not by any phrase it happens to contain:
- conversation: two or more people talking — a podcast, interview, Q&A, panel, debate. One person
  responds to another; questions get answers; there are reactions.
- solo_opinion: one speaker holds the floor and nobody responds — commentary, a rant, a motivational
  talk, a news take, a lecture in the first person. Even when the speaker quotes or criticises
  other people, there is no live back-and-forth.
- educational: teaching something the viewer could do or know — a tutorial, how-to, lecture,
  webinar, workshop, listicle. Outcomes are stated or demonstrated step by step.
- story: someone telling something that happened — a vlog, a storytime, an anecdote with a
  narrative arc. There are events in sequence and something changes.
- comedy: a comedy set, sketch, or banter — the point is the timing and the laugh.
- visual: the value is on screen, not in the words — gaming, sports, a reaction video, music
  performance, screen recording. The transcript may barely describe what happens.

RULES that decide it, when two profiles could both fit:
- Words about a procedure are not an educational video. A podcast that says "how to" three times is
  still a conversation. Only the video's shape decides.
- An anecdote inside a monologue is not a story video. Only the video's shape decides.
- Quote the transcript. Do not invent speakers, topics, or events.

CONFIDENCE:
- high: the shape is unambiguous from the transcript alone.
- medium: the dominant shape is clear but a substantial part of the video pulls another way.
- low: the transcript is too short, too noisy, or too mixed to tell.

OUTPUT:
- profile: one value from the list above.
- confidence: high, medium, or low.
- secondaryProfile: include ONLY if a substantial second profile is genuinely present (for example
  a webinar that ends with audience Q&A, or a comedy set with a long story segment). Omit it
  otherwise — a second guess here makes the caller less decisive, not more informed.
- summary: 2-3 sentences on what the video is about, written for someone who has not watched it.
- speakers: one entry per speaker. Use "host", "guest", or a name the transcript states. Use an
  empty string when the transcript does not establish who a speaker is — do not guess a name.
- mainTopics: up to 6 short topic strings.`

const VideoAnalysisSchema = zod.object({
  profile: zod.enum(CLIP_PROFILE_IDS),
  confidence: zod.enum(["high", "medium", "low"]),
  secondaryProfile: zod.enum(CLIP_PROFILE_IDS).optional(),
  summary: zod.string(),
  speakers: zod.array(zod.object({ role: zod.string() })),
  mainTopics: zod.array(zod.string()),
})

// ─── Fitting the transcript into the call ────────────────────────────────────

/**
 * Chars-per-token for English prose. Crude, and deliberately so: it only has to be good enough
 * for a guard that decides between "send it all" and "send an excerpt", and over-estimating the
 * token count fires the excerpt path early, which is the safe direction.
 */
const CHARS_PER_TOKEN = 4

/**
 * Token ceiling for the analysis input. `gpt-oss-120b` has a very large context, so this is not
 * the model's limit — it is the point past which one call becomes slow and expensive enough that
 * a cheaper excerpt is the better trade. One hour of sentence-level transcript measures about
 * 25k tokens, so the full text goes up for essentially every real video.
 */
const ANALYSIS_TOKEN_BUDGET = 60_000
const ANALYSIS_MAX_CHARS = ANALYSIS_TOKEN_BUDGET * CHARS_PER_TOKEN

/** Opening excerpt, when the transcript does not fit. Sets up who is talking and why. */
const ANALYSIS_HEAD_MS = 5 * 60 * 1000
/** Closing excerpt, when the transcript does not fit. Often carries the verdict or the payoff. */
const ANALYSIS_TAIL_MS = 3 * 60 * 1000
/**
 * Opening sentences sampled from each topic segment, when the transcript does not fit. This is
 * what makes the excerpt cover the whole video rather than just its ends — the middle of an hour
 * is usually where the actual subject is.
 */
const ANALYSIS_TOPIC_SAMPLE_SENTENCES = 3

/** The transcript actually sent, plus whether it is the whole thing or an excerpt. */
export interface AnalysisInput {
  text: string
  /** True when the full transcript did not fit and an excerpt was sent instead. */
  excerpted: boolean
  /** How many words went in. For the log line — an excerpt run should not look like a full one. */
  charCount: number
}

function renderSentences(sentences: Sentence[]): string {
  return sentences.map((s) => `#${s.index} ${s.text}`).join("\n")
}

/**
 * The transcript to classify.
 *
 * Below the budget this is every sentence, verbatim and in order. Above it, three excerpts: the
 * opening, the first few sentences of each topic segment, and the close. The middle gap is
 * labelled in the output, because the single worst failure mode here is an unlabeled gap — the
 * model reads non-adjacent sentences as contiguous speech and infers a conversation from two
 * unrelated paragraphs.
 */
export function buildAnalysisInput(
  sentences: Sentence[],
  topics: TopicSegment[] = [],
): AnalysisInput {
  const full = renderSentences(sentences)
  if (full.length <= ANALYSIS_MAX_CHARS) {
    return { text: full, excerpted: false, charCount: full.length }
  }

  const first = sentences[0]
  const last = sentences[sentences.length - 1]
  if (!first || !last) return { text: full, excerpted: false, charCount: full.length }

  const chosen = new Map<number, Sentence>()
  const take = (list: Sentence[]): void => {
    for (const s of list) chosen.set(s.index, s)
  }

  const headEndMs = first.startMs + ANALYSIS_HEAD_MS
  take(sentences.filter((s) => s.startMs < headEndMs))

  for (const seg of topics) {
    take(seg.sentences.slice(0, ANALYSIS_TOPIC_SAMPLE_SENTENCES))
  }

  const tailStartMs = last.endMs - ANALYSIS_TAIL_MS
  take(sentences.filter((s) => s.endMs > tailStartMs))

  const ordered = [...chosen.values()].sort((a, b) => a.index - b.index)
  const parts: string[] = []
  let previous: Sentence | null = null
  for (const s of ordered) {
    // Mark every discontinuity. These boundaries are the excerpt's structure, and an unmarked
    // jump from the opening to some segment in the middle reads as speech that followed directly.
    const gapMs = previous ? s.startMs - previous.endMs : 0
    const jumped = previous !== null && gapMs > ANALYSIS_TAIL_MS
    if (parts.length === 0 || jumped) {
      parts.push(jumped ? "\n[... transcript omitted here ...]\n" : "")
    }
    parts.push(renderSentences([s]))
    previous = s
  }

  const text = `This is an EXCERPT of a long transcript. Non-contiguous sections are marked with
"[... transcript omitted here ...]" — do not read across a gap as if the speech were continuous.

${parts.join("\n")}`
  return { text, excerpted: true, charCount: text.length }
}

// ─── The call ────────────────────────────────────────────────────────────────

/**
 * Ceiling on reported speakers. Real panels top out well below this; the cap exists because the
 * cost of a model answering "speakers: 40" for a two-person podcast is a nonsense line in every
 * selection prompt and in the report, and no cap turns a real 40-speaker event into a worse answer.
 */
const MAX_REPORTED_SPEAKERS = 10

/**
 * The numeric knobs that decide *what text the classifier reads*, as fingerprint lines.
 *
 * Exported as pre-rendered strings rather than as six bare constants because the pipeline
 * fingerprint lives in `clip-selector.ts`, and hashing it should not require re-exporting every
 * private threshold here for one call site. These are hashed for the same reason CHUNK_SIZE_MS and
 * the signal-tag thresholds are: they change the model's input, so a stored clip whose profile
 * came from an excerpted transcript must not share a fingerprint with one whose profile came from
 * the full text.
 */
export function analysisInputFingerprintFields(): string[] {
  return [
    `analysisCharsPerToken:${CHARS_PER_TOKEN}`,
    `analysisTokenBudget:${ANALYSIS_TOKEN_BUDGET}`,
    `analysisHeadMs:${ANALYSIS_HEAD_MS}`,
    `analysisTailMs:${ANALYSIS_TAIL_MS}`,
    `analysisTopicSampleSentences:${ANALYSIS_TOPIC_SAMPLE_SENTENCES}`,
    `analysisMaxSpeakers:${MAX_REPORTED_SPEAKERS}`,
  ]
}

/**
 * What selection falls back to when the analysis is unavailable (#98).
 *
 * Deliberately `solo_opinion` and `low`, not "generic": a generic rubric is an empty one, so
 * falling back to it would silently restore the bug this replaces. `solo_opinion` has a real
 * rubric, so a failed analysis degrades the selection rather than removing its guidance.
 *
 * A function, not a constant, because the returned object is handed to callers that store it —
 * a shared mutable instance would let one project write another's analysis.
 */
export function fallbackAnalysis(reason?: string): VideoAnalysis {
  return {
    profile: "solo_opinion",
    confidence: "low",
    summary: "",
    speakers: [],
    mainTopics: [],
    fallback: true,
    ...(reason !== undefined ? { summary: reason } : {}),
  }
}

/**
 * Classifies the video and describes it, in one structured call.
 *
 * Never throws and never rejects. Selection must not abort because a video could not be
 * described — a missing summary degrades the selection prompts, whereas failing here would throw
 * away clips the user could otherwise have reviewed. The client's own retry loop has already run
 * by the time a rejection reaches this function, so a catch here means the analysis genuinely is
 * not going to happen.
 */
export async function analyzeVideo(
  client: AiClient,
  sentences: Sentence[],
  topics: TopicSegment[] = [],
): Promise<VideoAnalysis> {
  // Nothing to classify. Not worth an API call, and `buildAnalysisInput` on an empty transcript
  // returns an empty string, which is a worse answer than the documented fallback.
  if (sentences.length === 0) return fallbackAnalysis()

  const input = buildAnalysisInput(sentences, topics)
  let raw: z.infer<typeof VideoAnalysisSchema>
  try {
    raw = await client.generateObject({
      prompt: `TRANSCRIPT\n\n${input.text}`,
      schema: VideoAnalysisSchema as unknown as z.ZodType<z.infer<typeof VideoAnalysisSchema>>,
      system: ANALYSIS_PROMPT,
    })
  } catch (err) {
    // Logged and swallowed. The trace and the report both record the fallback, so a video whose
    // analysis never ran is visible without being fatal.
    console.warn("[video-analysis] classification failed, falling back to solo_opinion:", err)
    return fallbackAnalysis()
  }

  // Clamp the two open-ended fields. The closed enums are already safe: zod rejects anything
  // outside them, and the client's retries have been exhausted by the time we get here.
  const speakers = raw.speakers.slice(0, MAX_REPORTED_SPEAKERS)
  return {
    profile: raw.profile,
    confidence: raw.confidence,
    ...(raw.secondaryProfile !== undefined ? { secondaryProfile: raw.secondaryProfile } : {}),
    summary: raw.summary.trim(),
    speakers,
    mainTopics: raw.mainTopics
      .slice(0, 6)
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    fallback: false,
  }
}

// ─── The block every selection prompt carries ────────────────────────────────

/**
 * The wrapper around the per-video fields, kept as a template rather than written inline in
 * `renderVideoContext` for two reasons: the guidance below `{{CONTEXT}}` is prompt text, and prompt
 * text that lives inside a function is invisible to the fingerprint — a reader auditing "what does
 * the model actually read?" would find half of it there and half of it in a string constant it had
 * to know to check.
 */
export const VIDEO_CONTEXT_TEMPLATE = `VIDEO CONTEXT — what this video is, judged once before clip selection.

{{CONTEXT}}

Treat the summary and topics as background: they tell you what a viewer is missing, so you can
judge whether a range stands on its own. They are not a transcript summary to write captions
from.`

export interface VideoContextOptions {
  /** The profile in effect, which need not be `analysis.profile`. See below. */
  profileId: ClipProfileId
  /**
   * A caller-supplied profile wins over `analysis.profile` — a user override (#98). The model is
   * told only the effective profile: it has no use for the difference, and being told it was
   * overridden is noise at best and a prompt-injection handle at worst.
   */
  override?: ClipProfileId | null
}

/**
 * Renders the context block, template and all.
 *
 * Every field line is optional. A fallback analysis has an empty summary and no speakers, and
 * emitting "Speakers: none identified" or "Summary: " would put a sentence in front of the model
 * that reads as fact. An absent line is absent.
 *
 * `{{CONTEXT}}` is substituted with a function for the same reason `{{TRANSCRIPT}}` is in
 * `clip-selector.ts`: these are model-authored strings, so a summary containing `$$` or `$'` would
 * otherwise be corrupted by `String.prototype.replace`, and one containing `{{TRANSCRIPT}}` would
 * swallow the transcript if it were substituted before that placeholder.
 */
export function renderVideoContext(analysis: VideoAnalysis, options: VideoContextOptions): string {
  const profileId = options.override ?? options.profileId
  const profile = CLIP_PROFILES[profileId]
  const lines: string[] = []
  lines.push(`Profile: ${profile.label} — looking for: ${profile.lookingFor}`)
  if (analysis.summary) lines.push(`Summary: ${analysis.summary}`)

  const speakers = analysis.speakers.map((s) => s.role.trim()).filter((r) => r.length > 0)
  if (speakers.length > 0) {
    const distinct = [...new Set(speakers)]
    lines.push(`Speakers: ${distinct.join(", ")}`)
  }

  const topics = analysis.mainTopics.filter((t) => t.length > 0)
  if (topics.length > 0) lines.push(`Main topics: ${topics.join("; ")}`)

  return VIDEO_CONTEXT_TEMPLATE.replace("{{CONTEXT}}", () => lines.join("\n"))
}

/**
 * Sample rendering of the block above, hashed into the fingerprint so the *format* stays covered
 * even though the values are per-video and cannot be. Same reasoning as RERANK_FORMAT_SAMPLE: the
 * block's shape is part of the configuration, and a format change changes what the model reads
 * even when no rubric changed.
 *
 * A function rather than a constant because it calls `renderVideoContext`, and a module-level
 * `const` initializer would run before `CLIP_PROFILES` is assigned — a temporal dead zone crash
 * at import time rather than a type error. Called from `computePipelineFingerprint`, which runs
 * after this module is fully initialised.
 */
export function videoContextSample(): string {
  return renderVideoContext(
    {
      profile: "conversation",
      confidence: "high",
      summary: "Two founders discuss pricing.",
      speakers: [{ role: "host" }, { role: "guest" }],
      mainTopics: ["pricing"],
      fallback: false,
    },
    { profileId: "conversation" },
  )
}
