import { contextBridge, ipcRenderer, webUtils } from "electron"
import type { IpcInvokeChannels, IpcEventChannels } from "@video-editor/types"

const api = {
  invoke<K extends keyof IpcInvokeChannels>(
    channel: K,
    args?: IpcInvokeChannels[K]["args"],
  ): Promise<IpcInvokeChannels[K]["result"]> {
    return ipcRenderer.invoke(channel, args)
  },
  on<K extends keyof IpcEventChannels>(
    channel: K,
    callback: (data: IpcEventChannels[K]) => void,
  ): () => void {
    const handler = (_: Electron.IpcRendererEvent, data: IpcEventChannels[K]): void =>
      callback(data)
    ipcRenderer.on(channel as string, handler)
    return () => ipcRenderer.removeListener(channel as string, handler)
  },
  getFilePath(file: File): string {
    return webUtils.getPathForFile(file)
  },
}

contextBridge.exposeInMainWorld("api", api)

export type Api = typeof api
