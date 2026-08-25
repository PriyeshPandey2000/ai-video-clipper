import { app, BrowserWindow, shell } from "electron"
import { join, dirname } from "path"
import { existsSync } from "fs"
import { closeDb } from "@video-editor/database"
import { registerIpcHandlers } from "./ipc"
import { loadGroqApiKeySync } from "./config"
import { initLogger } from "./logger"
import { initUpdater } from "./updater"

initLogger()

// Load .env into process.env for the main process.
// dotenv searches from process.cwd() by default, which in dev mode
// is apps/desktop — the .env is at the monorepo root, so we search upward.
import * as dotenv from "dotenv"
const envPaths: string[] = []
try {
  envPaths.push(
    join(dirname(app.getAppPath()), ".env"),
    join(app.getAppPath(), ".env"),
    join(app.getAppPath(), "../../.env"),
  )
} catch {}
envPaths.push(join(__dirname, "../../../../.env"))
for (const p of envPaths) {
  if (existsSync(p)) {
    dotenv.config({ path: p })
    break
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  })

  win.on("ready-to-show", () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"])
    win.webContents.openDevTools()
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"))
  }
}

app.whenReady().then(() => {
  // Override .env with user-saved API key from Settings (takes priority over .env)
  const savedKey = loadGroqApiKeySync()
  if (savedKey) process.env["GROQ_API_KEY"] = savedKey

  registerIpcHandlers()
  createWindow()
  initUpdater()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("will-quit", () => {
  closeDb()
})
