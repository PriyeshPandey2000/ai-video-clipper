// One object per clip profile (#98).
//
// This is the replacement for the regex content-type detector that used to live in
// `clip-selector.ts`. A podcast's best clip is a claim plus pushback; a tutorial's is one complete
// step; a comedy clip is setup plus punchline. Treating every video the same is why the wrong
// moments were being picked, and a regex over the joined transcript could not tell a comedy
// podcast from an opinion monologue — one stray "how to" reclassified an entire hour as a tutorial.
//
// Pure data plus the accessors that read it. The prompt text lives here rather than inline at the
// call site because the pipeline fingerprint hashes every rubric: a rubric edited anywhere other
// than this table would change clip output invisibly.

import { CLIP_PROFILE_DISPLAY, CLIP_PROFILE_IDS, type ClipProfileId } from "@video-editor/types"
import { MIN_CLIP_MS, MAX_CLIP_MS } from "@video-editor/transcript"

export interface ClipProfile {
  id: ClipProfileId
  /** Display name in the UI and the report. */
  label: string
  /** One line for the UI: what this profile looks for in a clip. */
  lookingFor: string
  /** Appended to SYSTEM_PROMPT. This text steers selection as much as SYSTEM_PROMPT does. */
  rubric: string
  /**
   * The profile-specific yes/no questions issue 3's judging pass will ask. Defined here so they
   * live next to the rubric they judge against; not yet sent anywhere, and deliberately not in
   * the pipeline fingerprint — hashing a prompt nothing sends would make the hash claim coverage
   * it does not have.
   */
  judgeQuestions: string[]
  /**
   * Clip-length budget for this genre. Unused for now — every run keeps the global 15–90s — but
   * defined alongside the profile so the customization issue has one place to look, and so a
   * profile cannot later ship without one.
   */
  defaultLengthMs: { min: number; max: number }
}

/**
 * The global length budget every profile currently shares. Referenced rather than repeated so the
 * one line in this file is what a later change has to touch.
 */
const GLOBAL_LENGTH_MS = { min: MIN_CLIP_MS, max: MAX_CLIP_MS }

const CONVERSATION_RUBRIC = `

This video is a CONVERSATION — a podcast, interview, Q&A, or panel. Prioritise these clip shapes:
- A surprising claim plus a reaction to it: pushback, laughter, "really?", "wait, say that again"
- A personal story with a clear unexpected turn
- Genuine disagreement or tension between speakers
- A bold claim the host challenges, or the guest doubles down on
- A rare disclosure: "I've never told anyone this", "what most people don't know"

RULES:
- Include the question or prompt that set the answer up whenever the answer does not stand alone
  without it. An answer that opens on "yeah, exactly" is not a clip.
- A clip from a two-speaker exchange must carry the reaction. The claim alone is a solo_opinion
  clip wearing a conversation's clothes.`

const SOLO_OPINION_RUBRIC = `

This video is a SOLO OPINION — commentary, a rant, a motivational talk, a news take. One speaker
holds the floor and nobody pushes back. Prioritise these clip shapes:
- A strong, specific, contestable claim the speaker commits to
- A quotable line: compressed, repeatable, still true without the surrounding minutes
- A reframing of a common belief — the thing everyone assumes, stated back wrong, then corrected

RULES:
- Start on the claim itself or at most one sentence before it, never on the wind-up, the
  throat-clearing, or the restatement of the question. The wind-up is where these clips go to die.
- One speaker means no reaction to wait for. If a candidate needs someone else to answer it, it
  is the wrong candidate.`

const EDUCATIONAL_RUBRIC = `

This video is EDUCATIONAL — a tutorial, how-to, lecture, webinar, or listicle. Prioritise these
clip shapes:
- One complete step or idea with a stated outcome ("do X, you get Y")
- The mistake most people make, immediately followed by the correct approach
- A wrong-way/right-way or before/after reveal
- A single rule or mental model that changes how the viewer does the thing

HARD RULE: never clip a partial step. A clip that starts or ends mid-instruction fails on its
own terms — it teaches the beginning of something and stops, which is worse than not posting it.
The clip must teach one thing fully.`

const STORY_RUBRIC = `

This video is a STORY — a vlog, a storytime, a retelling. Prioritise these clip shapes:
- One beat containing setup, turn, and payoff together

HARD RULE: the clip must contain the payoff. A beat that ends on the setup, or on the turn with
the payoff left for the next breath, is an anticlimax on screen. Never end a story clip before
it lands.`

const COMEDY_RUBRIC = `

This video is COMEDY — a comedy set, a sketch, a comedy podcast, a banter-heavy panel. The value is
in the timing, not in the information. Prioritise these clip shapes:
- Setup plus punchline, both inside the clip
- A funny exchange between two people

RULES:
- End just after the punchline or the laugh. Every extra second past the laugh is the audience
  moving on, and it reads as a clip that overshot.
- Cutting before the punchline is worse than overshooting — it turns the joke into a non-joke.`

