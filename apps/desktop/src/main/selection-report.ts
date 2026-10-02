// Writes the per-run clip-selection debug report (#97).
//
// Two files land in `<projectDir>/selection-reports/`: the raw trace as JSON (for diffing two
// runs mechanically) and a Markdown rendering of the same data (for reading one by eye). Both are
// written from the same `ClipSelectionTrace`, so they cannot disagree — a divergence here would
// mean someone hand-edited one format's fields and not the other's.
//
// This lives in the desktop app rather than `packages/ai` because `packages/ai` deliberately
// knows nothing about files: `selectClips` returns trace data, the caller decides to persist it.

import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ClipSelectionProvenance, ClipSelectionTrace, TraceEntry } from "@video-editor/ai"
import { CLIP_PROFILES, renderVideoContext } from "@video-editor/ai"
import type { VideoAnalysis } from "@video-editor/types"

export const SELECTION_REPORTS_DIR = "selection-reports"

/** Header context the package cannot know: the video itself and this app's run metadata. */
export interface SelectionReportHeader {
  projectId: string
  projectName: string
  /** Media duration in ms. Distinguishes "the model found nothing" from "there was nothing there". */
  durationMs: number
  /** ms at which the run started — the report filename is derived from this too. */
  startedAtMs: number
}

export interface SelectionReport {
  header: SelectionReportHeader
  provenance: ClipSelectionProvenance
  /** What the classifier made of the video before selection (#98). */
  analysis: VideoAnalysis
  trace: ClipSelectionTrace
  /** mm:ss start→end for each kept clip, in final rank order. The report's headline answer. */
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

/**
 * Filenames sort chronologically because they lead with a zero-padded, lexicographically
 * ordered timestamp. A `Date#toISOString` string cannot be used verbatim — it contains colons,
 * which are illegal in filenames on Windows, and the app ships a Windows build.
 */
export function reportFileStamp(startedAtMs: number): string {
  const d = new Date(startedAtMs)
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0")
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `${pad(d.getUTCMilliseconds(), 3)}Z`
  )
}

export function reportsDirFor(projectDir: string): string {
  return join(projectDir, SELECTION_REPORTS_DIR)
}

