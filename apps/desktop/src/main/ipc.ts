import { ipcMain } from "electron"

// IPC handlers are registered here and call into packages.
// Rule: main process owns all I/O. Renderer only sends/receives via IPC.
export function registerIpcHandlers(): void {
  ipcMain.handle("project:list", async () => {
    // TODO: wire up @video-editor/database
    return []
  })

  ipcMain.handle(
    "project:create",
    async (_event, { name, mediaPath }: { name: string; mediaPath: string }) => {
      // TODO: create project in DB, copy media, start proxy generation
      void name
      void mediaPath
      return null
    },
  )

  ipcMain.handle("pipeline:start", async (_event, { projectId }: { projectId: string }) => {
    // TODO: orchestrate whisper → ai → db write → notify renderer
    void projectId
  })

  ipcMain.handle(
    "clip:update-status",
    async (_event, { clipId, status }: { clipId: string; status: string }) => {
      // TODO: update clip status in DB
      void clipId
      void status
    },
  )

  ipcMain.handle(
    "export:clips",
    async (_event, { projectId, clipIds }: { projectId: string; clipIds: string[] }) => {
      // TODO: call @video-editor/export → ffmpeg → return output paths
      void projectId
      void clipIds
      return []
    },
  )
}
