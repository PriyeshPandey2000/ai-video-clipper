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
  | "project:save-caption-style"
  | "project:load-caption-style"
  | "get-font-url"
  | "project:get-filler-words"
  | "project:set-filler-words"
  | "models:list"
  | "models:delete"
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
