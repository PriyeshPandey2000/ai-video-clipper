import { spawn } from "node:child_process"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { readFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

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
  blurBg?: boolean // fill 9:16 background with blurred source instead of black bars
  // E6 — two-pass loudnorm to -14 LUFS. Ignored when removeSegments spans more than one
  // keep interval — that path routes through exportEpisode, which doesn't normalize.
  normalizeLoudness?: boolean
  /** D7 — filler/silence segments to cut out of the clip before encoding. */
  removeSegments?: { startMs: number; endMs: number }[]
  /** E5 — text burned into the first ~3 s of the clip with a fade-out (hook overlay). */
  hookText?: string
  onProgress?: (fraction: number) => void
}

/**
 * Subtracts `remove` intervals from `[startMs, endMs]`, returning the kept intervals in order.
 * Exported so callers can remap subtitle timestamps against the same intervals.
 */
export function subtractSegments(
  startMs: number,
  endMs: number,
  remove: { startMs: number; endMs: number }[],
): { startMs: number; endMs: number }[] {
  const sorted = remove
    .filter((r) => r.startMs < endMs && r.endMs > startMs)
    .sort((a, b) => a.startMs - b.startMs)
  const result: { startMs: number; endMs: number }[] = []
  let cur = startMs
  for (const r of sorted) {
    const rs = Math.max(r.startMs, startMs)
    const re = Math.min(r.endMs, endMs)
    if (cur < rs) result.push({ startMs: cur, endMs: rs })
    cur = Math.max(cur, re)
  }
  if (cur < endMs) result.push({ startMs: cur, endMs: endMs })
  return result
}

/** E6 — streaming targets. -14 LUFS is where platforms stop turning content down. */
const LUFS_TARGET = -14
const TRUE_PEAK_TARGET = -1.5
const LRA_TARGET = 11

/** Upper bound on the measure pass so a stalled ffmpeg can't hang the export forever. */
const MEASURE_TIMEOUT_MS = 120_000

interface LoudnessStats {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

/**
 * Pass 1 of loudnorm. Single-pass loudnorm compresses dynamic range because it can't see the
 * whole signal; measuring first and feeding the values back keeps the dynamics intact.
 * Returns null on failure — the caller then skips normalization rather than failing the export.
 */
async function measureLoudness(
  binaryPath: string,
  inputPath: string,
  startMs: number,
  endMs: number,
): Promise<LoudnessStats | null> {
  const args = [
    "-hide_banner",
    "-nostats",
    "-ss",
    String(startMs / 1000),
    "-i",
    inputPath,
    "-t",
    String((endMs - startMs) / 1000),
    "-vn",
    "-af",
    `loudnorm=I=${LUFS_TARGET}:TP=${TRUE_PEAK_TARGET}:LRA=${LRA_TARGET}:print_format=json`,
    "-f",
    "null",
    "-",
  ]

  return new Promise((resolve) => {
    const proc = spawn(binaryPath, args)
    let stderr = ""
    let settled = false

    const finish = (value: LoudnessStats | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    // Without this, a stalled ffmpeg leaves the export awaiting forever and the export:clips IPC
    // handler never returns — a stuck export with no way to recover.
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      finish(null)
    }, MEASURE_TIMEOUT_MS)

    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on("error", () => finish(null))
    proc.on("close", (code) => {
      if (code !== 0) return finish(null)
      // loudnorm prints its JSON block last on stderr.
      const start = stderr.lastIndexOf("{")
      const end = stderr.lastIndexOf("}")
      if (start === -1 || end <= start) return finish(null)
      try {
        const parsed = JSON.parse(stderr.slice(start, end + 1)) as Partial<LoudnessStats>
        finish(isCompleteStats(parsed) ? parsed : null)
      } catch {
        finish(null)
      }
    })
  })
}

