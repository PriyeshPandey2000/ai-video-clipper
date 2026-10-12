#!/usr/bin/env node
// Smoke-run driver: runs the shipped clip-selection + report path for one or more local projects,
// the same way the desktop app's `runClipSelection` does (apps/desktop/src/main/ipc.ts), then prints
// the six smoke-checklist gates (docs/plans/clip-selection-5-smoke-checklist.md).
//
// Faithfulness is the point, not a faster path:
//   - words come from the app's own DB (`db.sqlite`), read only — nothing is written to the DB,
//   - `segmentTopics` runs against the app's models directory,
//   - arousal is measured from the project's own `audio.wav` with the bundled ffmpeg
//     (`resolveFfmpegBinary(resources/ffmpeg)`, the same binary the app resolves),
//   - the selection call is `selectClips` itself (chunking, judge, retries, genre analysis), and
//   - the report is written by the app's own `writeSelectionReport` into the project's
//     `selection-reports/` directory, so `pnpm report-table` reads it.
//
// The one deliberate difference: the app also writes suggested clips to the DB and replaces the
// previous run's suggestions. This driver writes only the report, so it cannot overwrite any state
// the app is showing.
//
// Requires Node ≥22.13 (node:sqlite + --experimental-strip-types) and GROQ_API_KEY, like the
// sibling scripts. Gives nothing without a working key, and nothing is faked if a call fails.
//
// Usage:
//   GROQ_API_KEY=... node --experimental-strip-types scripts/smoke-run.ts <projectId> [projectId ...]

import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { buildSentences, segmentTopics } from "@video-editor/transcript"
import { createAiClient, selectClips, isClipProfileId } from "@video-editor/ai"
import type { ClipSelectionProvenance, ClipSelectionTrace } from "@video-editor/ai"
import { measureArousal, resolveFfmpegBinary } from "@video-editor/ffmpeg"
import { writeSelectionReport } from "../apps/desktop/src/main/selection-report.ts"

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
const MODELS_DIR = join(SUPPORT_DIR, "models")
const MAX_CLIPS = 10

// Transcript spot-check thresholds. Conservative on purpose: these gate the benchmark, so they only
// flag shapes that cannot be real speech — a word lasting over ten seconds, a pairwise overlap
// beyond half a second (whisper word timestamps can jitter slightly, so a strict `>` 0 would fire on
// healthy audio), an empty or zero-length token. What they guard against is a corrupted transcript
// (duplicated tail, runaway word) being scored as if it were a clean one.
const WORD_MAX_DURATION_MS = 10_000
const WORD_OVERLAP_TOLERANCE_MS = 500

interface TranscriptSpotCheck {
  overlaps: number
  stuck: number
  empty: number
  worstOverlapMs: number
  longestWordMs: number
}

/** Words must be sorted by start time (the query is `ORDER BY start_ms`). */
function transcriptSpotCheck(
  words: { text: string; startMs: number; endMs: number }[],
): TranscriptSpotCheck {
  let overlaps = 0
  let stuck = 0
  let empty = 0
  let worstOverlapMs = 0
  let longestWordMs = 0
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w.text.trim() === "" || w.endMs <= w.startMs) empty++
    const duration = w.endMs - w.startMs
    if (duration > longestWordMs) longestWordMs = duration
    if (duration > WORD_MAX_DURATION_MS) stuck++
    const next = words[i + 1]
    if (next) {
      const overlap = w.endMs - next.startMs
      if (overlap > WORD_OVERLAP_TOLERANCE_MS) {
        overlaps++
        if (overlap > worstOverlapMs) worstOverlapMs = overlap
      }
    }
  }
  return { overlaps, stuck, empty, worstOverlapMs, longestWordMs }
}

interface ProjectRow {
  id: string
  name: string
  status: string
  duration_ms: number
  clip_profile_override: string | null
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

interface RunVerdict {
  projectId: string
  projectName: string
  pipelineVersion: string
  pipelineHash: string
  model: string
  analysis: { profile: string; confidence: string; fallback: boolean }
  chunks: {
    index: number
    failed: boolean
    bisected: boolean
    recovered: boolean
    splitOf?: number
  }[]
  failedChunkCount: number
  bisectedChunkCount: number
  recoveredChunkCount: number
  chunkFailures: string[]
  keptCount: number
  judgeFailedCount: number
  candidatesDropped: number
  transcript: TranscriptSpotCheck
  gates: { n: number; ok: boolean; detail: string }[]
  reportJsonPath: string
  reportMarkdownPath: string
}

async function openDb(): Promise<SqliteDatabase> {
  // @ts-expect-error `node:sqlite` shipped in Node 22.5 and @types/node is pinned at 20 for
  // Electron compatibility — the runtime that actually loads it (Node ≥22.13) is newer than the
  // types standing in for it here. Same stance as `recall-ablation.ts`.
  const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: DatabaseSyncCtor }
  return new DatabaseSync(DB_PATH)
}

