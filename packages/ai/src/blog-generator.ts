import type { AiClient } from "./client"

const SYSTEM_PROMPT = `You are a content writer. Convert podcast transcripts into engaging blog posts.
Write in first person, clean prose, no filler. Include a title, introduction, sections with headers, and conclusion.
Return markdown.`

export async function generateBlogPost(client: AiClient, transcript: string): Promise<string> {
  return client.complete(
    `Convert this podcast transcript into a blog post:\n\n${transcript}`,
    SYSTEM_PROMPT,
  )
}
