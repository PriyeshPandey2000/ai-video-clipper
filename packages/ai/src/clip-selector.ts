import type { AiClient } from "./client"
import type { z } from "zod"
import { z as zod } from "zod"

export interface ClipSuggestion {
  title: string
  startMs: number
  endMs: number
  score: number
  reason: string
  platform: "tiktok" | "reels" | "shorts" | "generic"
}

const ClipSuggestionSchema = zod.object({
  title: zod.string(),
  startMs: zod.number(),
  endMs: zod.number(),
  score: zod.number().min(0).max(1),
  reason: zod.string(),
  platform: zod.enum(["tiktok", "reels", "shorts", "generic"]),
})

const SYSTEM_PROMPT = `You are a viral content editor. Given a podcast transcript with word-level timestamps,
identify the most engaging segments that would perform well as short-form social media clips.

The transcript format is: [seconds] word [seconds] word ...
Example: [10.50] Hello [10.80] everyone [11.20] welcome

For each clip, provide these exact fields:
- title: short catchy title for the clip
- startMs: start time in MILLISECONDS (multiply the transcript timestamp in seconds by 1000)
- endMs: end time in MILLISECONDS (multiply the transcript timestamp in seconds by 1000)
- score: engagement score from 0 to 1
- reason: 1-2 sentence explanation of why this clip would perform well
- platform: one of "tiktok", "reels", "shorts", or "generic"

IMPORTANT: startMs and endMs must be in milliseconds. If the transcript shows [45.20], the value is 45200.
IMPORTANT: startMs and endMs must be within the actual transcript boundaries — do not exceed the video duration.

Return as JSON with a "clips" array containing the clips.`

export async function selectClips(
  client: AiClient,
  transcript: string,
  videoDurationMs: number,
  maxClips = 5,
): Promise<ClipSuggestion[]> {
  const durationSec = videoDurationMs / 1000
  const targetMin = Math.max(10, Math.round(durationSec * 0.2))
  const targetMax = Math.max(targetMin, Math.round(durationSec * 0.6))
  const clipCount = Math.min(maxClips, Math.max(1, Math.floor(durationSec / targetMin)))
  const prompt = `Video duration: ${durationSec.toFixed(1)} seconds (${videoDurationMs}ms).\n\nTranscript:\n${transcript}\n\nFind the top ${clipCount} most engaging clips (each ${targetMin}–${targetMax} seconds long). Do not exceed the video duration.`
  const schema = zod.object({
    clips: zod.array(ClipSuggestionSchema).min(1).max(maxClips),
  })
  const result = await client.generateObject({
    prompt,
    schema: schema as unknown as z.ZodType<{ clips: ClipSuggestion[] }>,
    system: SYSTEM_PROMPT,
  })
  return result.clips
}
