import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { IpcChannels } from "@video-editor/types"

type InvokeChannels = Pick<
  IpcChannels,
  | "project:list"
  | "project:create"
  | "project:get"
  | "project:get-words"
  | "project:get-ai-outputs"
  | "clip:list"
  | "pipeline:start"
  | "clip:update-status"
  | "clip:update-times"
  | "clip:update-crop-x"
  | "export:clips"
  | "export:full"
  | "export:srt"
  | "dialog:pick-folder"
  | "ffmpeg:has-subtitles-filter"
  | "shell:show-item"
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
  getFilePath(file: File): string {
    return webUtils.getPathForFile(file)
  },
}

contextBridge.exposeInMainWorld("api", api)

export type Api = typeof api
