#!/usr/bin/env node
// Recall ablation (#46): sends the full unchunked transcript to the LLM in one shot,
// compares against pipeline clips, and measures what % of pipeline clips are recalled.
// Gates B12: need ≥90% recall before enabling the pre-filter.
//
// #91 — this file owns no copy of the pipeline prompt. The system and user strings are built by
// `resolveSelectionContext` + `buildChunkPrompts`, the same pair `selectClips` and
// `selectFromChunk` build every selection request from, with:
//   - the `VideoAnalysis` stored for the run being measured (so the context block is the one that
//     run actually sent, not a re-classification that may answer differently),
//   - the project's own `clip_profile_override`, and
//   - arousal re-measured from the same `audio.wav` the pipeline measured, so `{loud}` tags are
//     present rather than silently absent.
// `scripts/recall-ablation.test.ts` asserts the strings equal what `selectClips` sends for the
// same inputs; that assertion, not this comment, is what stops the copy returning.
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

import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildSentences } from "@video-editor/transcript"
import {
  analyzeVideo,
  buildChunkPrompts,
  createAiClient,
  isClipProfileId,
  resolveSelectionContext,
  CandidateSchema,
} from "@video-editor/ai"
import { measureArousal, resolveFfmpegBinary } from "@video-editor/ffmpeg"
import { z } from "zod"
import type { ClipProfileId, Sentence, VideoAnalysis, Word } from "@video-editor/types"

/**
 * The slice of `node:sqlite`'s `DatabaseSync` this file uses, stated structurally so importing the
 * module for its exported prompt builder does not pull in `node:sqlite`.
 *
 * That matters twice over: the parity test runs under vitest, whose resolver predates `node:sqlite`
 * and fails on it, and `@types/node` is pinned at 20 while `node:sqlite` shipped in 22.5 — so a
 * type-level import would not compile even if the runtime one loads.
 */
interface SqlStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}
interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}
type DatabaseSyncCtor = new (path: string) => SqliteDatabase

const SUPPORT_DIR = join(homedir(), "Library", "Application Support", "@video-editor", "desktop")
const DB_PATH = join(SUPPORT_DIR, "db.sqlite")
const PROJECTS_DIR = join(SUPPORT_DIR, "projects")

// Clip overlap threshold: pipeline clip "recalled" if ref clip overlaps by ≥50% (see overlapRatio).
const OVERLAP_THRESHOLD = 0.5
// B12 gate: need ≥90% recall to safely pre-filter.
const RECALL_GO_THRESHOLD = 0.9

// `CandidateSchema` is the pipeline's own — importing it rather than restating it is what keeps a
// field the pipeline stops sending (it dropped `strong` in v3) from being demanded here. The `.max`
// is the one deliberate difference: the pipeline caps per *chunk*, and this is one call over the
// whole transcript.
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
  clip_profile_override: string | null
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
    speakerLabel: row.speaker_label,
  }
}

/**
 * The analysis `selectClips` used for this project's most recent run, or null if the run predates
 * #98 or its row is unreadable. Re-reading it rather than re-classifying is the point: the context
 * block has to be the block that run sent, and a fresh call at a different time is not that.
 */
function readStoredAnalysis(db: SqliteDatabase, projectId: string): VideoAnalysis | null {
  const row = db
    .prepare(
      "SELECT content FROM ai_outputs WHERE project_id = ? AND type = 'video_analysis' ORDER BY created_at DESC LIMIT 1",
    )
    .get(projectId) as { content: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.content) as VideoAnalysis
  } catch {
    return null
  }
}

export interface ReferencePromptInput {
  sentences: Sentence[]
  words: Word[]
  analysis: VideoAnalysis
  profileOverride: ClipProfileId | null
  arousalPerSec?: number[]
}

/**
 * Exactly the system + user strings the pipeline sends for one selection call over `sentences`.
 *
 * Exported so the parity test can compare this against a captured `selectClips` request instead of
 * the test re-deriving the assembly and drifting from the script it is meant to protect.
 */
