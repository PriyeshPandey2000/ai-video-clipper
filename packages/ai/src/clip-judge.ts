// Judges a clip's FINAL cut on its real text (#99).
//
// Before this, "is this clip good?" was answered by the generation call: once per 20-minute chunk,
// on a sentence range the code then moved, with a `strong` flag whose bar differed between chunks.
// Here every refined clip is judged in its own call, on exactly the words that will be exported,
// against the same questions — so scores are comparable across the whole video.
//
// The judge never sees other candidates. One call per clip means no position bias and no anchoring
// between clips, which is why batch size is deliberately 1.

import type { z } from "zod"
import { z as zod } from "zod"
import type { ClipJudgeRecord, JudgeGrade, Sentence, Word } from "@video-editor/types"
import type { AiClient } from "./client"
import type { ClipProfile } from "./profiles"
import { withRateLimitRetry, type Sleep, realSleep } from "./concurrency"

// ─── Questions ───────────────────────────────────────────────────────────────

export type { JudgeGrade }

/** Value of each grade in the score. Three levels, not booleans, so scores do not tie in bunches. */
export const GRADE_VALUE: Record<JudgeGrade, number> = { yes: 1, partly: 0.5, no: 0 }

export interface JudgeQuestion {
  /** Stable — stored with every judgement. Never rename; add a new id instead. */
  id: string
  text: string
  weight: number
  /** A "no" on a hard question rejects the clip outright, whatever else it scored. */
  hard: boolean
}

/**
 * Asked of every clip. `standalone` and `payoff` are hard: either one failing makes a clip
 * unpostable regardless of anything else. `hook` and `postable` weigh most because they are what a
 * scrolling viewer actually reacts to.
 */
export const UNIVERSAL_JUDGE_QUESTIONS: JudgeQuestion[] = [
  {
    id: "hook",
    text: "Would the first sentence on its own make a scrolling viewer stop and keep watching?",
    weight: 3,
    hard: false,
  },
  {
    id: "standalone",
    text: "Does it make complete sense to someone who has never seen this video?",
    weight: 2,
    hard: true,
  },
  {
    id: "payoff",
    text: "Does it end on a resolution: an answer, punchline, conclusion or reveal?",
    weight: 2,
    hard: true,
  },
  {
    id: "oneIdea",
    text: "Is it about one idea, rather than drifting between topics?",
    weight: 1,
    hard: false,
  },
  {
    id: "postable",
    text: "Would a professional short-form editor for this channel actually post it?",
    weight: 3,
    hard: false,
  },
]

/** Weight of each profile-specific question. Lower than the universal set on purpose. */
export const PROFILE_QUESTION_WEIGHT = 1

/**
 * The questions for one run: the universal set, then the effective profile's `judgeQuestions`.
 * Profile ids are positional (`conversation_1`) — reordering a profile's questions changes the
 * ids, which is acceptable because it also changes the pipeline fingerprint.
 */
export function judgeQuestionsFor(
  profile: Pick<ClipProfile, "id" | "judgeQuestions">,
): JudgeQuestion[] {
  return [
    ...UNIVERSAL_JUDGE_QUESTIONS,
    ...profile.judgeQuestions.map((text, i) => ({
      id: `${profile.id}_${i + 1}`,
      text,
      weight: PROFILE_QUESTION_WEIGHT,
      hard: false,
    })),
  ]
}

// ─── Scoring (pure) ──────────────────────────────────────────────────────────

export interface ClipJudgement {
  answers: Record<string, JudgeGrade>
  /** One sentence for the UI. */
  note: string
  /**
   * Global sentence index the judge thinks is the strongest opening, or null. Stored now so the
   * judge-chosen-opening issue (#100) needs no second schema change; unused by selection today.
   */
  bestOpeningSentence: number | null
  /** 0–1, a pure function of `answers` and the question weights. */
  score: number
}

/** Weighted share of the available points, 0–1, to 2 decimal places. Pure: re-scorable offline. */
export function scoreAnswers(
  answers: Record<string, JudgeGrade>,
  questions: readonly JudgeQuestion[],
): number {
  let earned = 0
  let total = 0
  for (const q of questions) {
    total += q.weight
    earned += q.weight * GRADE_VALUE[answers[q.id] ?? "no"]
  }
  return total === 0 ? 0 : Number((earned / total).toFixed(2))
}

