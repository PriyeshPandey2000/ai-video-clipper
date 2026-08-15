#!/usr/bin/env node
// Recall ablation (#46): sends the full unchunked transcript to the LLM in one shot,
// compares against pipeline clips, and measures what % of pipeline clips are recalled.
// Gates B12: need ≥90% recall before enabling the pre-filter.
//
// Requires Node ≥22.13 (or ≥23.4) and GROQ_API_KEY env var. This is higher than the repo's
// .node-version (20) — node:sqlite needs 22.5+, --experimental-strip-types needs 22.6+, and
// 22.6–22.12 additionally requires the now-removed --experimental-sqlite flag. Run this script
// with a separately-installed newer Node (e.g. `nvm exec 22 -- pnpm recall-ablation ...`); it's
// a standalone analysis tool, not part of the app's runtime, so the repo-wide Node version is
// intentionally left at 20 for Electron compatibility.
//
// Usage:
//   node --experimental-strip-types scripts/recall-ablation.ts [projectId]
//   pnpm recall-ablation [projectId]       (omit projectId to list projects)

import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { homedir } from "node:os"
import { buildSentences } from "@video-editor/transcript"
import { createAiClient } from "@video-editor/ai"
import { z } from "zod"
import type { Word } from "@video-editor/types"

const DB_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "@video-editor",
  "desktop",
  "db.sqlite",
)

// Clip overlap threshold: pipeline clip "recalled" if ref clip overlaps by ≥50% IoU.
const OVERLAP_THRESHOLD = 0.5
// B12 gate: need ≥90% recall to safely pre-filter.
const RECALL_GO_THRESHOLD = 0.9

// Mirror the pipeline's SYSTEM_PROMPT exactly so the comparison is fair.
const SYSTEM_PROMPT = `You are a short-form video editor selecting clips from a long transcript.

The transcript is given as numbered sentences:
#12 [10500-14200] Nobody expected this outcome.
#13 [14200-16000] So then everything changed.

Return clips as SENTENCE INDEX RANGES. Never write a timestamp — the numbers in brackets are for
your reference only, and any time value you output is discarded.

WHAT MAKES A CLIP WORTH POSTING — look for these, in rough order of value:
1. Hook — the opening line creates curiosity, tension, or a promise in one sentence
2. Emotional peak — anger, excitement, vulnerability, genuine laughter
3. Opinion bomb — a strong, specific, contestable claim the speaker commits to
4. Revelation — a surprising fact, number, or reversal of expectation
5. Conflict — disagreement, pushback, a challenged assumption
6. Quotable line — compressed, repeatable, survives without context
7. Story peak — a complete beat with setup, turn, and payoff
8. Practical value — one actionable idea a viewer could use today

A clip MUST be self-contained. Someone who never saw the source video should understand it.
Prefer a range that starts where a thought starts and ends where it resolves.

RANKING: return clips in order, best first.

STRONG FLAG: set "strong": true only if you would personally post this clip. Be strict.
Returning weak clips is worse than returning nothing.

Return JSON with a "clips" array. Each item: startSentence, endSentence, title, reason, strong,
platform ("tiktok" | "reels" | "shorts" | "generic").`

const CandidateSchema = z.object({
  startSentence: z.number().int().min(0),
  endSentence: z.number().int().min(0),
  title: z.string(),
  reason: z.string(),
  strong: z.boolean(),
  platform: z.enum(["tiktok", "reels", "shorts", "generic"]),
})

const ResponseSchema = z.object({ clips: z.array(CandidateSchema).max(50) })

