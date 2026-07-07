import type { AiClient } from "./client"

export interface ClipSuggestion {
  title: string
  startMs: number
  endMs: number
  score: number
  reason: string
  platform: "tiktok" | "reels" | "shorts" | "generic"
}

const SYSTEM_PROMPT = `You are a viral content editor. Given a podcast transcript with word-level timestamps,
identify the most engaging segments that would perform well as short-form social media clips.
Return JSON only. No explanation outside the JSON.`

export async function selectClips(
  client: AiClient,
  transcript: string,
  maxClips = 5,
): Promise<ClipSuggestion[]> {
  const prompt = `Transcript:\n${transcript}\n\nFind the top ${maxClips} most engaging clips (30–90 seconds each).
Return JSON array: [{ title, startMs, endMs, score (0-1), reason, platform }]`

  const raw = await client.complete(prompt, SYSTEM_PROMPT)

  const match = raw.match(/\[[\s\S]*\]/)
  if (!match?.[0]) throw new Error("AI returned no JSON array for clip selection")

  return JSON.parse(match[0]) as ClipSuggestion[]
}
