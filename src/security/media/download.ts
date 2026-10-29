import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { MediaError, SecurityError } from '../errors.js'
import { isLoopbackOrPrivateOnly, isPrivateOrReserved } from './address.js'

// Download guard (doc 2.5, 12.6 items 1-3; threat T9). Every hop is checked for scheme,
// host allowlist and resolved addresses, then the socket is opened to the vetted address
// (no second DNS lookup, so no rebinding between check and use).

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>

export interface TransportRequest {
  url: URL
  /** The vetted address to connect to. The Host header and TLS SNI still use `url.hostname`. */
  address: string
  family: 4 | 6
  headers: Record<string, string>
  signal: AbortSignal
}

export interface TransportResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
  /** Stop reading and release the socket. */
  close(): void
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>

export interface DownloadOptions {
  /** Hostname from `source.url`. Trusted for media; may be local/private (doc 12.6 item 3). */
  sourceHost: string
  /** If set, the source-host exception applies only on this port (pass the port from `source.url`). */
  sourcePort?: number
  /** `media.allowedHosts`. These get the full guard. */
  allowedHosts?: readonly string[]
  lookup?: LookupFn
  transport?: Transport
  /** Overall deadline across all hops. Default 30 s. */
  timeoutMs?: number
  /** Size cap. Default 50 MB. */
  maxBytes?: number
  /** Default 3. */
  maxRedirects?: number
  /** Extra request headers. Authorization, Cookie and Host are always dropped. */
  headers?: Record<string, string>
}

export interface DownloadResult {
  bytes: Buffer
  finalUrl: string
  contentType?: string
  redirects: number
  /** True when the source-host exception (plain http and/or a private address) was used. Report it. */
  sourceHostException: boolean
}

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
export const DEFAULT_MAX_REDIRECTS = 3

const DROPPED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'host', 'connection', 'content-length', 'transfer-encoding'])
const REDIRECTS = new Set([301, 302, 303, 307, 308])

const normHost = (h: string) => h.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

const defaultLookup: LookupFn = async (host) => dnsLookup(host, { all: true, verbatim: true })

interface Vetted {
  // Every resolved address passed the checks; they are tried in order (dual-stack hosts such as
  // localhost resolve to ::1 first while a service may listen on 127.0.0.1 only).
  addresses: { address: string; family: 4 | 6 }[]
  exception: boolean
}

// Connection-level failures where the next vetted address may still work.
const TRY_NEXT = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'])

async function vetHop(url: URL, o: DownloadOptions, lookup: LookupFn): Promise<Vetted> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SecurityError('SEC_INSECURE_SCHEME', `Refused ${url.protocol} media URL: only https is allowed.`)
  }
  if (url.username || url.password) {
    throw new MediaError('MEDIA_BAD_URL', 'Media URL contains credentials; refused.')
  }
  const host = normHost(url.hostname)
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  const isSource =
    host === normHost(o.sourceHost) && (o.sourcePort === undefined || o.sourcePort === port)
  const allowed = isSource || (o.allowedHosts ?? []).some((h) => normHost(h) === host)
  if (!allowed) {
    throw new SecurityError('SEC_HOST_NOT_ALLOWED', `Media host ${host} is not the source host or in media.allowedHosts.`)
  }
  const plainHttp = url.protocol === 'http:'
  if (plainHttp && !isSource) {
    throw new SecurityError('SEC_INSECURE_SCHEME', `Refused plain http to ${host}: only https is allowed for media hosts other than the source.`)
  }

  let addrs: { address: string; family: number }[]
  if (isIP(host)) {
    addrs = [{ address: host, family: isIP(host) }]
  } else {
    try {
      addrs = await lookup(host)
    } catch {
      throw new MediaError('MEDIA_DNS_FAILED', `Could not resolve media host ${host}.`)
    }
  }
  if (addrs.length === 0) throw new MediaError('MEDIA_DNS_FAILED', `Media host ${host} has no addresses.`)

  if (isSource) {
    if (plainHttp && !addrs.every((a) => isLoopbackOrPrivateOnly(a.address))) {
      throw new SecurityError('SEC_INSECURE_SCHEME', `Refused plain http to ${host}: it does not resolve only to loopback or private addresses.`)
    }
  } else if (addrs.some((a) => isPrivateOrReserved(a.address))) {
    throw new SecurityError('SEC_SSRF_BLOCKED', `Media host ${host} resolves to a private or reserved address.`)
  }
  return {
    addresses: addrs.map((a) => ({ address: a.address, family: isIP(a.address) === 6 ? 6 : 4 })),
    exception: isSource && (plainHttp || addrs.some((a) => isPrivateOrReserved(a.address))),
  }
}

