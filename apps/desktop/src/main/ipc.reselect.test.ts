import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
// Default import, matching packages/database. It works at runtime because Vite's CJS interop
// hands back module.exports, and it typechecks because apps/desktop/tsconfig.node.json sets
// esModuleInterop like the other packages. A namespace import would typecheck without that flag
// but Vite gives a namespace object for an `export =` module, so `new Database()` fails.
import Database from "better-sqlite3"
import { mkdtempSync, mkdirSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"

const MIGRATIONS_DIR = resolve(process.cwd(), "resources/drizzle")

// Mirrors packages/database/src/index.test.ts: the installed better-sqlite3 binary targets
// whichever runtime last built it — on a dev machine that is Electron (electron-rebuild), not
// the Node vitest runs under. CI installs fresh, where pnpm builds it against the same Node
// that runs the tests, so there a skip would mean silently shipping a re-selection path with no
// coverage. Locally we skip; in CI the suite fails instead of disappearing.
const sqliteUsable = (() => {
  try {
    new Database(":memory:")
    return true
  } catch {
    return false
  }
})()
type DescribeFn = (name: string, fn: () => void) => void
const describeSqlite: DescribeFn = sqliteUsable
  ? (name, fn) => describe(name, fn)
  : process.env.CI
    ? (name) =>
        describe(name, () => {
          it("loads better-sqlite3 against the Node running the tests", () => {
            throw new Error(
              "better-sqlite3 is not loadable in this runtime — the clip:reselect tests did NOT run. Rebuild it for the CI Node version instead of letting coverage disappear.",
            )
          })
        })
    : (name, fn) => describe.skip(name, fn)

// Stubbed so the test exercises ipc.ts's real selection logic without electron, Groq, or ffmpeg.
const {
  mockClipSelector,
  mockWriteReport,
  mockFindLastReport,
  mockMeasureArousal,
  mockComplete,
  userDataRoot,
  testDbHandle,
} = vi.hoisted(() => ({
  mockClipSelector: vi.fn(),
  mockWriteReport: vi.fn(),
  mockFindLastReport: vi.fn(),
  mockMeasureArousal: vi.fn(),
  mockComplete: vi.fn(),
  // Shared mutable cells: electron and initDb mocks are hoisted above the test body but need
  // the per-test temp dir and database instance, which do not exist yet when they are defined.
  userDataRoot: { value: "" },
  testDbHandle: { value: null as unknown },
}))

vi.mock("electron", () => ({
  app: {
    // A real directory, because registerIpcHandlers opens its database at userData/db.sqlite.
    // Pointing this at a path that does not exist fails inside initDb, not in the code under test.
    getPath: (name: string) => join(userDataRoot.value, name),
    isPackaged: false,
    getVersion: () => "0.0.0-test",
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, args: unknown) => Promise<unknown>) =>
      registered.set(channel, listener),
  },
  shell: { showItemInFolder: () => {}, openPath: async () => "" },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}))

// registerIpcHandlers opens the real singleton database via initDb. Handing it the in-memory
// instance the test seeds means the assertions read the same rows the handlers wrote, without a
// file on disk or a second connection that could not see them.
vi.mock("@video-editor/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@video-editor/database")>()
  return { ...actual, initDb: () => testDbHandle.value }
})

vi.mock("@video-editor/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@video-editor/ai")>()
  return {
    ...actual,
    selectClips: mockClipSelector,
    createAiClient: () => ({
      structuredModel: "test/model",
      // Social captions are generated on the same client after the clips are swapped. Returning
      // a rejection here is a test case of its own (see "survives a social-caption failure"),
      // so the default has to work rather than throw a TypeError.
      complete: mockComplete,
    }),
  }
})

vi.mock("../main/selection-report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../main/selection-report")>()
  return { ...actual, writeSelectionReport: mockWriteReport, findLastReport: mockFindLastReport }
})

vi.mock("@video-editor/ffmpeg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@video-editor/ffmpeg")>()
  return {
    ...actual,
    measureArousal: mockMeasureArousal,
    resolveFfmpegBinary: () => "/usr/bin/ffmpeg",
    resolveWhisperBinary: () => "/usr/bin/whisper",
  }
})

