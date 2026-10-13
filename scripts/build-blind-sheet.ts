#!/usr/bin/env node
// Build a fresh, uncontaminated BLIND LABELING SHEET from a pooled generation union.
//
// Why this exists: the earlier e35 sheet was built from one stored run and its scores were printed in
// chat, so it is contaminated. This rebuilds the pool the union experiment produced — 6 frozen
// generation passes, all candidates pooled, clustered by moment IoU — judges each cluster's medoid
// ONCE (single sample, vote off) so the sheet can be stratified across the score range, then writes
// a sheet with score, support and title HIDDEN.
//
// It also dumps the scored pool as JSON (for the later recall/AUC/support analysis) to a path you
// choose — keep that OUT of the repo so the labeler never sees it.
//
// Usage:
//   GROQ_API_KEY=... node --experimental-strip-types scripts/build-blind-sheet.ts \
//     <projectId> <reportJson> <outSheet.md> <outPool.json> [passes=6] [sample=25]

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { z as zod } from "zod"
import { buildSentences, refineClipBoundaries } from "@video-editor/transcript"
import type { RefinedBoundary } from "@video-editor/transcript"
import {
  createAiClient,
  buildChunkPrompts,
  renderVideoContext,
  judgeClip,
  failedHardQuestions,
  CLIP_PROFILES,
  CandidateSchema,
  type JudgeQuestion,
} from "@video-editor/ai"
import type { ClipProfileId, VideoAnalysis, Word, Sentence } from "@video-editor/types"
import { measureArousal, resolveFfmpegBinary } from "@video-editor/ffmpeg"

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
const UNION_IOU = 0.5
const repoRoot = () => resolve(fileURLToPath(new URL("..", import.meta.url)))

const iou = (a: RefinedBoundary, b: RefinedBoundary): number => {
  const inter = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)
  return inter <= 0 ? 0 : inter / (Math.max(a.endMs, b.endMs) - Math.min(a.startMs, b.startMs))
}

interface Cand {
  pass: number
  boundary: RefinedBoundary
}
interface Cluster {
  representative: RefinedBoundary
  support: number
  text: string
  score: number
  rejected: boolean
}

function cluster(cands: Cand[]): { rep: RefinedBoundary; support: number }[] {
  const parent = cands.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  for (let i = 0; i < cands.length; i++)
    for (let j = i + 1; j < cands.length; j++)
      if (iou(cands[i]!.boundary, cands[j]!.boundary) > UNION_IOU) parent[find(i)] = find(j)
  const byRoot = new Map<number, number[]>()
  cands.forEach((_, i) => {
    const r = find(i)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r)!.push(i)
  })
  return [...byRoot.values()].map((idxs) => {
    const members = idxs.map((i) => cands[i]!)
    let rep = members[0]!
    let bestMean = -1
    for (const m of members) {
      const mean = members.reduce((a, o) => a + iou(m.boundary, o.boundary), 0) / members.length
      if (mean > bestMean || (mean === bestMean && m.boundary.startMs < rep.boundary.startMs)) {
        bestMean = mean
        rep = m
      }
    }
    return { rep: rep.boundary, support: new Set(members.map((m) => m.pass)).size }
  })
}

const tc = (ms: number): string =>
  `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`

