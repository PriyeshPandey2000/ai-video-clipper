import { join } from "path"
import { mkdir, writeFile } from "fs/promises"
import { exportClip } from "@video-editor/ffmpeg"
import type { Clip, Word } from "@video-editor/types"
import { msToSrtTimecode } from "@video-editor/utils"

export interface ExportClipOptions {
  ffmpegBinaryPath: string
  clip: Clip
  mediaPath: string
  outputDir: string
  words: Word[]
  burnCaptions?: boolean
}

export async function exportSingleClip(opts: ExportClipOptions): Promise<string> {
  await mkdir(opts.outputDir, { recursive: true })

  const filename = `${sanitize(opts.clip.title)}_${opts.clip.id.slice(0, 8)}.mp4`
  const outputPath = join(opts.outputDir, filename)

  let srtPath: string | undefined
  if (opts.burnCaptions) {
    srtPath = join(opts.outputDir, `${opts.clip.id}.srt`)
    const clipWords = opts.words.filter(
      (w) => w.startMs >= opts.clip.startMs && w.endMs <= opts.clip.endMs,
    )
    await writeFile(srtPath, generateSrt(clipWords, opts.clip.startMs))
  }

  await exportClip({
    binaryPath: opts.ffmpegBinaryPath,
    inputPath: opts.mediaPath,
    outputPath,
    startMs: opts.clip.startMs,
    endMs: opts.clip.endMs,
    ...(srtPath !== undefined ? { srtPath } : {}),
  })

  return outputPath
}

function generateSrt(words: Word[], offsetMs: number): string {
  const lines: string[] = []
  const chunkSize = 7

  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize)
    const first = chunk[0]!
    const last = chunk[chunk.length - 1]!
    const index = Math.floor(i / chunkSize) + 1
    lines.push(
      `${index}`,
      `${msToSrtTimecode(first.startMs - offsetMs)} --> ${msToSrtTimecode(last.endMs - offsetMs)}`,
      chunk.map((w) => w.text).join(" "),
      "",
    )
  }

  return lines.join("\n")
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_-]/gi, "_").slice(0, 60)
}
