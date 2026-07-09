import { ipcMain, BrowserWindow, app, shell, dialog } from "electron"
import { join } from "path"
import { tmpdir } from "os"
import { copyFile, mkdir, writeFile, unlink } from "fs/promises"
import {
  getDb,
  projects,
  words,
  segments,
  clips,
  aiOutputs,
  eq,
  desc,
  inArray,
} from "@video-editor/database"
import {
  generateProxy,
  extractAudio,
  resolveFfmpegBinary,
  exportClip,
  exportEpisode,
  hasSubtitlesFilter,
} from "@video-editor/ffmpeg"
import {
  downloadModel,
  transcribe as whisperTranscribe,
  isModelDownloaded,
  resolveWhisperBinary,
} from "@video-editor/whisper"
import type { WhisperModel } from "@video-editor/types"
import { generateId, now } from "@video-editor/utils"
import type { PipelineProgress, PipelineStage } from "@video-editor/types"
import {
  whisperToWords,
  detectFillerWords,
  detectSilences,
  wordsToPlainText,
  wordsToTimestampedText,
} from "@video-editor/transcript"
import { createAiClient, selectClips, generateSocialCaptions } from "@video-editor/ai"

function getResourcesPath(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, "../../../../resources")
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function msToSrtTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const millis = ms % 1000
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(millis).padStart(3, "0")}`
}

function buildSrt(wordRows: Array<{ text: string; startMs: number; endMs: number }>): string {
  if (wordRows.length === 0) return ""
  const MAX_WORDS = 8
  const MAX_DURATION_MS = 4000
  const lines: Array<{ start: number; end: number; text: string }> = []
  let i = 0
  while (i < wordRows.length) {
    const lineStart = wordRows[i]!.startMs
    const lineWords: string[] = []
    let lineEnd = lineStart
    while (i < wordRows.length && lineWords.length < MAX_WORDS) {
      const word = wordRows[i]!
      if (
        lineWords.length > 0 &&
        (word.startMs - lineEnd > 1000 || word.endMs - lineStart > MAX_DURATION_MS)
      ) {
        break
      }
      lineWords.push(word.text.trim())
      lineEnd = word.endMs
      i++
    }
    if (lineWords.length > 0) {
      lines.push({ start: lineStart, end: lineEnd, text: lineWords.join(" ") })
    }
  }
  return lines
    .map(
      (line, idx) =>
        `${idx + 1}\n${msToSrtTime(line.start)} --> ${msToSrtTime(line.end)}\n${line.text}\n`,
    )
    .join("\n")
}

function getProjectsDir(): string {
  return join(app.getPath("userData"), "projects")
}

function projectDir(projectId: string): string {
  return join(getProjectsDir(), projectId)
}

export function registerIpcHandlers(): void {
  const dbPath = join(app.getPath("userData"), "db.sqlite")
  const db = getDb(dbPath)

  function send(channel: string, data: unknown): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.send(channel, data)
  }

  function sendProgress(
    projectId: string,
    stage: PipelineStage,
    progress: number,
    message?: string,
  ): void {
    const p: PipelineProgress = { projectId, stage, progress }
    if (message !== undefined) p.message = message
    send("pipeline:progress", p)
  }

  // Runs proxy generation + audio extraction in the background after project:create returns.
  async function runImportPipeline(
    projectId: string,
    sourcePath: string,
    dir: string,
  ): Promise<void> {
    const ffmpegBin = resolveFfmpegBinary(getResourcesPath())
    const proxyPath = join(dir, "proxy.mp4")
    const audioPath = join(dir, "audio.wav")

    try {
      sendProgress(projectId, "analyzing", 0.1, "Generating proxy video")
      await generateProxy({ binaryPath: ffmpegBin, inputPath: sourcePath, outputPath: proxyPath })

      sendProgress(projectId, "analyzing", 0.7, "Extracting audio")
      await extractAudio({ binaryPath: ffmpegBin, inputPath: sourcePath, outputPath: audioPath })

      db.update(projects)
        .set({ proxyPath, updatedAt: now() })
        .where(eq(projects.id, projectId))
        .run()

      sendProgress(projectId, "analyzing", 1, "Ready for transcription")
      send("pipeline:complete", { projectId })
    } catch (err) {
      db.update(projects)
        .set({ status: "error", updatedAt: now() })
        .where(eq(projects.id, projectId))
        .run()
      send("pipeline:error", { projectId, error: String(err) })
    }
  }

  ipcMain.handle("project:list", async () => {
    return db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
  })

  ipcMain.handle("project:get", async (_event, { id }: { id: string }) => {
    return db.select().from(projects).where(eq(projects.id, id)).all()[0] ?? null
  })

  ipcMain.handle("project:get-words", async (_event, { projectId }) => {
    return db.select().from(words).where(eq(words.projectId, projectId)).all()
  })

  ipcMain.handle("project:get-ai-outputs", async (_event, { projectId }) => {
    return db.select().from(aiOutputs).where(eq(aiOutputs.projectId, projectId)).all()
  })

  ipcMain.handle(
    "project:create",
    async (_event, { name, mediaPath }: { name: string; mediaPath: string }) => {
      const id = generateId()
      const dir = projectDir(id)
      await mkdir(dir, { recursive: true })

      const ext = mediaPath.split(".").pop() ?? "mp4"
      const destPath = join(dir, `original.${ext}`)
      await copyFile(mediaPath, destPath)

      const proj = {
        id,
        name,
        mediaPath: destPath,
        proxyPath: null,
        durationMs: 0,
        status: "idle" as const,
        createdAt: now(),
        updatedAt: now(),
      }

      db.insert(projects).values(proj).run()

      // Fire-and-forget: proxy + audio extraction happens in background.
      // Progress arrives via pipeline:progress events. IPC returns immediately.
      void runImportPipeline(id, destPath, dir)

      return proj
    },
  )

  ipcMain.handle(
    "pipeline:start",
    async (_event, { projectId, model }: { projectId: string; model: WhisperModel }) => {
      const proj = db.select().from(projects).where(eq(projects.id, projectId)).all()[0]
      if (!proj) throw new Error(`Project ${projectId} not found`)

      db.update(projects)
        .set({ status: "transcribing", updatedAt: now() })
        .where(eq(projects.id, projectId))
        .run()

      try {
        const modelsDir = join(app.getPath("userData"), "models")
        const audioPath = join(projectDir(projectId), "audio.wav")
        const whisperBin = resolveWhisperBinary(getResourcesPath())

        if (!isModelDownloaded(modelsDir, model)) {
          sendProgress(projectId, "transcribing", 0, `Downloading ${model} model`)
          await downloadModel(modelsDir, model, (pct) => {
            sendProgress(projectId, "transcribing", pct * 0.3, `Downloading ${model} model`)
          })
        }

        sendProgress(projectId, "transcribing", 0.35, "Transcribing audio")

        const result = await whisperTranscribe(
          { binaryPath: whisperBin, modelsDir },
          audioPath,
          model,
          (pct) => {
            sendProgress(projectId, "transcribing", 0.35 + pct * 0.5, "Transcribing audio")
          },
        )

        sendProgress(projectId, "transcribing", 0.9, "Writing transcript to database")

        const wordRows = whisperToWords(result.segments, projectId)
        const durationMs = wordRows[wordRows.length - 1]?.endMs ?? 0
        if (wordRows.length > 0) {
          db.insert(words).values(wordRows).run()
        }

        db.update(projects)
          .set({ status: "analyzing", durationMs, updatedAt: now() })
          .where(eq(projects.id, projectId))
          .run()

        sendProgress(projectId, "analyzing", 0.1, "Detecting filler words")
        const fillerSegments = detectFillerWords(wordRows, projectId)
        if (fillerSegments.length > 0) {
          db.insert(segments).values(fillerSegments).run()
        }

        sendProgress(projectId, "analyzing", 0.6, "Detecting silences")
        const silenceSegments = detectSilences(wordRows, projectId)
        if (silenceSegments.length > 0) {
          db.insert(segments).values(silenceSegments).run()
        }

        // AI content generation — failure here is non-fatal, transcript is still saved
        try {
          const client = createAiClient()

          const timestampedText = wordsToTimestampedText(wordRows)

          sendProgress(projectId, "generating_clips", 0.1, "Analyzing transcript for clips")
          const clipSuggestions = await selectClips(client, timestampedText, durationMs)
          const clipRows = clipSuggestions.map((c) => ({
            id: generateId(),
            projectId,
            title: c.title,
            startMs: c.startMs,
            endMs: c.endMs,
            aiScore: c.score,
            aiReason: c.reason,
            status: "suggested" as const,
            platform: c.platform,
            createdAt: now(),
          }))
          if (clipRows.length > 0) {
            db.insert(clips).values(clipRows).run()
          }

          if (clipSuggestions.length > 0) {
            sendProgress(projectId, "generating_content", 0.7, "Generating social captions")
            const topClip = clipSuggestions[0]!
            const clipWords = wordRows.filter(
              (w) => w.startMs >= topClip.startMs && w.endMs <= topClip.endMs,
            )
            const clipText = wordsToPlainText(clipWords)
            const captions = await generateSocialCaptions(client, topClip.title, clipText)
            db.insert(aiOutputs)
              .values({
                id: generateId(),
                projectId,
                type: "social_caption",
                content: JSON.stringify(captions),
                createdAt: now(),
              })
              .run()
          }
        } catch (err) {
          console.warn(
            "AI stage failed (GROQ_API_KEY missing or AI error) — transcript saved:",
            String(err),
          )
        }

        db.update(projects)
          .set({ status: "ready", updatedAt: now() })
          .where(eq(projects.id, projectId))
          .run()

        send("pipeline:complete", { projectId })
      } catch (err) {
        db.update(projects)
          .set({ status: "error", updatedAt: now() })
          .where(eq(projects.id, projectId))
          .run()
        send("pipeline:error", { projectId, error: String(err) })
      }
    },
  )

  ipcMain.handle("clip:list", async (_event, { projectId }) => {
    return db.select().from(clips).where(eq(clips.projectId, projectId)).all()
  })

  ipcMain.handle(
    "clip:update-status",
    async (
      _event,
      {
        clipId,
        status,
      }: { clipId: string; status: "suggested" | "approved" | "rejected" | "exported" },
    ) => {
      db.update(clips).set({ status }).where(eq(clips.id, clipId)).run()
    },
  )

  ipcMain.handle("ffmpeg:has-subtitles-filter", async () => {
    return hasSubtitlesFilter(resolveFfmpegBinary(getResourcesPath()))
  })

  ipcMain.handle(
    "dialog:pick-folder",
    async (_event, { defaultPath }: { defaultPath?: string }) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        defaultPath: defaultPath ?? app.getPath("downloads"),
      })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
  )

  ipcMain.handle(
    "export:clips",
    async (
      _event,
      {
        projectId,
        clipIds,
        outputDir,
        burnSubtitles = true,
      }: { projectId: string; clipIds: string[]; outputDir?: string; burnSubtitles?: boolean },
    ) => {
      const db = getDb(join(app.getPath("userData"), "db.sqlite"))
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
      if (!project) throw new Error("Project not found")

      const clipRows =
        clipIds.length > 0 ? db.select().from(clips).where(inArray(clips.id, clipIds)).all() : []

      const ffmpegBin = resolveFfmpegBinary(getResourcesPath())
      const outDir = outputDir ?? join(app.getPath("downloads"), sanitizeName(project.name))
      await mkdir(outDir, { recursive: true })

      const wordRows = burnSubtitles
        ? db.select().from(words).where(eq(words.projectId, projectId)).all()
        : []

      const exportedPaths: string[] = []
      for (const clip of clipRows) {
        const outPath = join(outDir, `${sanitizeName(clip.title)}.mp4`)

        let srtPath: string | undefined
        if (burnSubtitles) {
          const clipWords = wordRows
            .filter((w) => w.startMs >= clip.startMs && w.endMs <= clip.endMs)
            .map((w) => ({
              ...w,
              startMs: w.startMs - clip.startMs,
              endMs: w.endMs - clip.startMs,
            }))
          if (clipWords.length > 0) {
            srtPath = join(tmpdir(), `clip-${clip.id}.srt`)
            await writeFile(srtPath, buildSrt(clipWords), "utf-8")
          }
        }

        try {
          await exportClip({
            binaryPath: ffmpegBin,
            inputPath: project.mediaPath,
            outputPath: outPath,
            startMs: clip.startMs,
            endMs: clip.endMs,
            ...(srtPath ? { srtPath } : {}),
          })
        } finally {
          if (srtPath) await unlink(srtPath).catch(() => {})
        }

        db.update(clips).set({ status: "exported" }).where(eq(clips.id, clip.id)).run()
        exportedPaths.push(outPath)
      }
      return exportedPaths
    },
  )

  ipcMain.handle(
    "export:full",
    async (
      _event,
      {
        projectId,
        outputDir,
        burnSubtitles = true,
      }: { projectId: string; outputDir?: string; burnSubtitles?: boolean },
    ) => {
      const db = getDb(join(app.getPath("userData"), "db.sqlite"))
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
      if (!project) throw new Error("Project not found")

      const segs = db.select().from(segments).where(eq(segments.projectId, projectId)).all()
      const sorted = [...segs].sort((a, b) => a.startMs - b.startMs)
      const keepIntervals: { startMs: number; endMs: number }[] = []
      let cursor = 0
      for (const seg of sorted) {
        if (seg.startMs > cursor) keepIntervals.push({ startMs: cursor, endMs: seg.startMs })
        cursor = Math.max(cursor, seg.endMs)
      }
      if (cursor < project.durationMs)
        keepIntervals.push({ startMs: cursor, endMs: project.durationMs })
      if (keepIntervals.length === 0) keepIntervals.push({ startMs: 0, endMs: project.durationMs })

      const ffmpegBin = resolveFfmpegBinary(getResourcesPath())
      const outDir = outputDir ?? join(app.getPath("downloads"), sanitizeName(project.name))
      await mkdir(outDir, { recursive: true })
      const outPath = join(outDir, `${sanitizeName(project.name)}_episode.mp4`)

      let srtPath: string | undefined
      if (burnSubtitles) {
        const wordRows = db.select().from(words).where(eq(words.projectId, projectId)).all()
        if (wordRows.length > 0) {
          srtPath = join(tmpdir(), `episode-${projectId}.srt`)
          await writeFile(srtPath, buildSrt(wordRows), "utf-8")
        }
      }

      try {
        await exportEpisode({
          binaryPath: ffmpegBin,
          inputPath: project.mediaPath,
          outputPath: outPath,
          keepIntervals,
          ...(srtPath ? { srtPath } : {}),
        })
      } finally {
        if (srtPath) await unlink(srtPath).catch(() => {})
      }
      return outPath
    },
  )

  ipcMain.handle(
    "export:srt",
    async (_event, { projectId, outputDir }: { projectId: string; outputDir?: string }) => {
      const db = getDb(join(app.getPath("userData"), "db.sqlite"))
      const project = db.select().from(projects).where(eq(projects.id, projectId)).get()
      if (!project) throw new Error("Project not found")

      const wordRows = db.select().from(words).where(eq(words.projectId, projectId)).all()
      const srtContent = buildSrt(wordRows)

      const outDir = outputDir ?? join(app.getPath("downloads"), sanitizeName(project.name))
      await mkdir(outDir, { recursive: true })
      const outPath = join(outDir, `${sanitizeName(project.name)}.srt`)
      await writeFile(outPath, srtContent, "utf-8")
      return outPath
    },
  )

  ipcMain.handle("shell:show-item", async (_event, { path }: { path: string }) => {
    shell.showItemInFolder(path)
  })
}
