import { app, BrowserWindow } from "electron"
import { autoUpdater } from "electron-updater"
import type { IpcEventChannels } from "@video-editor/types"
import log from "./logger"
import { isBusy } from "./activity"

// Grace period between "download finished" and actually restarting when it's safe to — long
// enough for the toast's "restarting…" message to register, short enough not to feel stuck.
const AUTO_RESTART_DELAY_MS = 3000
const CHECK_DELAY_MS = 5000

function send<K extends keyof IpcEventChannels>(channel: K, data: IpcEventChannels[K]): void {
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
    send("updater:available", { version: info.version })
  })

  autoUpdater.on("download-progress", (progress) => {
    send("updater:progress", { percent: Math.round(progress.percent) })
  })

  autoUpdater.on("update-downloaded", () => {
    const readyToInstall = !isBusy()
    send("updater:downloaded", { readyToInstall })
    if (readyToInstall) {
      setTimeout(() => {
        // Re-check — a job may have started during the grace period.
        if (!isBusy()) autoUpdater.quitAndInstall()
      }, AUTO_RESTART_DELAY_MS)
    }
  })

  autoUpdater.on("error", (err) => {
    log.error("Auto-update error", err)
    send("updater:error", { message: err.message })
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err: unknown) => log.error("checkForUpdates failed", err))
  }, CHECK_DELAY_MS)
}

export function downloadUpdate(): void {
  autoUpdater.downloadUpdate().catch((err: unknown) => log.error("downloadUpdate failed", err))
}

export function restartAndInstall(): void {
  autoUpdater.quitAndInstall()
}
