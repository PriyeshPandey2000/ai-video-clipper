import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core"

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mediaPath: text("media_path").notNull(),
  proxyPath: text("proxy_path"),
  durationMs: integer("duration_ms").notNull().default(0),
  status: text("status", {
    enum: ["idle", "transcribing", "analyzing", "ready", "error"],
  })
    .notNull()
    .default("idle"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const words = sqliteTable("words", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  text: text("text").notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  confidence: real("confidence").notNull().default(1),
  speakerLabel: text("speaker_label"),
})

export const clips = sqliteTable("clips", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
  aiScore: real("ai_score"),
  aiReason: text("ai_reason"),
  status: text("status", {
    enum: ["suggested", "approved", "rejected", "exported"],
  })
    .notNull()
    .default("suggested"),
  platform: text("platform", {
    enum: ["tiktok", "reels", "shorts", "generic"],
  }),
  createdAt: integer("created_at").notNull(),
})

export const segments = sqliteTable("segments", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["filler", "silence"] }).notNull(),
  startMs: integer("start_ms").notNull(),
  endMs: integer("end_ms").notNull(),
})

export const aiOutputs = sqliteTable("ai_outputs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  type: text("type", {
    enum: ["blog_post", "social_caption", "timestamps", "chapter_markers"],
  }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at").notNull(),
})
