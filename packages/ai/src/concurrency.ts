// Small shared helpers for running many LLM calls without tripping provider rate limits.
//
// Kept separate from the client because the policy here — how long to wait after a 429, how many
// calls may be in flight — belongs to the selection pipeline, not to one provider's wrapper.

/**
 * Runs `fn` over `items` with at most `limit` in flight, returning results in INPUT order.
 *
 * Order matters: results are stored by index rather than pushed as calls finish, so two runs over
 * the same candidates cannot rank differently just because one response came back sooner.
 * `fn` must not throw — callers turn failures into values, so one bad item cannot reject the pool.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker)
  await Promise.all(workers)
  return results
}

/** Longest wait between rate-limit retries. Bounds worst-case run time. */
const MAX_RATE_LIMIT_WAIT_MS = 20_000
const BASE_RATE_LIMIT_WAIT_MS = 1_000
const RATE_LIMIT_ATTEMPTS = 4

interface ErrorLike {
  statusCode?: unknown
  status?: unknown
  message?: unknown
  cause?: unknown
  responseHeaders?: unknown
}

function asErrorLike(err: unknown): ErrorLike | null {
  return typeof err === "object" && err !== null ? (err as ErrorLike) : null
}

/** True for an HTTP 429 / "rate limit" failure, looking through `cause` chains. */
export function isRateLimitError(err: unknown): boolean {
  let current: unknown = err
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = asErrorLike(current)
    if (!e) return false
    if (e.statusCode === 429 || e.status === 429) return true
    if (typeof e.message === "string" && /\b429\b|rate.?limit|too many requests/i.test(e.message)) {
      return true
    }
    current = e.cause
  }
  return false
}

/** The server's own `retry-after` hint in ms, when the error carries response headers. */
function retryAfterMs(err: unknown): number | null {
  const headers = asErrorLike(err)?.responseHeaders
  if (typeof headers !== "object" || headers === null) return null
  const raw = (headers as Record<string, unknown>)["retry-after"]
  const seconds = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null
}

export type Sleep = (ms: number) => Promise<void>

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Calls `fn`, retrying ONLY rate-limit failures with a wait that honours `retry-after` and
 * otherwise backs off 1s, 2s, 4s. Any other error is thrown at once — `client.generateObject`
 * already retries malformed output, and retrying a real failure here would multiply its attempts.
 */
export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  sleep: Sleep = realSleep,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= RATE_LIMIT_ATTEMPTS) throw err
      const wait = retryAfterMs(err) ?? BASE_RATE_LIMIT_WAIT_MS * 2 ** (attempt - 1)
      await sleep(Math.min(wait, MAX_RATE_LIMIT_WAIT_MS))
    }
  }
}

/** Fingerprint-irrelevant: these change speed, not what the model reads. Exported for tests. */
export const RATE_LIMIT_POLICY = {
  attempts: RATE_LIMIT_ATTEMPTS,
  baseWaitMs: BASE_RATE_LIMIT_WAIT_MS,
  maxWaitMs: MAX_RATE_LIMIT_WAIT_MS,
} as const
