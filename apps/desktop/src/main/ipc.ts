import { ipcMain, BrowserWindow, app, shell, dialog } from "electron"
import { join } from "path"
import { tmpdir } from "os"
import { copyFile, mkdir, writeFile, unlink } from "fs/promises"
import {
  initDb,
  listProjects,
  getProject,
  insertProject,
  updateProjectImportResult,
  setProjectStatus,
  setCaptionStyle,
  setFillerWords,
  clearDerivedData,
  insertWords,
  insertSegments,
  insertClips,
  insertAiOutput,
  getWords,
  getSegments,
  getClips,
  getClipsByIds,
  getAiOutputs,
  setClipStatus,
  setClipTimes,
  setClipCropX,
  markClipExported,
} from "@video-editor/database"
import {
  generateProxy,
  extractAudio,
  probeDuration,
  resolveFfmpegBinary,
  exportClip,
  exportEpisode,
  hasSubtitlesFilter,
  measureArousal,
  subtractSegments,
  EmptyClipError,
} from "@video-editor/ffmpeg"
import {
  downloadModel,
  transcribe as whisperTranscribe,
  isModelDownloaded,
  getModelSizeOnDisk,
  deleteModel,
  resolveWhisperBinary,
} from "@video-editor/whisper"
import type { WhisperModel, ModelInfo } from "@video-editor/types"
import { WHISPER_MODELS } from "@video-editor/types"
import { generateId, now } from "@video-editor/utils"
import type {
  PipelineProgress,
  PipelineStage,
  IpcInvokeChannels,
  IpcEventChannels,
} from "@video-editor/types"
import {
  whisperToWords,
  detectFillerWords,
  detectSilences,
  wordsToPlainText,
  buildSentences,
  segmentTopics,
  DEFAULT_FILLER_WORDS,
} from "@video-editor/transcript"
import { createAiClient, selectClips, generateSocialCaptions } from "@video-editor/ai"
import { sanitizeName, buildSrt, remapWordsToEpisodeTimeline } from "@video-editor/export"
import { saveGroqApiKey } from "./config"
import log from "./logger"
import { beginActivity, endActivity } from "./activity"
import { downloadUpdate, restartAndInstall } from "./updater"
import { buildAssFile } from "@video-editor/captions"
import type { CaptionStyle } from "@video-editor/types"

// Typed wrapper around ipcMain.handle — channel and callback args are checked against
// IpcInvokeChannels, so a renamed/retyped channel is a compile error on the main side too
// (the renderer side was already checked via IpcInvokeChannels in preload/env.d.ts).
function handle<K extends keyof IpcInvokeChannels>(
  channel: K,
  listener: (
    event: Electron.IpcMainInvokeEvent,
    args: IpcInvokeChannels[K]["args"],
  ) => IpcInvokeChannels[K]["result"] | Promise<IpcInvokeChannels[K]["result"]>,
): void {
  ipcMain.handle(
    channel,
    listener as (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  )
}

// Both branches must return a path whose direct children are ffmpeg/whisper/fonts. In dev this
// is the repo's own resources/ folder. In a packaged app, process.resourcesPath is
// Contents/Resources — but electron-builder's extraResources config here has `to: "resources/"`,
// which nests everything one level deeper at Contents/Resources/resources/. Missing that extra
// segment meant every resolveFfmpegBinary/resolveWhisperBinary/font-path call in a packaged
// build silently fell through to each function's PATH-based fallback, which fails on a
// GUI-launched app (no Homebrew dirs in its PATH) — this was never caught before because every
// earlier verification ran the bundled binaries directly via absolute paths, never through this
// function.
function getResourcesPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "resources")
    : join(__dirname, "../../../../resources")
}

function getProjectsDir(): string {
  return join(app.getPath("userData"), "projects")
}

function projectDir(projectId: string): string {
  return join(getProjectsDir(), projectId)
}