vi.mock("@video-editor/transcript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@video-editor/transcript")>()
  return {
    ...actual,
    segmentTopics: async (s: unknown[]) => [{ sentences: s, startMs: 0, endMs: 1 }],
  }
})

const registered = new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()

import {
  createDb,
  getClips,
  getProject,
  getWords,
  insertClips,
  insertProject,
  insertWords,
  setProjectStatus,
} from "@video-editor/database"
import type { ClipSelectionTrace, TraceEntry } from "@video-editor/ai"

function traceEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    chunk: 0,
    startSentence: 0,
    endSentence: 12,
    title: "Candidate",
    reason: "Hook",
    strong: true,
    platform: "shorts",
    outcome: "kept",
    trimmedStartSentence: 0,
    startMs: 1000,
    endMs: 31000,
    startTimecode: "0:01",
    endTimecode: "0:31",
    boundary: { danglingUnresolved: false, endedOnCompleteThought: true, tooShort: false },
    gate: { passed: true, reasons: [], warnings: [] },
    duplicateOf: null,
    finalRank: 0,
    text: "some words",
    ...overrides,
  }
}

function selection(
  clips: { title: string; startMs: number; endMs: number }[],
  trace?: ClipSelectionTrace,
) {
  const fullTrace: ClipSelectionTrace = trace ?? {
    temperature: 0,
    sentenceCount: 2,
    chunks: [{ index: 0, firstSentence: 0, lastSentence: 1, candidateCount: clips.length }],
    candidates: clips.map((c, i) =>
      traceEntry({ title: c.title, startMs: c.startMs, endMs: c.endMs, finalRank: i }),
    ),
  }
  return {
    clips: clips.map((c, i) => ({
      title: c.title,
      startMs: c.startMs,
      endMs: c.endMs,
      score: 1 - i * 0.1,
      reason: "r",
      platform: "shorts" as const,
      warnings: [],
    })),
    rejected: [],
    pipelineVersion: "v1-unmeasured",
    pipelineHash: "hash",
    model: "test/model",
    contentType: "solo" as const,
    trace: fullTrace,
  }
}

function longTranscriptWords(projectId: string) {
  const rows = []
  let ms = 0
  for (let i = 0; i < 400; i++) {
    rows.push({
      id: `${projectId}-w${i}`,
      projectId,
      text: i % 3 === 0 ? "Nobody" : "expected",
      startMs: ms,
      endMs: ms + 300,
      confidence: 0.9,
      speakerLabel: null,
    })
    ms += 350
  }
  return rows
}

const PROJECT_ID = "proj-reselect"

function seedProject(db: ReturnType<typeof createDb>) {
  insertProject(db, {
    id: PROJECT_ID,
    name: "Test Video",
    mediaPath: "/media/t.mp4",
    proxyPath: null,
    durationMs: 140_000,
    status: "ready",
    createdAt: 1000,
    updatedAt: 1000,
  })
  insertWords(db, longTranscriptWords(PROJECT_ID))
}

async function invoke(channel: string, args: unknown) {
  const handler = registered.get(channel)
  if (!handler) throw new Error(`channel ${channel} not registered`)
  return handler({}, args)
}

