import { defineConfig } from "drizzle-kit"

// Migrations are generated straight into the repo's resources/ folder so they ride the same
// packaging path as ffmpeg/whisper/fonts: apps/desktop's extraResources copies resources/
// wholesale into the packaged app, and main resolves them via getResourcesPath() at runtime.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "../../resources/drizzle",
})