export function registerIpcHandlers(): void {
  const resourcesPath = getResourcesPath()
  log.info("Resolved binary paths", {
    resourcesPath,
    ffmpeg: resolveFfmpegBinary(resourcesPath),
    whisper: resolveWhisperBinary(resourcesPath),
  })

  const dbPath = join(app.getPath("userData"), "db.sqlite")
  // Migrations ride the same resources/ packaging path as ffmpeg/whisper/fonts (see
  // getResourcesPath above and the v0.1.2 resourcesPath incident) — drizzle's migrator reads
  // the .sql files from this folder at runtime.
  const db = initDb(dbPath, join(getResourcesPath(), "drizzle"))

  function send<K extends keyof IpcEventChannels>(channel: K, data: IpcEventChannels[K]): void {
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

    // beginActivity() was already called by project:create, before the media copy — this
    // closes that same scope once the whole background pipeline (not just the copy) finishes.
    try {
      sendProgress(projectId, "analyzing", 0.1, "Generating proxy video")
      await generateProxy({ binaryPath: ffmpegBin, inputPath: sourcePath, outputPath: proxyPath })

      sendProgress(projectId, "analyzing", 0.7, "Extracting audio")
      await extractAudio({ binaryPath: ffmpegBin, inputPath: sourcePath, outputPath: audioPath })

      const durationMs = await probeDuration(ffmpegBin, sourcePath)

      updateProjectImportResult(db, projectId, proxyPath, durationMs)

      sendProgress(projectId, "analyzing", 1, "Ready for transcription")
      send("pipeline:complete", { projectId })
    } catch (err) {
      log.error(`Import pipeline failed for project ${projectId}`, err)
      setProjectStatus(db, projectId, "error")
      send("pipeline:error", { projectId, error: String(err) })
    } finally {
      endActivity()
    }
  }

  handle("project:list", async () => {
    return listProjects(db)
  })

  handle("project:get", async (_event, { id }: { id: string }) => {
    return getProject(db, id)
  })

  handle("project:get-words", async (_event, { projectId }) => {
    return getWords(db, projectId)
  })

  handle("project:get-ai-outputs", async (_event, { projectId }) => {
    return getAiOutputs(db, projectId)
  })

  handle(
    "project:create",
    async (_event, { name, mediaPath }: { name: string; mediaPath: string }) => {
      const id = generateId()
      const dir = projectDir(id)
      await mkdir(dir, { recursive: true })

      const ext = mediaPath.split(".").pop() ?? "mp4"
      const destPath = join(dir, `original.${ext}`)

      // Opened here, before the media copy, closed inside runImportPipeline once the whole
      // background pipeline finishes — copyFile and the async import both count as "busy" so
      // the auto-updater can't restart mid-copy or mid-import. If the copy itself throws,
      // runImportPipeline never runs to close it, so close it here instead.
      beginActivity()
      try {
        await copyFile(mediaPath, destPath)
      } catch (err) {
        endActivity()
        throw err
      }

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

      insertProject(db, proj)

      // Fire-and-forget: proxy + audio extraction happens in background.
      // Progress arrives via pipeline:progress events. IPC returns immediately.
      void runImportPipeline(id, destPath, dir)

      return proj
    },
  )

  handle(
    "pipeline:start",
    async (_event, { projectId, model }: { projectId: string; model: WhisperModel }) => {
      const proj = getProject(db, projectId)
      if (!proj) throw new Error(`Project ${projectId} not found`)
      if (proj.status === "transcribing" || proj.status === "analyzing") {
        log.warn(`pipeline:start ignored — project ${projectId} already ${proj.status}`)
        return
      }

      setProjectStatus(db, projectId, "transcribing")
      beginActivity()

      try {
        const modelsDir = join(app.getPath("userData"), "models")
        const audioPath = join(projectDir(projectId), "audio.wav")
        const whisperBin = resolveWhisperBinary(getResourcesPath())

        if (!isModelDownloaded(modelsDir, model)) {
          sendProgress(projectId, "transcribing", 0, `Downloading ${model} model`)
          await ensureModelDownloaded(modelsDir, model, (pct) => {
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

        clearDerivedData(db, projectId)

        const wordRows = whisperToWords(result.segments, projectId)
        if (wordRows.length > 0) {
          insertWords(db, wordRows)
        }

        setProjectStatus(db, projectId, "analyzing")

        sendProgress(projectId, "analyzing", 0.1, "Detecting filler words")
        const fillerSegments = detectFillerWords(wordRows, projectId)
        if (fillerSegments.length > 0) {
          insertSegments(db, fillerSegments)
        }

        sendProgress(projectId, "analyzing", 0.6, "Detecting silences")
        const silenceSegments = detectSilences(wordRows, projectId)
        if (silenceSegments.length > 0) {
          insertSegments(db, silenceSegments)
        }

        // AI content generation — failure here is non-fatal, transcript is still saved
        try {
          const client = createAiClient()
          const ffmpegBin = resolveFfmpegBinary(getResourcesPath())

          const sentences = buildSentences(wordRows)

          sendProgress(projectId, "generating_clips", 0.05, "Segmenting topics")
          const topics = await segmentTopics(sentences, modelsDir)
          log.info(`[topics] ${topics.length} segment(s) found`)

          sendProgress(projectId, "generating_clips", 0.07, "Measuring audio arousal")
          const arousalPerSec = await measureArousal(ffmpegBin, audioPath)
          log.info(`[arousal] ${arousalPerSec.length} seconds measured`)

          sendProgress(projectId, "generating_clips", 0.1, "Analyzing transcript for clips")
          const { clips: clipSuggestions, rejected } = await selectClips(
            client,
            wordRows,
            sentences,
            topics,
            10,
            arousalPerSec,
          )
          if (rejected.length > 0) {
            log.info(
              `[clips] ${clipSuggestions.length} kept, ${rejected.length} dropped by quality gate:`,
              rejected.map((r) => `${r.title} (${r.reasons.join(", ")})`).join(" | "),
            )
          }
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
            insertClips(db, clipRows)
          }

          if (clipSuggestions.length > 0) {
            sendProgress(projectId, "generating_content", 0.7, "Generating social captions")
            const topClip = clipSuggestions[0]!
            const clipWords = wordRows.filter(
              (w) => w.startMs >= topClip.startMs && w.endMs <= topClip.endMs,
            )
            const clipText = wordsToPlainText(clipWords)
            const captions = await generateSocialCaptions(client, topClip.title, clipText)
            insertAiOutput(db, {
              id: generateId(),
              projectId,
              type: "social_caption",
              content: JSON.stringify(captions),
              createdAt: now(),
            })
          }
        } catch (err) {
          log.warn("AI stage failed (GROQ_API_KEY missing or AI error) — transcript saved:", err)
        }

        setProjectStatus(db, projectId, "ready")

        send("pipeline:complete", { projectId })
      } catch (err) {
        log.error(`Transcription pipeline failed for project ${projectId}`, err)
        setProjectStatus(db, projectId, "error")
        send("pipeline:error", { projectId, error: String(err) })
      } finally {
        endActivity()
      }
    },
  )

  handle("clip:list", async (_event, { projectId }) => {
    return getClips(db, projectId)
  })

  handle(
    "clip:update-status",
    async (
      _event,
      {
        clipId,
        status,
      }: { clipId: string; status: "suggested" | "approved" | "rejected" | "exported" },
    ) => {
      setClipStatus(db, clipId, status)
    },
  )

  handle(
    "clip:update-times",
    async (
      _event,
      { clipId, startMs, endMs }: { clipId: string; startMs: number; endMs: number },
    ) => {
      setClipTimes(db, clipId, startMs, endMs)
    },
  )

  handle(
    "clip:update-crop-x",
    async (_event, { clipId, cropX }: { clipId: string; cropX: number }) => {
      setClipCropX(db, clipId, cropX)
    },
  )

  handle("ffmpeg:has-subtitles-filter", async () => {
    return hasSubtitlesFilter(resolveFfmpegBinary(getResourcesPath()))
  })

  handle("dialog:pick-folder", async (_event, { defaultPath }: { defaultPath?: string }) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      defaultPath: defaultPath ?? app.getPath("downloads"),
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(
    "export:clips",
    async (
      _event,
      {
        projectId,
        clipIds,
        outputDir,
        burnSubtitles = true,
        reframe = false,
        blurBg = false,
        removeFillers = true,
        captionStyle,
      }: {
        projectId: string
        clipIds: string[]
        outputDir?: string
        burnSubtitles?: boolean
        reframe?: boolean
        blurBg?: boolean
        removeFillers?: boolean
        captionStyle?: CaptionStyle
      },
    ) => {
      const project = getProject(db, projectId)
      if (!project) throw new Error("Project not found")

      const clipRows = getClipsByIds(db, clipIds)

      const ffmpegBin = resolveFfmpegBinary(getResourcesPath())
      const fontsDir = join(getResourcesPath(), "fonts")
      const outDir = outputDir ?? join(app.getPath("downloads"), sanitizeName(project.name))
      await mkdir(outDir, { recursive: true })

      const useAnimated = burnSubtitles && captionStyle && captionStyle.preset !== "none"
      const wordRows = burnSubtitles ? getWords(db, projectId) : []

      // D7 — query segments once; subtractSegments computes keep intervals per clip.
      const allSegs = getSegments(db, projectId)

      const exportedPaths: string[] = []
      beginActivity()
      try {
        for (let ci = 0; ci < clipRows.length; ci++) {
          const clip = clipRows[ci]!
          const outPath = join(outDir, `${sanitizeName(clip.title)}.mp4`)

          // Segments that fall inside this clip's range. Individual clip export can opt out of
          // filler/silence removal (unlike episode cleanup, aggressive cutting can hurt a short
          // clip's rhythm — see docs/IMPROVEMENTS.md).
          const clipSegs = removeFillers
            ? allSegs.filter((s) => s.startMs < clip.endMs && s.endMs > clip.startMs)
            : []
          const keepIntervals =
            clipSegs.length > 0
              ? subtractSegments(clip.startMs, clip.endMs, clipSegs)
              : [{ startMs: clip.startMs, endMs: clip.endMs }]

          // Remap subtitle words to the output timeline accounting for removed segments.
          const clipWords = burnSubtitles
            ? remapWordsToEpisodeTimeline(
                wordRows.filter((w) => w.endMs > clip.startMs && w.startMs < clip.endMs),
                keepIntervals,
              )
            : []

          let srtPath: string | undefined
          let assPath: string | undefined
          if (useAnimated && clipWords.length > 0) {
            assPath = join(tmpdir(), `clip-${clip.id}.ass`)
            await writeFile(assPath, buildAssFile(clipWords, captionStyle!), "utf-8")
          } else if (burnSubtitles && clipWords.length > 0) {
            srtPath = join(tmpdir(), `clip-${clip.id}.srt`)
            await writeFile(srtPath, buildSrt(clipWords), "utf-8")
          }

          try {
            await exportClip({
              binaryPath: ffmpegBin,
              inputPath: project.mediaPath,
              outputPath: outPath,
              startMs: clip.startMs,
              endMs: clip.endMs,
              ...(clipSegs.length > 0 ? { removeSegments: clipSegs } : {}),
              ...(assPath ? { assPath, fontsDir } : {}),
              ...(srtPath ? { srtPath } : {}),
              ...(reframe ? { reframe: true, cropX: clip.cropX, blurBg } : {}),
              hookText: clip.title,
              normalizeLoudness: true,
              onProgress: (progress) =>
                send("export:progress", {
                  projectId,
                  stage: "clips",
                  clipIndex: ci,
                  clipTotal: clipRows.length,
                  clipId: clip.id,
                  progress,
                }),
            })
          } catch (err) {
            if (err instanceof EmptyClipError) {
              // Filler/silence removal consumed the whole clip — nothing to export, leave it
              // unmarked so it doesn't show up as a broken "exported" path.
              continue
            }
            throw err
          } finally {
            if (assPath) await unlink(assPath).catch(() => {})
            if (srtPath) await unlink(srtPath).catch(() => {})
          }

          markClipExported(db, clip.id)
          exportedPaths.push(outPath)
        }
      } finally {
        endActivity()
      }
      return exportedPaths
    },
  )

  handle(
    "export:full",
    async (
      _event,
      {
        projectId,
        outputDir,
        burnSubtitles = true,
        reframe = false,
        cropX = 0.5,
        blurBg = false,
      }: {
        projectId: string
        outputDir?: string
        burnSubtitles?: boolean
        reframe?: boolean
        cropX?: number
        blurBg?: boolean
      },
    ) => {
      const project = getProject(db, projectId)
      if (!project) throw new Error("Project not found")

      const segs = getSegments(db, projectId)
      const keepIntervals = subtractSegments(0, project.durationMs, segs)

      const ffmpegBin = resolveFfmpegBinary(getResourcesPath())
      const outDir = outputDir ?? join(app.getPath("downloads"), sanitizeName(project.name))
      await mkdir(outDir, { recursive: true })
      const outPath = join(outDir, `${sanitizeName(project.name)}_episode.mp4`)

      let srtPath: string | undefined
      if (burnSubtitles) {
        const wordRows = getWords(db, projectId)
        if (wordRows.length > 0) {
          const remappedWords = remapWordsToEpisodeTimeline(wordRows, keepIntervals)
          srtPath = join(tmpdir(), `episode-${projectId}.srt`)
          await writeFile(srtPath, buildSrt(remappedWords), "utf-8")
        }
      }

      beginActivity()
      try {
        await exportEpisode({
          binaryPath: ffmpegBin,
          inputPath: project.mediaPath,
          outputPath: outPath,
          keepIntervals,
          ...(srtPath ? { srtPath } : {}),
          ...(reframe ? { reframe: true, cropX, blurBg } : {}),
          // Episode export is multi-interval by definition — this is the fix for E6's loudnorm
          // previously being silently skipped whenever there was more than one keep interval.
          normalizeLoudness: true,
          onProgress: (progress) =>
            send("export:progress", {
              projectId,
              stage: "episode",
              clipIndex: 0,
              clipTotal: 1,
              progress,
            }),
        })
      } finally {
        if (srtPath) await unlink(srtPath).catch(() => {})
        endActivity()
      }
      return outPath
    },
  )

  handle(
    "export:srt",
    async (_event, { projectId, outputDir }: { projectId: string; outputDir?: string }) => {
      const project = getProject(db, projectId)
      if (!project) throw new Error("Project not found")

      const wordRows = getWords(db, projectId)
      const srtContent = buildSrt(wordRows)

      const outDir = outputDir ?? join(app.getPath("downloads"), sanitizeName(project.name))
      await mkdir(outDir, { recursive: true })
      const outPath = join(outDir, `${sanitizeName(project.name)}.srt`)
      await writeFile(outPath, srtContent, "utf-8")
      return outPath
    },
  )

  handle(
    "project:save-caption-style",
    async (
      _event,
      { projectId, captionStyle }: { projectId: string; captionStyle: CaptionStyle },
    ) => {
      setCaptionStyle(db, projectId, JSON.stringify(captionStyle))
    },
  )

  handle("project:load-caption-style", async (_event, { projectId }: { projectId: string }) => {
    const project = getProject(db, projectId)
    if (!project?.captionStyle) return null
    try {
      return JSON.parse(project.captionStyle) as CaptionStyle
    } catch {
      return null
    }
  })

  handle("get-font-url", () => {
    return `file://${join(getResourcesPath(), "fonts", "Montserrat-ExtraBold.ttf")}`
  })

  handle("project:get-filler-words", async (_event, { projectId }: { projectId: string }) => {
    const project = getProject(db, projectId)
    if (!project?.fillerWords) return DEFAULT_FILLER_WORDS
    try {
      return JSON.parse(project.fillerWords) as string[]
    } catch {
      return DEFAULT_FILLER_WORDS
    }
  })

  handle(
    "project:set-filler-words",
    async (_event, { projectId, fillerList }: { projectId: string; fillerList: string[] }) => {
      const wordRows = getWords(db, projectId)
      const fillerSegs = detectFillerWords(wordRows, projectId, new Set(fillerList))
      setFillerWords(db, projectId, JSON.stringify(fillerList), fillerSegs)
    },
  )

  handle("shell:show-item", async (_event, { path }: { path: string }) => {
    shell.showItemInFolder(path)
  })

  handle("shell:open-logs", async () => {
    await shell.openPath(app.getPath("logs"))
  })

  handle("updater:download", async () => {
    downloadUpdate()
  })

  handle("updater:restart-now", async () => {
    restartAndInstall()
  })

  handle(
    "log:report-error",
    async (
      _event,
      { message, stack, source }: { message: string; stack?: string; source: string },
    ) => {
      log.error(`[renderer:${source}] ${message}`, stack ?? "")
    },
  )

  // Deduplicates concurrent download requests for the same model across both
  // pipeline:start (implicit) and models:download (explicit) call sites.
  const inFlightDownloads = new Map<WhisperModel, Promise<void>>()

  function ensureModelDownloaded(
    modelsDir: string,
    model: WhisperModel,
    onProgress?: (progress: number) => void,
  ): Promise<void> {
    if (isModelDownloaded(modelsDir, model)) return Promise.resolve()
    const existing = inFlightDownloads.get(model)
    if (existing) return existing
    const promise = downloadModel(modelsDir, model, onProgress).finally(() =>
      inFlightDownloads.delete(model),
    )
    inFlightDownloads.set(model, promise)
    return promise
  }

  handle("models:list", async () => {
    const modelsDir = join(app.getPath("userData"), "models")
    const results: ModelInfo[] = await Promise.all(
      WHISPER_MODELS.map(async (model) => {
        const downloaded = isModelDownloaded(modelsDir, model)
        const sizeOnDisk = downloaded ? await getModelSizeOnDisk(modelsDir, model) : null
        return { model, downloaded, sizeOnDisk }
      }),
    )
    return results
  })

  handle("models:delete", async (_event, { model }: { model: WhisperModel }) => {
    const modelsDir = join(app.getPath("userData"), "models")
    await deleteModel(modelsDir, model)
  })

  handle("models:download", async (_event, { model }: { model: WhisperModel }) => {
    const modelsDir = join(app.getPath("userData"), "models")
    await ensureModelDownloaded(modelsDir, model, (progress) => {
      send("models:download-progress", { model, progress })
    })
  })

  handle("settings:get-api-key", async () => {
    const key = process.env["GROQ_API_KEY"] ?? ""
    if (!key) return { configured: false, preview: null }
    const preview = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "****"
    return { configured: true, preview }
  })

  handle("settings:set-api-key", async (_event, { groqApiKey }: { groqApiKey: string }) => {
    await saveGroqApiKey(groqApiKey)
    process.env["GROQ_API_KEY"] = groqApiKey
  })
}
