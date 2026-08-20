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

// llama-3.3-70b-versatile was deprecated by Groq — gpt-oss-120b is the current production-tier
// model (console.groq.com/docs/models, Production Models table).
const DEFAULT_TEXT_MODEL = "openai/gpt-oss-120b"
// json_object mode works on all Groq models. The SDK validates against Zod client-side.
// strict json_schema mode has limited model support and requires additionalProperties:false
// in every object which the AI SDK doesn't always produce correctly.
const DEFAULT_STRUCTURED_MODEL = "openai/gpt-oss-120b"

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

// A malformed/truncated JSON response from the model is common enough with json_object mode
// (no schema enforcement server-side) that a single attempt regularly loses an entire chunk's
// worth of clip candidates. Retrying a few times with backoff turns a transient bad response
// into a non-event instead of an aborted pipeline stage.
const GENERATE_OBJECT_ATTEMPTS = 3
const RETRY_BACKOFF_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
      let lastError: unknown
      for (let attempt = 1; attempt <= GENERATE_OBJECT_ATTEMPTS; attempt++) {
        try {
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
        } catch (err) {
          lastError = err
          if (attempt < GENERATE_OBJECT_ATTEMPTS) await sleep(RETRY_BACKOFF_MS * attempt)
        }
      }
      throw lastError
    },
  }
}