/** Downloads one media file under the guard. Throws SecurityError (policy) or MediaError (operational). */
export async function safeDownload(rawUrl: string, o: DownloadOptions): Promise<DownloadResult> {
  const lookup = o.lookup ?? defaultLookup
  const transport = o.transport ?? nodeTransport
  const maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = o.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const headers: Record<string, string> = { 'user-agent': 'wp2payload', accept: '*/*', 'accept-encoding': 'identity' }
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (!DROPPED_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new MediaError('MEDIA_BAD_URL', 'Media URL is not a valid URL.')
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const timedOut = () => new MediaError('MEDIA_TIMEOUT', `Media download timed out: ${url.href}`)
  let exception = false
  try {
    for (let hop = 0; ; hop++) {
      const v = await vetHop(url, o, lookup)
      exception ||= v.exception
      if (ac.signal.aborted) throw timedOut()
      let res: TransportResponse | undefined
      for (const [i, a] of v.addresses.entries()) {
        try {
          res = await transport({ url, address: a.address, family: a.family, headers, signal: ac.signal })
          break
        } catch (e) {
          if (ac.signal.aborted) throw timedOut()
          if (e instanceof SecurityError || e instanceof MediaError) throw e
          const code = (e as NodeJS.ErrnoException).code
          if (code && TRY_NEXT.has(code) && i < v.addresses.length - 1) continue
          throw new MediaError('MEDIA_NETWORK', `Could not download ${url.href}: ${code ?? 'network error'}.`)
        }
      }
      if (!res) throw new MediaError('MEDIA_NETWORK', `Could not download ${url.href}.`)

      if (REDIRECTS.has(res.status)) {
        res.close()
        const loc = header(res.headers, 'location')
        if (!loc) throw new MediaError(`MEDIA_HTTP_${res.status}`, `Redirect without a Location from ${url.href}.`, res.status)
        if (hop >= maxRedirects) {
          throw new SecurityError('SEC_TOO_MANY_REDIRECTS', `More than ${maxRedirects} redirects starting at ${rawUrl}.`)
        }
        try {
          url = new URL(loc, url)
        } catch {
          throw new MediaError('MEDIA_BAD_URL', 'Redirect target is not a valid URL.')
        }
        continue
      }
      if (res.status === 404) {
        res.close()
        throw new MediaError('MEDIA_404', `Media not found: ${url.href}`, 404)
      }
      if (res.status < 200 || res.status > 299) {
        res.close()
        throw new MediaError(`MEDIA_HTTP_${res.status}`, `Media request failed with HTTP ${res.status}: ${url.href}`, res.status)
      }

      const declared = Number(header(res.headers, 'content-length') ?? NaN)
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.close()
        throw new SecurityError('SEC_FILE_TOO_LARGE', `Media is ${declared} bytes, over the ${maxBytes}-byte cap.`)
      }
      const chunks: Buffer[] = []
      let total = 0
      try {
        for await (const c of res.body) {
          total += c.length
          if (total > maxBytes) {
            res.close()
            throw new SecurityError('SEC_FILE_TOO_LARGE', `Media exceeded the ${maxBytes}-byte cap while downloading.`)
          }
          chunks.push(Buffer.from(c))
        }
      } catch (e) {
        res.close()
        if (e instanceof SecurityError) throw e
        if (ac.signal.aborted) throw timedOut()
        throw new MediaError('MEDIA_NETWORK', `Download interrupted: ${url.href}.`)
      }
      const contentType = header(res.headers, 'content-type')
      const result: DownloadResult = {
        bytes: Buffer.concat(chunks, total),
        finalUrl: url.href,
        redirects: hop,
        sourceHostException: exception,
      }
      if (contentType) result.contentType = contentType
      return result
    }
  } finally {
    clearTimeout(timer)
  }
}

function header(h: TransportResponse['headers'], name: string): string | undefined {
  const v = h[name] ?? h[Object.keys(h).find((k) => k.toLowerCase() === name) ?? '']
  return Array.isArray(v) ? v[0] : v
}

/** Node transport: connects to the vetted address; Host header and SNI use the URL hostname. */
export const nodeTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    const hostname = req.url.hostname.replace(/^\[|\]$/g, '')
    // Pin the socket to the vetted address. Node may ask for `all: true` (autoSelectFamily).
    const pinned = ((_h: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
      if (opts?.all) cb(null, [{ address: req.address, family: req.family }])
      else cb(null, req.address, req.family)
    }) as unknown as LookupFunction
    const mod = req.url.protocol === 'https:' ? https : http
    const r = mod.request(
      {
        protocol: req.url.protocol,
        // An IP literal host is already the vetted address; otherwise pin via `lookup`.
        host: isIP(hostname) ? req.address : hostname,
        port: req.url.port || undefined,
        path: req.url.pathname + req.url.search,
        method: 'GET',
        headers: req.headers,
        lookup: pinned,
        agent: false,
        signal: req.signal,
        ...(req.url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          close: () => res.destroy(),
        })
      },
    )
    r.on('error', reject)
    r.end()
  })
