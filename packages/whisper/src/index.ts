import { spawn } from "node:child_process"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"

export type { WhisperWord, WhisperSegment, WhisperTranscriptionResult } from "@video-editor/types"
import type { WhisperTranscriptionResult } from "@video-editor/types"

export type WhisperModel = "tiny" | "base" | "small" | "medium"

export interface WhisperConfig {
  binaryPath: string
  modelsDir: string
}

export function resolveWhisperBinary(resourcesPath: string): string {
  return join(
    resourcesPath,
    "whisper",
    process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli",
  )
}

export function modelPath(modelsDir: string, model: WhisperModel): string {
  return join(modelsDir, `ggml-${model}.bin`)
}

export function isModelDownloaded(modelsDir: string, model: WhisperModel): boolean {
  return existsSync(modelPath(modelsDir, model))
}

const MODEL_URLS: Record<WhisperModel, string> = {
  tiny: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
  base: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
  small: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
  medium: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
}

export async function downloadModel(
  modelsDir: string,
  model: WhisperModel,
  onProgress?: (progress: number) => void,
): Promise<void> {
  await mkdir(modelsDir, { recursive: true })

  const url = MODEL_URLS[model]
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download model ${model}: ${response.status}`)
  }

  const total = Number(response.headers.get("content-length") ?? 0)
  let received = 0
  const chunks: Uint8Array[] = []

  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (total > 0) onProgress?.(received / total)
  }

  await writeFile(modelPath(modelsDir, model), Buffer.concat(chunks))
}

export async function transcribe(
  config: WhisperConfig,
  audioPath: string,
  model: WhisperModel = "base",
  onProgress?: (progress: number) => void,
): Promise<WhisperTranscriptionResult> {
  if (!isModelDownloaded(config.modelsDir, model)) {
    await downloadModel(config.modelsDir, model, onProgress)
  }

  return new Promise((resolve, reject) => {
    const args = [
      "-m",
      modelPath(config.modelsDir, model),
      "-f",
      audioPath,
      "-oj",
      "--word-timestamps",
      "true",
      "-t",
      "4",
    ]

    const proc = spawn(config.binaryPath, args)
    const stdout: string[] = []
    const stderr: string[] = []

    proc.stdout.on("data", (d: Buffer) => stdout.push(d.toString()))
    proc.stderr.on("data", (d: Buffer) => stderr.push(d.toString()))

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Whisper exited ${code}:\n${stderr.join("")}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.join("")) as WhisperTranscriptionResult)
      } catch {
        reject(new Error("Failed to parse Whisper JSON output"))
      }
    })
  })
}
