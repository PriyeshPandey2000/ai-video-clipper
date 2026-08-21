import { app, dialog } from "electron"
import { readdirSync, unlinkSync, statSync } from "fs"
import { dirname, join } from "path"
import log from "electron-log/main"

// Dialog storm guard: a looping uncaughtException (e.g. from a timer) would otherwise
// stack a native modal per throw. Show it once per window, keep logging every occurrence.
const DIALOG_COOLDOWN_MS = 30_000
let lastDialogAt = 0

// One file per launch (ISO timestamp in the name) instead of a single main.log that a
// long session can silently overwrite past — a bug reported a day later than it happened
// would otherwise already be evicted. Old sessions are pruned so this stays bounded.
const MAX_SESSIONS = 10

function pruneOldSessions(logDir: string, currentFileName: string): void {
  try {
    const sessions = readdirSync(logDir)
      .filter((f) => f.startsWith("session-") && f !== currentFileName)
      .map((f) => ({ name: f, mtimeMs: statSync(join(logDir, f)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const stale of sessions.slice(MAX_SESSIONS - 1)) {
      unlinkSync(join(logDir, stale.name))
    }
  } catch {
    // best-effort — a failed prune shouldn't block logging
  }
}

export function initLogger(): typeof log {
  const sessionFileName = `session-${new Date().toISOString().replace(/[:.]/g, "-")}.log`
  log.transports.file.fileName = sessionFileName
  log.transports.file.level = "info"
  // Default rotation is 1MB/.old.log, which is free — bumped up since a single pipeline
  // run (transcribe + ffmpeg stderr on failure) can be chatty.
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.console.level = app.isPackaged ? false : "debug"

  pruneOldSessions(dirname(log.transports.file.getFile().path), sessionFileName)

  log.errorHandler.startCatching({
    showDialog: false, // dialog shown manually below, rate-limited
    onError: ({ error, processType }) => {
      if (processType !== "browser" || !app.isPackaged) return
      const now = Date.now()
      if (now - lastDialogAt < DIALOG_COOLDOWN_MS) return
      lastDialogAt = now
      dialog.showErrorBox(
        "Clipper hit an unexpected error",
        `${error.message}\n\nDetails were written to the log file (Settings → Open Log Folder).`,
      )
    },
  })

  // Covers render-process-gone, child-process-gone, crashed, gpu-process-crashed,
  // certificate-error — none of which raise a catchable JS exception in main.
  log.eventLogger.startLogging()

  log.info(`Clipper ${app.getVersion()} starting`, {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
  })

  return log
}

export default log
