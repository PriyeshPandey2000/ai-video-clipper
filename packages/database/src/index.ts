import Database from "better-sqlite3"
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { and, desc, eq, inArray } from "drizzle-orm"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as schema from "./schema"
import { aiOutputs, clips, projects, segments, words } from "./schema"

export * from "./schema"
export type { BetterSQLite3Database }

export type Db = BetterSQLite3Database<typeof schema>
export type ProjectRow = typeof projects.$inferSelect
export type NewProject = typeof projects.$inferInsert
export type WordRow = typeof words.$inferSelect
export type NewWord = typeof words.$inferInsert
export type ClipRow = typeof clips.$inferSelect
export type NewClip = typeof clips.$inferInsert
export type SegmentRow = typeof segments.$inferSelect
export type NewSegment = typeof segments.$inferInsert
export type AiOutputRow = typeof aiOutputs.$inferSelect
export type NewAiOutput = typeof aiOutputs.$inferInsert
export type ProjectStatus = ProjectRow["status"]
export type ClipStatus = ClipRow["status"]

// SQLite's bound-parameter limit (SQLITE_MAX_VARIABLE_NUMBER) is 999 in the most conservative
// common builds. A single multi-row insert binds rows.length * columnsPerRow parameters — a
// long transcript's word count clears that easily (better-sqlite3 throws "too many SQL
// variables" around ~140 word rows at 7 columns each). Split into batches that stay under it.
const SQLITE_MAX_VARIABLES = 999

export function insertBatched<T>(
  insertFn: (batch: T[]) => void,
  rows: T[],
  columnsPerRow: number,
): void {
  if (
    !Number.isInteger(columnsPerRow) ||
    columnsPerRow < 1 ||
    columnsPerRow > SQLITE_MAX_VARIABLES
  ) {
    throw new Error(
      `insertBatched: columnsPerRow must be an integer between 1 and ${SQLITE_MAX_VARIABLES}, got ${columnsPerRow}`,
    )
  }
  if (rows.length === 0) return
  const batchSize = Math.floor(SQLITE_MAX_VARIABLES / columnsPerRow)
  for (let i = 0; i < rows.length; i += batchSize) {
    insertFn(rows.slice(i, i + batchSize))
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

// Legacy databases were first-run-created by raw CREATE TABLE DDL (bootstrapSchema) before
// migrations existed. That DDL matches 0000_initial-schema exactly, so replaying it would fail
// on existing tables. Instead, stamp the FIRST migration's journal timestamp as already applied:
// drizzle's migrator skips migrations whose folderMillis is <= that value, so 0000 is skipped
// while every later migration (generated after it, larger timestamp) still applies. Using a
// runtime Date.now() here would be wrong — a user skipping several app versions would baseline
// above migrations generated before "now", and those would be silently skipped, leaving their
// schema permanently behind.
function baselineLegacyDb(sqlite: Database.Database, migrationsFolder: string): void {
  const hasTables =
    (
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'words', 'clips', 'segments', 'ai_outputs')",
        )
        .get() as { n: number } | undefined
    )?.n === 5

  const migrationTableExists = !!sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get()

  if (!hasTables || (migrationTableExists && hasAppliedMigrations(sqlite))) return

  // No journal (or no entries) means there is nothing to skip — let migrate() handle everything.
  const firstMigrationWhen = readFirstMigrationTimestamp(migrationsFolder)
  if (firstMigrationWhen === null) return

  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT, created_at NUMERIC)',
  )
  sqlite
    .prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)')
    .run("legacy-bootstrap-baseline", firstMigrationWhen)
}

function readFirstMigrationTimestamp(migrationsFolder: string): number | null {
  try {
    const journalPath = join(migrationsFolder, "meta", "_journal.json")
    const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
      entries?: { when?: number }[]
    }
    const when = journal.entries?.[0]?.when
    return typeof when === "number" ? when : null
  } catch {
    return null
  }
}

function hasAppliedMigrations(sqlite: Database.Database): boolean {
  const row = sqlite.prepare('SELECT COUNT(*) AS n FROM "__drizzle_migrations"').get() as
    { n: number } | undefined
  return (row?.n ?? 0) > 0
}

export function createDb(sqlite: Database.Database, migrationsFolder: string): Db {
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  baselineLegacyDb(sqlite, migrationsFolder)
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder })
  return db
}

let _db: Db | null = null
let _sqlite: Database.Database | null = null

export function initDb(dbPath: string, migrationsFolder: string): Db {
  if (_db) throw new Error("initDb called twice — the database is opened exactly once at startup")
  _sqlite = new Database(dbPath)
  _db = createDb(_sqlite, migrationsFolder)
  return _db
}

