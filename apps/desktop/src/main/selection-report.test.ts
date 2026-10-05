import { describe, it, expect } from "vitest"
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ClipSelectionTrace, TraceEntry } from "@video-editor/ai"
import type { VideoAnalysis } from "@video-editor/types"
import {
  findLastReport,
  readLastReportFunnel,
  reportFileStamp,
  writeSelectionReport,
} from "./selection-report"

const provenance = {
  pipelineVersion: "v1-unmeasured",
  pipelineHash: "a".repeat(64),
  model: "openai/gpt-oss-120b",
  contentType: "solo_opinion" as const,
  contentTypeOverridden: false,
}

/** A successful detection, so report tests exercise the normal path. */
function analysis(overrides: Partial<VideoAnalysis> = {}): VideoAnalysis {
  return {
    profile: "solo_opinion",
    confidence: "high",
    summary: "One person arguing a case straight to camera.",
    speakers: [{ role: "Host" }],
    mainTopics: ["creator tools"],
    fallback: false,
    ...overrides,
  }
}

function trace(overrides: Partial<ClipSelectionTrace> = {}): ClipSelectionTrace {
  return {
    temperature: 0,
    sentenceCount: 2,
    chunks: [
      {
        index: 0,
        firstSentence: 0,
        lastSentence: 41,
        candidateCount: 2,
        candidatesDropped: 0,
        failed: false,
      },
    ],
    candidates: [],
    judgeQuestions: [
      { id: "hook", text: "Would it stop the scroll?", weight: 3, hard: false },
      { id: "payoff", text: "Does it pay off?", weight: 2, hard: true },
    ],
    ...overrides,
  }
}

function entry(overrides: Partial<TraceEntry>): TraceEntry {
  return {
    chunk: 0,
    startSentence: 0,
    endSentence: 12,
    title: "Untitled clip",
    reason: "Hook",
    platform: "shorts",
    outcome: "kept",
    judge: null,
    judgeReasons: [],
    startMs: 0,
    endMs: 30000,
    startTimecode: "0:00",
    endTimecode: "0:30",
    boundary: { danglingUnresolved: false, endedOnCompleteThought: true, tooShort: false },
    gate: { passed: true, reasons: [], warnings: [] },
    duplicateOf: null,
    finalRank: 0,
    text: "Nobody expected this.",
    opening: null,
    ...overrides,
  }
}

async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "selection-report-test-"))
}

describe("reportFileStamp", () => {
  it("produces a filename-safe UTC stamp that sorts chronologically as a string", () => {
    // Colons are illegal in Windows filenames and the app ships a Windows build, so the raw
    // ISO string cannot be used. The zero-padded layout is what keeps lexical order == time order.
    const stamp = reportFileStamp(Date.UTC(2026, 0, 2, 3, 4, 5, 6))
    expect(stamp).toBe("20260102T030405006Z")
    expect(stamp).not.toContain(":")
    expect(stamp).toMatch(/^[0-9TZ]+$/)
  })

  it("orders two runs lexicographically in the order they happened", () => {
    const earlier = reportFileStamp(Date.UTC(2026, 0, 2, 3, 4, 5, 0))
    const later = reportFileStamp(Date.UTC(2026, 0, 2, 3, 4, 5, 1))
    expect(earlier < later).toBe(true)
  })
})

