import type { AiClient } from "./client"

export interface SocialCaption {
  platform: "twitter" | "linkedin" | "instagram"
  caption: string
  hashtags: string[]
}

const SYSTEM_PROMPT = `You are a social media strategist. Write platform-optimized captions for podcast clips.
Return JSON only: [{ platform, caption, hashtags }]`

export async function generateSocialCaptions(
  client: AiClient,
  clipTitle: string,
  clipTranscript: string,
): Promise<SocialCaption[]> {
  const prompt = `Clip title: ${clipTitle}\n\nTranscript:\n${clipTranscript}\n\nWrite captions for Twitter, LinkedIn, and Instagram.`
  const raw = await client.complete(prompt, SYSTEM_PROMPT)
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match?.[0]) throw new Error("AI returned no JSON for social captions")
  return JSON.parse(match[0]) as SocialCaption[]
}