async function runOne(projectId: string): Promise<RunVerdict> {
  const db = await openDb()
  const project = db
    .prepare(
      "SELECT id, name, status, duration_ms, clip_profile_override FROM projects WHERE id = ?",
    )
    .get(projectId) as ProjectRow | undefined
  if (!project) {
    db.close()
    throw new Error(`Project "${projectId}" not found`)
  }

  const wordRows = db
    .prepare(
      "SELECT id, project_id, text, start_ms, end_ms, confidence, speaker_label FROM words WHERE project_id = ? ORDER BY start_ms",
    )
    .all(projectId) as WordRow[]
  db.close()
  if (wordRows.length === 0) {
    throw new Error(`Project "${projectId}" has no words — nothing to run`)
  }

  const words = wordRows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    text: r.text,
    startMs: r.start_ms,
    endMs: r.end_ms,
    confidence: r.confidence,
    speakerLabel: r.speaker_label,
  }))
  const sentences = buildSentences(words)
  if (sentences.length === 0) throw new Error(`Project "${projectId}" built no sentences`)

  const profileOverride = isClipProfileId(project.clip_profile_override)
    ? project.clip_profile_override
    : null

  const client = createAiClient()
  const ffmpegBin = resolveFfmpegBinary(join(repoRoot(), "resources"))

  const topics = await segmentTopics(sentences, MODELS_DIR)
  const arousalPerSec = await measureArousal(ffmpegBin, join(PROJECTS_DIR, projectId, "audio.wav"))

  const selection = await selectClips(
    client,
    words,
    sentences,
    topics,
    MAX_CLIPS,
    arousalPerSec,
    profileOverride,
  )

  const trace: ClipSelectionTrace | undefined = selection.trace
  if (!trace) {
    throw new Error("selectClips returned no trace; refusing to write an unsourced report")
  }
  const allChunksFailed = trace.chunks.length > 0 && trace.chunks.every((c) => c.failed)
  if (allChunksFailed) {
    throw new Error(
      `Clip selection failed for all ${trace.chunks.length} chunk(s). Nothing was written.`,
    )
  }

  const provenance: ClipSelectionProvenance = {
    pipelineVersion: selection.pipelineVersion,
    pipelineHash: selection.pipelineHash,
    model: selection.model,
    contentType: selection.contentType,
    contentTypeOverridden: selection.contentTypeOverridden,
  }

  const startedAtMs = Date.now()
  const projectDir = join(PROJECTS_DIR, projectId)
  const { reportJsonPath, reportMarkdownPath } = await writeSelectionReport(projectDir, {
    header: {
      projectId,
      projectName: project.name,
      durationMs: project.duration_ms,
      startedAtMs,
    },
    provenance,
    analysis: selection.analysis,
    trace,
    // The report type promises rank order (0 = best) and the app sorts here too — see the #118 fix.
    finalRanked: trace.candidates
      .filter((c) => c.outcome === "kept" && c.startMs !== null && c.endMs !== null)
      .map((c) => ({
        rank: c.finalRank ?? 0,
        title: c.title,
        reason: c.reason,
        platform: c.platform,
        startTimecode: c.startTimecode ?? "—",
        endTimecode: c.endTimecode ?? "—",
        durationMs: (c.endMs ?? 0) - (c.startMs ?? 0),
        text: c.text,
      }))
      .sort((a, b) => a.rank - b.rank),
  })

  const keptCount = trace.candidates.filter((c) => c.outcome === "kept").length
  const judgeFailedCount = trace.candidates.filter((c) => c.outcome === "judge-failed").length
  const candidatesDropped = trace.chunks.reduce((n, c) => n + (c.candidatesDropped ?? 0), 0)
  // Sections that genuinely produced nothing. A bisected parent is structural — its halves are the
  // leaves — so counting it too would report one hole twice.
  const failedChunks = trace.chunks.filter((c) => c.failed && !c.bisected).length
  const bisectedChunks = trace.chunks.filter((c) => c.bisected).length
  const recoveredChunks = trace.chunks.filter((c) => c.recovered).length
  const chunkFailures = trace.chunks
    .filter((c) => c.failure)
    .map((c) => {
      const f = c.failure!
      const label = c.bisected ? `#${c.index} parent` : `#${c.index}`
      const tokens =
        f.inputTokens !== null || f.outputTokens !== null
          ? ` · ${f.inputTokens ?? "?"}→${f.outputTokens ?? "?"} tok`
          : ""
      return `${label}: ${f.reason} (${f.attempts} calls, ${f.promptChars} chars${tokens})`
    })
  const transcript = transcriptSpotCheck(words)

  const fallback = selection.analysis.fallback === true
  const transcriptOk = transcript.overlaps === 0 && transcript.stuck === 0 && transcript.empty === 0
  const gates = [
    {
      n: 1,
      ok: !fallback,
      detail: fallback
        ? `FALLBACK — genre detection failed (${selection.analysis.profile} ${selection.analysis.confidence})`
        : `genre detected: ${selection.analysis.profile} (${selection.analysis.confidence})`,
    },
    {
      n: 2,
      ok: failedChunks === 0,
      detail: `chunks ${trace.chunks.length} (${failedChunks} failed${
        bisectedChunks > 0 ? `, ${bisectedChunks} split` : ""
      }${recoveredChunks > 0 ? `, ${recoveredChunks} recovered` : ""})`,
    },
    { n: 3, ok: keptCount >= 1, detail: `kept ${keptCount} candidate(s)` },
    {
      n: 4,
      ok: judgeFailedCount === 0,
      detail: `judge-failed ${judgeFailedCount}`,
    },
    {
      n: 5,
      ok: candidatesDropped === 0,
      detail:
        candidatesDropped === 0
          ? "no cap drops"
          : `${candidatesDropped} dropped over the per-chunk cap`,
    },
    {
      n: 6,
      ok: failedChunks === 0 && Boolean(selection.pipelineHash),
      detail: `hash ${(selection.pipelineHash ?? "").slice(0, 12) || "(missing)"}`,
    },
    {
      n: 7,
      ok: transcriptOk,
      detail: transcriptOk
        ? `words ${words.length} · longest ${transcript.longestWordMs}ms · no overlaps/empty words`
        : `words ${words.length} · overlaps ${transcript.overlaps} (worst ${transcript.worstOverlapMs}ms) · stuck ${transcript.stuck} · empty ${transcript.empty} · longest ${transcript.longestWordMs}ms`,
    },
  ]

  return {
    projectId,
    projectName: project.name,
    pipelineVersion: selection.pipelineVersion,
    pipelineHash: selection.pipelineHash,
    model: selection.model,
    analysis: {
      profile: selection.analysis.profile,
      confidence: selection.analysis.confidence,
      fallback,
    },
    chunks: trace.chunks.map((c) => ({
      index: c.index,
      failed: c.failed,
      bisected: c.bisected === true,
      recovered: c.recovered === true,
      ...(c.splitOf !== undefined ? { splitOf: c.splitOf } : {}),
    })),
    failedChunkCount: failedChunks,
    bisectedChunkCount: bisectedChunks,
    recoveredChunkCount: recoveredChunks,
    chunkFailures,
    keptCount,
    judgeFailedCount,
    candidatesDropped,
    transcript,
    gates,
    reportJsonPath,
    reportMarkdownPath,
  }
}

