import { ipcMain, BrowserWindow, app } from "electron"
import { join } from "path"
import { copyFile, mkdir } from "fs/promises"
import { getDb, projects, words, segments, clips, eq, desc } from "@video-editor/database"
import { generateProxy, extractAudio, resolveFfmpegBinary } from "@video-editor/ffmpeg"
import {
  downloadModel,
  transcribe as whisperTranscribe,
  isModelDownloaded,
  resolveWhisperBinary,
} from "@video-editor/whisper"
import type { WhisperModel } from "@video-editor/types"
import { generateId, now } from "@video-editor/utils"
import type { PipelineProgress, PipelineStage } from "@video-editor/types"
import { whisperToWords, detectFillerWords, detectSilences } from "@video-editor/transcript"

function getResourcesPath(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, "../../../../resources")
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
      if (wordRows.length > 0) {
        db.insert(words).values(wordRows).run()
      }

      db.update(projects)
        .set({ status: "analyzing", updatedAt: now() })
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

      db.update(projects)
        .set({ status: "ready", updatedAt: now() })
        .where(eq(projects.id, projectId))
        .run()

      send("pipeline:complete", { projectId })
    },
  )

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

  ipcMain.handle(
    "export:clips",
    async (_event, { projectId, clipIds }: { projectId: string; clipIds: string[] }) => {
      void projectId
      void clipIds
      return []
    },
  )

  ipcMain.handle("export:full", async (_event, { projectId }: { projectId: string }) => {
    void projectId
    return ""
  })
}
