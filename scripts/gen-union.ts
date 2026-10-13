#!/usr/bin/env node
// GENERATION-UNION EXPERIMENT (diagnostic — changes nothing in the pipeline).
//
// Tests whether running generation several times and UNIONING the candidates stabilizes the kept
// set. Frozen analysis/genre/chunking (from a stored report), same prompt, vote OFF.
//
// Design:
//   - 6 generation passes over the frozen chunks.
//   - pool A = union of passes 1-3, pool B = union of passes 4-6.
//   - each pool is clustered by moment IoU (> 0.5); the representative is the MEDOID (highest mean
//     IoU to the other members), deterministic.
//   - each cluster carries a SUPPORT count = how many of the 3 passes proposed a member.
//   - judge every cluster representative ONCE (single sample), same questions/context as the run.
//   - rank each pool (hard-gate rejects dropped, score desc), take the top 10, and compare the two
//     top-10s at moment level (IoU > 0.5). Single-run baseline was ~4 of 8 shared.
//
// Usage:
//   GROQ_API_KEY=... node --experimental-strip-types scripts/gen-union.ts <projectId> <reportJson> [passes=6]

import { readFileSync } from "node:fs"
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
const TOP_N = 10
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
  members: Cand[]
  representative: RefinedBoundary
  support: number
  score: number
  rejected: boolean
}

/** Union-find cluster of candidates whose pairwise IoU exceeds `thr`. */
function clusterCandidates(cands: Cand[]): Cluster[] {
  const parent = cands.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
  const union = (i: number, j: number): void => {
    parent[find(i)] = find(j)
  }
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      if (iou(cands[i]!.boundary, cands[j]!.boundary) > UNION_IOU) union(i, j)
    }
  }
  const byRoot = new Map<number, number[]>()
  cands.forEach((_, i) => {
    const r = find(i)
    if (!byRoot.has(r)) byRoot.set(r, [])
    byRoot.get(r)!.push(i)
  })
  return [...byRoot.values()].map((idxs) => {
    const members = idxs.map((i) => cands[i]!)
    // Medoid: highest mean IoU to the other members; ties broken by earliest start.
    let rep = members[0]!
    let bestMean = -1
    for (const m of members) {
      const mean = members.reduce((a, o) => a + iou(m.boundary, o.boundary), 0) / members.length
      if (mean > bestMean || (mean === bestMean && m.boundary.startMs < rep.boundary.startMs)) {
        bestMean = mean
        rep = m
      }
    }
    return {
      members,
      representative: rep.boundary,
      support: new Set(members.map((m) => m.pass)).size,
      score: 0,
      rejected: false,
    }
  })
}

async function main(): Promise<void> {
  const [projectId, reportJson, passesArg] = process.argv.slice(2)
  if (!projectId || !reportJson) {
    console.error("Usage: gen-union.ts <projectId> <reportJson> [passes=6]")
    process.exit(1)
  }
  const passes = Number(passesArg ?? 6)
  const report = JSON.parse(
    readFileSync(join(PROJECTS_DIR, projectId, "selection-reports", reportJson), "utf-8"),
  ) as {
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

  // The pipeline's chunk loop retries and bisects; this harness keeps it simple but must not die on
  // a transient empty output, or one blip discards a whole pass. Retry a few times, then skip.
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

  // 6 passes, each a full generation over the frozen chunks. Vote off throughout.
  const byPool: Cand[][] = [[], []]
  for (let p = 0; p < passes; p++) {
    const pool = byPool[Math.floor(p / (passes / 2))]!
    const tag = Math.floor(p / (passes / 2)) === 0 ? "A" : "B"
    let n = 0
    for (const chunk of chunks) {
      let result: { clips: { startSentence: number; endSentence: number }[] }
      try {
        result = await genChunk(chunk)
      } catch (err) {
        console.warn(`[gen-union] pass ${p + 1} chunk #${chunk[0]!.index} failed, skipped:`, err)
        continue
      }
      const first = chunk[0]!.index
      const last = chunk[chunk.length - 1]!.index
      for (const c of result.clips.filter(
        (c) => c.startSentence >= first && c.endSentence <= last,
      )) {
        const b = refineClipBoundaries(words, sentences, c.startSentence, c.endSentence)
        if (b) {
          pool.push({ pass: p, boundary: b })
          n++
        }
      }
    }
    console.log(`[gen-union] pass ${p + 1}/6 (pool ${tag}): ${n} candidate(s)`)
  }

  let judgeCalls = 0
  const runPool = async (name: string, pool: Cand[]): Promise<Cluster[]> => {
    const clusters = clusterCandidates(pool)
    for (const cl of clusters) {
      try {
        const j = await judgeClip({
          client,
          questions,
          context: contextBlock,
          words,
          sentences,
          boundary: cl.representative,
        })
        judgeCalls++
        cl.score = j.score
        cl.rejected = failedHardQuestions(j.answers, questions).length > 0
      } catch (err) {
        cl.rejected = true
        console.warn(`[gen-union] judge failed on ${name} cluster:`, err)
      }
    }
    const support = [0, 0, 0, 0]
    for (const cl of clusters) support[cl.support]!++
    console.log(
      `\n[gen-union] pool ${name}: ${pool.length} candidates → ${clusters.length} moments ` +
        `(support 1/2/3 = ${support[1]}/${support[2]}/${support[3]}), ${clusters.filter((c) => !c.rejected).length} survive hard gates`,
    )
    return clusters
      .filter((c) => !c.rejected)
      .sort((a, b) => b.score - a.score || a.representative.startMs - b.representative.startMs)
  }

  const A = await runPool("A", byPool[0]!)
  const B = await runPool("B", byPool[1]!)

  const topA = A.slice(0, TOP_N)
  const topB = B.slice(0, TOP_N)
  const usedB = new Set<number>()
  let shared = 0
  for (const a of topA) {
    let bi = -1,
      best = UNION_IOU
    topB.forEach((b, i) => {
      if (usedB.has(i)) return
      const v = iou(a.representative, b.representative)
      if (v > best) {
        best = v
        bi = i
      }
    })
    if (bi >= 0) {
      usedB.add(bi)
      shared++
    }
  }

  console.log("\n=== top-10 (pool A) vs top-10 (pool B), moment IoU > 0.5 ===")
  console.log(`  A kept ${A.length}, B kept ${B.length}; top-10 shared ${shared} of 10`)
  console.log(`  judge calls: ${judgeCalls} (single-sample)`)
  // Support vs score, before any use of support in ranking.
  const both = [...A, ...B]
  for (const s of [1, 2, 3]) {
    const grp = both.filter((c) => c.support === s)
    const mean = grp.length ? grp.reduce((a, c) => a + c.score, 0) / grp.length : 0
    console.log(`  support ${s}: n=${grp.length}, mean judge score ${mean.toFixed(2)}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
