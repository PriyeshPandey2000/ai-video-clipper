// Mechanical metrics over every clip-selection report on disk — the light version of the eval
// harness (#101 first, #46 later).
//
// `selection-report.ts` already writes one JSON per run. This reads all of them and prints the
// numbers a person cannot scan by eye across runs: the candidate funnel, whether genre detection
// fell back, failed chunks, judge-score spread, clip durations, and how often the opening step moved
// a clip. None of it is a judgement of clip quality — the reference moments are. This is the layer
// that answers "is the app even working?" before any quality question is worth asking.
//
// Three views:
//   (default)   one row per run, across every project
//   --detail    one block per run plus the candidate table, for reading a single run closely
//   --blind     only rank, timecode, duration and transcript text — for labelling post/maybe/no
//               WITHOUT seeing the judge's score, note, or the model's title/reason. The label has
//               to measure the clip, not your agreement with the judge.
//
// Usage:
//   node --experimental-strip-types scripts/report-table.ts [--dir <projectsDir>] [--detail|--blind] [filter]
//   pnpm report-table [--detail] [filter]
//
// `filter` is a substring of a project id or name; reports are newest-first and every run is shown
// unless a filter is given. Requires Node ≥22.6 for --experimental-strip-types, like the sibling
// recall-ablation script.

import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The slice of `SelectionReport` this reads. Stated structurally rather than imported from the
 * desktop app so the script type-checks standalone and does not drag an Electron package into
 * `scripts/tsconfig.json` to render a table.
 */
interface ReportFile {
  header: {
    projectId: string
    projectName: string
    durationMs: number
    startedAtMs: number
  }
  provenance: {
    pipelineVersion: string
    pipelineHash: string
    model: string
    temperature?: number
  }
  analysis: {
    profile: string
    confidence: string
    fallback: boolean
  }
  trace: {
    temperature?: number
    chunks: { index: number; failed: boolean; candidateCount: number; candidatesDropped?: number }[]
    candidates: {
      outcome: string
      judge: { score: number } | null
      judgeReasons: string[]
      opening: { suggestedSentence: number | null; adopted: boolean } | null | undefined
      finalRank: number | null
    }[]
  }
  finalRanked: {
    rank: number
    title: string
    reason: string
    platform: string
    startTimecode: string
    endTimecode: string
    durationMs: number
    text: string | null
  }[]
}

/** Pipeline order, so the funnel reads the way candidates actually flow. */
const OUTCOME_ORDER = [
  "kept",
  "gate-rejected",
  "invalid-range",
  "duplicate",
  "judge-rejected",
  "judge-failed",
  "over-budget",
] as const

const DEFAULT_PROJECTS_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "@video-editor",
  "desktop",
  "projects",
)

interface Summary {
  path: string
  projectId: string
  projectName: string
  startedAtMs: number
  profile: string
  confidence: string
  fallback: boolean
  chunkCount: number
  failedChunkCount: number
  candidatesDropped: number
  candidateCount: number
  outcomes: Record<string, number>
  keptCount: number
  judged: number
  judgeMean: number | null
  judgeMin: number | null
  judgeMax: number | null
  meanDurationS: number | null
  minDurationS: number | null
  maxDurationS: number | null
  openingProposed: number
  openingAdopted: number
  pipelineVersion: string
  pipelineHash: string
  model: string
  temperature: number | null
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function summarise(report: ReportFile, path: string): Summary {
  const outcomes: Record<string, number> = {}
  for (const c of report.trace.candidates) outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1

  const scores = report.trace.candidates
    .map((c) => c.judge?.score)
    .filter((s): s is number => typeof s === "number")
  const durationsS = report.finalRanked.map((c) => c.durationMs / 1000)

  // `opening` is present for every clip that reached the opening step, so this counts proposals and
  // adoptions over that population rather than over all candidates. Reports written before #100
  // have no such field at all, hence the nullish filter rather than a `!== null` one.
  const openings = report.trace.candidates
    .map((c) => c.opening)
    .filter((o): o is NonNullable<typeof o> => o != null)

  const judgeMean = mean(scores)
  return {
    path,
    projectId: report.header.projectId,
    projectName: report.header.projectName,
    startedAtMs: report.header.startedAtMs,
    profile: report.analysis.profile,
    confidence: report.analysis.confidence,
    fallback: report.analysis.fallback,
    chunkCount: report.trace.chunks.length,
    failedChunkCount: report.trace.chunks.filter((c) => c.failed).length,
    candidatesDropped: report.trace.chunks.reduce((n, c) => n + (c.candidatesDropped ?? 0), 0),
    candidateCount: report.trace.candidates.length,
    outcomes,
    keptCount: report.finalRanked.length,
    judged: scores.length,
    judgeMean,
    judgeMin: scores.length ? Math.min(...scores) : null,
    judgeMax: scores.length ? Math.max(...scores) : null,
    meanDurationS: mean(durationsS),
    minDurationS: durationsS.length ? Math.min(...durationsS) : null,
    maxDurationS: durationsS.length ? Math.max(...durationsS) : null,
    openingProposed: openings.filter((o) => o.suggestedSentence !== null).length,
    openingAdopted: openings.filter((o) => o.adopted).length,
    pipelineVersion: report.provenance.pipelineVersion,
    pipelineHash: report.provenance.pipelineHash,
    model: report.provenance.model,
    temperature: report.trace.temperature ?? report.provenance.temperature ?? null,
  }
}

/** `YYYY-MM-DD HH:MM` in local time, for scanning a column of runs. */
function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`
}

function secs(v: number | null): string {
  return v === null ? "-" : `${v.toFixed(1)}s`
}

function score(v: number | null): string {
  return v === null ? "-" : v.toFixed(2)
}

function truncate(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, width - 1)}…`
}

