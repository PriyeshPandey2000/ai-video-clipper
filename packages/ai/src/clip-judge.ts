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

/**
 * Grade ordinal, for taking the median across samples (#125). Order is load-bearing: yes > partly >
 * no. The median of an odd number of grades is itself a grade, which is what lets a hard gate
 * reject only when the *majority* of samples said "no" rather than one sampled call.
 */
const GRADE_RANK: Record<JudgeGrade, number> = { no: 0, partly: 1, yes: 2 }
const RANK_GRADE: readonly JudgeGrade[] = ["no", "partly", "yes"]

/**
 * How many samples a clip gets (#125). Odd so the median is a real grade with no tie, and 3 as the
 * smallest odd number that lets one dissenting sample be outvoted by two.
 */
export const JUDGE_SAMPLES = 3

/**
 * A first sample at or below this score (or failing both hard questions) is "clearly dead" and is
 * not resampled (#125): the extra samples cannot rescue a clip this far from the gate, and spending
 * them on the ~75% of candidates that are clearly rejected is most of the vote's cost.
 */
export const JUDGE_DEAD_SCORE = 0.15

/** Three-level grade ordinal comparison, exported for the aggregation tests. */
export function gradeRank(grade: JudgeGrade): number {
  return GRADE_RANK[grade]
}

/** Would this single sample be judged without resampling? See JUDGE_DEAD_SCORE. */
export function isClearlyDead(
  judgement: ClipJudgement,
  questions: readonly JudgeQuestion[],
): boolean {
  if (judgement.score < JUDGE_DEAD_SCORE) return true
  const hardNos = questions.filter((q) => q.hard && judgement.answers[q.id] === "no").length
  return hardNos >= 2
}

/**
 * The voted verdict from 1..k samples (#125). Pure — no calls — so the aggregation is unit-testable
 * without a model:
 * - each question's answer is the MEDIAN grade across samples (yes > partly > no), so a hard gate
 *   rejects only when a majority said "no";
 * - the score is the MEAN of the per-sample scores;
 * - the note and best-opening come from the sample whose score is closest to that mean — the
 *   representative call, so the note a reader sees belongs to a verdict near the aggregate rather
 *   than an arbitrary one;
 * - best-opening is the modal non-null proposal, ties broken toward the earlier sentence.
 *
 * A single sample returns itself unchanged, so a not-resampled clip is byte-identical to today's
 * output.
 */
export function aggregateJudgements(samples: readonly ClipJudgement[]): ClipJudgement {
  const first = samples[0]
  if (!first) throw new Error("aggregateJudgements requires at least one sample")
  if (samples.length === 1) return first

  const ids = new Set<string>()
  for (const s of samples) for (const id of Object.keys(s.answers)) ids.add(id)

  const answers: Record<string, JudgeGrade> = {}
  for (const id of ids) {
    // A question missing from a sample reads as "no", the same default `scoreAnswers` uses.
    const ranks = samples.map((s) => GRADE_RANK[s.answers[id] ?? "no"]).sort((a, b) => a - b)
    answers[id] = RANK_GRADE[ranks[Math.floor(ranks.length / 2)]!]!
  }

  const score = Number((samples.reduce((a, s) => a + s.score, 0) / samples.length).toFixed(2))

  let representative = first
  let closest = Math.abs(first.score - score)
  for (const s of samples) {
    const d = Math.abs(s.score - score)
    if (d < closest) {
      closest = d
      representative = s
    }
  }

  return {
    answers,
    note: representative.note,
    bestOpeningSentence: modalOpening(samples),
    score,
  }
}

/** Modal non-null `bestOpeningSentence` across samples, ties broken toward the earlier sentence. */
function modalOpening(samples: readonly ClipJudgement[]): number | null {
  const counts = new Map<number, number>()
  for (const s of samples) {
    const v = s.bestOpeningSentence
    if (v != null) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best: number | null = null
  let bestCount = 0
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      bestCount = count
      best = value
    }
  }
  return best
}

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
  strongest opening — but ONLY if the clip still makes complete sense to a viewer starting there.
  A later sentence that is punchier but strands the clip without its setup is a worse opening, not
  a better one. Return null when the clip's first sentence is already the best opening.`

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
    // A string is tolerated too: the clip renders sentences as "#N" labels, and models occasionally
    // echo the whole label back instead of the digits. parseOpeningSentence normalises it.
    bestOpeningSentence: zod.union([zod.number().int(), zod.string()]).nullish(),
  })
}

