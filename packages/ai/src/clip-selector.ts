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

For each clip, provide these exact fields:
- title: short catchy title for the clip
- startMs: start time in milliseconds
- endMs: end time in milliseconds
- score: engagement score from 0 to 1
- reason: 1-2 sentence explanation of why this clip would perform well
- platform: one of "tiktok", "reels", "shorts", or "generic"

Return as JSON with a "clips" array containing the clips.`

export async function selectClips(
  client: AiClient,
  transcript: string,
  maxClips = 5,
): Promise<ClipSuggestion[]> {
  const prompt = `Transcript:\n${transcript}\n\nFind the top ${maxClips} most engaging clips (30–90 seconds each).`
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
