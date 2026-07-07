import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

export type AiProvider = "openai" | "anthropic"

export interface AiClient {
  provider: AiProvider
  complete(prompt: string, systemPrompt: string): Promise<string>
}

export function createAiClient(provider: AiProvider, apiKey: string): AiClient {
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey })
    return {
      provider,
      async complete(prompt, systemPrompt) {
        const msg = await client.messages.create({
          model: "claude-sonnet-5",
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }],
        })
        const block = msg.content[0]
        if (block?.type !== "text") throw new Error("Unexpected response type from Anthropic")
        return block.text
      },
    }
  }

  const client = new OpenAI({ apiKey })
  return {
    provider,
    async complete(prompt, systemPrompt) {
      const res = await client.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      })
      const content = res.choices[0]?.message.content
      if (!content) throw new Error("Empty response from OpenAI")
      return content
    },
  }
}
