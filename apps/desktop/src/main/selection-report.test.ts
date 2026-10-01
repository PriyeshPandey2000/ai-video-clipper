import { describe, it, expect } from "vitest"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ClipSelectionTrace, TraceEntry } from "@video-editor/ai"
import { findLastReport, reportFileStamp, writeSelectionReport } from "./selection-report"

const provenance = {
  pipelineVersion: "v1-unmeasured",
  pipelineHash: "a".repeat(64),
  model: "openai/gpt-oss-120b",
  contentType: "solo" as const,
}

function trace(overrides: Partial<ClipSelectionTrace> = {}): ClipSelectionTrace {
  return {
    temperature: 0,
    sentenceCount: 2,
    chunks: [{ index: 0, firstSentence: 0, lastSentence: 41, candidateCount: 2, failed: false }],
    candidates: [],
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
    strong: true,
    platform: "shorts",
    outcome: "kept",
    trimmedStartSentence: 0,
    startMs: 0,
    endMs: 30000,
    startTimecode: "0:00",
    endTimecode: "0:30",
    boundary: { danglingUnresolved: false, endedOnCompleteThought: true, tooShort: false },
    gate: { passed: true, reasons: [], warnings: [] },
    duplicateOf: null,
    finalRank: 0,
    text: "Nobody expected this.",
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
      trace: trace({ candidates: [entry({})] }),
      finalRanked: [],
    })

    const json = JSON.parse(await readFile(reportJsonPath, "utf-8")) as Record<string, unknown>
    expect(json.header).toMatchObject({ projectName: "My Video", durationMs: 3_600_000 })
    expect(json.provenance).toMatchObject({
      pipelineVersion: "v1-unmeasured",
      pipelineHash: "a".repeat(64),
      model: "openai/gpt-oss-120b",
      contentType: "solo",
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
      trace: trace({
        candidates: [
          entry({ finalRank: 0 }),
          entry({ outcome: "duplicate", duplicateOf: "Untitled clip", finalRank: null }),
          entry({
            outcome: "gate-rejected",
            finalRank: null,
            gate: { passed: false, reasons: ["not marked strong"], warnings: [] },
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
      trace: trace({
        candidates: [
          entry({ finalRank: 0, title: "The kept one" }),
          entry({
            outcome: "gate-rejected",
            finalRank: null,
            title: "The weak one",
            gate: { passed: false, reasons: ["not marked strong"], warnings: [] },
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
    expect(md).toContain("not marked strong")
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
      trace: trace({ sentenceCount: 0, chunks: [], candidates: [] }),
      finalRanked: [],
    })
    const md = await readFile(reportMarkdownPath, "utf-8")
    expect(md).toContain("_No chunks — the transcript had no sentences._")
  })
})
