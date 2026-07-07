import { createGroq } from "@ai-sdk/groq"
import { generateText, Output } from "ai"
import type { z } from "zod"

export const SUPPORTED_PROVIDERS = ["groq"] as const
export type AiProvider = (typeof SUPPORTED_PROVIDERS)[number]

export type AiClientConfig = {
  provider?: AiProvider
  apiKey?: string
  model?: string
}

export interface AiClient {
  readonly provider: AiProvider
  readonly model: string

  complete(prompt: string, system?: string): Promise<string>

  generateObject<T>(params: { prompt: string; schema: z.ZodType<T>; system?: string }): Promise<T>
}

const DEFAULT_MODELS: Record<AiProvider, string> = {
  groq: "llama-3.3-70b-versatile",
}

const ENV_KEYS: Record<AiProvider, string | undefined> = {
  groq: "GROQ_API_KEY",
}

function envKey(provider: AiProvider): string | undefined {
  return ENV_KEYS[provider]
}

export function createAiClient(config?: AiClientConfig): AiClient {
  const provider = config?.provider ?? "groq"
  const model = config?.model ?? DEFAULT_MODELS[provider]
  const key = config?.apiKey ?? (envKey(provider) ? process.env[envKey(provider)!] : undefined)

  if (!key) {
    throw new Error(
      `No API key for ${provider}. Set ${envKey(provider)} environment variable or pass apiKey in config.`,
    )
  }

  if (provider === "groq") {
    const groq = createGroq({ apiKey: key })
    return createGroqClient(groq, model)
  }

  throw new Error(`Unsupported provider: ${provider}`)
}

function createGroqClient(groq: ReturnType<typeof createGroq>, model: string): AiClient {
  return {
    provider: "groq",
    model,
    async complete(prompt, system) {
      const { text } = await generateText({
        model: groq(model),
        prompt,
        ...(system ? { system } : {}),
      })
      return text
    },
    async generateObject({ prompt, schema: _schema, system }) {
      const { output } = await generateText({
        model: groq(model),
        prompt: `${prompt}\n\nReturn ONLY valid JSON. No explanation, no markdown, no code fences.`,
        ...(system ? { system } : {}),
        output: Output.object({ schema: _schema }),
        providerOptions: {
          groq: {
            structuredOutputs: false,
          },
        },
      })
      return output as never
    },
  }
}
