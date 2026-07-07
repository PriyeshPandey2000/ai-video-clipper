import { spawn } from "node:child_process"
import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"

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

export function resolveFfmpegBinary(resourcesPath: string): string {
  return join(resourcesPath, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
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
    args.push("-vf", `subtitles='${opts.srtPath}'`)
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

export { join, mkdir, writeFile }
