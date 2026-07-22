import { spawn } from "node:child_process"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises"

export type {
  WhisperWord,
  WhisperSegment,
  WhisperTranscriptionResult,
  WhisperModel,
} from "@video-editor/types"
import type {
  WhisperWord,
  WhisperSegment,
  WhisperTranscriptionResult,
  WhisperModel,
} from "@video-editor/types"

export interface WhisperConfig {
  binaryPath: string
  modelsDir: string
}

export function resolveWhisperBinary(resourcesPath: string): string {
  const bundled = join(
    resourcesPath,
    "whisper",
    process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli",
  )
  if (existsSync(bundled)) return bundled
  return "whisper-cli"
}

const MODEL_FILES: Record<WhisperModel, string> = {
  tiny: "ggml-tiny.bin",
  base: "ggml-base.bin",
  small: "ggml-small.bin",
  medium: "ggml-medium.bin",
  large: "ggml-large-v3.bin",
}

export const MODEL_DISPLAY_SIZE: Record<WhisperModel, string> = {
  tiny: "~75 MB",
  base: "~142 MB",
  small: "~466 MB",
  medium: "~1.5 GB",
  large: "~3.1 GB",
}

const MODEL_URLS: Record<WhisperModel, string> = {
  tiny: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES.tiny}`,
  base: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES.base}`,
  small: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES.small}`,
  medium: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES.medium}`,
  large: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES.large}`,
}

export function modelPath(modelsDir: string, model: WhisperModel): string {
  return join(modelsDir, MODEL_FILES[model])
}

export function isModelDownloaded(modelsDir: string, model: WhisperModel): boolean {
  return existsSync(modelPath(modelsDir, model))
}

export async function getModelSizeOnDisk(
  modelsDir: string,
  model: WhisperModel,
): Promise<number | null> {
  try {
    const s = await stat(modelPath(modelsDir, model))
    return s.size
  } catch {
    return null
  }
}

export async function deleteModel(modelsDir: string, model: WhisperModel): Promise<void> {
  await unlink(modelPath(modelsDir, model))
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

interface WhisperCliToken {
  text: string
  offsets: { from: number; to: number }
  p: number
  id: number
  t_dtw: number
}

interface WhisperCliSegment {
  timestamps: { from: string; to: string }
  offsets: { from: number; to: number }
  text: string
  tokens: WhisperCliToken[]
}

interface WhisperCliResult {
  systeminfo: string
  model: { type: string }
  params: Record<string, unknown>
  result: { language: string }
  transcription: WhisperCliSegment[]
}

function normalizeWhisperResult(raw: WhisperCliResult): WhisperTranscriptionResult {
  const segments: WhisperSegment[] = raw.transcription.map((seg, i) => {
    const words: WhisperWord[] = []
    for (const t of seg.tokens) {
      const text = t.text.trim()
      if (!text || text.startsWith("[") || text.startsWith("<")) continue
      words.push({
        word: text,
        start: t.offsets.from / 1000,
        end: t.offsets.to / 1000,
        probability: t.p,
      })
    }
    return {
      id: i,
      start: seg.offsets.from / 1000,
      end: seg.offsets.to / 1000,
      text: seg.text.trim(),
      words,
    }
  })

  return { segments, language: raw.result.language }
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
    const jsonPath = `${audioPath}.json`
    const args = [
      "-m",
      modelPath(config.modelsDir, model),
      "-f",
      audioPath,
      "-ojf",
      "-sow",
      "-t",
      "4",
    ]

    const proc = spawn(config.binaryPath, args)
    const stderr: string[] = []

    proc.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString()
      stderr.push(chunk)
      if (onProgress) {
        const match = chunk.match(/whisper_full(?:_parallel)?:?\s+progress\s*=\s*(\d+)\s*%/)
        if (match) {
          onProgress(parseInt(match[1]!, 10) / 100)
        }
      }
    })

    proc.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(`Whisper exited ${code}:\n${stderr.join("")}`))
        return
      }
      try {
        const raw = await readFile(jsonPath, "utf-8")
        const parsed = JSON.parse(raw) as WhisperCliResult
        await unlink(jsonPath).catch(() => {})
        resolve(normalizeWhisperResult(parsed))
      } catch {
        reject(
          new Error(
            `Failed to parse Whisper JSON output from ${jsonPath}\nstderr: ${stderr.join("").slice(0, 500)}`,
          ),
        )
      }
    })
  })
}
