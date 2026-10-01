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

/**
 * Temperature for every structured (clip-selection) call. Pinned to 0 so two runs over the same
 * transcript are comparable — #97's whole test loop is "re-run selection and read the report",
 * and an unpinned temperature makes every report a coin flip against the previous one.
 *
 * Exported rather than inlined so the pipeline fingerprint and the debug report cannot drift from
 * the value actually sent: both read this constant, so changing one place changes all three.
 *
 * This is the temperature half of #90. The other half (top_p, seed) is not exposed by the
 * Groq provider in a way this SDK surfaces, so 0 is the strongest determinism available here.
 */
export const CLIP_SELECTION_TEMPERATURE = 0

export interface AiClient {
  readonly provider: AiProvider
  readonly textModel: string
  readonly structuredModel: string
  /** The temperature actually sent on every generateObject call. See CLIP_SELECTION_TEMPERATURE. */
  readonly temperature: number

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
  // CLIP_MODEL overrides the structured model without a code edit, so the 5-video comparison in
  // #97 can switch models by restarting the app rather than by rebuilding. Precedence is
  // explicit config > env > default, matching every other config field in this function.
  const structuredModel =
    config?.structuredModel ?? process.env["CLIP_MODEL"] ?? DEFAULT_STRUCTURED_MODEL
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

// Appended to every structured-output prompt. Exported because it is part of what the model
// actually receives, so the pipeline fingerprint must cover it (#89) — editing this changes clip
// output as surely as editing a system prompt does.
export const STRUCTURED_OUTPUT_SUFFIX =
  "\n\nReturn ONLY valid JSON. No explanation, no markdown, no code fences."

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
    temperature: CLIP_SELECTION_TEMPERATURE,
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
            prompt: `${prompt}${STRUCTURED_OUTPUT_SUFFIX}`,
            // Pinned, not defaulted: without this the provider picks, and two runs over the same
            // transcript diverge for reasons no report can attribute (#97/#90).
            temperature: CLIP_SELECTION_TEMPERATURE,
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
