import { describe, it, expect, vi } from "vitest"
import Database from "better-sqlite3"
import { resolve } from "node:path"
import {
  insertBatched,
  createDb,
  initDb,
  closeDb,
  listProjects,
  getProject,
  getClipsByIds,
  insertProject,
  insertClips,
  insertWords,
  insertSegments,
  clearDerivedData,
  setClipStatus,
  setClipTimes,
  markClipExported,
  setFillerWords,
  updateProjectImportResult,
  words as wordsTable,
  segments as segmentsTable,
  type NewWord,
  type NewSegment,
  type SegmentRow,
  type Db,
} from "./index"

// drizzle-kit generates migrations into the repo's resources/ folder (see drizzle.config.ts).
// Resolved from cwd because vitest runs from the repo root (root package.json "test" script)
// and this package compiles as CommonJS, where import.meta/__dirname aren't available.
const MIGRATIONS_DIR = resolve(process.cwd(), "resources/drizzle")

// The installed better-sqlite3 binary targets whichever runtime last built it — on dev machines
// that's usually Electron (electron-rebuild), not system Node, so vitest can't load it here.
// CI installs fresh, where pnpm builds it against the same Node that runs tests. Skip the
// sqlite-backed tests when the native module doesn't match instead of failing the whole suite.
const sqliteUsable = (() => {
  try {
    new Database(":memory:")
    return true
  } catch {
    return false
  }
})()
const describeSqlite = sqliteUsable ? describe : describe.skip

function testDb(): Db {
  return createDb(new Database(":memory:"), MIGRATIONS_DIR)
}

const baseProject = {
  id: "p1",
  name: "Test Project",
  mediaPath: "/media/p1.mp4",
  createdAt: 1000,
  updatedAt: 1000,
}

const baseClip = (projectId: string) => ({
  id: "c1",
  projectId,
  title: "Clip",
  startMs: 0,
  endMs: 5000,
  createdAt: 1000,
})

describe("insertBatched", () => {
  it("does nothing for an empty array", () => {
    const insertFn = vi.fn()
    insertBatched(insertFn, [], 7)
    expect(insertFn).not.toHaveBeenCalled()
  })

  it("inserts everything in one call when under the limit", () => {
    const insertFn = vi.fn()
    const rows = Array.from({ length: 50 }, (_, i) => i)
    insertBatched(insertFn, rows, 7)
    expect(insertFn).toHaveBeenCalledTimes(1)
    expect(insertFn).toHaveBeenCalledWith(rows)
  })

  it("splits into batches that stay under 999 bound parameters", () => {
    const insertFn = vi.fn()
    // 7 columns/row -> batch size floor(999/7) = 142
    const rows = Array.from({ length: 6300 }, (_, i) => i)
    insertBatched(insertFn, rows, 7)

    const batches = insertFn.mock.calls.map((call) => call[0] as number[])
    for (const batch of batches) {
      expect(batch.length * 7).toBeLessThanOrEqual(999)
    }
    // Every row appears exactly once, in order, across all batches.
    expect(batches.flat()).toEqual(rows)
  })

  it("rejects invalid columnsPerRow instead of silently misbehaving", () => {
    // Each of these would otherwise silently do the wrong thing: 0 -> Infinity batch size
    // (reverts to one giant unbatched insert, the exact bug this function exists to prevent),
    // NaN -> Math.max(1, NaN) is NaN -> an empty first slice and the loop never advances,
    // negative -> clamped to 1 masking a caller bug, over the SQLite limit -> a single row
    // alone could still exceed it.
    const insertFn = vi.fn()
    const rows = [1, 2, 3]
    for (const bad of [0, -5, NaN, 1.5, 1000]) {
      expect(() => insertBatched(insertFn, rows, bad)).toThrow(/columnsPerRow/)
    }
    expect(insertFn).not.toHaveBeenCalled()
  })
})

