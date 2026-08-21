import type { IpcInvokeChannels, IpcEventChannels } from "@video-editor/types"

interface ElectronAPI {
  [key: string]: unknown
}

interface Api {
  invoke<K extends keyof IpcInvokeChannels>(
    channel: K,
    args?: IpcInvokeChannels[K]["args"],
  ): Promise<IpcInvokeChannels[K]["result"]>
  on<K extends keyof IpcEventChannels>(
    channel: K,
    callback: (data: IpcEventChannels[K]) => void,
  ): () => void
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