function funnelText(s: Summary): string {
  const parts = OUTCOME_ORDER.filter((o) => (s.outcomes[o] ?? 0) > 0).map(
    (o) => `${o} ${s.outcomes[o]}`,
  )
  return parts.length ? parts.join(" · ") : "no candidates"
}

function printTable(summaries: Summary[]): void {
  const cols: { head: string; width: number; value: (s: Summary) => string }[] = [
    { head: "project", width: 34, value: (s) => truncate(s.projectName, 34) },
    { head: "run", width: 16, value: (s) => stamp(s.startedAtMs) },
    { head: "profile", width: 21, value: (s) => `${s.profile} (${s.confidence})` },
    { head: "genre", width: 9, value: (s) => (s.fallback ? "FALLBACK" : "detected") },
    {
      head: "chunks",
      width: 10,
      value: (s) =>
        s.failedChunkCount ? `${s.chunkCount}/!${s.failedChunkCount}` : `${s.chunkCount}`,
    },
    { head: "cand", width: 5, value: (s) => `${s.candidateCount}` },
    { head: "kept", width: 5, value: (s) => `${s.keptCount}` },
    { head: "judge", width: 6, value: (s) => score(s.judgeMean) },
    { head: "dur", width: 8, value: (s) => secs(s.meanDurationS) },
    { head: "open", width: 7, value: (s) => `${s.openingAdopted}/${s.openingProposed}` },
    { head: "hash", width: 8, value: (s) => s.pipelineHash.slice(0, 8) },
  ]

  const line = cols.map((c) => c.head.padEnd(c.width)).join("  ")
  console.log(line)
  console.log("-".repeat(line.length))
  for (const s of summaries) {
    console.log(cols.map((c) => c.value(s).padEnd(c.width)).join("  "))
    if (s.candidatesDropped > 0) {
      console.log(
        `  ⚠ ${s.candidatesDropped} candidate(s) dropped over the per-chunk cap — a recall ceiling, not a safety valve`,
      )
    }
  }
  console.log("")
  console.log(
    "genre FALLBACK and chunks !N (failed) are reliability bugs, not quality problems — fix them first.",
  )
}

function printDetail(summaries: Summary[]): void {
  for (const s of summaries) {
    console.log("─".repeat(96))
    console.log(`${s.projectName}  (${s.projectId.slice(0, 8)})`)
    console.log(
      `  run ${stamp(s.startedAtMs)} · ${s.pipelineVersion} · ${s.model} · temp ${s.temperature ?? "?"} · hash ${s.pipelineHash.slice(0, 12)}`,
    )
    console.log(
      `  profile ${s.profile} (${s.confidence})${s.fallback ? "  ⚠ FALLBACK — genre detection failed" : ""}`,
    )
    console.log(`  chunks ${s.chunkCount} (${s.failedChunkCount} failed)`)
    console.log(
      `  funnel ${s.candidateCount} candidates → ${s.keptCount} kept   [${funnelText(s)}]`,
    )
    console.log(
      `  judge  mean ${score(s.judgeMean)} (n=${s.judged}, min ${score(s.judgeMin)}, max ${score(s.judgeMax)})`,
    )
    console.log(
      `  clips  ${s.keptCount} · mean ${secs(s.meanDurationS)} (${secs(s.minDurationS)}–${secs(s.maxDurationS)})`,
    )
    console.log(`  openings ${s.openingAdopted} adopted of ${s.openingProposed} proposed`)
  }
}

/**
 * The labelling view. Deliberately omits the title, reason, judge score, judge note and the opening
 * step: every one of those is the app's opinion, and a label entered after reading them measures
 * agreement with the app rather than whether the clip is worth posting.
 */
