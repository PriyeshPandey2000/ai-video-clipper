import { describe, it, expect, vi } from "vitest"
import Database from "better-sqlite3"
import { resolve, join } from "node:path"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
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
  replaceClipsByStatus,
  insertAiOutput,
  getAiOutputs,
  replaceAiOutputByType,
  setClipStatus,
  setClipTimes,
  markClipExported,
  setFillerWords,
  setClipProfileOverride,
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
// CI installs fresh, where pnpm builds it against the same Node that runs tests — so there,
// skipping would mean silently shipping without any database coverage. Locally we skip; in CI
// the suite fails instead.
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
              "better-sqlite3 is not loadable in this runtime — database tests did NOT run. Rebuild it for the CI Node version instead of letting coverage disappear.",
            )
          })
        })
    : (name, fn) => describe.skip(name, fn)

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
    const sqlite = makeLegacySqlite()
    const db = createDb(sqlite, MIGRATIONS_DIR)

    // Migration 0000 was skipped (tables already exist), user data survives, and the db is usable.
    expect(getProject(db, "legacy")?.name).toBe("Old")
    insertProject(db, { ...baseProject, id: "new" })
    expect(getProject(db, "new")).not.toBeNull()
  })

  it("still applies later migrations to a baselined legacy database even though their timestamps predate 'now'", () => {
    // Regression: the baseline used to stamp Date.now(), so a user skipping app versions would
    // baseline ABOVE migrations generated before "now" and those migrations were silently
    // skipped, leaving their schema permanently behind. The baseline must use migration 0000's
    // journal timestamp instead — here both fake migrations are stamped in 1970 (long before any
    // plausible Date.now()), so a Date.now() baseline would skip 0001 and fail this test.
    const dir = mkdtempSync(join(tmpdir(), "db-migrations-test-"))
    mkdirSync(join(dir, "meta"))
    writeFileSync(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [
          { idx: 0, version: "6", when: 1000, tag: "0000_legacy", breakpoints: true },
          { idx: 1, version: "6", when: 2000, tag: "0001_late", breakpoints: true },
        ],
      }),
    )
    // 0000 never runs on legacy dbs (tables exist); its content is irrelevant here.
    writeFileSync(join(dir, "0000_legacy.sql"), "SELECT 1;")
    writeFileSync(join(dir, "0001_late.sql"), "ALTER TABLE projects ADD COLUMN marker TEXT;")

    const sqlite = makeLegacySqlite()
    createDb(sqlite, dir)

    const columns = sqlite.prepare("PRAGMA table_info(projects)").all() as { name: string }[]
    expect(columns.some((c) => c.name === "marker")).toBe(true)
    // Read through raw SQL rather than getProject on purpose. This fixture ships a hand-written
    // pair of migrations, so its `projects` table only has the columns those two add — it is not
    // the full current schema, and `getProject` selects every column drizzle knows about. The claim
    // under test is "the baseline did not lose data or skip 0001", and that is answerable from the
    // table this fixture actually built. Whether the real migration chain brings a legacy database
    // all the way to the current schema is covered by the tests above, which use MIGRATIONS_DIR.
    expect(sqlite.prepare("SELECT name FROM projects WHERE id = 'legacy'").get()).toEqual({
      name: "Old",
    })
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

  // The whole point of #89: a user trim must not destroy the record of what the AI chose.
  // Without this, boundary error and precision@5 (#46 taste tier) are uncomputable forever.
  it("setClipTimes preserves the AI's original boundaries and provenance", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertClips(db, [
      {
        ...baseClip("p1"),
        originalStartMs: 0,
        originalEndMs: 5000,
        aiRank: 0,
        pipelineVersion: "v1-unmeasured",
        pipelineHash: "abc123",
        aiModel: "openai/gpt-oss-120b",
        contentType: "solo_opinion" as const,
      },
    ])

    setClipTimes(db, "c1", 1200, 4300)

    expect(getClipsByIds(db, ["c1"])[0]).toMatchObject({
      startMs: 1200,
      endMs: 4300,
      originalStartMs: 0,
      originalEndMs: 5000,
      aiRank: 0,
      pipelineVersion: "v1-unmeasured",
      pipelineHash: "abc123",
      aiModel: "openai/gpt-oss-120b",
      contentType: "solo_opinion",
    })
  })

  it("repeated trims still report the same original boundary", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertClips(db, [{ ...baseClip("p1"), originalStartMs: 10, originalEndMs: 5000 }])

    setClipTimes(db, "c1", 1200, 4300)
    setClipTimes(db, "c1", 2000, 3000)
    setClipTimes(db, "c1", 10, 5000)

    const clip = getClipsByIds(db, ["c1"])[0]
    expect(clip?.startMs).toBe(10)
    expect([clip?.originalStartMs, clip?.originalEndMs]).toEqual([10, 5000])
  })

  it("leaves provenance null for clips written without it, rather than backfilling a guess", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertClips(db, [baseClip("p1")])
    setClipTimes(db, "c1", 900, 4000)

    const clip = getClipsByIds(db, ["c1"])[0]
    expect(clip?.startMs).toBe(900)
    // A pre-migration clip may well have been trimmed already, so the original is unknowable.
    // Inventing one would report fabricated precision as if it were a measurement.
    expect(clip?.originalStartMs).toBeNull()
    expect(clip?.originalEndMs).toBeNull()
    expect(clip?.pipelineHash).toBeNull()
  })

  // `source` exists to separate model output from hand-made clips, so it has three states, not two.
  it("distinguishes ai, user and pre-migration clips, with no default filling the third in", () => {
    const db = testDb()
    insertProject(db, baseProject)
    // baseClip hardcodes id "c1", so each row overrides it. All three live under p1 — projectId has
    // an FK, and inventing sibling projects here would test the FK rather than the point.
    insertClips(db, [
      { ...baseClip("p1"), id: "c-ai", source: "ai" as const, aiRank: 0, pipelineHash: "abc123" },
      { ...baseClip("p1"), id: "c-user", source: "user" as const },
      // No source: stands in for a row written before the column existed.
      { ...baseClip("p1"), id: "c-legacy" },
    ])

    // getClipsByIds does not promise to preserve input order, so look each row up by id.
    const byId = new Map(getClipsByIds(db, ["c-ai", "c-user", "c-legacy"]).map((c) => [c.id, c]))
    expect(byId.get("c-ai")?.source).toBe("ai")
    expect(byId.get("c-user")?.source).toBe("user")
    expect(byId.get("c-legacy")?.source).toBeNull()

    // The property that matters for #46: only clips that actually came from the model may enter a
    // precision@5 denominator. A default of "ai" would have made the legacy row a false contributor.
    const aiOriginated = [...byId.values()].filter((c) => c.source === "ai")
    expect(aiOriginated).toHaveLength(1)
    expect(aiOriginated[0]?.pipelineHash).toBe("abc123")

    const unknown = [...byId.values()].filter((c) => c.source === null)
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.id).toBe("c-legacy")
  })

  // #97's re-selection path. The whole point is that re-running replaces the model's own output
  // and nothing else: a re-run that deleted an approved clip would destroy the user's decision,
  // and one that deleted an exported clip would discard work already rendered to disk.
  it("replaceClipsByStatus removes only the statuses it is given, leaving user work intact", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertClips(db, [
      { ...baseClip("p1"), id: "c-sug", status: "suggested" },
      { ...baseClip("p1"), id: "c-rej", status: "rejected" },
      { ...baseClip("p1"), id: "c-app", status: "approved" },
      { ...baseClip("p1"), id: "c-exp", status: "exported" },
    ])

    const removed = replaceClipsByStatus(
      db,
      "p1",
      ["suggested", "rejected"],
      [
        { ...baseClip("p1"), id: "c-new-1" },
        { ...baseClip("p1"), id: "c-new-2" },
      ],
    )
    expect(removed).toBe(2)

    const left = getClipsByIds(db, ["c-sug", "c-rej", "c-app", "c-exp", "c-new-1", "c-new-2"]).map(
      (c) => c.id,
    )
    expect(left.sort()).toEqual(["c-app", "c-exp", "c-new-1", "c-new-2"])
  })

  it("replaceClipsByStatus is scoped to one project", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertProject(db, { ...baseProject, id: "p2" })
    insertClips(db, [
      { ...baseClip("p1"), id: "c-p1" },
      { ...baseClip("p2"), id: "c-p2" },
    ])

    expect(replaceClipsByStatus(db, "p1", ["suggested"], [])).toBe(1)
    // Re-running clips on one video must never touch another's suggestions — they share the
    // clips table and differ only by project_id.
    expect(getClipsByIds(db, ["c-p2"]).map((c) => c.id)).toEqual(["c-p2"])
  })

  it("replaceClipsByStatus does nothing for an empty status list", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertClips(db, [baseClip("p1")])
    // An empty inArray is a malformed query that some drivers reject and others silently turn
    // into "delete everything". Refusing it here keeps that ambiguity out of the caller, while
    // still inserting the new rows — a run that legitimately found no old rows must not abort.
    expect(replaceClipsByStatus(db, "p1", [], [{ ...baseClip("p1"), id: "c-new" }])).toBe(0)
    expect(
      getClipsByIds(db, ["c1", "c-new"])
        .map((c) => c.id)
        .sort(),
    ).toEqual(["c-new", "c1"])
  })

  it("replaceClipsByStatus leaves the old set in place when the insert fails", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertClips(db, [
      { ...baseClip("p1"), id: "c-old", status: "suggested" },
      { ...baseClip("p1"), id: "c-keep", status: "approved" },
    ])

    // A duplicate primary key aborts the insert half of the swap. The delete must roll back with
    // it: "no old suggestions and no new ones" is the one outcome a re-run must not produce,
    // because it looks to the user like the run silently ate their clips.
    expect(() =>
      replaceClipsByStatus(
        db,
        "p1",
        ["suggested"],
        [
          { ...baseClip("p1"), id: "c-new" },
          { ...baseClip("p1"), id: "c-new" },
        ],
      ),
    ).toThrow()

    expect(
      getClipsByIds(db, ["c-old", "c-keep", "c-new"])
        .map((c) => c.id)
        .sort(),
    ).toEqual(["c-keep", "c-old"])
  })

  // Social captions are regenerated by a re-run, so the previous row describes a clip that no
  // longer exists. Appending instead would leave two rows and let the panel read the stale one.
  it("replaceAiOutputByType swaps one type and leaves other types alone", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertAiOutput(db, {
      id: "cap-old",
      projectId: "p1",
      type: "social_caption",
      content: '["old"]',
      createdAt: 1000,
    })
    insertAiOutput(db, {
      id: "blog-keep",
      projectId: "p1",
      type: "blog_post",
      content: "keep me",
      createdAt: 1000,
    })

    const replaced = replaceAiOutputByType(db, "p1", "social_caption", {
      id: "cap-new",
      projectId: "p1",
      type: "social_caption",
      content: '["new"]',
      createdAt: 2000,
    })
    expect(replaced).toBe(1)

    const captions = getAiOutputs(db, "p1").filter((o) => o.type === "social_caption")
    expect(captions.map((o) => o.id)).toEqual(["cap-new"])
    expect(getAiOutputs(db, "p1").some((o) => o.id === "blog-keep")).toBe(true)
  })

  it("getAiOutputs returns the newest row first", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertAiOutput(db, {
      id: "cap-1",
      projectId: "p1",
      type: "social_caption",
      content: "[]",
      createdAt: 1000,
    })
    insertAiOutput(db, {
      id: "cap-2",
      projectId: "p1",
      type: "social_caption",
      content: "[]",
      createdAt: 2000,
    })

    // The panel picks with `.find`, so this ordering decides which captions the user sees. Left
    // unordered, "the most recent" is whatever SQLite happens to return first.
    expect(getAiOutputs(db, "p1").map((o) => o.id)).toEqual(["cap-2", "cap-1"])
  })

  // The stored video_analysis is the per-run counterpart to the per-project override (#98): one
  // describes the video as the classifier saw it, the other records the user's disagreement. A
  // re-run replaces the first and leaves the second alone, which is the whole point of splitting
  // them across two tables.
  it("stores one video_analysis per run, replaced on re-run without touching other outputs", () => {
    const db = testDb()
    insertProject(db, baseProject)
    insertAiOutput(db, {
      id: "analysis-old",
      projectId: "p1",
      type: "video_analysis",
      content: '{"profile":"solo_opinion","fallback":true}',
      createdAt: 1000,
    })
    insertAiOutput(db, {
      id: "cap-keep",
      projectId: "p1",
      type: "social_caption",
      content: "keep me",
      createdAt: 1000,
    })

    const replaced = replaceAiOutputByType(db, "p1", "video_analysis", {
      id: "analysis-new",
      projectId: "p1",
      type: "video_analysis",
      content: '{"profile":"conversation","fallback":false}',
      createdAt: 2000,
    })

    expect(replaced).toBe(1)
    const analyses = getAiOutputs(db, "p1").filter((o) => o.type === "video_analysis")
    expect(analyses.map((o) => o.id)).toEqual(["analysis-new"])
    expect(getAiOutputs(db, "p1").some((o) => o.id === "cap-keep")).toBe(true)
  })

  it("clipProfileOverride is null until set, and null again after being cleared", () => {
    const db = testDb()
    insertProject(db, baseProject)

    // Null means "use what the classifier detected". It has to be a real null rather than a
    // sentinel, because every read has to distinguish "no override" from "override to X" without
    // knowing the set of profiles.
    expect(getProject(db, "p1")?.clipProfileOverride).toBeNull()

    setClipProfileOverride(db, "p1", "educational")
    expect(getProject(db, "p1")?.clipProfileOverride).toBe("educational")

    setClipProfileOverride(db, "p1", null)
    expect(getProject(db, "p1")?.clipProfileOverride).toBeNull()
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
function makeLegacySqlite(): Database.Database {
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
  return sqlite
}

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
