import { app, BrowserWindow } from "electron"
import { autoUpdater } from "electron-updater"
import type { IpcEventChannels, UpdaterState } from "@video-editor/types"
import log from "./logger"
import { isBusy } from "./activity"

// Grace period between "download finished" and actually restarting when it's safe to — long
// enough for the toast's "restarting…" message to register, short enough not to feel stuck.
const AUTO_RESTART_DELAY_MS = 3000
const CHECK_DELAY_MS = 5000

// Mirrors whatever was last sent over IpcEventChannels — webContents.send() silently drops an
// event if the renderer isn't listening yet, so a toast that mounts after checkForUpdates()
// already fired would otherwise miss it for the rest of the session. UpdateToast reads this via
// updater:get-state on mount to catch up on anything it missed.
let currentState: UpdaterState = { kind: "idle" }

export function getUpdaterState(): UpdaterState {
  return currentState
}

function emit<K extends keyof IpcEventChannels>(
  channel: K,
  data: IpcEventChannels[K],
  state: UpdaterState,
): void {
  currentState = state
  const win = BrowserWindow.getAllWindows()[0]
  if (win) win.webContents.send(channel, data)
}

export function initUpdater(): void {
  if (!app.isPackaged) return // no real update feed in dev

  autoUpdater.autoDownload = false
  // If a job is running when the update finishes downloading, don't force a restart — install
  // silently whenever the user eventually quits on their own instead of killing their work.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = log

  autoUpdater.on("update-available", (info) => {
    emit(
      "updater:available",
      { version: info.version },
      { kind: "available", version: info.version },
    )
  })

  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.round(progress.percent)
    emit("updater:progress", { percent }, { kind: "downloading", percent })
  })

  autoUpdater.on("update-downloaded", () => {
    const readyToInstall = !isBusy()
    emit("updater:downloaded", { readyToInstall }, { kind: "downloaded", readyToInstall })
    if (readyToInstall) {
      setTimeout(() => {
        // Re-check — a job may have started during the grace period.
        if (!isBusy()) autoUpdater.quitAndInstall()
      }, AUTO_RESTART_DELAY_MS)
    }
  })

  autoUpdater.on("error", (err) => {
    log.error("Auto-update error", err)
    emit("updater:error", { message: err.message }, { kind: "error", message: err.message })
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err: unknown) => log.error("checkForUpdates failed", err))
  }, CHECK_DELAY_MS)
}

export function downloadUpdate(): void {
  autoUpdater.downloadUpdate().catch((err: unknown) => log.error("downloadUpdate failed", err))
}

export function restartAndInstall(): void {
  // Not reachable from the current UI (the toast never shows a manual restart button while
  // busy), but this is exposed over IPC — guard it here, not just at the call site, so any
  // future caller gets the same protection by construction.
  if (isBusy()) {
    log.warn("restartAndInstall ignored — a job is currently running")
    return
  }
  autoUpdater.quitAndInstall()
}
