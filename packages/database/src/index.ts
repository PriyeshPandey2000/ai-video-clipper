import Database from "better-sqlite3"
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import * as schema from "./schema"

export * from "./schema"
export type { BetterSQLite3Database }
export { eq, and, or, desc, asc, sql, inArray } from "drizzle-orm"

let _db: BetterSQLite3Database<typeof schema> | null = null
let _sqlite: Database.Database | null = null

export function getDb(dbPath: string): BetterSQLite3Database<typeof schema> {
  if (_db) return _db
  _sqlite = new Database(dbPath)
  _sqlite.pragma("journal_mode = WAL")
  _sqlite.pragma("foreign_keys = ON")
  bootstrapSchema(_sqlite)
  _db = drizzle(_sqlite, { schema })
  return _db
}

export function closeDb(): void {
  _sqlite?.close()
  _sqlite = null
  _db = null
}

// bootstrapSchema creates tables on first run.
// Column names here MUST match schema.ts — update both when adding columns.
function bootstrapSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      media_path TEXT NOT NULL,
      proxy_path TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS words (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      confidence REAL NOT NULL DEFAULT 1,
      speaker_label TEXT
    );
    CREATE TABLE IF NOT EXISTS clips (
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
    CREATE TABLE IF NOT EXISTS segments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_outputs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)

  // Column migrations for existing databases
  try {
    sqlite.exec(`ALTER TABLE clips ADD COLUMN crop_x REAL NOT NULL DEFAULT 0.5`)
  } catch {
    // column already exists
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN caption_style TEXT`)
  } catch {
    // column already exists
  }
  try {
    sqlite.exec(`ALTER TABLE projects ADD COLUMN filler_words TEXT`)
  } catch {
    // column already exists
  }
}