/**
 * The `visual` rubric is the `solo_opinion` rubric verbatim, plus one line saying why it is the
 * one. Composed rather than retyped so the two cannot drift apart when either is reworded.
 *
 * Gaming, sports, reaction and music footage is mostly not in the transcript at all — the moment
 * that makes a clip is on screen. The honest response is to say so in the prompt and judge on the
 * words we do have, not to pretend the transcript described the video.
 */
const VISUAL_RUBRIC = `${SOLO_OPINION_RUBRIC}

NOTE: this video is primarily VISUAL — the moment that makes a clip is happening on screen, not in
the spoken words. You cannot see it. Judge only what the dialogue supports, and prefer clips where
the speaker is reacting to or describing something specific enough that the picture is inferable.
Do not award a clip for a visual event you have no evidence of.`

export const CLIP_PROFILES: Record<ClipProfileId, ClipProfile> = {
  conversation: {
    id: "conversation",
    label: CLIP_PROFILE_DISPLAY.conversation.label,
    lookingFor: CLIP_PROFILE_DISPLAY.conversation.lookingFor,
    rubric: CONVERSATION_RUBRIC,
    judgeQuestions: [
      "Does the clip contain both a claim and someone's reaction to it?",
      "If it opens on an answer, does it include the question that prompted it?",
      "Would this land without having heard the rest of the conversation?",
    ],
    defaultLengthMs: GLOBAL_LENGTH_MS,
  },
  solo_opinion: {
    id: "solo_opinion",
    label: CLIP_PROFILE_DISPLAY.solo_opinion.label,
    lookingFor: CLIP_PROFILE_DISPLAY.solo_opinion.lookingFor,
    rubric: SOLO_OPINION_RUBRIC,
    judgeQuestions: [
      "Is there one contestable claim, and is it specific rather than general?",
      "Does the clip open on the claim rather than on a wind-up?",
      "Does the line survive being read on its own, out of context?",
    ],
    defaultLengthMs: GLOBAL_LENGTH_MS,
  },
  educational: {
    id: "educational",
    label: CLIP_PROFILE_DISPLAY.educational.label,
    lookingFor: CLIP_PROFILE_DISPLAY.educational.lookingFor,
    rubric: EDUCATIONAL_RUBRIC,
    judgeQuestions: [
      "Does the clip teach one thing from beginning to end, with no instruction cut in half?",
      "Is the outcome of the step stated or unmistakably shown?",
      "Would a viewer be able to act on this immediately after watching?",
    ],
    defaultLengthMs: GLOBAL_LENGTH_MS,
  },
  story: {
    id: "story",
    label: CLIP_PROFILE_DISPLAY.story.label,
    lookingFor: CLIP_PROFILE_DISPLAY.story.lookingFor,
    rubric: STORY_RUBRIC,
    judgeQuestions: [
      "Does the clip contain the payoff, not just the setup or the turn?",
      "Is the turn present — is anything actually different from where the beat began?",
      "Does it end on the moment landing rather than on the moment starting?",
    ],
    defaultLengthMs: GLOBAL_LENGTH_MS,
  },
  comedy: {
    id: "comedy",
    label: CLIP_PROFILE_DISPLAY.comedy.label,
    lookingFor: CLIP_PROFILE_DISPLAY.comedy.lookingFor,
    rubric: COMEDY_RUBRIC,
    judgeQuestions: [
      "Is the punchline inside the clip?",
      "Does the clip end within a second or two of the laugh rather than seconds after it?",
      "Does the timing still read without the surrounding room?",
    ],
    defaultLengthMs: GLOBAL_LENGTH_MS,
  },
  visual: {
    id: "visual",
    label: CLIP_PROFILE_DISPLAY.visual.label,
    lookingFor: CLIP_PROFILE_DISPLAY.visual.lookingFor,
    rubric: VISUAL_RUBRIC,
    judgeQuestions: [
      "Is the moment inferable from the words alone, or does it depend on unseen footage?",
      "Is the speaker reacting to something specific enough that the picture follows?",
      "Would this clip be confusing with the audio muted?",
    ],
    defaultLengthMs: GLOBAL_LENGTH_MS,
  },
}

/**
 * Profile lookup with a runtime check, for values that crossed IPC and therefore are only
 * nominally a `ClipProfileId`. A stored or wire value can be anything; returning undefined would
 * push that failure into a property access several frames later.
 */
export function getClipProfile(id: ClipProfileId): ClipProfile {
  return CLIP_PROFILES[id]
}

export function isClipProfileId(value: unknown): value is ClipProfileId {
  return typeof value === "string" && (CLIP_PROFILE_IDS as readonly string[]).includes(value)
}

export { CLIP_PROFILE_IDS }
