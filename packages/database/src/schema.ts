import { index, sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core"
import { CLIP_PROFILE_IDS } from "@video-editor/types"

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
  captionStyle: text("caption_style"),
  fillerWords: text("filler_words"),
  /**
   * The user's chosen clip profile, overriding what the classifier detected (#98).
   *
   * Nullable with no default, and deliberately so: NULL means "use the detected profile", which is
   * the state every project is in until someone overrides it. An empty string or a sentinel like
   * "auto" would have to be distinguished from a real value on every read, and this column already
   * has a null that means exactly the right thing.
   *
   * Overriding writes no new transcript: the analysis is re-derived from the stored words on the
   * re-run that follows, so an override is always about the same video and never drifts from it.
   */
  clipProfileOverride: text("clip_profile_override", { enum: CLIP_PROFILE_IDS }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})

export const words = sqliteTable(
  "words",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    confidence: real("confidence").notNull().default(1),
    speakerLabel: text("speaker_label"),
  },
  // SQLite does not auto-index foreign-key columns — every repository query filters by
  // project_id, so each child table needs its own index.
  (table) => ({ wordsProjectIdIdx: index("words_project_id_idx").on(table.projectId) }),
)

export const clips = sqliteTable(
  "clips",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    aiScore: real("ai_score"),
    aiReason: text("ai_reason"),
    /**
     * The judge's verdict on this clip's exact exported range (#99): graded answers, the questions
     * they answer, a one-line note and the score. JSON, parsed by `parseClipJudge`.
     *
     * Nullable with no default: NULL means "never judged" — a clip written before #99, or one the
     * user cut by hand. An empty object would read as a judgement that found nothing.
     */
    judgeJson: text("judge_json"),
    status: text("status", {
      enum: ["suggested", "approved", "rejected", "exported"],
    })
      .notNull()
      .default("suggested"),
    platform: text("platform", {
      enum: ["tiktok", "reels", "shorts", "generic"],
    }),
    cropX: real("crop_x").notNull().default(0.5),
    createdAt: integer("created_at").notNull(),
    // ── Provenance (#89) ──────────────────────────────────────────────────────
    // The AI's cut as first written, preserved across user trims. setClipTimes overwrites
    // startMs/endMs in place, so without these the only record of what the model chose is lost
    // on the first drag. Null on rows written before this migration — the pre-migration value is
    // not knowable, and guessing would poison boundary-error stats with fabricated provenance.
    originalStartMs: integer("original_start_ms"),
    originalEndMs: integer("original_end_ms"),
    /** 0-based position in the ranked output the model produced. */
    aiRank: integer("ai_rank"),
    /** Hand-bumped label for the selection code, e.g. "v1-unmeasured". See PIPELINE_VERSION. */
    pipelineVersion: text("pipeline_version"),
    /** sha256 of every prompt template and threshold the selection path reads. Source of truth. */
    pipelineHash: text("pipeline_hash"),
    /** Model that served the structured clip-selection calls, e.g. "openai/gpt-oss-120b". */
    aiModel: text("ai_model"),
    /**
     * The genre profile the selection prompt was swapped to, so "which rubric produced this clip?"
     * is answerable from the clip alone (#89, widened to profile ids in #98).
     *
     * The enum is TypeScript-only — drizzle's `text({ enum })` emits plain `text` with no CHECK
     * constraint — so widening it from the old content types changed no SQL and rows written before
     * #98 still hold `interview`/`tutorial`/`solo`/`generic` verbatim. Those values are left
     * untouched on purpose: rewriting them would mean guessing what a pre-#98 `solo` row was
     * really closest to, and a fabricated profile is worse than a stale one.
     */
    contentType: text("content_type", { enum: CLIP_PROFILE_IDS }),
    // ── Clip origin (#46 taste tier; added in #97) ─────────────────────────────
    // Who authored this clip: the selection pipeline, or the user by hand.
    //
    // Deliberately nullable with NO default, and that is the whole point. Three states:
    //   "ai"    — written by selectClips
    //   "user"  — authored manually
    //   NULL    — written before this migration, so the origin is not knowable
    // Defaulting to "ai" would label every pre-migration row as model output and silently inflate
    // the denominator of precision@5 (#46's taste tier) with hand-made or legacy clips. NULL keeps
    // "we don't know" distinguishable from "the model chose this", exactly as the nullable
    // provenance columns above do.
    source: text("source", { enum: ["ai", "user"] }),
  },
  (table) => ({
    clipsProjectIdIdx: index("clips_project_id_idx").on(table.projectId),
    // Provenance reports (#46 taste tier, #89) aggregate across projects by hash and rank.
    clipsPipelineHashIdx: index("clips_pipeline_hash_idx").on(table.pipelineHash),
  }),
)

export const segments = sqliteTable(
  "segments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["filler", "silence"] }).notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
  },
  (table) => ({ segmentsProjectIdIdx: index("segments_project_id_idx").on(table.projectId) }),
)

export const aiOutputs = sqliteTable(
  "ai_outputs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type", {
      // "video_analysis" (#98) is the JSON `VideoAnalysis` from the pre-selection LLM call. It
      // lives here rather than in a column because it is a per-run artifact with a natural
      // replace-on-rerun lifecycle, which `replaceAiOutputByType` already implements for the
      // social captions.
      enum: ["blog_post", "social_caption", "timestamps", "chapter_markers", "video_analysis"],
    }).notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({ aiOutputsProjectIdIdx: index("ai_outputs_project_id_idx").on(table.projectId) }),
)
