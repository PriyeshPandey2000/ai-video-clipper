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

const MODEL_URLS: Record<WhisperModel, string> = {
  tiny: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES.tiny}`,
  base: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES.base}`,
  small: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES.small}`,
  medium: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES.medium}`,
  large: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILES.large}`,
}

/**
 * `--dtw` requires a preset naming the model's alignment heads; passing the flag alone is a
 * usage error, and an unrecognised preset exits with code 3. Note `large` maps to `large.v3`,
 * matching the `ggml-large-v3.bin` weights we download — `--dtw large` would fail outright.
 */
const DTW_PRESET: Record<WhisperModel, string> = {
  tiny: "tiny",
  base: "base",
  small: "small",
  medium: "medium",
  large: "large.v3",
}

/** Silero VAD, converted to ggml. Gates decoding to speech so Whisper can't hallucinate. */
const VAD_MODEL_FILE = "ggml-silero-v6.2.0.bin"
const VAD_MODEL_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_MODEL_FILE}`

export function modelPath(modelsDir: string, model: WhisperModel): string {
  return join(modelsDir, MODEL_FILES[model])
}

export function vadModelPath(modelsDir: string): string {
  return join(modelsDir, VAD_MODEL_FILE)
}

/** Same download-on-first-use path as the Whisper weights; failure is non-fatal. */
export async function downloadVadModel(modelsDir: string): Promise<boolean> {
  const dest = vadModelPath(modelsDir)
  if (existsSync(dest)) return true
  try {
    await mkdir(modelsDir, { recursive: true })
    const response = await fetch(VAD_MODEL_URL)
    if (!response.ok) return false
    await writeFile(dest, Buffer.from(await response.arrayBuffer()))
    return true
  } catch {
    return false
  }
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

/**
 * whisper.cpp emits BPE subword tokens, not words, and marks a word start with a **leading
 * space**: `" Hello"`, `" everyone"`, then `","` and `"'s"` continue the token before them.
 *
 * Trimming each token and treating it as a word splits "2026" into "22"/"6", "full-stack" into
 * "full"/"-"/"st"/"ack", and turns every comma into its own record — which then flows into SRT
 * export, captions, and filler detection. Merging on the leading-space marker is what makes the
 * `words` table actually word-level. `-sow` keeps segment boundaries on word boundaries, so
 * merging per segment is safe.
 */
function normalizeWhisperResult(raw: WhisperCliResult): WhisperTranscriptionResult {
  const segments: WhisperSegment[] = raw.transcription.map((seg, i) => {
    const words: WhisperWord[] = []
    for (const t of seg.tokens) {
      const text = t.text.trim()
      if (!text || text.startsWith("[") || text.startsWith("<")) continue

      const startsNewWord = /^\s/.test(t.text)
      const current = words[words.length - 1]
      if (!startsNewWord && current) {
        current.word += text
        current.end = t.offsets.to / 1000
        current.probability = Math.min(current.probability, t.p)
        continue
      }

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

/**
 * Buffers stderr chunks across `data` events and fires `onProgress` once per complete
 * "progress = N%" line. Node's stream `data` event has no line-framing guarantee — a single
 * chunk can contain several lines, or a line can be split across two chunks — so matching
 * against each raw chunk independently both misses split lines entirely and only reports the
 * first of several lines that land in the same chunk. Buffering until a full line arrives before
 * matching handles both cases.
 */
export function createProgressParser(
  onProgress: (progress: number) => void,
): (chunk: string) => void {
  let buffer = ""
  return (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? "" // last element is the trailing partial line, if any — keep it
    for (const line of lines) {
      // Not anchored to a specific function name (e.g. "whisper_full:") — whisper.cpp v1.9.2
      // actually prints this from `whisper_print_progress_callback:`, which an earlier anchored
      // regex never matched. Matching on "progress = N%" alone is resilient to whichever
      // function name printed it, including future whisper.cpp renames.
      const match = line.match(/progress\s*=\s*(\d+)\s*%/)
      if (match) {
        onProgress(parseInt(match[1]!, 10) / 100)
      }
    }
  }
}

export async function transcribe(
  config: WhisperConfig,
  audioPath: string,
  model: WhisperModel = "medium",
  onProgress?: (progress: number) => void,
): Promise<WhisperTranscriptionResult> {
  if (!isModelDownloaded(config.modelsDir, model)) {
    await downloadModel(config.modelsDir, model, onProgress)
  }

  // A3 — VAD is best-effort: if the model can't be fetched we transcribe without it.
  const vadReady = await downloadVadModel(config.modelsDir)

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
      // A2 — cross-attention DTW token timestamps, far better than raw token offsets.
      // `--no-flash-attn` is REQUIRED: flash attention is on by default and whisper.cpp
      // silently disables DTW when both are set ("dtw_token_timestamps is not supported with
      // flash_attn - disabling"), so the flag would be a no-op without this.
      "--no-flash-attn",
      "--dtw",
      DTW_PRESET[model],
      // print_progress defaults to false in whisper-cli — without this flag it never prints a
      // progress line at all, so onProgress below was never called and the UI sat frozen at
      // whatever percentage the last stage left it at until the whole process exited.
      "-pp",
    ]
    if (vadReady) {
      args.push("--vad", "-vm", vadModelPath(config.modelsDir))
    }

    const proc = spawn(config.binaryPath, args)
    const stderr: string[] = []
    const parseProgress = onProgress ? createProgressParser(onProgress) : null

    proc.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString()
      stderr.push(chunk)
      parseProgress?.(chunk)
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
