import { isIP } from 'node:net'

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>

/** Error type for the REST extractor. Messages never contain credentials. */
export class RestError extends Error {
  readonly code: string
  readonly status?: number
  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'RestError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

export function isLoopbackOrPrivate(address: string): boolean {
  let a = address.toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (mapped?.[1]) a = mapped[1]
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number]
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168)
  }
  if (isIP(a) === 6) {
    if (a === '::1') return true
    const first = Number.parseInt(a.split(':')[0] || '0', 16)
    return (first & 0xfe00) === 0xfc00 // fc00::/7
  }
  return false
}

export interface NormalisedSite {
  /** Base URL without trailing slash, no query/hash/userinfo. */
  base: string
  origin: string
  host: string
  secure: boolean
}

export function normaliseSiteUrl(raw: string): NormalisedSite {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new RestError('REST_BAD_URL', 'The source URL is not a valid URL. Use a full address such as https://example.com.')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new RestError('REST_BAD_URL', 'The source URL must start with https:// (or http:// for a local site).')
  }
  if (u.username || u.password) {
    throw new RestError('REST_BAD_URL', 'Remove the user name and password from the source URL. Use WP_USER and WP_APP_PASSWORD instead.')
  }
  const path = u.pathname.replace(/\/+$/, '')
  return { base: `${u.origin}${path}`, origin: u.origin, host: u.hostname, secure: u.protocol === 'https:' }
}

/** Plain http is allowed only when the host resolves exclusively to loopback/private addresses. */
export async function assertTransportAllowed(site: NormalisedSite, lookup: LookupFn): Promise<void> {
  if (site.secure) return
  const host = site.host.replace(/^\[|\]$/g, '')
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host)
  } catch {
    throw new RestError('REST_DNS_FAILED', `Could not resolve ${host}. Check the source URL and your network, then try again.`)
  }
  if (addrs.length === 0 || !addrs.every((a) => isLoopbackOrPrivate(a.address))) {
    throw new RestError(
      'REST_HTTP_NOT_ALLOWED',
      `Refusing plain http to ${host}: it does not resolve to a loopback or private address. Use https://${host} for a remote site.`,
    )
  }
}
