export interface RetryOptions {
  attempts?: number // total tries, default 3 (doc 2.8)
  baseMs?: number // backoff base, doubles each try, default 250
}

/** Retry a Payload write with exponential backoff; rethrows the last error. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3
  const base = opts.baseMs ?? 250
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      last = error
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, base * 2 ** i))
    }
  }
  throw last
}