export function buildReferencePrompt(input: ReferencePromptInput): {
  system: string
  prompt: string
} {
  const { profile, contextBlock } = resolveSelectionContext(input.analysis, input.profileOverride)
  return buildChunkPrompts({
    chunk: input.sentences,
    words: input.words,
    profile,
    contextBlock,
    arousalPerSec: input.arousalPerSec ?? [],
  })
}

/** True when this file was invoked directly, rather than imported (by the parity test). */
function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

async function main() {
  // Dynamic rather than top-level: see `SqliteDatabase` above. Only `main` needs the handle.
  // @ts-expect-error `node:sqlite` shipped in Node 22.5 and @types/node is pinned at 20 for
  // Electron compatibility — the runtime that actually loads it (Node ≥22.13) is newer than the
  // types standing in for it here.
  const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: DatabaseSyncCtor }
  const db = new DatabaseSync(DB_PATH)
  db.exec("PRAGMA journal_mode = WAL")

  const projectId = process.argv[2]

  if (!projectId) {
    const rows = db
      .prepare("SELECT id, name, status, clip_profile_override FROM projects ORDER BY created_at")
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

  const project = db
    .prepare("SELECT id, name, status, clip_profile_override FROM projects WHERE id = ?")
    .get(projectId) as Project | undefined
  if (!project) {
    console.error(`Project "${projectId}" not found.`)
    db.close()
    process.exit(1)
  }
  const profileOverride = isClipProfileId(project.clip_profile_override)
    ? project.clip_profile_override
    : null

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

  const client = createAiClient()

  // The analysis the measured run used. Fall back to classifying now — with no topic segments,
  // which only changes the transcript excerpting decision for very long videos. A stored row whose
  // profile id is not one this build knows would index `CLIP_PROFILES` to undefined, so it counts
  // as absent rather than as a crash halfway through the run.
  const stored = readStoredAnalysis(db, projectId)
  const storedAnalysis = stored && isClipProfileId(stored.profile) ? stored : null
  const analysis = storedAnalysis ?? (await analyzeVideo(client, sentences, []))
  console.log(
    `Analysis        : ${
      storedAnalysis
        ? `stored (${storedAnalysis.profile}, ${storedAnalysis.confidence})`
        : `classified now (${analysis.profile}) — no stored video_analysis row`
    }`,
  )
  console.log(`Profile         : ${profileOverride ? `${profileOverride} (override)` : "detected"}`)

  // Arousal, from the same audio.wav the pipeline measured. `measureArousal` resolves to [] on any
  // ffmpeg failure, so a missing file degrades to "no {loud} tags" rather than aborting — but a
  // silent shortfall here would make the reference prompt differ from the shipped one, so say so.
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)))
  const ffmpegBin = resolveFfmpegBinary(join(repoRoot, "resources"))
  const arousalPerSec = await measureArousal(ffmpegBin, join(PROJECTS_DIR, projectId, "audio.wav"))
  if (arousalPerSec.length === 0) {
    console.warn(
      "Arousal        : 0 seconds measured — {loud} tags will be absent from this run's prompt.",
    )
  } else {
    console.log(`Arousal         : ${arousalPerSec.length} seconds measured`)
  }

  const { system, prompt } = buildReferencePrompt({
    sentences,
    words,
    analysis,
    profileOverride,
    arousalPerSec,
  })

  // Full transcript prompt — all sentences, no chunking. `prompt` is the pipeline's own user
  // template, so it already carries the context block, the sentence-range line and the signal tags.
  console.log(
    `\nPrompt          : ${sentences.length} sentences, ${Math.round(prompt.length / 1000)}k chars sent`,
  )
  console.log("Calling LLM (no chunking)...\n")

  const result = await client.generateObject({
    prompt,
    schema: ResponseSchema,
    system,
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

if (isDirectRun()) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
