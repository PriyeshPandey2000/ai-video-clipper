import { resolve } from "path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "dotenv",
          "@video-editor/ai",
          "@video-editor/captions",
          "@video-editor/database",
          "@video-editor/ffmpeg",
          "@video-editor/player",
          "@video-editor/transcript",
          "@video-editor/types",
          "@video-editor/ui",
          "@video-editor/utils",
          "@video-editor/whisper",
        ],
      }),
    ],
    resolve: {
      alias: {
        "@main": resolve("src/main"),
        "@video-editor/ai": resolve("../../packages/ai/src/index.ts"),
        "@video-editor/captions": resolve("../../packages/captions/src/index.ts"),
        "@video-editor/database": resolve("../../packages/database/src/index.ts"),
        "@video-editor/ffmpeg": resolve("../../packages/ffmpeg/src/index.ts"),
        "@video-editor/player": resolve("../../packages/player/src/index.ts"),
        "@video-editor/transcript": resolve("../../packages/transcript/src/index.ts"),
        "@video-editor/types": resolve("../../packages/types/src/index.ts"),
        "@video-editor/ui": resolve("../../packages/ui/src/index.ts"),
        "@video-editor/utils": resolve("../../packages/utils/src/index.ts"),
        "@video-editor/whisper": resolve("../../packages/whisper/src/index.ts"),
      },
    },
    build: {
      rollupOptions: {
        external: ["better-sqlite3", "bindings", "file-uri-to-path", "onnxruntime-node"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
    },
  },
})