async function main(): Promise<void> {
  const [projectId, reportJson, outSheet, outPool, passesArg, sampleArg] = process.argv.slice(2)
  if (!projectId || !reportJson || !outSheet || !outPool) {
    console.error(
      "Usage: build-blind-sheet.ts <projectId> <reportJson> <outSheet.md> <outPool.json> [passes=6] [sample=25]",
    )
    process.exit(1)
  }
  const passes = Number(passesArg ?? 6)
  const sampleN = Number(sampleArg ?? 25)

  const report = JSON.parse(
    readFileSync(join(PROJECTS_DIR, projectId, "selection-reports", reportJson), "utf-8"),
  ) as {
    header: { projectName: string }
    provenance: { contentType: string; contentTypeOverridden: boolean }
    analysis: VideoAnalysis
    trace: {
      chunks: { firstSentence: number; lastSentence: number; bisected?: boolean }[]
      judgeQuestions: JudgeQuestion[]
    }
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
  const questions = report.trace.judgeQuestions
  const arousalPerSec = await measureArousal(
    resolveFfmpegBinary(join(repoRoot(), "resources")),
    join(PROJECTS_DIR, projectId, "audio.wav"),
  )
  const chunks: Sentence[][] = report.trace.chunks
    .filter((c) => !c.bisected)
    .map((c) => sentences.filter((s) => s.index >= c.firstSentence && s.index <= c.lastSentence))

  const client = createAiClient()
  const schema = zod.object({ clips: zod.array(CandidateSchema) })
  const genChunk = async (chunk: Sentence[]) => {
    let lastErr: unknown
    for (let a = 0; a < 3; a++) {
      try {
        const { prompt, system } = buildChunkPrompts({
          chunk,
          words,
          profile,
          contextBlock,
          arousalPerSec,
        })
        return await client.generateObject({ prompt, schema, system })
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 500 * (a + 1)))
      }
    }
    throw lastErr
  }

  const all: Cand[] = []
  for (let p = 0; p < passes; p++) {
    let n = 0
    for (const chunk of chunks) {
      let result: { clips: { startSentence: number; endSentence: number }[] }
      try {
        result = await genChunk(chunk)
      } catch (err) {
        console.warn(`[blind-sheet] pass ${p + 1} chunk #${chunk[0]!.index} failed, skipped:`, err)
        continue
      }
      const first = chunk[0]!.index
      const last = chunk[chunk.length - 1]!.index
      for (const c of result.clips.filter(
        (c) => c.startSentence >= first && c.endSentence <= last,
      )) {
        const b = refineClipBoundaries(words, sentences, c.startSentence, c.endSentence)
        if (b) {
          all.push({ pass: p, boundary: b })
          n++
        }
      }
    }
    console.log(`[blind-sheet] pass ${p + 1}/${passes}: ${n} candidate(s)`)
  }

  const clusters = cluster(all)
  const scored: Cluster[] = []
  for (const cl of clusters) {
    const text = words
      .filter((w) => w.startMs >= cl.rep.startMs && w.endMs <= cl.rep.endMs)
      .map((w) => w.text)
      .join(" ")
    let score = 0
    let rejected = true
    try {
      const j = await judgeClip({
        client,
        questions,
        context: contextBlock,
        words,
        sentences,
        boundary: cl.rep,
      })
      score = j.score
      rejected = failedHardQuestions(j.answers, questions).length > 0
    } catch (err) {
      console.warn("[blind-sheet] judge failed on a cluster:", err)
    }
    scored.push({ representative: cl.rep, support: cl.support, text, score, rejected })
  }
  console.log(
    `[blind-sheet] ${all.length} candidates → ${clusters.length} moments; ${scored.filter((c) => !c.rejected).length} survive hard gates`,
  )

  // Stratify across the score range: bucket by score, round-robin so low- and high-scoring moments
  // both reach the sheet.
  const bands = 5
  const buckets: Cluster[][] = Array.from({ length: bands }, () => [])
  for (const c of scored) {
    const b = Math.min(bands - 1, Math.floor(c.score * bands))
    buckets[b]!.push(c)
  }
  const pick: Cluster[] = []
  let more = true
  while (more && pick.length < sampleN) {
    more = false
    for (const bucket of buckets) {
      if (bucket.length && pick.length < sampleN) {
        pick.push(bucket.shift()!)
        more = true
      }
    }
  }
  pick.sort((a, b) => a.representative.startMs - b.representative.startMs)

  let sheet = `# BLIND LABELING SHEET — ${report.header.projectName} (pooled union, v2)\n`
  sheet +=
    "# Label each: post / maybe / no. If no, note why: boundary, missing context, or weak content.\n"
  sheet += "# Score, support and title are HIDDEN. Label before opening the app or the reports.\n"
  pick.forEach((c, i) => {
    const dur = ((c.representative.endMs - c.representative.startMs) / 1000).toFixed(1)
    sheet += `\n[${i + 1}] ${tc(c.representative.startMs)}-${tc(c.representative.endMs)} (${dur}s)\n${c.text}\n`
  })
  writeFileSync(outSheet, sheet)
  writeFileSync(
    outPool,
    `${JSON.stringify(
      scored.map((c) => ({
        startMs: c.representative.startMs,
        endMs: c.representative.endMs,
        support: c.support,
        score: c.score,
        rejected: c.rejected,
        text: c.text,
      })),
      null,
      2,
    )}\n`,
  )
  console.log(
    `[blind-sheet] wrote ${pick.length} clips to ${outSheet}; scored pool (${scored.length}) to ${outPool}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
