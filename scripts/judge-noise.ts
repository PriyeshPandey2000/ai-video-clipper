#!/usr/bin/env node
// JUDGE-NOISE HARNESS (diagnostic only — changes nothing in the pipeline).
//
// Re-judges a stored run's already-proposed candidates N times each, with NO regeneration and NO
// change to the proposal stage. The per-clip score spread and hard-question flips it prints are the
// judge's own noise floor, isolated from generation and boundary variance.
//
// It reconstructs the exact judge input the pipeline used: the same words (from the app DB), the
// same sentences, the same context block (`renderVideoContext` over the report's stored analysis),
// the same questions (stored in the trace), and the same boundary (`refineClipBoundaries` over the
// model's own sentence range — deterministic, so it reproduces the original cut).
//
// Usage:
//   GROQ_API_KEY=... node --experimental-strip-types scripts/judge-noise.ts <projectId> <reportJson> [repeats] [limit]

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { buildSentences } from "@video-editor/transcript"
import {
  createAiClient,
  judgeClip,
  failedHardQuestions,
  renderVideoContext,
  type JudgeQuestion,
} from "@video-editor/ai"
import type { Word, Sentence, VideoAnalysis } from "@video-editor/types"

interface SqlStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}
interface SqliteDatabase {
  prepare(sql: string): SqlStatement
  close(): void
}
type DatabaseSyncCtor = new (path: string) => SqliteDatabase

const SUPPORT_DIR = join(homedir(), "Library", "Application Support", "@video-editor", "desktop")
const DB_PATH = join(SUPPORT_DIR, "db.sqlite")
const PROJECTS_DIR = join(SUPPORT_DIR, "projects")

interface ReportFile {
  provenance: { pipelineHash: string; contentType: string; contentTypeOverridden: boolean }
  analysis: VideoAnalysis
  trace: {
    judgeQuestions: JudgeQuestion[]
    candidates: {
      outcome: string
      title: string
      startSentence: number
      endSentence: number
      startMs: number | null
      endMs: number | null
      startTimecode: string | null
      endTimecode: string | null
      judge: { score: number } | null
      judgeReasons: string[]
    }[]
  }
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

async function openDb(): Promise<SqliteDatabase> {
  // @ts-expect-error node:sqlite is newer than @types/node (20) pinned for Electron.
  const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: DatabaseSyncCtor }
  return new DatabaseSync(DB_PATH)
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!, i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

async function main(): Promise<void> {
  const [projectId, reportJson, repeatsArg, limitArg] = process.argv.slice(2)
  if (!projectId || !reportJson) {
    console.error("Usage: judge-noise.ts <projectId> <reportJson> [repeats=3] [limit=all]")
    process.exit(1)
  }
  const repeats = Number(repeatsArg ?? 3)
  const limit = limitArg ? Number(limitArg) : Infinity

  const report = JSON.parse(
    readFileSync(join(PROJECTS_DIR, projectId, "selection-reports", reportJson), "utf-8"),
  ) as ReportFile

  const db = await openDb()
  const rows = db
    .prepare(
      "SELECT id, project_id, text, start_ms, end_ms, confidence, speaker_label FROM words WHERE project_id = ? ORDER BY start_ms",
    )
    .all(projectId) as WordRow[]
  db.close()

  const words: Word[] = rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    text: r.text,
    startMs: r.start_ms,
    endMs: r.end_ms,
    confidence: r.confidence,
    speakerLabel: r.speaker_label,
  }))
  const sentences: Sentence[] = buildSentences(words)
  const context = renderVideoContext(report.analysis, {
    profileId: report.analysis.profile,
    override: report.provenance.contentTypeOverridden
      ? (report.provenance.contentType as never)
      : null,
  })
  const questions = report.trace.judgeQuestions
  const client = createAiClient()

  const { refineClipBoundaries } = await import("@video-editor/transcript")

  const judged = report.trace.candidates
    .filter(
      (c) => ["kept", "judge-rejected", "over-budget"].includes(c.outcome) && c.startMs !== null,
    )
    .slice(0, limit)

  console.log(
    `[judge-noise] ${judged.length} candidates × ${repeats} repeats = ${judged.length * repeats} calls`,
  )

  const results = await mapPool(judged, 3, async (c, i) => {
    const boundary = refineClipBoundaries(words, sentences, c.startSentence, c.endSentence)
    if (!boundary) return { c, scores: [] as number[], fails: [] as string[] }
    const runs: { score: number; fails: string[] }[] = []
    for (let r = 0; r < repeats; r++) {
      try {
        const j = await judgeClip({ client, questions, context, words, sentences, boundary })
        runs.push({ score: j.score, fails: failedHardQuestions(j.answers, questions) })
      } catch (err) {
        runs.push({ score: -1, fails: [`CALL_FAILED: ${(err as Error).message}`] })
      }
    }
    process.stderr.write(`\r[judge-noise] ${i + 1}/${judged.length}   `)
    const scores = runs.map((r) => r.score)
    const fails = runs.map((r) => (r.fails.length ? r.fails.join("+") : "pass"))
    return { c, scores, fails }
  })

  console.log("\n\n=== per-candidate judge noise (score across repeats) ===")
  let flips = 0
  let sumRange = 0
  let counted = 0
  for (const { c, scores, fails } of results) {
    if (scores.length === 0) continue
    const valid = scores.filter((s) => s >= 0)
    const range = valid.length ? Math.max(...valid) - Math.min(...valid) : 0
    const verdicts = fails.map((f) => (f === "pass" ? "KEPT" : "REJ"))
    const flipped = verdicts.some((v) => v !== verdicts[0])
    if (flipped) flips++
    sumRange += range
    counted++
    const orig = c.judge?.score != null ? c.judge.score.toFixed(2) : " -- "
    console.log(
      `  ${c.startTimecode}-${c.endTimecode}  orig=${orig} ${c.outcome.padEnd(14)} ` +
        `repeatScores=[${valid.map((s) => s.toFixed(2)).join(", ")}] range=${range.toFixed(2)} ` +
        `${flipped ? "FLIP" : ""} verdicts=[${verdicts.join(",")}] fails=[${fails.join("|")}]`,
    )
  }
  console.log(
    `\n[judge-noise] mean score range ${(sumRange / counted).toFixed(3)} across ${counted} clips; ` +
      `${flips} clip(s) flipped kept↔rejected on the SAME input (${((flips / counted) * 100).toFixed(0)}%)`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