/** Ids of hard questions answered "no". A "partly" does not reject. */
export function failedHardQuestions(
  answers: Record<string, JudgeGrade>,
  questions: readonly JudgeQuestion[],
): string[] {
  return questions.filter((q) => q.hard && answers[q.id] === "no").map((q) => q.id)
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

/**
 * Hashed into the pipeline fingerprint. The question list is appended per run (profile-dependent),
 * so everything shared by every call sits first — good for provider-side prompt caching.
 */
export const JUDGE_SYSTEM_PROMPT = `You are a strict editor deciding whether ONE short clip is worth posting.

You are shown the clip exactly as a viewer will get it, between [CLIP STARTS] and [CLIP ENDS]. Text
under [BEFORE CLIP] is context only — the viewer does NOT see it. Judge only what is inside the clip.

Answer each question with exactly one of:
- "yes": clearly true.
- "partly": true in part, or arguable.
- "no": false, or mostly false.

Be strict. Most clips are not postable as they stand. Do not reward length, and do not reward a clip
for being on a good topic if the clip itself does not deliver.

Also return:
- note: ONE sentence on the clip's biggest strength or flaw, written for the editor.
- bestOpeningSentence: the number from a "#N" label inside the clip whose sentence would make the
  strongest opening. Omit it if the clip's first sentence is already the best opening.`

export const JUDGE_USER_TEMPLATE = `{{CONTEXT}}

Clip length: {{SECONDS}} seconds.

[BEFORE CLIP — the viewer does NOT see this]
{{BEFORE}}

[CLIP STARTS]
{{CLIP}}
[CLIP ENDS]

Answer every question for this clip.`

/** Sentences of lead-in shown to the judge. Hashed. */
export const JUDGE_BEFORE_SENTENCES = 2

export function renderJudgeQuestions(questions: readonly JudgeQuestion[]): string {
  return (
    '\n\nQUESTIONS — use these exact ids as keys of "answers":\n' +
    questions.map((q) => `- ${q.id}: ${q.text}`).join("\n")
  )
}

/**
 * Placeholders are filled with function replacements: the clip text is spoken words and the context
 * is model-authored, so `$$`, `$'` or a literal `{{CLIP}}` in either must not be interpreted.
 */
export function renderJudgePrompt(parts: {
  context: string
  seconds: number
  before: string
  clip: string
}): string {
  return JUDGE_USER_TEMPLATE.replace("{{SECONDS}}", String(parts.seconds))
    .replace("{{BEFORE}}", () => parts.before)
    .replace("{{CLIP}}", () => parts.clip)
    .replace("{{CONTEXT}}", () => parts.context)
}

/**
 * The words the exported clip contains, labelled by sentence. Built from the words inside the final
 * boundary — not the model's requested sentence range — so a clip trimmed by the length clamp shows
 * the judge only what survives.
 */
export function renderClipForJudge(
  words: Word[],
  sentences: Sentence[],
  boundary: {
    startMs: number
    endMs: number
    startSentenceIndex: number
    endSentenceIndex: number
  },
): string {
  const lines: string[] = []
  for (let i = boundary.startSentenceIndex; i <= boundary.endSentenceIndex; i++) {
    const s = sentences[i]
    if (!s) continue
    const text = words
      .slice(s.firstWordIndex, s.lastWordIndex + 1)
      .filter((w) => w.startMs >= boundary.startMs && w.endMs <= boundary.endMs)
      .map((w) => w.text)
      .join(" ")
    if (text) lines.push(`#${s.index} ${text}`)
  }
  return lines.join("\n")
}

export function renderBeforeForJudge(sentences: Sentence[], startSentenceIndex: number): string {
  const from = Math.max(0, startSentenceIndex - JUDGE_BEFORE_SENTENCES)
  const before = sentences.slice(from, startSentenceIndex)
  return before.length > 0
    ? before.map((s) => s.text).join(" ")
    : "(this is the start of the video)"
}

// ─── The call ────────────────────────────────────────────────────────────────

function buildSchema(questions: readonly JudgeQuestion[]) {
  const grade = zod.enum(["yes", "partly", "no"])
  return zod.object({
    answers: zod.object(Object.fromEntries(questions.map((q) => [q.id, grade]))),
    note: zod.string(),
    // null is accepted as well as absent: models routinely answer "none" with an explicit null.
    bestOpeningSentence: zod.number().int().nullable().optional(),
  })
}

export interface JudgeClipInput {
  client: AiClient
  questions: readonly JudgeQuestion[]
  /** The #98 VIDEO CONTEXT block, identical for every clip in the run. */
  context: string
  words: Word[]
  sentences: Sentence[]
  boundary: { startMs: number; endMs: number; startSentenceIndex: number; endSentenceIndex: number }
  sleep?: Sleep
}

/**
 * Judges one refined clip. Rejects on failure — the caller turns that into a per-candidate outcome,
 * because one failed judgement must reject that candidate, not abort the run.
 */
export async function judgeClip(input: JudgeClipInput): Promise<ClipJudgement> {
  const { client, questions, boundary } = input
  const schema = buildSchema(questions)
  const prompt = renderJudgePrompt({
    context: input.context,
    seconds: Math.round((boundary.endMs - boundary.startMs) / 1000),
    before: renderBeforeForJudge(input.sentences, boundary.startSentenceIndex),
    clip: renderClipForJudge(input.words, input.sentences, boundary),
  })

  const raw = await withRateLimitRetry(
    () =>
      client.generateObject({
        prompt,
        schema: schema as unknown as z.ZodType<z.infer<typeof schema>>,
        system: JUDGE_SYSTEM_PROMPT + renderJudgeQuestions(questions),
      }),
    input.sleep ?? realSleep,
  )

  const answers = raw.answers as Record<string, JudgeGrade>
  // Only an index that is really inside the clip is kept — a hallucinated number must not reach #100.
  const best = raw.bestOpeningSentence
  const bestOpeningSentence =
    best != null && best >= boundary.startSentenceIndex && best <= boundary.endSentenceIndex
      ? best
      : null

  return {
    answers,
    note: raw.note.trim(),
    bestOpeningSentence,
    score: scoreAnswers(answers, questions),
  }
}

/**
 * The record stored in `clips.judge_json`. Questions are copied in so the stored clip stays
 * readable after the question set changes (see `ClipJudgeRecord`).
 */
export function toJudgeRecord(
  judgement: ClipJudgement,
  questions: readonly JudgeQuestion[],
): ClipJudgeRecord {
  return {
    score: judgement.score,
    note: judgement.note,
    answers: judgement.answers,
    bestOpeningSentence: judgement.bestOpeningSentence,
    questions: questions.map((q) => ({ id: q.id, text: q.text, hard: q.hard })),
  }
}