// Matches packages/ai/src/clip-selector.ts overlapRatio exactly — intersection over the SHORTER
// clip's duration, not IoU. Using a different denominator here would make this script's recall
// number (which gates the B12 go/no-go decision) measure something the pipeline doesn't.
function overlapRatio(
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): number {
  const inter = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)
  if (inter <= 0) return 0
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs)
  return inter / shorter
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, "0")}`
}

interface Project {
  id: string
  name: string
  status: string
}

interface Clip {
  id: string
  title: string
  start_ms: number
  end_ms: number
}

interface WordRow {
  id: string
  project_id: string
  text: string
  start_ms: number
  end_ms: number
  confidence: number
  speaker_label: string | null
}

function toWord(row: WordRow): Word {
  return {
    id: row.id,
    projectId: row.project_id,
    text: row.text,
    startMs: row.start_ms,
    endMs: row.end_ms,
    confidence: row.confidence,
    speakerLabel: row.speaker_label ?? undefined,
  }
}

async function main() {
  const db = new DatabaseSync(DB_PATH)
  db.exec("PRAGMA journal_mode = WAL")

  const projectId = process.argv[2]

  if (!projectId) {
    const rows = db
      .prepare("SELECT id, name, status FROM projects ORDER BY created_at")
      .all() as Project[]
    if (rows.length === 0) {
      console.log("No projects in DB.")
    } else {
      console.log("Projects:\n")
      for (const p of rows) {
        console.log(`  ${p.id}`)
        console.log(`    name   : ${p.name}`)
        console.log(`    status : ${p.status}`)
        console.log()
      }
    }
    console.log("Usage: pnpm recall-ablation <projectId>")
    db.close()
    return
  }

  // Load words
  const wordRows = db
    .prepare(
      "SELECT id, project_id, text, start_ms, end_ms, confidence, speaker_label FROM words WHERE project_id = ? ORDER BY start_ms",
    )
    .all(projectId) as WordRow[]

  if (wordRows.length === 0) {
    console.error(`No words found for project "${projectId}". Run the pipeline first.`)
    db.close()
    process.exit(1)
  }
  console.log(`Words loaded    : ${wordRows.length}`)

  // Load pipeline clips (ground truth)
  const clipRows = db
    .prepare("SELECT id, title, start_ms, end_ms FROM clips WHERE project_id = ?")
    .all(projectId) as Clip[]
  console.log(`Pipeline clips  : ${clipRows.length}`)

  if (clipRows.length === 0) {
    console.error("No pipeline clips found. Run the pipeline first.")
    db.close()
    process.exit(1)
  }

  // Build sentences
  const words = wordRows.map(toWord)
  const sentences = buildSentences(words)
  console.log(`Sentences built : ${sentences.length}`)

  if (sentences.length === 0) {
    console.error(
      `No sentences built for project "${projectId}" (words present but none formed a sentence).`,
    )
    db.close()
    process.exit(1)
  }

  // Full transcript prompt — all sentences, no chunking
  const firstIdx = sentences[0]!.index
  const lastIdx = sentences[sentences.length - 1]!.index
  const transcriptText = sentences
    .map((s) => `#${s.index} [${s.startMs}-${s.endMs}] ${s.text}`)
    .join("\n")

  const prompt = `Sentences #${firstIdx} to #${lastIdx}.

${transcriptText}

Select every clip worth posting, best first. Each clip should span roughly 30–90 seconds.
Only use sentence indices between ${firstIdx} and ${lastIdx}.
Return fewer clips — or an empty array — rather than padding with weak ones.`

  console.log(
    `\nTranscript      : ${sentences.length} sentences, ~${Math.round(transcriptText.length / 1000)}k chars`,
  )
  console.log("Calling LLM (no chunking)...\n")

  const client = createAiClient()
  const result = await client.generateObject({
    prompt,
    schema: ResponseSchema,
    system: SYSTEM_PROMPT,
  })
  const refCandidates = result.clips
  console.log(`Reference clips : ${refCandidates.length} from LLM`)

  // Map candidates → ms via sentence index
  const sentenceByIndex = new Map(sentences.map((s) => [s.index, s]))
  const refClips = refCandidates
    .map((c) => {
      const start = sentenceByIndex.get(c.startSentence)
      const end = sentenceByIndex.get(c.endSentence)
      if (!start || !end) return null
      return { title: c.title, startMs: start.startMs, endMs: end.endMs }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)

  // Measure recall: pipeline clip recalled if any ref clip overlaps it ≥ OVERLAP_THRESHOLD
  let recalled = 0
  const missed: Array<{ title: string; startMs: number; endMs: number }> = []

  for (const pc of clipRows) {
    const found = refClips.some(
      (rc) => overlapRatio({ startMs: pc.start_ms, endMs: pc.end_ms }, rc) >= OVERLAP_THRESHOLD,
    )
    if (found) recalled++
    else missed.push({ title: pc.title, startMs: pc.start_ms, endMs: pc.end_ms })
  }

  const recall = recalled / clipRows.length
  const recallPct = (recall * 100).toFixed(1)
  const go = recall >= RECALL_GO_THRESHOLD

  console.log("\n" + "─".repeat(50))
  console.log(`Pipeline clips  : ${clipRows.length}`)
  console.log(`Reference clips : ${refClips.length}  (LLM, full transcript, no chunking)`)
  console.log(`Recalled        : ${recalled} / ${clipRows.length}`)
  console.log(`Recall          : ${recallPct}%`)
  console.log()
  if (go) {
    console.log(`✅  GO — ${recallPct}% ≥ 90%. B12 pre-filter is safe to enable.`)
  } else {
    console.log(`❌  NO-GO — ${recallPct}% < 90%. Investigate missed clips before enabling B12.`)
  }

  if (missed.length > 0) {
    console.log(`\nMissed clips (${missed.length}):`)
    for (const m of missed) {
      console.log(`  [${formatMs(m.startMs)} – ${formatMs(m.endMs)}] ${m.title}`)
    }
  }

  if (refClips.length > 0) {
    console.log(`\nReference clip list:`)
    for (const rc of refClips) {
      console.log(`  [${formatMs(rc.startMs)} – ${formatMs(rc.endMs)}] ${rc.title}`)
    }
  }

  db.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