describe("writeSelectionReport", () => {
  it("writes both formats into selection-reports/ under the project dir", async () => {
    const dir = await tmpDir()
    const { reportJsonPath, reportMarkdownPath } = await writeSelectionReport(dir, {
      header: {
        projectId: "p1",
        projectName: "My Video",
        durationMs: 3_600_000,
        startedAtMs: Date.UTC(2026, 0, 2, 3, 4, 5, 6),
      },
      provenance,
      analysis: analysis(),
      trace: trace({ candidates: [entry({})] }),
      finalRanked: [
        {
          rank: 0,
          title: "Untitled clip",
          reason: "Hook",
          platform: "shorts",
          startTimecode: "0:00",
          endTimecode: "0:30",
          durationMs: 30000,
          text: "Nobody expected this.",
        },
      ],
    })

    expect(reportJsonPath).toBe(join(dir, "selection-reports", "20260102T030405006Z.json"))
    expect(reportMarkdownPath).toBe(join(dir, "selection-reports", "20260102T030405006Z.md"))
    expect(existsSync(reportJsonPath)).toBe(true)
    expect(existsSync(reportMarkdownPath)).toBe(true)
  })

  it("records the header fields the report's comparability depends on", async () => {
    // #97's header requirement: which config produced this run, and enough about the input that
    // two runs are comparable by eye. Without model + temperature + hash, two reports cannot be
    // lined up at all.
    const dir = await tmpDir()
    const { reportJsonPath } = await writeSelectionReport(dir, {
      header: {
        projectId: "p1",
        projectName: "My Video",
        durationMs: 3_600_000,
        startedAtMs: Date.UTC(2026, 0, 2, 3, 4, 5, 6),
      },
      provenance,
      analysis: analysis(),
      trace: trace({ candidates: [entry({})] }),
      finalRanked: [],
    })

    const json = JSON.parse(await readFile(reportJsonPath, "utf-8")) as Record<string, unknown>
    expect(json.header).toMatchObject({ projectName: "My Video", durationMs: 3_600_000 })
    expect(json.provenance).toMatchObject({
      pipelineVersion: "v1-unmeasured",
      pipelineHash: "a".repeat(64),
      model: "openai/gpt-oss-120b",
      contentType: "solo_opinion",
    })
    expect((json.trace as ClipSelectionTrace).temperature).toBe(0)
    expect((json.trace as ClipSelectionTrace).sentenceCount).toBe(2)
    expect((json.summary as { chunkCount: number }).chunkCount).toBe(1)
  })

  it("tallies outcomes so a reader does not have to count rows by hand", async () => {
    const dir = await tmpDir()
    const { reportJsonPath } = await writeSelectionReport(dir, {
      header: { projectId: "p1", projectName: "V", durationMs: 0, startedAtMs: 0 },
      provenance,
      analysis: analysis(),
      trace: trace({
        candidates: [
          entry({ finalRank: 0 }),
          entry({ outcome: "duplicate", duplicateOf: "Untitled clip", finalRank: null }),
          entry({
            outcome: "gate-rejected",
            finalRank: null,
            gate: { passed: false, reasons: ["shorter than 15000ms"], warnings: [] },
          }),
        ],
      }),
      finalRanked: [],
    })

    const json = JSON.parse(await readFile(reportJsonPath, "utf-8")) as {
      summary: { candidateCount: number; outcomes: Record<string, number> }
    }
    expect(json.summary.candidateCount).toBe(3)
    expect(json.summary.outcomes).toEqual({ kept: 1, duplicate: 1, "gate-rejected": 1 })
  })
})

describe("findLastReport", () => {
  it("returns null when the project has never been re-run", async () => {
    expect(await findLastReport(await tmpDir())).toBeNull()
  })

  it("returns null when the reports dir exists but is empty", async () => {
    const dir = await tmpDir()
    await writeSelectionReport(dir, {
      header: { projectId: "p1", projectName: "V", durationMs: 0, startedAtMs: 0 },
      provenance,
      analysis: analysis(),
      trace: trace(),
      finalRanked: [],
    })
    // Only the first report exists; a second lookup must not be confused by the dir merely existing.
    expect(await findLastReport(dir)).not.toBeNull()
  })

  it("returns the newest report, preferring the .md a human can open", async () => {
    const dir = await tmpDir()
    for (const at of [1000, 2000, 3000]) {
      await writeSelectionReport(dir, {
        header: { projectId: "p1", projectName: "V", durationMs: 0, startedAtMs: at },
        provenance,
        analysis: analysis(),
        trace: trace(),
        finalRanked: [],
      })
    }
    const latest = await findLastReport(dir)
    expect(latest?.endsWith(".md")).toBe(true)
    expect(latest).toContain(reportFileStamp(3000))
  })

  it("ignores files that are not reports", async () => {
    const dir = await tmpDir()
    await writeFile(join(dir, "selection-reports-placeholder"), "x")
    await writeSelectionReport(dir, {
      header: { projectId: "p1", projectName: "V", durationMs: 0, startedAtMs: 1000 },
      provenance,
      analysis: analysis(),
      trace: trace(),
      finalRanked: [],
    })
    expect(await findLastReport(dir)).toContain(reportFileStamp(1000))
  })
})

