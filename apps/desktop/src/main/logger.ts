import { app, dialog } from "electron"
import log from "electron-log/main"

// Dialog storm guard: a looping uncaughtException (e.g. from a timer) would otherwise
// stack a native modal per throw. Show it once per window, keep logging every occurrence.
const DIALOG_COOLDOWN_MS = 30_000
let lastDialogAt = 0

export function initLogger(): typeof log {
  log.transports.file.level = "info"
  // Default rotation is 1MB/.old.log, which is free — bumped up since a single pipeline
  // run (transcribe + ffmpeg stderr on failure) can be chatty.
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.console.level = app.isPackaged ? false : "debug"

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
