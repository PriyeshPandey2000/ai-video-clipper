#!/usr/bin/env node
// Prompt bench: runs the real selectClips pipeline (chunking, boundary refinement, quality
// gate, dedupe — everything except the system prompt) against ONE project's transcript, once
// per prompt variant defined below. Prints a side-by-side comparison and writes a markdown
// report so a human can pick a winner. Not a scoring harness (see #46 for that) — this is a
// scrappy "which of these prompts reads better today" tool.
//
// Requires Node ≥22.13 (or ≥23.4) and GROQ_API_KEY env var — see scripts/recall-ablation.ts
// for why this repo's Node version (20) isn't enough.
//
// Usage:
//   node --experimental-strip-types scripts/prompt-bench.ts [projectId]
//   pnpm prompt-bench [projectId]       (omit projectId to list projects)

import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { homedir } from "node:os"
import { writeFileSync } from "node:fs"
import { buildSentences } from "@video-editor/transcript"
import { createAiClient, selectClips } from "@video-editor/ai"
import type { ClipSelectionResult } from "@video-editor/ai"
import type { Word } from "@video-editor/types"

const DB_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "@video-editor",
  "desktop",
  "db.sqlite",
)

// ─── Prompt variants under test ──────────────────────────────────────────────
// "current" passes undefined so selectClips uses the exact shipped SYSTEM_PROMPT — that's the
// baseline every other variant is measured against. Add/edit variants here, run the script, read
// the report, then hand-port the winner into packages/ai/src/clip-selector.ts if it wins.

interface Variant {
  name: string
  systemPrompt: string | undefined
}

const VARIANTS: Variant[] = [
  {
    name: "current",
    systemPrompt: undefined,
  },
  {
    name: "strict-repost-bar",
    systemPrompt: `You are a short-form video editor selecting clips from a long transcript.

The transcript is given as numbered sentences with optional signal tags in {braces}:
#12 [10500-14200] {hook,fast} Nobody expected this outcome.
#13 [14200-16000] So then everything changed.

Signal tags — use as extra evidence, not hard rules:
  {hook}        — question, number, superlative, reveal, or contrarian framing detected
  {fast}        — speech rate significantly above speaker's rolling baseline (excitement)
  {slow}        — speech rate below baseline (deliberate emphasis or emotional weight)
  {loud}        — audio energy significantly above speaker's rolling baseline (emotional peak)
  {burst}       — sentence follows a notable silence (>800ms gap) — strong clip start point
  {filler:high} — >15% filler words (um/uh/like/basically…) — weaker content

Return clips as SENTENCE INDEX RANGES. Never write a timestamp — the numbers in brackets are for
your reference only, and any time value you output is discarded.

THE BAR: would YOU personally post this to your own TikTok/Reels account, under your own name,
today? Not "is this decent content" — would you stake your feed on it. Most transcripts clear
this bar zero or one time. If nothing clears it, return an empty array. Padding is a worse outcome
than an empty list.

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

RANKING: return clips in order, best first. Do not assign numeric scores — ordering is your
judgment, and an absolute score would be noise.

STRONG FLAG: set "strong": true only if it clears THE BAR above. Be ruthless — if you're unsure,
it's not strong.

Return JSON with a "clips" array. Each item: startSentence, endSentence, title, reason, strong,
platform ("tiktok" | "reels" | "shorts" | "generic").`,
  },
  {
    name: "hook-first-3s",
    systemPrompt: `You are a short-form video editor selecting clips from a long transcript.

The transcript is given as numbered sentences with optional signal tags in {braces}:
#12 [10500-14200] {hook,fast} Nobody expected this outcome.
#13 [14200-16000] So then everything changed.

Signal tags — use as extra evidence, not hard rules:
  {hook}        — question, number, superlative, reveal, or contrarian framing detected
  {fast}        — speech rate significantly above speaker's rolling baseline (excitement)
  {slow}        — speech rate below baseline (deliberate emphasis or emotional weight)
  {loud}        — audio energy significantly above speaker's rolling baseline (emotional peak)
  {burst}       — sentence follows a notable silence (>800ms gap) — strong clip start point
  {filler:high} — >15% filler words (um/uh/like/basically…) — weaker content

Return clips as SENTENCE INDEX RANGES. Never write a timestamp — the numbers in brackets are for
your reference only, and any time value you output is discarded.

THE FIRST 3 SECONDS DECIDE EVERYTHING. On every short-form platform, ~65% of viewers who watch 3
seconds go on to watch 10 — but only if those first 3 seconds land a hook. A clip with a slow or
generic opening dies in the feed no matter how good the payoff is. When picking a range, treat the
opening sentence as the single highest-leverage decision you make: it must be a question, a bold
claim, a number, or a promise — never scene-setting or a dangling reference.

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
Prefer a range that starts where a thought starts and ends where it resolves. If the strongest
payoff in a range is preceded by throat-clearing, prefer starting the range later, right on the
hook — a shorter clip with a strong open beats a longer one with a weak open.

RANKING: return clips in order, best first. Do not assign numeric scores — ordering is your
judgment, and an absolute score would be noise.

STRONG FLAG: set "strong": true only if you would personally post this clip. Be strict. A
transcript with no outstanding moments should return few clips, or none. Returning weak clips is
worse than returning nothing.

Return JSON with a "clips" array. Each item: startSentence, endSentence, title, reason, strong,
platform ("tiktok" | "reels" | "shorts" | "generic").`,
  },
]

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

