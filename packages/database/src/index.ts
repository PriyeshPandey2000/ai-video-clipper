import Database from "better-sqlite3"
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3"
import * as schema from "./schema"

export * from "./schema"
export type { BetterSQLite3Database }

let _db: BetterSQLite3Database<typeof schema> | null = null

export function getDb(dbPath: string): BetterSQLite3Database<typeof schema> {
  if (_db) return _db
  const sqlite = new Database(dbPath)
  sqlite.pragma("journal_mode = WAL")
  sqlite.pragma("foreign_keys = ON")
  _db = drizzle(sqlite, { schema })
  return _db
}

export function closeDb(): void {
  _db = null
}
