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
  if (opts.srtPath) {
    args.push("-vf", `subtitles=filename=${escapeFiltergraphPath(opts.srtPath)}`)
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
}

export async function exportEpisode(opts: EpisodeExportOptions): Promise<void> {
  if (opts.keepIntervals.length === 0) {
    throw new Error("No keep intervals — nothing to export")
  }

  if (opts.keepIntervals.length === 1) {
    const seg = opts.keepIntervals[0]!
    await exportClip({
      binaryPath: opts.binaryPath,
      inputPath: opts.inputPath,
      outputPath: opts.outputPath,
      startMs: seg.startMs,
      endMs: seg.endMs,
      ...(opts.srtPath ? { srtPath: opts.srtPath } : {}),
    })
    return
  }

  const filterParts: string[] = []
  const concatInputs: string[] = []

  opts.keepIntervals.forEach((seg, i) => {
    const start = seg.startMs / 1000
    const end = seg.endMs / 1000
    filterParts.push(`[0:v]trim=${start}:${end},setpts=PTS-STARTPTS[v${i}]`)
    filterParts.push(`[0:a]atrim=${start}:${end},asetpts=PTS-STARTPTS[a${i}]`)
    concatInputs.push(`[v${i}][a${i}]`)
  })

  const n = opts.keepIntervals.length
  const finalV = opts.srtPath ? "outvsub" : "outv"
  filterParts.push(`${concatInputs.join("")}concat=n=${n}:v=1:a=1[outv][outa]`)
  if (opts.srtPath) {
    filterParts.push(`[outv]subtitles=filename=${escapeFiltergraphPath(opts.srtPath)}[outvsub]`)
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