/**
 * `loudnormFilter` interpolates five fields. A missing or non-numeric one yields
 * `measured_TP=undefined` or a stray `:` that splits the filter options — ffmpeg then rejects
 * `-af` and the whole export fails, defeating the point of falling back to no normalization.
 */
function isCompleteStats(stats: Partial<LoudnessStats>): stats is LoudnessStats {
  return (["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"] as const).every(
    (key) => {
      // Number() coerces null, false and "" to 0, all finite — so check the type and emptiness
      // first. loudnorm also reports "-inf" for silent audio, which Number() maps to NaN.
      const value = stats[key]
      return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
    },
  )
}

function loudnormFilter(stats: LoudnessStats): string {
  return [
    `loudnorm=I=${LUFS_TARGET}`,
    `TP=${TRUE_PEAK_TARGET}`,
    `LRA=${LRA_TARGET}`,
    `measured_I=${stats.input_i}`,
    `measured_TP=${stats.input_tp}`,
    `measured_LRA=${stats.input_lra}`,
    `measured_thresh=${stats.input_thresh}`,
    `offset=${stats.target_offset}`,
    "linear=true",
    "print_format=summary",
  ].join(":")
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
    proc.on("error", reject)
  })
}

// Uses FFmpeg's -progress pipe:1 to stream machine-readable progress to stdout.
// out_time_ms is in microseconds despite the name (same as out_time_us).
function runWithProgress(
  binaryPath: string,
  args: string[],
  totalMs: number,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const allArgs = [...args.slice(0, -1), "-progress", "pipe:1", args[args.length - 1]!]
    const proc = spawn(binaryPath, allArgs)
    const stderr: string[] = []
    let buf = ""
    proc.stdout.on("data", (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        const m = line.match(/^out_time_ms=(\d+)/)
        if (m && totalMs > 0) {
          onProgress(Math.min(parseInt(m[1]!, 10) / 1000 / totalMs, 1))
        }
      }
    })
    proc.stderr.on("data", (d: Buffer) => stderr.push(d.toString()))
    proc.on("close", (code) => {
      if (code === 0) {
        onProgress(1)
        resolve()
      } else {
        reject(new Error(`FFmpeg exited ${code}:\n${stderr.join("")}`))
      }
    })
    proc.on("error", reject)
  })
}

function escapeDrawtextText(text: string): string {
  // Two escaping levels stack here: drawtext's own option-value level (colon, percent) and the
  // outer filtergraph level (comma, semicolon, brackets — these delimit filters/chains/links and
  // will otherwise truncate or misparse the whole -vf chain, not just the text). Backslash first,
  // since every other replacement below introduces literal backslashes that must survive as-is.
  return (
    text
      .replace(/\\/g, "\\\\")
      // Deliberately NOT backslash-escaped (`\'`). Verified against the app's bundled ffmpeg binary:
      // `\'` renders a blank frame (no text at all), `\\'` renders with the apostrophe silently
      // dropped. FFmpeg's drawtext quote escaping is notoriously inconsistent across its own
      // documented "levels" — even the official docs recommend `textfile=` instead. Substituting
      // the lookalike U+2019 is the only one of these that renders correctly.
      .replace(/'/g, "’")
      .replace(/:/g, "\\:")
      .replace(/%/g, "%%")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]")
  )
}

function buildDrawtextFilter(text: string): string {
  const escaped = escapeDrawtextText(text)
  // Fade: fully visible until 2.5 s, fades to transparent by 3 s.
  // '...' around the alpha expression protects its commas from filtergraph option parsing.
  return [
    `drawtext=text=${escaped}`,
    `x=(w-text_w)/2`,
    `y=h*0.06`,
    `fontsize=52`,
    `fontcolor=white`,
    `box=1`,
    `boxcolor=black@0.45`,
    `boxborderw=12`,
    `alpha='if(lt(t,2.5),1,max(0,(3-t)/0.5))'`,
  ].join(":")
}

