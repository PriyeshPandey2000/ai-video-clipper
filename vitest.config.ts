import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

// Aliased to src so tests don't depend on package build order.
export default defineConfig({
  resolve: {
    alias: {
      "@video-editor/transcript": resolve(__dirname, "packages/transcript/src/index.ts"),
      "@video-editor/types": resolve(__dirname, "packages/types/src/index.ts"),
      "@video-editor/utils": resolve(__dirname, "packages/utils/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/src/**/*.test.ts"],
    environment: "node",
  },
})