export function closeDb(): void {
  _sqlite?.close()
  _sqlite = null
  _db = null
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function listProjects(db: Db): ProjectRow[] {
  return db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
}

export function getProject(db: Db, id: string): ProjectRow | null {
  return db.select().from(projects).where(eq(projects.id, id)).get() ?? null
}

export function insertProject(db: Db, project: NewProject): void {
  db.insert(projects).values(project).run()
}

export function updateProjectImportResult(
  db: Db,
  projectId: string,
  proxyPath: string,
  durationMs: number,
): void {
  db.update(projects)
    .set({ proxyPath, durationMs, updatedAt: Date.now() })
    .where(eq(projects.id, projectId))
    .run()
}

export function setProjectStatus(db: Db, projectId: string, status: ProjectStatus): void {
  db.update(projects).set({ status, updatedAt: Date.now() }).where(eq(projects.id, projectId)).run()
}

export function setCaptionStyle(db: Db, projectId: string, captionStyleJson: string): void {
  db.update(projects)
    .set({ captionStyle: captionStyleJson, updatedAt: Date.now() })
    .where(eq(projects.id, projectId))
    .run()
}

// Atomic read-modify-write: the filler word list update, deletion of the previous filler
// segments, and insertion of the recomputed ones must land together or a failure partway
// through leaves the word list updated but segments half-written.
export function setFillerWords(
  db: Db,
  projectId: string,
  fillerWordsJson: string,
  fillerSegments: NewSegment[],
): void {
  db.transaction((tx) => {
    tx.update(projects)
      .set({ fillerWords: fillerWordsJson, updatedAt: Date.now() })
      .where(eq(projects.id, projectId))
      .run()
    tx.delete(segments)
      .where(and(eq(segments.projectId, projectId), eq(segments.type, "filler")))
      .run()
    insertBatched((batch) => tx.insert(segments).values(batch).run(), fillerSegments, 5)
  })
}

// ---------------------------------------------------------------------------
// Words / segments / AI outputs
// ---------------------------------------------------------------------------

export function getWords(db: Db, projectId: string): WordRow[] {
  return db.select().from(words).where(eq(words.projectId, projectId)).all()
}

export function getSegments(db: Db, projectId: string): SegmentRow[] {
  return db.select().from(segments).where(eq(segments.projectId, projectId)).all()
}

export function getAiOutputs(db: Db, projectId: string): AiOutputRow[] {
  return db.select().from(aiOutputs).where(eq(aiOutputs.projectId, projectId)).all()
}

// Everything regenerated when a transcript is re-run: derived data, never source media. One
// transaction — a partial clear followed by re-inserts would mix stale clips/outputs with a
// fresh transcript.
export function clearDerivedData(db: Db, projectId: string): void {
  db.transaction((tx) => {
    tx.delete(words).where(eq(words.projectId, projectId)).run()
    tx.delete(segments).where(eq(segments.projectId, projectId)).run()
    tx.delete(clips).where(eq(clips.projectId, projectId)).run()
    tx.delete(aiOutputs).where(eq(aiOutputs.projectId, projectId)).run()
  })
}

export function insertWords(db: Db, rows: NewWord[]): void {
  // A long transcript's word insert can take dozens of batches (see insertBatched) — wrap in a
  // transaction so a failure partway through can't leave a half-written transcript.
  db.transaction((tx) => {
    insertBatched((batch) => tx.insert(words).values(batch).run(), rows, 7)
  })
}

export function insertSegments(db: Db, rows: NewSegment[]): void {
  db.transaction((tx) => {
    insertBatched((batch) => tx.insert(segments).values(batch).run(), rows, 5)
  })
}

export function insertAiOutput(db: Db, row: NewAiOutput): void {
  db.insert(aiOutputs).values(row).run()
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export function getClips(db: Db, projectId: string): ClipRow[] {
  return db.select().from(clips).where(eq(clips.projectId, projectId)).all()
}

export function getClipsByIds(db: Db, ids: string[]): ClipRow[] {
  return ids.length > 0 ? db.select().from(clips).where(inArray(clips.id, ids)).all() : []
}

export function setClipStatus(db: Db, clipId: string, status: ClipStatus): void {
  db.update(clips).set({ status }).where(eq(clips.id, clipId)).run()
}

// Resizing an exported clip demotes it back to approved so it re-exports cleanly.
export function setClipTimes(db: Db, clipId: string, startMs: number, endMs: number): void {
  const clip = getClip(db, clipId)
  const status = clip?.status === "exported" ? "approved" : undefined
  db.update(clips)
    .set({ startMs, endMs, ...(status ? { status } : {}) })
    .where(eq(clips.id, clipId))
    .run()
}

export function setClipCropX(db: Db, clipId: string, cropX: number): void {
  db.update(clips).set({ cropX }).where(eq(clips.id, clipId)).run()
}

export function markClipExported(db: Db, clipId: string): void {
  db.update(clips).set({ status: "exported" }).where(eq(clips.id, clipId)).run()
}

function getClip(db: Db, clipId: string): ClipRow | undefined {
  return db.select().from(clips).where(eq(clips.id, clipId)).get()
}

export function insertClips(db: Db, rows: NewClip[]): void {
  if (rows.length === 0) return
  db.insert(clips).values(rows).run()
}