export async function writeSelectionReport(
  projectDir: string,
  report: SelectionReport,
): Promise<{ reportJsonPath: string; reportMarkdownPath: string }> {
  const dir = reportsDirFor(projectDir)
  await mkdir(dir, { recursive: true })

  const stamp = reportFileStamp(report.header.startedAtMs)
  const reportJsonPath = join(dir, `${stamp}.json`)
  const reportMarkdownPath = join(dir, `${stamp}.md`)

  // The JSON carries the header/provenance/trace verbatim. The `clipCount` and outcome tally are
  // derived here rather than in the package because they are properties of this report, not of
  // selection — and a reader scanning the file should not have to run the trace to get them.
  const json = {
    ...report,
    summary: summarise(report),
  }
  await writeFile(reportJsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf-8")
  await writeFile(reportMarkdownPath, renderMarkdown(report), "utf-8")

  return { reportJsonPath, reportMarkdownPath }
}

/**
 * Most recent report for a project, or null.
 *
 * Sorted by filename rather than by mtime: filename order is the run's own start time, so it
 * survives a file copy or a sync that scrambles mtimes. The `.md` is preferred over the `.json`
 * because it is what a human opens.
 */
export async function findLastReport(projectDir: string): Promise<string | null> {
  let entries: string[]
  try {
    entries = await readdir(reportsDirFor(projectDir))
  } catch {
    // No reports dir at all — the project has never been re-run through #97's path.
    return null
  }
  const latest = entries
    .filter((f) => f.endsWith(".md"))
    .sort()
    .at(-1)
  if (!latest) return null
  return join(reportsDirFor(projectDir), latest)
}

function summarise(report: SelectionReport): {
  clipCount: number
  candidateCount: number
  outcomes: Record<string, number>
  chunkCount: number
  failedChunkCount: number
} {
  const outcomes: Record<string, number> = {}
  for (const c of report.trace.candidates) {
    outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1
  }
  return {
    clipCount: report.finalRanked.length,
    candidateCount: report.trace.candidates.length,
    outcomes,
    chunkCount: report.trace.chunks.length,
    failedChunkCount: report.trace.chunks.filter((c) => c.failed).length,
  }
}

/** mm:ss, or a dash when there is no boundary — an invalid range has no place on a clock. */
function tc(value: string | null): string {
  return value ?? "—"
}

function fence(text: string | null): string {
  // Transcript text is plain speech, but a model-authored title or reason could contain a
  // backtick run that would break out of the inline code span. Fenced blocks can't be escaped
  // into by content, so the text goes in one verbatim.
  return ["```text", text ?? "", "```"].join("\n")
}

/** Escapes the pipe-heavy characters a title or reason can contain in a Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

/**
 * Speaker list for the report's analysis table. Distinct and non-empty, or a dash — the model is
 * told to return an empty role when it cannot tell who is speaking, so a list of blanks is a real
 * shape and "Speaker 1, Speaker 2" would be a worse rendering of it than an honest dash.
 */
function renderSpeakerList(analysis: VideoAnalysis): string {
  const roles = [...new Set(analysis.speakers.map((s) => s.role.trim()))].filter(
    (r) => r.length > 0,
  )
  return roles.length > 0 ? cell(roles.join(", ")) : "—"
}

const OUTCOME_LABEL: Record<TraceEntry["outcome"], string> = {
  kept: "kept",
  "gate-rejected": "gate-rejected",
  "invalid-range": "invalid range",
  duplicate: "duplicate",
  "judge-rejected": "judge-rejected",
  "judge-failed": "judge call failed",
  "over-budget": "over budget",
}

const GRADE_MARK = { yes: "✓", partly: "~", no: "✗" } as const

/** Compact judge verdict: score, then one mark per question in the run's own order. */
function judgeLines(c: TraceEntry, questions: ClipSelectionTrace["judgeQuestions"]): string[] {
  const out: string[] = []
  if (c.judge) {
    const marks = questions
      .map((q) => `${q.id} ${GRADE_MARK[c.judge!.answers[q.id] ?? "no"]}`)
      .join(" · ")
    out.push(`- judge: score ${c.judge.score.toFixed(2)} — ${marks}`)
    if (c.judge.note) out.push(`- judge note: ${cell(c.judge.note)}`)
  }
  if (c.judgeReasons.length > 0) out.push(`- judge verdict: ${c.judgeReasons.join("; ")}`)
  return out
}

function renderJudgeQuestions(trace: ClipSelectionTrace): string[] {
  const lines = ["## Judge questions", "", "| id | weight | hard | question |", "|---|---|---|---|"]
  for (const q of trace.judgeQuestions) {
    lines.push(`| ${q.id} | ${q.weight} | ${q.hard ? "yes" : ""} | ${cell(q.text)} |`)
  }
  lines.push(
    "",
    "Grades: ✓ yes = 1, ~ partly = 0.5, ✗ no = 0. A ✗ on a hard question rejects the clip.",
    "",
  )
  return lines
}

function renderMarkdown(report: SelectionReport): string {
  const { header, provenance, analysis, trace } = report
  const s = summarise(report)
  const kept = trace.candidates.filter((c) => c.outcome === "kept")
  const dropped = trace.candidates.filter((c) => c.outcome !== "kept")
  const lines: string[] = []

  lines.push(`# Clip selection report — ${header.projectName}`)
  lines.push("")
  lines.push(`Run started ${new Date(header.startedAtMs).toISOString()}`)
  lines.push("")

  lines.push("## Video analysis")
  lines.push("")
  lines.push(
    `What the classifier decided about this video before any clip was chosen. The profile selects ` +
      `the rubric; the context block is prepended to every selection prompt.`,
  )
  lines.push("")
  lines.push("| field | value |")
  lines.push("| --- | --- |")
  lines.push(`| profile used | ${CLIP_PROFILES[provenance.contentType].label} |`)
  lines.push(`| profile detected | ${CLIP_PROFILES[analysis.profile].label} |`)
  if (provenance.contentTypeOverridden) {
    // Stated rather than left to arithmetic: the detected and used profiles differ, and the reader
    // needs to know whether that was the model or the user.
    lines.push(`| profile source | **user override** — the classifier's choice was not used |`)
  }
  lines.push(
    `| confidence | ${analysis.fallback ? "n/a (analysis unavailable)" : analysis.confidence} |`,
  )
  if (analysis.secondaryProfile) {
    lines.push(
      `| secondary profile | ${CLIP_PROFILES[analysis.secondaryProfile].label} (recorded, not used) |`,
    )
  }
  lines.push(`| speakers | ${renderSpeakerList(analysis)} |`)
  lines.push(`| main topics | ${cell(analysis.mainTopics.join("; ")) || "—"} |`)
  lines.push(`| summary | ${cell(analysis.summary) || "—"} |`)
  lines.push("")
  lines.push("VIDEO CONTEXT block, as sent:")
  lines.push("")
  lines.push(
    fence(
      renderVideoContext(analysis, {
        profileId: analysis.profile,
        override: provenance.contentTypeOverridden ? provenance.contentType : null,
      }),
    ),
  )
  lines.push("")
  lines.push("RUBRIC appended to the system prompt, as sent:")
  lines.push("")
  lines.push(fence(CLIP_PROFILES[provenance.contentType].rubric))
  lines.push("")

  lines.push("## Run")
  lines.push("")
  lines.push("| field | value |")
  lines.push("| --- | --- |")
  lines.push(`| pipeline version | \`${provenance.pipelineVersion}\` |`)
  lines.push(`| pipeline hash | \`${provenance.pipelineHash}\` |`)
  lines.push(`| model | \`${provenance.model}\` |`)
  lines.push(`| temperature | ${trace.temperature} |`)
  lines.push(`| clip profile | \`${provenance.contentType}\` |`)
  lines.push(`| video duration | ${formatDuration(header.durationMs)} |`)
  lines.push(`| sentences | ${trace.sentenceCount} |`)
  lines.push(
    `| chunks | ${s.chunkCount}${
      s.failedChunkCount > 0 ? ` (**${s.failedChunkCount} failed**) ` : ""
    }|`,
  )
  lines.push(
    `| candidates returned | ${s.candidateCount} (${Object.entries(s.outcomes)
      .map(([k, v]) => `${v} ${OUTCOME_LABEL[k as TraceEntry["outcome"]] ?? k}`)
      .join(", ")}) |`,
  )
  lines.push(`| clips kept | ${s.clipCount} |`)
  lines.push("")

  lines.push("## Chunks")
  lines.push("")
  if (trace.chunks.length === 0) {
    lines.push("_No chunks — the transcript had no sentences._")
  } else {
    lines.push("| # | sentences | candidates | result |")
    lines.push("| --- | --- | --- | --- |")
    for (const c of trace.chunks) {
      // "0 candidates" and "the call failed" are different answers to why a chunk contributed
      // nothing, and this report is the only place either is visible.
      lines.push(
        `| ${c.index} | #${c.firstSentence}–#${c.lastSentence} | ${c.candidateCount} | ${
          c.failed ? `**failed**${c.error ? `: ${c.error}` : ""}` : "answered"
        } |`,
      )
    }
  }
  lines.push("")

  lines.push("## Final ranked clips")
  lines.push("")
  if (report.finalRanked.length === 0) {
    lines.push("_No clips survived selection. The candidate table below says why._")
  } else {
    lines.push("| # | title | timecode | length | platform |")
    lines.push("| --- | --- | --- | --- | --- |")
    for (const clip of report.finalRanked) {
      lines.push(
        `| ${clip.rank} | ${cell(clip.title)} | ${clip.startTimecode}–${clip.endTimecode} | ${formatDuration(clip.durationMs)} | ${clip.platform} |`,
      )
    }
    lines.push("")
    for (const clip of report.finalRanked) {
      lines.push(`### ${clip.rank}. ${clip.title}`)
      lines.push("")
      lines.push(`_${clip.reason}_`)
      lines.push("")
      lines.push(fence(clip.text))
      lines.push("")
    }
  }

  if (trace.judgeQuestions.length > 0) lines.push(...renderJudgeQuestions(trace))

  if (dropped.length > 0) {
    lines.push("## Dropped candidates")
    lines.push("")
    for (const c of dropped) {
      lines.push(`### ${OUTCOME_LABEL[c.outcome]} — ${cell(c.title)}`)
      lines.push("")
      lines.push(`- chunk: ${c.chunk}`)
      lines.push(`- model range: #${c.startSentence}–#${c.endSentence}`)
      lines.push(`- reason: ${cell(c.reason)}`)
      if (c.startMs !== null && c.endMs !== null) {
        lines.push(`- refined: ${tc(c.startTimecode)}–${tc(c.endTimecode)}`)
      } else {
        lines.push("- refined: — (no boundary produced)")
      }
      if (c.boundary) {
        lines.push(
          `- boundary flags: danglingUnresolved=${c.boundary.danglingUnresolved}, ` +
            `endedOnCompleteThought=${c.boundary.endedOnCompleteThought}, tooShort=${c.boundary.tooShort}`,
        )
      }
      if (c.gate.reasons.length > 0) {
        lines.push(`- gate: ${c.gate.reasons.join("; ")}`)
      }
      if (c.gate.warnings.length > 0) {
        lines.push(`- warnings: ${c.gate.warnings.join("; ")}`)
      }
      lines.push(...judgeLines(c, trace.judgeQuestions))
      if (c.duplicateOf) {
        lines.push(`- duplicate of: ${cell(c.duplicateOf)}`)
      }
      lines.push("")
    }
  }

  if (kept.length > 0) {
    lines.push("## Kept candidates (full detail)")
    lines.push("")
    for (const c of kept) {
      lines.push(`### ${c.finalRank}. ${cell(c.title)}`)
      lines.push("")
      lines.push(`- chunk: ${c.chunk}`)
      lines.push(`- model range: #${c.startSentence}–#${c.endSentence}`)
      lines.push(`- refined: ${tc(c.startTimecode)}–${tc(c.endTimecode)}`)
      lines.push(...judgeLines(c, trace.judgeQuestions))
      if (c.boundary) {
        lines.push(
          `- boundary flags: danglingUnresolved=${c.boundary.danglingUnresolved}, ` +
            `endedOnCompleteThought=${c.boundary.endedOnCompleteThought}, tooShort=${c.boundary.tooShort}`,
        )
      }
      if (c.gate.warnings.length > 0) {
        lines.push(`- warnings: ${c.gate.warnings.join("; ")}`)
      }
      lines.push("")
      lines.push(fence(c.text))
      lines.push("")
    }
  }

  return `${lines.join("\n")}\n`
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`
}
