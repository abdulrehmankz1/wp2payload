import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SecurityError, MediaError } from '../../src/security/errors.js'
import { isPrivateOrReserved } from '../../src/security/media/address.js'
import { safeDownload, type DownloadOptions, type Transport, type TransportRequest } from '../../src/security/media/download.js'

const PUBLIC = '93.184.216.34'
const lookupMap = (m: Record<string, string[]>) => async (host: string) => {
  const a = m[host]
  if (!a) throw new Error('ENOTFOUND ' + host)
  return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

type Reply = { status?: number; headers?: Record<string, string>; chunks?: Buffer[] }
function fakeTransport(handler: (req: TransportRequest, n: number) => Reply) {
  const calls: TransportRequest[] = []
  const transport: Transport = async (req) => {
    calls.push(req)
    const r = handler(req, calls.length)
    const chunks = r.chunks ?? [Buffer.from('hello')]
    return {
      status: r.status ?? 200,
      headers: r.headers ?? { 'content-type': 'image/jpeg' },
      body: (async function* () {
        for (const c of chunks) yield c
      })(),
      close: () => {},
    }
  }
  return { transport, calls }
}

const base = (extra: Partial<DownloadOptions> = {}): DownloadOptions => ({
  sourceHost: 'example.com',
  allowedHosts: ['cdn.example.net'],
  lookup: lookupMap({ 'example.com': [PUBLIC], 'cdn.example.net': [PUBLIC], 'evil.example': [PUBLIC] }),
  ...extra,
})

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof SecurityError || e instanceof MediaError) return e.code
    throw e
  }
  return 'NO_ERROR'
}

describe('isPrivateOrReserved (T9)', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '0.1.2.3', '100.64.0.1', '100.127.255.255', '224.0.0.1', '239.1.1.1', '255.255.255.255', '240.0.0.1',
    '192.0.0.8', '198.18.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '::1', '::', 'fe80::1', 'FE80::abcd', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '2001:db8::1', '::127.0.0.1', 'not-an-ip',
  ]
  const allowed = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:93.184.216.34']
  it.each(blocked)('blocks %s', (a) => expect(isPrivateOrReserved(a)).toBe(true))
  it.each(allowed)('allows %s', (a) => expect(isPrivateOrReserved(a)).toBe(false))
})

