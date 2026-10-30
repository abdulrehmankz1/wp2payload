import { RestError, assertTransportAllowed, normaliseSiteUrl, type LookupFn, type NormalisedSite } from './net.js'

export interface ClientOptions {
  url: string
  auth?: { user: string; appPassword: string }
  fetch: typeof fetch
  lookup: LookupFn
  timeoutMs: number
  maxRetries: number
  sleep: (ms: number) => Promise<void>
}

export interface RestResponse {
  json: unknown
  headers: Headers
}

const MAX_REDIRECTS = 3
const MAX_RETRY_AFTER_MS = 60_000
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
}

class Retryable extends Error {
  readonly err: RestError
  readonly retryAfterMs: number | undefined
  constructor(err: RestError, retryAfterMs?: number) {
    super(err.message)
    this.err = err
    this.retryAfterMs = retryAfterMs
  }
}

export class RestClient {
  readonly site: NormalisedSite
  readonly authenticated: boolean
  readonly #authHeader: string | undefined
  #guard: Promise<void> | undefined
  readonly #o: ClientOptions

  constructor(o: ClientOptions) {
    this.#o = o
    this.site = normaliseSiteUrl(o.url)
    this.authenticated = o.auth !== undefined
    if (o.auth) {
      this.#authHeader = 'Basic ' + Buffer.from(`${o.auth.user}:${o.auth.appPassword}`, 'utf8').toString('base64')
    }
  }

  /** GET a path under the site base, e.g. `/wp-json/wp/v2/posts`. */
  async get(path: string, query: Record<string, string | number> = {}): Promise<RestResponse> {
    this.#guard ??= assertTransportAllowed(this.site, this.#o.lookup)
    await this.#guard
    const url = new URL(this.site.base + path)
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#once(url)
      } catch (e) {
        if (e instanceof Retryable) {
          if (attempt >= this.#o.maxRetries) throw e.err
          await this.#o.sleep(e.retryAfterMs ?? 500 * 2 ** attempt)
          continue
        }
        throw e
      }
    }
  }

  async #once(start: URL): Promise<RestResponse> {
    let url = start
    for (let hops = 0; ; hops++) {
      const headers: Record<string, string> = { Accept: 'application/json' }
      // Credentials only ever go to the configured origin (enforced below on every hop).
      if (this.#authHeader) headers.Authorization = this.#authHeader
      let res: Response
      try {
        res = await this.#o.fetch(url.toString(), {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.#o.timeoutMs),
        })
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
        throw new Retryable(
          new RestError(
            timedOut ? 'REST_TIMEOUT' : 'REST_NETWORK',
            timedOut
              ? `Request to ${this.site.origin} timed out after ${this.#o.timeoutMs} ms. Check the site is up, then try again.`
              : `Could not connect to ${this.site.origin}. Check the URL and your network connection.`,
          ),
        )
      }

      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        if (hops >= MAX_REDIRECTS) {
          throw new RestError('REST_TOO_MANY_REDIRECTS', `${this.site.origin} redirected more than ${MAX_REDIRECTS} times. Check the source URL.`)
        }
        const loc = res.headers.get('location')
        let next: URL
        try {
          if (!loc) throw new Error('no location')
          next = new URL(loc, url)
        } catch {
          throw new RestError('REST_BAD_REDIRECT', `${this.site.origin} sent an invalid redirect. Check the source URL.`)
        }
        if (next.origin !== this.site.origin) {
          throw new RestError(
            'REST_CROSS_ORIGIN',
            `Refusing redirect from ${this.site.origin} to another origin (${next.origin}). Set the source URL to the final site address.`,
          )
        }
        url = next
        continue
      }

      if (res.status === 429 || res.status >= 500) {
        throw new Retryable(this.#httpError(res.status), retryAfter(res.headers.get('retry-after')))
      }
      if (!res.ok) throw this.#httpError(res.status, await wpErrorCode(res))

      try {
        return { json: await res.json(), headers: res.headers }
      } catch {
        throw new RestError('REST_NOT_JSON', `${this.site.base}/wp-json did not return JSON. Check the URL points at a WordPress site.`)
      }
    }
  }

  #httpError(status: number, wpCode?: string): RestError {
    const label = `${status} ${STATUS_TEXT[status] ?? 'Error'}`
    const head = `Could not reach ${this.site.base}/wp-json (${label})`
    if (status === 401 || status === 403) {
      return new RestError(
        'REST_AUTH',
        `${head}\nCheck WP_USER and WP_APP_PASSWORD. Application Passwords are under Users → Profile in WordPress 5.6+.`,
        status,
        wpCode,
      )
    }
    if (status === 404) {
      return new RestError(
        'REST_NOT_FOUND',
        `${head}\nThe WordPress REST API is disabled or the URL is wrong. Check the source URL and that /wp-json is not blocked by a plugin or firewall.`,
        status,
        wpCode,
      )
    }
    return new RestError('REST_HTTP', `${head}\nThe server rejected the request. Try again later or check the site logs.`, status, wpCode)
  }
}

const MAX_ERROR_BODY_CHARS = 64 * 1024

/** The `code` of a WordPress REST error body, if it is a short identifier. Never echoes other content. */
async function wpErrorCode(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text()
    if (text.length > MAX_ERROR_BODY_CHARS) return undefined
    const body: unknown = JSON.parse(text)
    const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined
    return typeof code === 'string' && /^[a-z0-9_]{1,64}$/i.test(code) ? code : undefined
  } catch {
    return undefined
  }
}

function retryAfter(v: string | null): number | undefined {
  if (!v) return undefined
  const secs = Number(v)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_RETRY_AFTER_MS)
  const date = Date.parse(v)
  if (Number.isNaN(date)) return undefined
  return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS)
}