describeSqlite("repository", () => {
  it("runs migrations on a fresh database", () => {
    const db = testDb()
    expect(listProjects(db)).toEqual([])
  })

  it("baselines a legacy bootstrapSchema database without re-running DDL or losing data", () => {
    // The exact DDL bootstrapSchema used before migrations existed (minus the try/catch ALTERs,
    // which produced this same final shape).
    const sqlite = new Database(":memory:")
    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        media_path TEXT NOT NULL,
        proxy_path TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        caption_style TEXT,
        filler_words TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE words (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        speaker_label TEXT
      );
      CREATE TABLE clips (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        ai_score REAL,
        ai_reason TEXT,
        status TEXT NOT NULL DEFAULT 'suggested',
        platform TEXT,
        crop_x REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE segments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL
      );
      CREATE TABLE ai_outputs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    sqlite
      .prepare(
        "INSERT INTO projects (id, name, media_path, created_at, updated_at) VALUES ('legacy', 'Old', '/m.mp4', 1, 1)",
      )
      .run()

    const db = createDb(sqlite, MIGRATIONS_DIR)

    // Migration 0000 was skipped (tables already exist), user data survives, and the db is usable.
    expect(getProject(db, "legacy")?.name).toBe("Old")
    insertProject(db, { ...baseProject, id: "new" })
    expect(getProject(db, "new")).not.toBeNull()
  })

  it("insertProject / getProject / listProjects order by updatedAt desc", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertProject(db, { ...baseProject, id: "p2", updatedAt: 2000 })

    expect(listProjects(db).map((p) => p.id)).toEqual(["p2", "p1"])
    expect(getProject(db, "p1")?.name).toBe("Test Project")
    expect(getProject(db, "missing")).toBeNull()
  })

  it("updateProjectImportResult sets proxy, duration and bumps updatedAt", () => {
    const db = testDb()
    insertProject(db, baseProject)
    updateProjectImportResult(db, "p1", "/proxy.mp4", 42000)
    const p = getProject(db, "p1")!
    expect(p.proxyPath).toBe("/proxy.mp4")
    expect(p.durationMs).toBe(42000)
    expect(p.updatedAt).toBeGreaterThan(1000)
  })

  it("insertWords batches long transcripts past the SQLite variable limit", () => {
    const db = testDb()
    insertProject(db, baseProject)
    const rows: NewWord[] = Array.from({ length: 6300 }, (_, i) => ({
      id: `w${i}`,
      projectId: "p1",
      text: "word",
      startMs: i * 10,
      endMs: i * 10 + 5,
    }))
    // Would throw "too many SQL variables" if issued as one statement (~140 row limit).
    expect(() => insertWords(db, rows)).not.toThrow()
    expect(db.select({ id: wordsTable.id }).from(wordsTable).all()).toHaveLength(6300)
  })

  it("clearDerivedData removes words, segments, clips and ai outputs but keeps the project", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertWords(db, [{ id: "w1", projectId: "p1", text: "hi", startMs: 0, endMs: 10 }])
    insertSegments(db, [{ id: "s1", projectId: "p1", type: "filler", startMs: 0, endMs: 10 }])
    insertClips(db, [baseClip("p1")])

    clearDerivedData(db, "p1")

    expect(getWordsCount(db)).toBe(0)
    expect(getSegmentsCount(db)).toBe(0)
    expect(getClipsByIds(db, ["c1"])).toEqual([])
    expect(getProject(db, "p1")).not.toBeNull()
  })

  it("setClipTimes demotes an exported clip back to approved", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertClips(db, [baseClip("p1")])
    markClipExported(db, "c1")
    setClipTimes(db, "c1", 100, 900)
    expect(getClipsByIds(db, ["c1"])[0]).toMatchObject({
      status: "approved",
      startMs: 100,
      endMs: 900,
    })

    // Non-exported clips keep their status.
    setClipStatus(db, "c1", "rejected")
    setClipTimes(db, "c1", 200, 800)
    expect(getClipsByIds(db, ["c1"])[0]?.status).toBe("rejected")
  })

  it("setFillerWords atomically replaces filler segments", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertSegments(db, [
      { id: "old-filler", projectId: "p1", type: "filler", startMs: 0, endMs: 10 },
      { id: "silence", projectId: "p1", type: "silence", startMs: 20, endMs: 40 },
    ])

    const replacements: NewSegment[] = [
      { id: "new-filler", projectId: "p1", type: "filler", startMs: 50, endMs: 60 },
    ]
    setFillerWords(db, "p1", JSON.stringify(["um"]), replacements)

    expect(getProject(db, "p1")?.fillerWords).toBe(JSON.stringify(["um"]))
    const segs = allSegments(db)
    expect(segs.map((s) => s.id).sort()).toEqual(["new-filler", "silence"].sort())
  })
})

// Small raw helpers for assertions — reading through drizzle directly keeps these tests honest
// about what actually landed in sqlite.
function getWordsCount(db: Db): number {
  return db.select({ id: wordsTable.id }).from(wordsTable).all().length
}
function getSegmentsCount(db: Db): number {
  return db.select({ id: segmentsTable.id }).from(segmentsTable).all().length
}
function allSegments(db: Db): SegmentRow[] {
  return db.select().from(segmentsTable).all()
}

describeSqlite("initDb lifecycle", () => {
  it("refuses double initialization", () => {
    initDb(":memory:", MIGRATIONS_DIR)
    expect(() => initDb(":memory:", MIGRATIONS_DIR)).toThrow(/twice/)
    closeDb()
  })
})