describe('safeDownload policy (AC-B2, fake transport)', () => {
  it('downloads over https from the source host and connects to the vetted address with the original host', async () => {
    const f = fakeTransport(() => ({ chunks: [Buffer.from('ab'), Buffer.from('cd')] }))
    const r = await safeDownload('https://example.com/wp-content/uploads/a.jpg', base({ transport: f.transport }))
    expect(r.bytes.toString()).toBe('abcd')
    expect(r.finalUrl).toBe('https://example.com/wp-content/uploads/a.jpg')
    expect(r.contentType).toBe('image/jpeg')
    expect(r.sourceHostException).toBe(false)
    expect(f.calls[0]?.address).toBe(PUBLIC)
    expect(f.calls[0]?.url.hostname).toBe('example.com')
  })

  // Found against the Docker fixture: localhost resolves to ::1 first, WordPress listens on 127.0.0.1 only.
  it('falls back to the next vetted address when the first refuses the connection', async () => {
    const calls: string[] = []
    const transport: Transport = async (req) => {
      calls.push(req.address)
      if (req.family === 6) throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
      return { status: 200, headers: {}, body: (async function* () { yield Buffer.from('ok') })(), close: () => {} }
    }
    const r = await safeDownload('http://localhost:8080/a.jpg', {
      sourceHost: 'localhost',
      sourcePort: 8080,
      lookup: lookupMap({ localhost: ['::1', '127.0.0.1'] }),
      transport,
    })
    expect(r.bytes.toString()).toBe('ok')
    expect(calls).toEqual(['::1', '127.0.0.1'])
  })

  it('does not fall back when the last address also refuses', async () => {
    const transport: Transport = async () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
    }
    expect(await code(safeDownload('https://example.com/a.jpg', base({ transport })))).toBe('MEDIA_NETWORK')
  })

  it('never sends Authorization or Cookie, even when the caller passes them', async () => {
    const f = fakeTransport(() => ({}))
    await safeDownload(
      'https://example.com/a.jpg',
      base({ transport: f.transport, headers: { Authorization: 'Basic x', cookie: 'a=b', 'X-Ok': '1' } }),
    )
    const h = Object.fromEntries(Object.entries(f.calls[0]?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    expect(h.authorization).toBeUndefined()
    expect(h.cookie).toBeUndefined()
    expect(h['x-ok']).toBe('1')
  })

  it('allows hosts in allowedHosts and rejects others', async () => {
    const f = fakeTransport(() => ({}))
    await expect(safeDownload('https://cdn.example.net/a.jpg', base({ transport: f.transport }))).resolves.toBeTruthy()
    expect(await code(safeDownload('https://evil.example/a.jpg', base({ transport: f.transport })))).toBe('SEC_HOST_NOT_ALLOWED')
  })

  it('rejects plain http for non-source hosts and for a public source host', async () => {
    const f = fakeTransport(() => ({}))
    expect(await code(safeDownload('http://cdn.example.net/a.jpg', base({ transport: f.transport })))).toBe('SEC_INSECURE_SCHEME')
    expect(await code(safeDownload('http://example.com/a.jpg', base({ transport: f.transport })))).toBe('SEC_INSECURE_SCHEME')
    expect(await code(safeDownload('ftp://example.com/a.jpg', base({ transport: f.transport })))).toBe('SEC_INSECURE_SCHEME')
    expect(await code(safeDownload('file:///etc/passwd', base({ transport: f.transport })))).toBe('SEC_INSECURE_SCHEME')
    expect(f.calls).toHaveLength(0)
  })

  it('source host exception: http and private address allowed when every address is loopback/private, and recorded', async () => {
    const f = fakeTransport(() => ({}))
    const o = base({ sourceHost: 'wordpress', lookup: lookupMap({ wordpress: ['172.18.0.3'] }), transport: f.transport })
    const r = await safeDownload('http://wordpress/wp-content/uploads/a.jpg', o)
    expect(r.sourceHostException).toBe(true)
    expect(f.calls[0]?.address).toBe('172.18.0.3')
  })

  it('source host over http is refused when any address is public (mixed answers)', async () => {
    const f = fakeTransport(() => ({}))
    const o = base({ sourceHost: 'wp.local', lookup: lookupMap({ 'wp.local': ['127.0.0.1', PUBLIC] }), transport: f.transport })
    expect(await code(safeDownload('http://wp.local/a.jpg', o))).toBe('SEC_INSECURE_SCHEME')
  })

  it('source host port is enforced when configured', async () => {
    const f = fakeTransport(() => ({}))
    const o = base({ sourceHost: 'localhost', sourcePort: 8080, lookup: lookupMap({ localhost: ['127.0.0.1'] }), transport: f.transport })
    await expect(safeDownload('http://localhost:8080/a.jpg', o)).resolves.toBeTruthy()
    expect(await code(safeDownload('http://localhost:6379/a.jpg', o))).toBe('SEC_HOST_NOT_ALLOWED')
  })

  it.each([
    ['169.254.169.254'], ['127.0.0.1'], ['10.1.2.3'], ['::1'], ['fe80::1'], ['::ffff:127.0.0.1'], ['100.64.1.1'], ['0.0.0.0'],
  ])('blocks an allowed host that resolves to %s (SSRF)', async (addr) => {
    const f = fakeTransport(() => ({}))
    const o = base({ lookup: lookupMap({ 'example.com': [PUBLIC], 'cdn.example.net': [PUBLIC, addr] }), transport: f.transport })
    expect(await code(safeDownload('https://cdn.example.net/a.jpg', o))).toBe('SEC_SSRF_BLOCKED')
    expect(f.calls).toHaveLength(0)
  })

  it('blocks IP literals that are private, and needs them allowlisted otherwise', async () => {
    const f = fakeTransport(() => ({}))
    const o = base({ allowedHosts: ['169.254.169.254', '[::1]'], transport: f.transport })
    expect(await code(safeDownload('https://169.254.169.254/latest/meta-data/', o))).toBe('SEC_SSRF_BLOCKED')
    expect(await code(safeDownload('https://[::1]/a.jpg', o))).toBe('SEC_SSRF_BLOCKED')
    expect(await code(safeDownload('https://10.0.0.1/a.jpg', o))).toBe('SEC_HOST_NOT_ALLOWED')
  })

  it('rejects URLs with credentials', async () => {
    const f = fakeTransport(() => ({}))
    expect(await code(safeDownload('https://u:p@example.com/a.jpg', base({ transport: f.transport })))).toBe('MEDIA_BAD_URL')
    expect(await code(safeDownload('not a url', base({ transport: f.transport })))).toBe('MEDIA_BAD_URL')
  })

  it('follows up to 3 redirects, re-validating every hop', async () => {
    const f = fakeTransport((_r, n) => (n <= 3 ? { status: 302, headers: { location: `/r${n}` } } : {}))
    const r = await safeDownload('https://example.com/start', base({ transport: f.transport }))
    expect(r.finalUrl).toBe('https://example.com/r3')
    expect(r.redirects).toBe(3)

    const g = fakeTransport(() => ({ status: 301, headers: { location: '/again' } }))
    expect(await code(safeDownload('https://example.com/start', base({ transport: g.transport })))).toBe('SEC_TOO_MANY_REDIRECTS')
    expect(g.calls).toHaveLength(4)
  })

  it('a redirect to an internal address, a disallowed host or http is blocked', async () => {
    for (const [loc, want] of [
      ['https://169.254.169.254/latest/meta-data/', 'SEC_HOST_NOT_ALLOWED'],
      ['https://evil.example/x', 'SEC_HOST_NOT_ALLOWED'],
      ['http://cdn.example.net/x', 'SEC_INSECURE_SCHEME'],
      ['https://cdn.example.net/x', 'SEC_SSRF_BLOCKED'],
    ] as const) {
      const f = fakeTransport((_r, n) => (n === 1 ? { status: 302, headers: { location: loc } } : {}))
      const o = base({ lookup: lookupMap({ 'example.com': [PUBLIC], 'cdn.example.net': ['10.0.0.5'] }), transport: f.transport })
      expect(await code(safeDownload('https://example.com/a.jpg', o))).toBe(want)
      expect(f.calls).toHaveLength(1)
    }
  })

  it('maps 404 and other statuses to non-security media errors', async () => {
    const a = fakeTransport(() => ({ status: 404 }))
    expect(await code(safeDownload('https://example.com/a.jpg', base({ transport: a.transport })))).toBe('MEDIA_404')
    const b = fakeTransport(() => ({ status: 503 }))
    expect(await code(safeDownload('https://example.com/a.jpg', base({ transport: b.transport })))).toBe('MEDIA_HTTP_503')
  })

  it('rejects a Content-Length over the cap before reading, and aborts a stream that exceeds it', async () => {
    const a = fakeTransport(() => ({ headers: { 'content-length': '1000' }, chunks: [Buffer.alloc(10)] }))
    expect(await code(safeDownload('https://example.com/a.jpg', base({ transport: a.transport, maxBytes: 100 })))).toBe('SEC_FILE_TOO_LARGE')
    const b = fakeTransport(() => ({ headers: {}, chunks: Array.from({ length: 20 }, () => Buffer.alloc(10)) }))
    expect(await code(safeDownload('https://example.com/a.jpg', base({ transport: b.transport, maxBytes: 100 })))).toBe('SEC_FILE_TOO_LARGE')
    const c = fakeTransport(() => ({ headers: {}, chunks: [Buffer.alloc(100)] }))
    await expect(safeDownload('https://example.com/a.jpg', base({ transport: c.transport, maxBytes: 100 }))).resolves.toBeTruthy()
  })

  it('reports DNS failure as a media error', async () => {
    const f = fakeTransport(() => ({}))
    const o = base({ lookup: lookupMap({ 'example.com': [] }), transport: f.transport })
    expect(await code(safeDownload('https://example.com/a.jpg', o))).toBe('MEDIA_DNS_FAILED')
  })
})

describe('safeDownload over a real local server (AC-B2)', () => {
  let server: Server
  let port = 0
  const seen: { url: string; headers: IncomingHttpHeaders }[] = []

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers })
      if (req.url === '/hang') return // never answers
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        const chunk = Buffer.alloc(64 * 1024)
        let sent = 0
        const pump = () => {
          while (sent < 50 && res.write(chunk)) sent++
          if (sent < 50) res.once('drain', pump)
          else res.end()
        }
        pump()
        return
      }
      if (req.url === '/to-other') {
        res.writeHead(302, { location: `http://other.test:${port}/a.jpg` })
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'image/jpeg' })
      res.end('JPEGDATA')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  })

  // wp.test does not exist in real DNS: success proves we connect to the vetted address we resolved.
  const opts = (extra: Partial<DownloadOptions> = {}): DownloadOptions => ({
    sourceHost: 'wp.test',
    allowedHosts: ['other.test'],
    lookup: lookupMap({ 'wp.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'] }),
    ...extra,
  })

  it('allows the configured source host over http on loopback, sending the original Host header', async () => {
    seen.length = 0
    const r = await safeDownload(`http://wp.test:${port}/a.jpg`, opts({ headers: { authorization: 'Basic leak' } }))
    expect(r.bytes.toString()).toBe('JPEGDATA')
    expect(r.sourceHostException).toBe(true)
    expect(seen[0]?.headers.host).toBe(`wp.test:${port}`)
    expect(seen[0]?.headers.authorization).toBeUndefined()
  })

  it('blocks the same server reached through a non-source host name that resolves to 127.0.0.1', async () => {
    seen.length = 0
    expect(await code(safeDownload(`https://other.test:${port}/a.jpg`, opts()))).toBe('SEC_SSRF_BLOCKED')
    expect(await code(safeDownload(`http://other.test:${port}/a.jpg`, opts()))).toBe('SEC_INSECURE_SCHEME')
    expect(seen).toHaveLength(0)
  })

  it('blocks a redirect from the source host to another internal host', async () => {
    seen.length = 0
    expect(await code(safeDownload(`http://wp.test:${port}/to-other`, opts()))).toBe('SEC_INSECURE_SCHEME')
    expect(seen).toHaveLength(1)
  })

  it('times out', async () => {
    expect(await code(safeDownload(`http://wp.test:${port}/hang`, opts({ timeoutMs: 200 })))).toBe('MEDIA_TIMEOUT')
  })

  it('aborts a streamed body past the size cap', async () => {
    expect(await code(safeDownload(`http://wp.test:${port}/big`, opts({ maxBytes: 100_000 })))).toBe('SEC_FILE_TOO_LARGE')
  })

  it('reports a refused connection as a media error', async () => {
    const s = createServer()
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const closedPort = (s.address() as AddressInfo).port
    await new Promise<void>((r) => s.close(() => r()))
    expect(await code(safeDownload(`http://wp.test:${closedPort}/a.jpg`, opts()))).toBe('MEDIA_NETWORK')
  })
})