describe("renderSelectionReportMarkdown", () => {
  it("shows every candidate and its fate, including the dropped ones", async () => {
    const dir = await tmpDir()
    const { reportMarkdownPath } = await writeSelectionReport(dir, {
      header: { projectId: "p1", projectName: "My Video", durationMs: 60000, startedAtMs: 0 },
      provenance,
      analysis: analysis(),
      trace: trace({
        candidates: [
          entry({ finalRank: 0, title: "The kept one" }),
          entry({
            outcome: "gate-rejected",
            finalRank: null,
            title: "The weak one",
            gate: { passed: false, reasons: ["shorter than 15000ms"], warnings: [] },
            text: "This one never shipped.",
          }),
          entry({
            outcome: "duplicate",
            duplicateOf: "The kept one",
            finalRank: null,
            title: "The seam duplicate",
          }),
        ],
      }),
      finalRanked: [
        {
          rank: 0,
          title: "The kept one",
          reason: "Hook",
          platform: "shorts",
          startTimecode: "0:00",
          endTimecode: "0:30",
          durationMs: 30000,
          text: "Nobody expected this.",
        },
      ],
    })

    const md = await readFile(reportMarkdownPath, "utf-8")
    expect(md).toContain("# Clip selection report — My Video")
    expect(md).toContain("`openai/gpt-oss-120b`")
    expect(md).toContain("| temperature | 0 |")
    expect(md).toContain("Nobody expected this.")
    expect(md).toContain("gate-rejected — The weak one")
    expect(md).toContain("shorter than 15000ms")
    expect(md).toContain("duplicate — The seam duplicate")
    expect(md).toContain("duplicate of: The kept one")
  })

  it("does not leak a fence-breaking title out of its markdown cell", async () => {
    // A model-authored title can contain anything, including a pipe that would break the table
    // or a backtick run. Cell text is escaped; transcript text goes in a fenced block.
    const dir = await tmpDir()
    const hostile = "Pipe | and `backticks` and\nnewline"
    await writeSelectionReport(dir, {
      header: { projectId: "p1", projectName: hostile, durationMs: 0, startedAtMs: 0 },
      provenance,
      analysis: analysis(),
      trace: trace({ candidates: [entry({ title: hostile })] }),
      finalRanked: [],
    })
    const files = await readdir(join(dir, "selection-reports"))
    const md = await readFile(
      join(
        dir,
        "selection-reports",
        files.find((f) => f.endsWith(".md"))!,
      ),
      "utf-8",
    )
    // The pipe is escaped in the table row, so the row count is unchanged.
    expect(md.split("\n").filter((l) => l.startsWith("| 0 |"))).toHaveLength(1)
    expect(md).toContain("\\|")
  })

  it("says plainly when nothing was kept, and points at the candidate table", async () => {
    const dir = await tmpDir()
    const { reportMarkdownPath } = await writeSelectionReport(dir, {
      header: { projectId: "p1", projectName: "Quiet video", durationMs: 60000, startedAtMs: 0 },
      provenance,
      analysis: analysis(),
      trace: trace({
        candidates: [entry({ outcome: "gate-rejected", finalRank: null, title: "Nope" })],
      }),
      finalRanked: [],
    })
    const md = await readFile(reportMarkdownPath, "utf-8")
    expect(md).toContain("_No clips survived selection.")
    // "No clips" without the reason is the exact dead end #97 was filed about.
    expect(md).toContain("## Dropped candidates")
  })

  it("renders a zero-sentence run instead of crashing", async () => {
    const dir = await tmpDir()
    const { reportMarkdownPath } = await writeSelectionReport(dir, {
      header: { projectId: "p1", projectName: "Empty", durationMs: 0, startedAtMs: 0 },
      provenance,
      analysis: analysis(),
      trace: trace({ sentenceCount: 0, chunks: [], candidates: [] }),
      finalRanked: [],
    })
    const md = await readFile(reportMarkdownPath, "utf-8")
    expect(md).toContain("_No chunks — the transcript had no sentences._")
  })

  it("shows the judge's verdict on kept and rejected candidates, and the question table (#99)", async () => {
    const dir = await tmpDir()
    const { reportMarkdownPath } = await writeSelectionReport(dir, {
      header: { projectId: "p1", projectName: "My Video", durationMs: 60000, startedAtMs: 0 },
      provenance,
      analysis: analysis(),
      trace: trace({
        candidates: [
          entry({
            finalRank: 0,
            title: "Judged keeper",
            judge: {
              answers: { hook: "yes", payoff: "partly" },
              note: "Strong opening, soft landing.",
              bestOpeningSentence: null,
              score: 0.8,
            },
          }),
          entry({
            outcome: "judge-rejected",
            finalRank: null,
            title: "Judged reject",
            judge: {
              answers: { hook: "yes", payoff: "no" },
              note: "Never resolves.",
              bestOpeningSentence: null,
              score: 0.6,
            },
            judgeReasons: ["fails payoff"],
          }),
        ],
      }),
      finalRanked: [],
    })
    const md = await readFile(reportMarkdownPath, "utf-8")
    expect(md).toContain("## Judge questions")
    expect(md).toContain("| payoff | 2 | yes |")
    expect(md).toContain("judge: score 0.80 — hook ✓ · payoff ~")
    expect(md).toContain("judge note: Strong opening, soft landing.")
    expect(md).toContain("judge-rejected — Judged reject")
    expect(md).toContain("judge: score 0.60 — hook ✓ · payoff ✗")
    expect(md).toContain("judge verdict: fails payoff")
  })

  it("shows whether the opening was moved, and both scores, whether or not it won (#100)", async () => {
    const dir = await tmpDir()
    const { reportMarkdownPath } = await writeSelectionReport(dir, {
      header: { projectId: "p1", projectName: "My Video", durationMs: 60000, startedAtMs: 0 },
      provenance,
      analysis: analysis(),
      trace: trace({
        candidates: [
          entry({
            finalRank: 0,
            title: "Moved opener",
            opening: {
              originalStartMs: 1000,
              originalStartTimecode: "0:01",
              suggestedSentence: 6,
              originalScore: 0.54,
              retryStartMs: 21000,
              retryStartTimecode: "0:21",
              retryScore: 0.86,
              adopted: true,
              note: "judge proposed sentence #6",
            },
          }),
          entry({
            finalRank: 1,
            title: "Kept opener",
            opening: {
              originalStartMs: 40000,
              originalStartTimecode: "0:40",
              suggestedSentence: 44,
              originalScore: 0.79,
              retryStartMs: 58000,
              retryStartTimecode: "0:58",
              retryScore: 0.61,
              adopted: false,
              note: "re-judged opening did not score higher",
            },
          }),
          entry({
            finalRank: 2,
            title: "No proposal",
            opening: {
              originalStartMs: 90000,
              originalStartTimecode: "1:30",
              suggestedSentence: null,
              originalScore: 0.71,
              retryStartMs: null,
              retryStartTimecode: null,
              retryScore: null,
              adopted: false,
              note: "no better opening suggested",
            },
          }),
        ],
      }),
      finalRanked: [],
    })
    const md = await readFile(reportMarkdownPath, "utf-8")
    // Adopted: both timecodes and the score it moved between.
    expect(md).toContain("- opening: MOVED 0:01 → 0:21 [0.54 vs 0.86] — judge proposed sentence #6")
    // Lost proposal: the losing score is still printed, which is the point of keeping both.
    expect(md).toContain(
      "- opening: kept 0:40 [0.79 vs 0.61] — re-judged opening did not score higher",
    )
    // No proposal: the report says so rather than staying silent.
    expect(md).toContain("- opening: kept 1:30 — no better opening suggested")
  })
})