function repoRoot(): string {
  return resolve(fileURLToPath(new URL("..", import.meta.url)))
}

function printVerdict(v: RunVerdict): void {
  console.log("─────────────────────────────────────────────────────────────────")
  console.log(`${v.projectName}`)
  console.log(`  project      : ${v.projectId}`)
  console.log(
    `  pipeline     : ${v.pipelineVersion} · hash ${(v.pipelineHash ?? "").slice(0, 12) || "(missing)"} · ${v.model}`,
  )
  console.log(
    `  genre        : ${v.analysis.fallback ? "FALLBACK" : v.analysis.profile} (${v.analysis.confidence})`,
  )
  console.log(`  report json  : ${v.reportJsonPath}`)
  console.log(`  report markdown : ${v.reportMarkdownPath}`)
  console.log(
    `  chunks       : ${v.chunks.length} total · ${v.failedChunkCount} failed · ${v.bisectedChunkCount} split · ${v.recoveredChunkCount} recovered`,
  )
  for (const f of v.chunkFailures) console.log(`    entry: ${f}`)
  console.log("  gates:")
  for (const g of v.gates) {
    console.log(`    ${g.ok ? "PASS" : "FAIL"}  gate ${g.n}: ${g.detail}`)
  }
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2)
  if (ids.length === 0) {
    console.error(
      "Usage: GROQ_API_KEY=... node --experimental-strip-types scripts/smoke-run.ts <projectId> [projectId ...]",
    )
    process.exit(1)
  }
  let allOk = true
  for (const id of ids) {
    try {
      const v = await runOne(id)
      printVerdict(v)
      if (!v.gates.every((g) => g.ok)) allOk = false
    } catch (err) {
      allOk = false
      console.log("─────────────────────────────────────────────────────────────────")
      console.log(`${id}: ERROR — ${(err as Error).message}`)
    }
  }
  console.log("─────────────────────────────────────────────────────────────────")
  console.log(
    allOk ? "ALL GATES PASS" : "ONE OR MORE GATES FAILED — smoke gate blocks the benchmark",
  )
  if (!allOk) process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
