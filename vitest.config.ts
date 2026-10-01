import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

// Aliased to src so tests don't depend on package build order.
export default defineConfig({
  resolve: {
    alias: {
      "@video-editor/transcript": resolve(__dirname, "packages/transcript/src/index.ts"),
      "@video-editor/types": resolve(__dirname, "packages/types/src/index.ts"),
      "@video-editor/utils": resolve(__dirname, "packages/utils/src/index.ts"),
      "@video-editor/ai": resolve(__dirname, "packages/ai/src/index.ts"),
      "@video-editor/database": resolve(__dirname, "packages/database/src/index.ts"),
    },
  },
  test: {
    // apps/desktop is included for its main-process pure-logic modules only (e.g. the #97
    // selection-report writer). Nothing there may import electron: these run under plain Node,
    // so an electron import would fail to load rather than silently skip.
    include: ["packages/**/src/**/*.test.ts", "apps/desktop/src/main/**/*.test.ts"],
    environment: "node",
  },
})