describe("readLastReportFunnel", () => {
  /** A written report, so the funnel reader is exercised against the real file format. */
  async function report(
    dir: string,
    t: ClipSelectionTrace,
    finalRanked: number,
    startedAtMs = Date.UTC(2026, 0, 2, 3, 4, 5, 6),
  ): Promise<void> {
    await writeSelectionReport(dir, {
      header: {
        projectId: "p1",
        projectName: "My Video",
        durationMs: 3_600_000,
        startedAtMs,
      },
      provenance,
      analysis: analysis(),
      trace: t,
      finalRanked: Array.from({ length: finalRanked }, (_, i) => ({
        rank: i,
        title: `Clip ${i}`,
        reason: "r",
        platform: "shorts",
        startTimecode: "0:00",
        endTimecode: "0:30",
        durationMs: 30000,
        text: "t",
      })),
    })
  }

  it("returns null when the project has no report at all", async () => {
    const dir = await tmpDir()
    expect(await readLastReportFunnel(dir)).toBeNull()
  })

  it("accounts for every candidate in the zero-clip case", async () => {
    // The empty review screen's question is "why did nothing survive", and the answer has to add
    // up. 6 candidates that reached ranking, none kept: the rest must be visible as gate
    // rejections, otherwise the panel is guessing.
    const dir = await tmpDir()
    await report(
      dir,
      trace({
        // Deliberately not in pipeline order. A funnel built from the tally's own insertion order
        // would render these as they happen to appear in the trace, which is the order candidates
        // were *generated*, not the order they were *eliminated* — and the list has to read as a
        // sequence for it to explain the outcome.
        candidates: [
          entry({ outcome: "judge-rejected" }),
          entry({ outcome: "gate-rejected" }),
          entry({ outcome: "judge-failed" }),
          entry({ outcome: "invalid-range" }),
          entry({ outcome: "gate-rejected" }),
          entry({ outcome: "duplicate" }),
        ],
      }),
      0,
    )
    const funnel = await readLastReportFunnel(dir)
    expect(funnel).not.toBeNull()
    expect(funnel!.candidateCount).toBe(6)
    expect(funnel!.keptCount).toBe(0)
    expect(funnel!.steps).toEqual([
      { outcome: "gate-rejected", label: "gate-rejected", count: 2 },
      { outcome: "invalid-range", label: "invalid range", count: 1 },
      { outcome: "duplicate", label: "duplicate", count: 1 },
      { outcome: "judge-rejected", label: "judge-rejected", count: 1 },
      { outcome: "judge-failed", label: "judge call failed", count: 1 },
    ])
    // The steps must account for every candidate that was ranked.
    expect(funnel!.steps.reduce((n, s) => n + s.count, 0)).toBe(funnel!.candidateCount)
  })

  it("reports failed chunks separately from chunks that answered with nothing", async () => {
    const dir = await tmpDir()
    await report(
      dir,
      trace({
        chunks: [
          {
            index: 0,
            firstSentence: 0,
            lastSentence: 40,
            candidateCount: 1,
            candidatesDropped: 0,
            failed: false,
          },
          {
            index: 1,
            firstSentence: 40,
            lastSentence: 80,
            candidateCount: 0,
            candidatesDropped: 0,
            failed: true,
            error: "429",
          },
        ],
        candidates: [entry({})],
      }),
      1,
    )
    const funnel = await readLastReportFunnel(dir)
    expect(funnel!.chunkCount).toBe(2)
    expect(funnel!.failedChunkCount).toBe(1)
  })

  it("surfaces candidates dropped at the per-chunk cap", async () => {
    const dir = await tmpDir()
    await report(
      dir,
      trace({
        chunks: [
          {
            index: 0,
            firstSentence: 0,
            lastSentence: 80,
            candidateCount: 20,
            candidatesDropped: 7,
            failed: false,
          },
        ],
        candidates: [entry({})],
      }),
      1,
    )
    const funnel = await readLastReportFunnel(dir)
    // Never judged, so absent from the steps — but it must not be invisible either.
    expect(funnel!.droppedCandidateCount).toBe(7)
    expect(funnel!.steps.reduce((n, s) => n + s.count, 0)).toBe(funnel!.candidateCount)
  })

  it("reads a report written before the drop count existed", async () => {
    // Reports already on disk have no `candidatesDropped`. Summing `undefined` would make the
    // funnel report NaN and render as "NaN" in the UI, so old files have to stay readable.
    const dir = await tmpDir()
    await mkdir(join(dir, "selection-reports"), { recursive: true })
    const stamp = reportFileStamp(Date.UTC(2026, 0, 2, 3, 4, 5, 6))
    const legacy = {
      header: {
        projectId: "p1",
        projectName: "My Video",
        durationMs: 3_600_000,
        startedAtMs: Date.UTC(2026, 0, 2, 3, 4, 5, 6),
      },
      provenance,
      analysis: analysis(),
      trace: {
        temperature: 0,
        sentenceCount: 2,
        chunks: [
          { index: 0, firstSentence: 0, lastSentence: 41, candidateCount: 1, failed: false },
        ],
        candidates: [entry({})],
        judgeQuestions: [],
      },
      finalRanked: [],
    }
    await writeFile(join(dir, "selection-reports", `${stamp}.json`), JSON.stringify(legacy))
    await writeFile(join(dir, "selection-reports", `${stamp}.md`), "# report")
    const funnel = await readLastReportFunnel(dir)
    expect(funnel!.droppedCandidateCount).toBe(0)
    expect(Number.isNaN(funnel!.droppedCandidateCount)).toBe(false)
  })

  it("returns null for an unreadable report rather than throwing", async () => {
    // A broken file must not take the review screen down with it.
    const dir = await tmpDir()
    await mkdir(join(dir, "selection-reports"), { recursive: true })
    const stamp = reportFileStamp(Date.UTC(2026, 0, 2, 3, 4, 5, 6))
    await writeFile(join(dir, "selection-reports", `${stamp}.md`), "# report")
    await writeFile(join(dir, "selection-reports", `${stamp}.json`), "{ not json")
    expect(await readLastReportFunnel(dir)).toBeNull()
  })

  it("reads the newest report when a project has several", async () => {
    const dir = await tmpDir()
    await report(dir, trace({ candidates: [entry({})] }), 1, Date.UTC(2026, 0, 2, 3, 4, 5, 6))
    await report(
      dir,
      trace({
        candidates: [entry({ outcome: "judge-rejected" })],
      }),
      0,
      Date.UTC(2026, 0, 2, 9, 10, 11, 12),
    )
    const funnel = await readLastReportFunnel(dir)
    expect(funnel!.keptCount).toBe(0)
  })
})
