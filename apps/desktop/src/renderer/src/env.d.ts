import type { IpcChannels } from "@video-editor/types"

type InvokeChannels = Pick<
  IpcChannels,
  | "project:list"
  | "project:create"
  | "project:get"
  | "pipeline:start"
  | "clip:update-status"
  | "export:clips"
  | "export:full"
>

interface ElectronAPI {
  [key: string]: unknown
}

interface Api {
  invoke<K extends keyof InvokeChannels>(
    channel: K,
    args?: InvokeChannels[K]["args"],
  ): Promise<InvokeChannels[K]["result"]>
  on<K extends keyof IpcChannels>(channel: K, callback: (data: IpcChannels[K]) => void): () => void
  getFilePath(file: File): string
}

declare global {
  interface Window {
    api: Api
    electron: ElectronAPI
  }

  interface File {
    path?: string
  }
}