/** Thrown by {@link exportClip} when removeSegments consumes the entire clip range. */
export class EmptyClipError extends Error {
  constructor() {
    super("clip has no content left after removing filler/silence segments")
    this.name = "EmptyClipError"
  }
}

export async function exportClip(opts: ExportOptions): Promise<void> {
  // D7 — strip filler/silence segments within the clip before encoding.
  if (opts.removeSegments?.length) {
    const intervals = subtractSegments(opts.startMs, opts.endMs, opts.removeSegments)
    if (intervals.length === 0) throw new EmptyClipError()
    if (intervals.length > 1) {
      return exportEpisode({
        binaryPath: opts.binaryPath,
        inputPath: opts.inputPath,
        outputPath: opts.outputPath,
        keepIntervals: intervals,
        ...(opts.assPath ? { assPath: opts.assPath, fontsDir: opts.fontsDir } : {}),
        ...(opts.srtPath && !opts.assPath ? { srtPath: opts.srtPath } : {}),
        ...(opts.reframe ? { reframe: true, cropX: opts.cropX, blurBg: opts.blurBg } : {}),
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      })
    }
    // Single keep interval — tighten bounds and fall through to the normal path.
    opts = { ...opts, startMs: intervals[0]!.startMs, endMs: intervals[0]!.endMs }
  }

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

  // E5 — hook text overlay: visible for first 3 s with a 0.5 s fade-out starting at 2.5 s.
  // Not applied when D7 routes through exportEpisode (multi-interval concat path).
  const drawtextFilter = opts.hookText ? buildDrawtextFilter(opts.hookText) : null

  if (opts.reframe && opts.blurBg) {
    const bgChain = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=20:luma_power=2`
    // Fit full frame (no crop) — lets blurred bg show above/below for 16:9 sources
    const fgChain = `scale=1080:1920:force_original_aspect_ratio=decrease`
    // Chain extra filters (subtitle, then drawtext) after the overlay as separate graph nodes.
    const extraFilters = [subtitleFilter, drawtextFilter].filter((f): f is string => f !== null)
    const overlayOut = extraFilters.length > 0 ? "f0" : "out"
    const filterParts = [
      `[0:v]${bgChain}[bg]`,
      `[0:v]${fgChain}[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[${overlayOut}]`,
    ]
    extraFilters.forEach((f, i) => {
      filterParts.push(`[f${i}]${f}[${i === extraFilters.length - 1 ? "out" : `f${i + 1}`}]`)
    })
    args.push("-filter_complex", filterParts.join(";"), "-map", "[out]", "-map", "0:a?")
  } else if (opts.reframe) {
    const cx = opts.cropX ?? 0.5
    const cropFilter = `crop=ih*9/16:ih:(iw-ih*9/16)*${cx}:0,scale=1080:1920`
    const vfParts = [cropFilter, subtitleFilter, drawtextFilter].filter(
      (f): f is string => f !== null,
    )
    args.push("-vf", vfParts.join(","))
  } else if (subtitleFilter || drawtextFilter) {
    const vfParts = [subtitleFilter, drawtextFilter].filter((f): f is string => f !== null)
    args.push("-vf", vfParts.join(","))
  }
  if (opts.normalizeLoudness) {
    const stats = await measureLoudness(opts.binaryPath, opts.inputPath, opts.startMs, opts.endMs)
    if (stats) args.push("-af", loudnormFilter(stats))
  }

  args.push(opts.outputPath)
  if (opts.onProgress) {
    await runWithProgress(opts.binaryPath, args, opts.endMs - opts.startMs, opts.onProgress)
  } else {
    await run(opts.binaryPath, args)
  }
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
  reframe?: boolean
  cropX?: number
  blurBg?: boolean
  onProgress?: (fraction: number) => void
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
      ...(opts.reframe ? { reframe: true, cropX: opts.cropX, blurBg: opts.blurBg } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    })
    return
  }

  const filterParts: string[] = []
  const cx = opts.cropX ?? 0.5

  opts.keepIntervals.forEach((seg, i) => {
    const start = seg.startMs / 1000
    const end = seg.endMs / 1000
    if (opts.reframe && opts.blurBg) {
      // Per-segment: split raw → blur bg + 9:16 fg → overlay
      filterParts.push(`[0:v]trim=${start}:${end},setpts=PTS-STARTPTS[vraw${i}]`)
      filterParts.push(`[vraw${i}]split[vbg${i}][vfg${i}]`)
      filterParts.push(
        `[vbg${i}]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=20:luma_power=2[bg${i}]`,
      )
      filterParts.push(`[vfg${i}]scale=1080:1920:force_original_aspect_ratio=decrease[fg${i}]`)
      filterParts.push(`[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2[v${i}]`)
    } else if (opts.reframe) {
      filterParts.push(
        `[0:v]trim=${start}:${end},setpts=PTS-STARTPTS,crop=ih*9/16:ih:(iw-ih*9/16)*${cx}:0,scale=1080:1920[v${i}]`,
      )
    } else {
      filterParts.push(`[0:v]trim=${start}:${end},setpts=PTS-STARTPTS[v${i}]`)
    }
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

  const episodeArgs = [
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
  ]
  if (opts.onProgress) {
    const totalMs = opts.keepIntervals.reduce((sum, iv) => sum + (iv.endMs - iv.startMs), 0)
    await runWithProgress(opts.binaryPath, episodeArgs, totalMs, opts.onProgress)
  } else {
    await run(opts.binaryPath, episodeArgs)
  }
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

const AROUSAL_TIMEOUT_MS = 300_000

/**
 * B4 — Measures per-second audio RMS (dBFS) for the full file using ffmpeg astats.
 * Returns one value per second, index-aligned to the recording start (index 0 = second 0).
 * Returns [] on any failure — arousal signal is always optional.
 */
export async function measureArousal(binaryPath: string, inputPath: string): Promise<number[]> {
  const tmp = join(tmpdir(), `arousal-${randomUUID()}.txt`)
  const args = [
    "-hide_banner",
    "-nostats",
    "-i",
    inputPath,
    "-vn",
    "-af",
    // aresample=8000 normalises sample rate INSIDE the filter chain so asetnsamples=n=8000
    // always produces exactly one second of audio per frame regardless of the source rate.
    // (-ar on the output option applies AFTER the filter chain, not before.)
    // reset=1 resets astats once per frame → one RMS value per second.
    // p=0 drops a trailing partial second to avoid a skewed final value.
    `aresample=8000,aformat=channel_layouts=mono,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:file=${escapeFiltergraphPath(tmp)}:key=lavfi.astats.Overall.RMS_level`,
    "-f",
    "null",
    "-",
  ]

  return new Promise((resolve) => {
    const proc = spawn(binaryPath, args)
    let settled = false

    // Drain stdout/stderr so ffmpeg never blocks on a full pipe buffer.
    proc.stdout.on("data", () => {})
    proc.stderr.on("data", () => {})

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!ok) {
        unlink(tmp)
          .catch(() => {})
          .finally(() => resolve([]))
        return
      }
      readFile(tmp, "utf-8")
        .then((content) => {
          const vals: number[] = []
          for (const line of content.split("\n")) {
            const m = line.match(/RMS_level=(-?(?:inf|\d+\.?\d*))/)
            if (!m) continue
            const raw = m[1]!
            const db = raw.includes("inf") ? -60 : parseFloat(raw)
            vals.push(isFinite(db) ? db : -60)
          }
          resolve(vals)
        })
        .catch(() => resolve([]))
        .finally(() => unlink(tmp).catch(() => {}))
    }

    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
      finish(false)
    }, AROUSAL_TIMEOUT_MS)

    proc.on("error", () => finish(false))
    proc.on("close", (code) => finish(code === 0))
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