/** `1` from a number, "1" or "#1" from a string, or null when the answer is not an integer label. */
function parseOpeningSentence(value: number | string | null | undefined): number | null {
  if (value == null) return null
  if (typeof value === "number") return Number.isInteger(value) ? value : null
  const m = /^#?\s*(\d+)\s*$/.exec(value)
  return m ? Number(m[1]) : null
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
  const parsedOpening = parseOpeningSentence(raw.bestOpeningSentence)
  const bestOpeningSentence =
    parsedOpening != null &&
    parsedOpening >= boundary.startSentenceIndex &&
    parsedOpening <= boundary.endSentenceIndex
      ? parsedOpening
      : null

  return {
    answers,
    note: raw.note.trim(),
    bestOpeningSentence,
    score: scoreAnswers(answers, questions),
  }
}

/** A voted judgement plus the raw samples that produced it (#125). */
export interface VotedJudgement {
  judgement: ClipJudgement
  samples: ClipJudgement[]
}

/**
 * Judges one clip, sampling up to `JUDGE_SAMPLES` times and voting (#125).
 *
 * The first sample decides everything when it is clearly dead (see `isClearlyDead`): no resample is
 * spent, so a clearly-rejected candidate costs one call. Otherwise the extra samples are taken and
 * `aggregateJudgements` combines them.
 *
 * Failure handling is deliberate: a FIRST-sample failure is rethrown, because that is a judge
 * failure and the caller's abort ratio must see it. A RESAMPLE failure is swallowed and the samples
 * in hand are used, because by then the clip has a verdict — dropping it for a transient blip on the
 * second or third call would turn a working judgement into a lost clip.
 *
 * Samples run sequentially, not in parallel: the caller already runs several clips concurrently
 * (`JUDGE_CONCURRENCY`), and fanning each into three more would multiply the in-flight calls against
 * a rate limit the client is backing off from.
 */
export async function judgeClipVoted(input: JudgeClipInput): Promise<VotedJudgement> {
  const first = await judgeClip(input)
  if (isClearlyDead(first, input.questions)) return { judgement: first, samples: [first] }

  const rest: ClipJudgement[] = []
  for (let i = 1; i < JUDGE_SAMPLES; i++) {
    try {
      rest.push(await judgeClip(input))
    } catch (err) {
      // A resample blip is not a judge failure: keep the samples we have.
      console.warn("[clip-judge] resample failed, using available samples:", err)
    }
  }

  const samples = [first, ...rest]
  if (samples.length > 1) logDisagreement(samples, input.questions)
  return { judgement: aggregateJudgements(samples), samples }
}

/**
 * Per-question sample disagreement, printed once per voted clip. This is the number that tells a
 * reviewer which question carries the judge's noise: a question that flips between samples is one
 * whose wording (not the clip) is the problem.
 */
function logDisagreement(
  samples: readonly ClipJudgement[],
  questions: readonly JudgeQuestion[],
): void {
  const disagree = questions
    .filter((q) => new Set(samples.map((s) => s.answers[q.id] ?? "no")).size > 1)
    .map((q) => q.id)
  if (disagree.length > 0) {
    console.log(`[clip-judge] samples disagree on: ${disagree.join(", ")}`)
  }
}

/**
 * Per-question sample disagreement across a run (#125): for each question, how many clips' samples
 * disagreed on the grade, out of the clips that were actually voted (more than one sample). This is
 * the number that says WHICH question carries the judge's noise — a question that flips between
 * samples is one whose wording, not the clip, is the problem.
 */
export function disagreementCounts(
  samplesPerClip: readonly (readonly ClipJudgement[])[],
  questions: readonly JudgeQuestion[],
): { id: string; disagreed: number; voted: number }[] {
  const voted = samplesPerClip.filter((s) => s.length > 1)
  return questions.map((q) => {
    let disagreed = 0
    for (const samples of voted) {
      // Missing reads as "no", the same default `scoreAnswers` uses, so an absent question is not
      // counted as a disagreement against a "no" sample.
      if (new Set(samples.map((s) => s.answers[q.id] ?? "no")).size > 1) disagreed++
    }
    return { id: q.id, disagreed, voted: voted.length }
  })
}

/**
 * The record stored in `clips.judge_json`. Questions are copied in so the stored clip stays
 * readable after the question set changes (see `ClipJudgeRecord`). `samples` carries the raw
 * per-call verdicts behind a voted result (#125) — omitted by callers that only have one.
 */
export function toJudgeRecord(
  judgement: ClipJudgement,
  questions: readonly JudgeQuestion[],
  samples?: readonly ClipJudgement[],
): ClipJudgeRecord {
  return {
    score: judgement.score,
    note: judgement.note,
    answers: judgement.answers,
    bestOpeningSentence: judgement.bestOpeningSentence,
    questions: questions.map((q) => ({ id: q.id, text: q.text, hard: q.hard })),
    ...(samples && samples.length > 0
      ? {
          samples: samples.map((s) => ({
            score: s.score,
            note: s.note,
            answers: s.answers,
            bestOpeningSentence: s.bestOpeningSentence,
          })),
        }
      : {}),
  }
}
