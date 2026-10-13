#!/usr/bin/env node
// GENERATION-NOISE HARNESS (diagnostic only — changes nothing in the pipeline).
//
// Experiment 2: freeze the analysis/genre/chunking and run ONLY the generation stage N times (no
// judge, no opening). Then compare the candidate MOMENTS each run proposes. If the candidate set
// still swings with the genre frozen, the variance is generation sampling; if it stabilizes, the
// genre re-roll was the cause.
//
// The chunking, profile and context block are reconstructed from a stored report, so only the model
// call varies between runs.
//
// Usage:
//   GROQ_API_KEY=... node --experimental-strip-types scripts/gen-noise.ts <projectId> <reportJson> [runs=3]

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { z as zod } from "zod"
import { buildSentences, refineClipBoundaries } from "@video-editor/transcript"
import {
  createAiClient,
  buildChunkPrompts,
  renderVideoContext,
  CLIP_PROFILES,
  CandidateSchema,
} from "@video-editor/ai"
import type { ClipProfileId, VideoAnalysis, Word, Sentence } from "@video-editor/types"
import { measureArousal, resolveFfmpegBinary } from "@video-editor/ffmpeg"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

interface SqlStatement {
  all(...p: unknown[]): unknown[]
}
interface SqliteDatabase {
  prepare(sql: string): SqlStatement
  close(): void
}
type DatabaseSyncCtor = new (path: string) => SqliteDatabase

const SUPPORT_DIR = join(homedir(), "Library", "Application Support", "@video-editor", "desktop")
const DB_PATH = join(SUPPORT_DIR, "db.sqlite")
const PROJECTS_DIR = join(SUPPORT_DIR, "projects")
const repoRoot = () => resolve(fileURLToPath(new URL("..", import.meta.url)))

const iou = (a: { s: number; e: number }, b: { s: number; e: number }) => {
  const inter = Math.min(a.e, b.e) - Math.max(a.s, b.s)
  return inter <= 0 ? 0 : inter / (Math.max(a.e, b.e) - Math.min(a.s, b.s))
}

async function main(): Promise<void> {
  const [projectId, reportJson, runsArg] = process.argv.slice(2)
  if (!projectId || !reportJson) {
    console.error("Usage: gen-noise.ts <projectId> <reportJson> [runs=3]")
    process.exit(1)
  }
  const runs = Number(runsArg ?? 3)
  const report = JSON.parse(
    readFileSync(join(PROJECTS_DIR, projectId, "selection-reports", reportJson), "utf-8"),
  ) as {
    provenance: { contentType: string; contentTypeOverridden: boolean }
    analysis: VideoAnalysis
    trace: { chunks: { firstSentence: number; lastSentence: number; bisected?: boolean }[] }
  }

  // @ts-expect-error node:sqlite newer than @types/node pinned for Electron.
  const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: DatabaseSyncCtor }
  const db = new DatabaseSync(DB_PATH)
  const rows = db
    .prepare(
      "SELECT id, project_id, text, start_ms, end_ms, confidence, speaker_label FROM words WHERE project_id = ? ORDER BY start_ms",
    )
    .all(projectId) as {
    id: string
    project_id: string
    text: string
    start_ms: number
    end_ms: number
    confidence: number
    speaker_label: string | null
  }[]
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
  const profileId = report.provenance.contentType as ClipProfileId
  const profile = CLIP_PROFILES[profileId]
  const contextBlock = renderVideoContext(report.analysis, {
    profileId: report.analysis.profile,
    override: report.provenance.contentTypeOverridden ? profileId : null,
  })
  const arousalPerSec = await measureArousal(
    resolveFfmpegBinary(join(repoRoot(), "resources")),
    join(PROJECTS_DIR, projectId, "audio.wav"),
  )

  // Frozen chunks, reconstructed from the report so chunking is held constant.
  const chunks: Sentence[][] = report.trace.chunks
    .filter((c) => !c.bisected)
    .map((c) => sentences.filter((s) => s.index >= c.firstSentence && s.index <= c.lastSentence))

  const client = createAiClient()
  const schema = zod.object({ clips: zod.array(CandidateSchema) })

  const perRun: { s: number; e: number }[][] = []
  for (let r = 0; r < runs; r++) {
    const moments: { s: number; e: number }[] = []
    for (const chunk of chunks) {
      const { prompt, system } = buildChunkPrompts({
        chunk,
        words,
        profile,
        contextBlock,
        arousalPerSec,
      })
      const result = await client.generateObject({ prompt, schema, system })
      const first = chunk[0]!.index
      const last = chunk[chunk.length - 1]!.index
      for (const c of result.clips.filter(
        (c) => c.startSentence >= first && c.endSentence <= last,
      )) {
        const b = refineClipBoundaries(words, sentences, c.startSentence, c.endSentence)
        if (b) moments.push({ s: b.startMs, e: b.endMs })
      }
    }
    perRun.push(moments)
    console.log(`[gen-noise] run ${r + 1}: ${moments.length} candidate moment(s)`)
  }

  console.log("\n=== candidate-moment overlap across runs (match = temporal IoU > 0.5) ===")
  const match = (A: { s: number; e: number }[], B: { s: number; e: number }[]) => {
    const usedB = new Set<number>()
    let shared = 0
    let diffCut = 0
    for (const a of A) {
      let bi = -1,
        best = 0.5
      B.forEach((b, i) => {
        if (usedB.has(i)) return
        const v = iou(a, b)
        if (v > best) {
          best = v
          bi = i
        }
      })
      if (bi >= 0) {
        usedB.add(bi)
        shared++
        const b = B[bi]!
        if (Math.abs(a.s - b.s) > 1000 || Math.abs(a.e - b.e) > 1000) diffCut++
      }
    }
    return { shared, diffCut, aOnly: A.length - shared, bOnly: B.length - shared }
  }
  for (let i = 0; i < perRun.length; i++) {
    for (let j = i + 1; j < perRun.length; j++) {
      const m = match(perRun[i]!, perRun[j]!)
      console.log(
        `run${i + 1}(${perRun[i]!.length}) vs run${j + 1}(${perRun[j]!.length}): shared ${m.shared}, different cut ${m.diffCut}, unique ${m.aOnly}+${m.bOnly}`,
      )
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