function printBlind(summaries: Summary[], reports: Map<string, ReportFile>): void {
  for (const s of summaries) {
    const report = reports.get(s.path)
    if (!report) continue
    console.log("═".repeat(96))
    console.log(`${s.projectName} — ${stamp(s.startedAtMs)} — ${report.finalRanked.length} clips`)
    console.log("═".repeat(96))
    if (report.finalRanked.length === 0) {
      console.log("  (nothing kept — record this as a zero-clip run)")
      continue
    }
    // `finalRank` is 0-based and best-first (`finalRank = clips.length - 1` at push time), but the
    // report array is built by filtering the trace in trace order — not rank order. Sort here so
    // the labelling view is best-first regardless, and say so when the file disagreed.
    const kept = [...report.finalRanked].sort((a, b) => a.rank - b.rank)
    if (report.finalRanked.some((c, i) => c.rank !== kept[i]!.rank)) {
      console.log("  ⚠ report array is not in rank order; sorted here by the rank field (0 = best)")
    }
    kept.forEach((c, i) => {
      console.log(
        `\n  #${i + 1}  ${c.startTimecode}–${c.endTimecode}  (${(c.durationMs / 1000).toFixed(1)}s)`,
      )
      console.log(`      ${c.text ?? "(no transcript text)"}`)
    })
    console.log("")
  }
  console.log(
    "Label post / maybe / no for each clip NOW, before opening the app or --detail. That is the whole point of this view.",
  )
}

/**
 * Every `*.json` under `<projectsDir>/<id>/selection-reports/`. A project with no directory has
 * simply never been re-run through #97's path — not an error.
 */
async function discoverReports(projectsDir: string): Promise<string[]> {
  let projectEntries: string[]
  try {
    projectEntries = await readdir(projectsDir)
  } catch {
    return []
  }
  const paths: string[] = []
  for (const project of projectEntries) {
    let files: string[]
    try {
      files = await readdir(join(projectsDir, project, "selection-reports"))
    } catch {
      continue
    }
    for (const file of files) {
      if (file.endsWith(".json")) paths.push(join(projectsDir, project, "selection-reports", file))
    }
  }
  return paths
}

async function loadReport(path: string): Promise<ReportFile | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as ReportFile
    if (!parsed.header || !parsed.analysis || !parsed.trace || !parsed.finalRanked) return null
    return parsed
  } catch (err) {
    console.warn(`[report-table] skipping unreadable report ${path}:`, err)
    return null
  }
}

interface Args {
  projectsDir: string
  mode: "table" | "detail" | "blind"
  filter: string | null
}

function parseArgs(argv: string[]): Args {
  let projectsDir = process.env.CLIPPER_PROJECTS_DIR ?? DEFAULT_PROJECTS_DIR
  let mode: Args["mode"] = "table"
  let filter: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--dir") projectsDir = argv[++i] ?? projectsDir
    else if (a === "--detail") mode = "detail"
    else if (a === "--blind") mode = "blind"
    else if (a === "--help" || a === "-h") mode = "table"
    else if (a.startsWith("--")) console.warn(`[report-table] ignoring unknown flag ${a}`)
    else filter = a
  }
  return { projectsDir, mode, filter }
}

function usage(): void {
  console.log(`Usage: report-table [--dir <projectsDir>] [--detail|--blind] [filter]

  (default)   one table row per run, across every project
  --detail    one block per run, plus the funnel/judge/duration summary
  --blind     rank, timecode, duration and transcript text only, for labelling
  filter      substring of a project id or name
  --dir       projects directory (default: ${DEFAULT_PROJECTS_DIR}, or $CLIPPER_PROJECTS_DIR)`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    usage()
    return
  }

  const paths = await discoverReports(args.projectsDir)
  if (paths.length === 0) {
    console.error(`No selection reports under ${args.projectsDir}`)
    console.error(
      `Reports are written on re-run clip selection (#97); there is nothing to read yet.`,
    )
    process.exit(1)
  }

  const reports = new Map<string, ReportFile>()
  const summaries: Summary[] = []
  for (const path of paths) {
    const report = await loadReport(path)
    if (!report) continue
    reports.set(path, report)
    summaries.push(summarise(report, path))
  }

  const filtered = summaries
    .filter((s) =>
      args.filter ? s.projectId.includes(args.filter) || s.projectName.includes(args.filter) : true,
    )
    .sort((a, b) => b.startedAtMs - a.startedAtMs)

  if (filtered.length === 0) {
    console.error(`No reports match "${args.filter}" (${summaries.length} report(s) on disk).`)
    process.exit(1)
  }

  if (args.mode === "blind") printBlind(filtered, reports)
  else if (args.mode === "detail") printDetail(filtered)
  else printTable(filtered)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
