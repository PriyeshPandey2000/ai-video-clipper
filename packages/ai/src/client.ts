import { createGroq } from "@ai-sdk/groq"
import { generateText, Output } from "ai"
import type { z } from "zod"

export const SUPPORTED_PROVIDERS = ["groq"] as const
export type AiProvider = (typeof SUPPORTED_PROVIDERS)[number]

export type AiClientConfig = {
  provider?: AiProvider
  apiKey?: string
  textModel?: string
  structuredModel?: string
}

export interface AiClient {
  readonly provider: AiProvider
  readonly textModel: string
  readonly structuredModel: string

  complete(prompt: string, system?: string): Promise<string>

  generateObject<T>(params: { prompt: string; schema: z.ZodType<T>; system?: string }): Promise<T>
}

const DEFAULT_TEXT_MODEL = "llama-3.3-70b-versatile"
// json_object mode works on all Groq models. The SDK validates against Zod client-side.
// strict json_schema mode has limited model support and requires additionalProperties:false
// in every object which the AI SDK doesn't always produce correctly.
const DEFAULT_STRUCTURED_MODEL = "llama-3.3-70b-versatile"

const ENV_KEYS: Record<AiProvider, string | undefined> = {
  groq: "GROQ_API_KEY",
}

function envKey(provider: AiProvider): string | undefined {
  return ENV_KEYS[provider]
}

export function createAiClient(config?: AiClientConfig): AiClient {
  const provider = config?.provider ?? "groq"
  const textModel = config?.textModel ?? DEFAULT_TEXT_MODEL
  const structuredModel = config?.structuredModel ?? DEFAULT_STRUCTURED_MODEL
  const key = config?.apiKey ?? (envKey(provider) ? process.env[envKey(provider)!] : undefined)

  if (!key) {
    throw new Error(
      `No API key for ${provider}. Set ${envKey(provider)} environment variable or pass apiKey in config.`,
    )
  }

  if (provider === "groq") {
    const groq = createGroq({ apiKey: key })
    return createGroqClient(groq, textModel, structuredModel)
  }

  throw new Error(`Unsupported provider: ${provider}`)
}

function createGroqClient(
  groq: ReturnType<typeof createGroq>,
  textModel: string,
  structuredModel: string,
): AiClient {
  return {
    provider: "groq",
    textModel,
    structuredModel,
    async complete(prompt, system) {
      const { text } = await generateText({
        model: groq(textModel),
        prompt,
        ...(system ? { system } : {}),
      })
      return text
    },
    async generateObject({ prompt, schema: _schema, system }) {
      const { output } = await generateText({
        model: groq(structuredModel),
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
