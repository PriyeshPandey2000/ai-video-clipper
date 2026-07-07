import { contextBridge, ipcRenderer } from "electron"
import { electronAPI } from "@electron-toolkit/preload"
import type { IpcChannels } from "@video-editor/types"

type InvokeChannels = Pick<
  IpcChannels,
  "project:list" | "project:create" | "pipeline:start" | "clip:update-status" | "export:clips"
>

const api = {
  invoke<K extends keyof InvokeChannels>(
    channel: K,
    args?: InvokeChannels[K]["args"],
  ): Promise<InvokeChannels[K]["result"]> {
    return ipcRenderer.invoke(channel, args)
  },
  on<K extends keyof IpcChannels>(
    channel: K,
    callback: (data: IpcChannels[K]) => void,
  ): () => void {
    const handler = (_: Electron.IpcRendererEvent, data: IpcChannels[K]): void => callback(data)
    ipcRenderer.on(channel as string, handler)
    return () => ipcRenderer.removeListener(channel as string, handler)
  },
}

contextBridge.exposeInMainWorld("electron", electronAPI)
contextBridge.exposeInMainWorld("api", api)

export type Api = typeof api