function renderResult(v: Variant, result: ClipSelectionResult): string {
  const lines: string[] = []
  lines.push(`## ${v.name}`)
  lines.push("")
  lines.push(`Clips: ${result.clips.length}  |  Rejected: ${result.rejected.length}`)
  lines.push("")
  if (result.clips.length === 0) {
    lines.push("_No clips returned._")
  } else {
    for (const c of result.clips) {
      const durSec = Math.round((c.endMs - c.startMs) / 1000)
      const warn = c.warnings.length > 0 ? `  ⚠️ ${c.warnings.join(", ")}` : ""
      lines.push(
        `- **${c.title}** [${formatMs(c.startMs)}–${formatMs(c.endMs)}, ${durSec}s, ${c.platform}]${warn}`,
      )
      lines.push(`  ${c.reason}`)
    }
  }
  if (result.rejected.length > 0) {
    lines.push("")
    lines.push(
      `Rejected: ${result.rejected.map((r) => `"${r.title}" (${r.reasons.join("; ")})`).join(", ")}`,
    )
  }
  lines.push("")
  return lines.join("\n")
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
    console.log("Usage: pnpm prompt-bench <projectId>")
    db.close()
    return
  }

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

  const words = wordRows.map(toWord)
  const sentences = buildSentences(words)
  console.log(`Words     : ${words.length}`)
  console.log(`Sentences : ${sentences.length}`)
  console.log(`Variants  : ${VARIANTS.map((v) => v.name).join(", ")}`)
  console.log()

  const client = createAiClient()
  const sections: string[] = [
    `# Prompt bench — project ${projectId}`,
    "",
    `Words: ${words.length}  |  Sentences: ${sentences.length}`,
    "",
  ]

  for (const variant of VARIANTS) {
    console.log(`Running "${variant.name}"...`)
    try {
      const result = await selectClips(client, words, sentences, [], 10, [], variant.systemPrompt)
      console.log(`  → ${result.clips.length} clips, ${result.rejected.length} rejected`)
      sections.push(renderResult(variant, result))
    } catch (err) {
      console.error(`  ✗ failed:`, err)
      sections.push(`## ${variant.name}\n\n_FAILED: ${String(err)}_\n`)
    }
  }

  const reportPath = join(process.cwd(), `prompt-bench-${projectId}-${Date.now()}.md`)
  writeFileSync(reportPath, sections.join("\n"))
  console.log(`\nReport written to ${reportPath}`)

  db.close()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
