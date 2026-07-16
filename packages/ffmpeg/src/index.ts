import { spawn } from "node:child_process"
import { join } from "node:path"
import { existsSync } from "node:fs"

export interface ExportOptions {
  binaryPath: string
  inputPath: string
  outputPath: string
  startMs: number
  endMs: number
  srtPath?: string
  assPath?: string
  fontsDir?: string
  reframe?: boolean
  cropX?: number // 0.0 (left) – 1.0 (right), default 0.5 (center)
}

export interface ProxyOptions {
  binaryPath: string
  inputPath: string
  outputPath: string
}

export interface AudioExtractOptions {
  binaryPath: string
  inputPath: string
  outputPath: string
}

export async function hasSubtitlesFilter(binaryPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, ["-filters"])
    const out: string[] = []
    proc.stdout.on("data", (d: Buffer) => out.push(d.toString()))
    proc.stderr.on("data", (d: Buffer) => out.push(d.toString()))
    proc.on("close", () => resolve(out.join("").includes("subtitles")))
    proc.on("error", () => resolve(false))
  })
}

export function resolveFfmpegBinary(resourcesPath: string): string {
  const bundled = join(
    resourcesPath,
    "ffmpeg",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  )
  if (existsSync(bundled)) return bundled
  return "ffmpeg"
}

function escapeFiltergraphPath(p: string): string {
  // In -filter_complex strings: escape chars that have meaning in filtergraph syntax
  // Colon separates options, semicolon separates filterchains, backslash is escape char
  // No shell quoting — spawn passes args directly to the process
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/;/g, "\\;")
}

function run(binaryPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binaryPath, args)
    const stderr: string[] = []
    proc.stderr.on("data", (d: Buffer) => stderr.push(d.toString()))
    proc.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`FFmpeg exited ${code}:\n${stderr.join("")}`))
    })
  })
}

export async function exportClip(opts: ExportOptions): Promise<void> {
  const startSec = opts.startMs / 1000
  const durationSec = (opts.endMs - opts.startMs) / 1000
  const args = [
    "-y",
    "-ss",
    String(startSec),
    "-i",
    opts.inputPath,
    "-t",
    String(durationSec),
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
  ]
  const subtitleFilter = opts.assPath
    ? `subtitles=filename=${escapeFiltergraphPath(opts.assPath)}${opts.fontsDir ? `:fontsdir=${escapeFiltergraphPath(opts.fontsDir)}` : ""}`
    : opts.srtPath
      ? `subtitles=filename=${escapeFiltergraphPath(opts.srtPath)}`
      : null
  if (opts.reframe) {
    const cx = opts.cropX ?? 0.5
    const cropFilter = `crop=ih*9/16:ih:(iw-ih*9/16)*${cx}:0,scale=1080:1920`
    args.push("-vf", subtitleFilter ? `${cropFilter},${subtitleFilter}` : cropFilter)
  } else if (subtitleFilter) {
    args.push("-vf", subtitleFilter)
  }
  args.push(opts.outputPath)
  await run(opts.binaryPath, args)
}

export async function generateProxy(opts: ProxyOptions): Promise<void> {
  await run(opts.binaryPath, [
    "-y",
    "-i",
    opts.inputPath,
    "-vf",
    "scale=960:-2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    opts.outputPath,
  ])
}

export interface EpisodeExportOptions {
  binaryPath: string
  inputPath: string
  outputPath: string
  keepIntervals: { startMs: number; endMs: number }[]
  srtPath?: string
  assPath?: string
  fontsDir?: string
}

export async function exportEpisode(opts: EpisodeExportOptions): Promise<void> {
  if (opts.keepIntervals.length === 0) {
    throw new Error("No keep intervals — nothing to export")
  }

  const subtitleFilter = opts.assPath
    ? `subtitles=filename=${escapeFiltergraphPath(opts.assPath)}${opts.fontsDir ? `:fontsdir=${escapeFiltergraphPath(opts.fontsDir)}` : ""}`
    : opts.srtPath
      ? `subtitles=filename=${escapeFiltergraphPath(opts.srtPath)}`
      : null

  if (opts.keepIntervals.length === 1) {
    const seg = opts.keepIntervals[0]!
    await exportClip({
      binaryPath: opts.binaryPath,
      inputPath: opts.inputPath,
      outputPath: opts.outputPath,
      startMs: seg.startMs,
      endMs: seg.endMs,
      ...(opts.assPath ? { assPath: opts.assPath, fontsDir: opts.fontsDir } : {}),
      ...(opts.srtPath && !opts.assPath ? { srtPath: opts.srtPath } : {}),
    })
    return
  }

  const filterParts: string[] = []

  opts.keepIntervals.forEach((seg, i) => {
    const start = seg.startMs / 1000
    const end = seg.endMs / 1000
    filterParts.push(`[0:v]trim=${start}:${end},setpts=PTS-STARTPTS[v${i}]`)
    filterParts.push(`[0:a]atrim=${start}:${end},asetpts=PTS-STARTPTS[a${i}]`)
  })

  const n = opts.keepIntervals.length
  const finalV = subtitleFilter ? "outvsub" : "outv"

  const videoInputs = opts.keepIntervals.map((_, i) => `[v${i}]`).join("")
  const audioInputs = opts.keepIntervals.map((_, i) => `[a${i}]`).join("")
  filterParts.push(`${videoInputs}concat=n=${n}:v=1:a=0[outv]`)
  filterParts.push(`${audioInputs}concat=n=${n}:v=0:a=1[outa]`)

  if (subtitleFilter) {
    filterParts.push(`[outv]${subtitleFilter}[outvsub]`)
  }

  await run(opts.binaryPath, [
    "-y",
    "-i",
    opts.inputPath,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    `[${finalV}]`,
    "-map",
    "[outa]",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    opts.outputPath,
  ])
}

export async function probeDuration(binaryPath: string, inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binaryPath, ["-i", inputPath])
    const stderr: string[] = []
    proc.stderr.on("data", (d: Buffer) => stderr.push(d.toString()))
    // FFmpeg exits non-zero when no output is specified — that's expected here
    proc.on("close", () => {
      const match = stderr.join("").match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
      if (!match) {
        reject(new Error("Could not parse duration from FFmpeg output"))
        return
      }
      const ms = Math.round(
        (parseInt(match[1]!, 10) * 3600 + parseInt(match[2]!, 10) * 60 + parseFloat(match[3]!)) *
          1000,
      )
      resolve(ms)
    })
    proc.on("error", reject)
  })
}

export async function extractAudio(opts: AudioExtractOptions): Promise<void> {
  await run(opts.binaryPath, [
    "-y",
    "-i",
    opts.inputPath,
    "-vn",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-f",
    "wav",
    opts.outputPath,
  ])
}