describeSqlite("clip:reselect (#97)", () => {
  let sqlite: Database.Database
  let db: ReturnType<typeof createDb>

  beforeEach(async () => {
    registered.clear()
    mockClipSelector.mockReset()
    mockMeasureArousal.mockReset().mockResolvedValue([0.1, 0.2])
    mockWriteReport.mockReset().mockImplementation(async (dir: string) => ({
      reportJsonPath: join(dir, "selection-reports", "r.json"),
      reportMarkdownPath: join(dir, "selection-reports", "r.md"),
    }))
    mockFindLastReport.mockReset().mockResolvedValue(null)
    // A well-formed social-caption response, so a run reaches completion by default. The JSON
    // array shape is what generateSocialCaptions parses out of the completion.
    mockComplete.mockReset().mockResolvedValue('["one","two"]')

    const userDataDir = mkdtempSync(join(tmpdir(), "clipper-ipc-test-"))
    mkdirSync(join(userDataDir, "projects", PROJECT_ID), { recursive: true })
    mkdirSync(join(userDataDir, "models"), { recursive: true })
    userDataRoot.value = userDataDir

    sqlite = new Database(":memory:")
    db = createDb(sqlite, MIGRATIONS_DIR)
    seedProject(db)
    testDbHandle.value = db

    vi.resetModules()
    const { registerIpcHandlers } = await import("../main/ipc")
    registerIpcHandlers()
  })

  afterEach(() => {
    sqlite.close()
    testDbHandle.value = null
  })

  it("registers the reselect and last-report channels", () => {
    expect(registered.has("clip:reselect")).toBe(true)
    expect(registered.has("clip:last-report")).toBe(true)
  })

  it("re-runs selection from the stored transcript without touching the words", async () => {
    mockClipSelector.mockResolvedValue(
      selection([{ title: "New clip", startMs: 1000, endMs: 31000 }]),
    )

    const result = (await invoke("clip:reselect", { projectId: PROJECT_ID })) as {
      clipCount: number
      reportMarkdownPath: string
    }

    expect(result.clipCount).toBe(1)
    expect(result.reportMarkdownPath).toContain("selection-reports")
    expect(getClips(db, PROJECT_ID).map((c) => c.title)).toEqual(["New clip"])
    // The premise of the whole issue: selection re-runs off the stored transcript, so the words
    // table must be untouched. If it were cleared, the next re-run would have nothing to read.
    expect(getWords(db, PROJECT_ID)).toHaveLength(400)
    // Selection runs without the Whisper binary being touched at all.
    expect(mockMeasureArousal).toHaveBeenCalled()
  })

  it("replaces suggested and rejected clips but keeps approved and exported ones", async () => {
    // The acceptance criterion, and the reason the delete is status-scoped rather than
    // project-wide: a re-run must never discard the user's own decisions.
    insertClips(db, [
      {
        id: "old-sug",
        projectId: PROJECT_ID,
        title: "Old suggestion",
        startMs: 0,
        endMs: 5000,
        status: "suggested",
        createdAt: 1000,
      },
      {
        id: "old-rej",
        projectId: PROJECT_ID,
        title: "Old rejection",
        startMs: 1000,
        endMs: 6000,
        status: "rejected",
        createdAt: 1000,
      },
      {
        id: "keep-app",
        projectId: PROJECT_ID,
        title: "User approved",
        startMs: 2000,
        endMs: 7000,
        status: "approved",
        createdAt: 1000,
      },
      {
        id: "keep-exp",
        projectId: PROJECT_ID,
        title: "User exported",
        startMs: 3000,
        endMs: 8000,
        status: "exported",
        createdAt: 1000,
      },
    ])

    mockClipSelector.mockResolvedValue(
      selection([{ title: "Fresh clip", startMs: 1000, endMs: 31000 }]),
    )
    await invoke("clip:reselect", { projectId: PROJECT_ID })

    const titles = getClips(db, PROJECT_ID)
      .map((c) => c.title)
      .sort()
    expect(titles).toEqual(["Fresh clip", "User approved", "User exported"])
  })

  it("writes a report carrying the header fields a run is compared by", async () => {
    let captured: unknown
    mockWriteReport.mockImplementation(async (dir: string, report: unknown) => {
      captured = report
      return {
        reportJsonPath: join(dir, "selection-reports", "r.json"),
        reportMarkdownPath: join(dir, "selection-reports", "r.md"),
      }
    })
    mockClipSelector.mockResolvedValue(selection([{ title: "Clip", startMs: 1000, endMs: 31000 }]))

    await invoke("clip:reselect", { projectId: PROJECT_ID })

    const report = captured as {
      header: { durationMs: number; projectName: string }
      provenance: { model: string }
      trace: { temperature: number }
    }
    expect(report.header.projectName).toBe("Test Video")
    // Duration distinguishes "the model found nothing" from "there was nothing there".
    expect(report.header.durationMs).toBe(140_000)
    expect(report.provenance.model).toBe("test/model")
    expect(report.trace.temperature).toBe(0)
  })

  it("leaves the previous suggestions in place when selection fails", async () => {
    insertClips(db, [
      {
        id: "old-sug",
        projectId: PROJECT_ID,
        title: "Old suggestion",
        startMs: 0,
        endMs: 5000,
        status: "suggested",
        createdAt: 1000,
      },
    ])
    mockClipSelector.mockRejectedValue(new Error("simulated API failure"))

    await expect(invoke("clip:reselect", { projectId: PROJECT_ID })).rejects.toThrow(/simulated/)
    // A failed re-run must be a no-op, not a wipe: the swap happens only after selection
    // succeeds, so the user still has whatever they had.
    expect(getClips(db, PROJECT_ID).map((c) => c.title)).toEqual(["Old suggestion"])
  })

  it("keeps the run successful when social-caption generation fails", async () => {
    insertClips(db, [
      {
        id: "old-sug",
        projectId: PROJECT_ID,
        title: "Old suggestion",
        startMs: 0,
        endMs: 5000,
        status: "suggested",
        createdAt: 1000,
      },
    ])
    // Captions are generated after the clips have already been swapped. Treating a caption
    // failure as a run failure would report an error for a run whose clips are correct, and
    // would do so right after the previous suggestions were replaced — the user is told their
    // clips were left alone when in fact they were replaced.
    mockComplete.mockRejectedValue(new Error("caption API down"))
    mockClipSelector.mockResolvedValue(selection([{ title: "New clip", startMs: 0, endMs: 30000 }]))

    const result = (await invoke("clip:reselect", { projectId: PROJECT_ID })) as {
      clipCount: number
    }
    expect(result.clipCount).toBe(1)
    expect(getClips(db, PROJECT_ID).map((c) => c.title)).toEqual(["New clip"])
    expect(getProject(db, PROJECT_ID)?.status).toBe("ready")
  })

  it("refuses to run while the project is transcribing", async () => {
    setProjectStatus(db, PROJECT_ID, "transcribing")

    await expect(invoke("clip:reselect", { projectId: PROJECT_ID })).rejects.toThrow(/transcribing/)
    // Never even called — a re-selection racing a transcription would read words being rewritten.
    expect(mockClipSelector).not.toHaveBeenCalled()
  })

  it("refuses a second run while the first is still in flight", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    mockClipSelector.mockImplementation(async () => {
      await gate
      return selection([{ title: "Clip", startMs: 0, endMs: 30000 }])
    })

    const first = invoke("clip:reselect", { projectId: PROJECT_ID })
    // The renderer's button is disabled during a run, but that is UI state; the main process
    // marks the project "analyzing" synchronously before its first await, and this guard reads
    // that back. The two overlapping runs must not both reach the selection call.
    await expect(invoke("clip:reselect", { projectId: PROJECT_ID })).rejects.toThrow(/analyzing/)
    release()
    await first
    expect(mockClipSelector).toHaveBeenCalledTimes(1)
  })

  it("restores the project status after a failure", async () => {
    mockClipSelector.mockRejectedValue(new Error("boom"))
    await expect(invoke("clip:reselect", { projectId: PROJECT_ID })).rejects.toThrow()
    // Not left stuck at "analyzing", which would make the UI think a run is still going and
    // would make the guard above refuse every later re-selection for this project.
    expect(getProject(db, PROJECT_ID)?.status).toBe("ready")
  })

  it("restores the project status after a successful run", async () => {
    mockClipSelector.mockResolvedValue(selection([{ title: "Clip", startMs: 0, endMs: 30000 }]))
    await invoke("clip:reselect", { projectId: PROJECT_ID })

    // The asymmetry that matters: this one silently broke re-selection entirely, because a
    // project left at "analyzing" is refused by the guard on every subsequent call. There is
    // no user action that recovers from it short of restarting the app.
    expect(getProject(db, PROJECT_ID)?.status).toBe("ready")
    await invoke("clip:reselect", { projectId: PROJECT_ID })
    expect(mockClipSelector).toHaveBeenCalledTimes(2)
  })
})
