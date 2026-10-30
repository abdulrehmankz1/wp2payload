import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normaliseSlug } from '../../src/extractors/rest/decode.js'
import { RestError, RestExtractor } from '../../src/extractors/rest/index.js'
import { DownloadCache } from '../../src/migrate/download-cache.js'
import type { DownloadResult } from '../../src/security/index.js'

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
const noSleep = async () => {}

describe('normaliseSlug', () => {
  it('decodes percent-encoded non-ASCII slugs once, to NFC', () => {
    expect(normaliseSlug('%d8%b3%d9%84%d8%a7%d9%85')).toBe('سلام')
    expect(normaliseSlug('cafe%cc%81')).toBe('café'.normalize('NFC'))
    expect(normaliseSlug('100%25-sure')).toBe('100%-sure')
  })

  it('keeps plain and malformed slugs as sent', () => {
    expect(normaliseSlug('hello-world')).toBe('hello-world')
    expect(normaliseSlug('bad%zzescape')).toBe('bad%zzescape')
  })

  it('turns smuggled separators into hyphens and drops invisible characters', () => {
    expect(normaliseSlug('a%2Fb%3Fc%23d%5Ce')).toBe('a-b-c-d-e')
    expect(normaliseSlug('ad%e2%80%aemin%00%20x')).toBe('adminx')
  })

  it('is applied to documents, terms and authors from the REST API', async () => {
    const fetch = (async (input: string | URL) => {
      const url = new URL(String(input))
      const body =
        url.pathname.endsWith('/categories') ? [{ id: 1, name: 'C', slug: '%d8%a8', parent: 0 }]
        : url.pathname.endsWith('/tags') ? []
        : url.pathname.endsWith('/users') ? [{ id: 2, name: 'A', slug: '%d8%aa' }]
        : [{ id: 3, slug: '%d8%b3', title: { rendered: 'T' }, content: { rendered: '' }, link: 'https://example.com/%d8%b3/', status: 'publish', date_gmt: '2021-01-01T00:00:00', modified_gmt: '2021-01-01T00:00:00' }]
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'x-wp-totalpages': '1' } })
    }) as unknown as typeof globalThis.fetch
    const ex = new RestExtractor({ url: 'https://example.com/', fetch, lookup: publicLookup, sleep: noSleep, seoPlugin: 'none' })
    const all = async <T>(it: AsyncIterable<T>) => {
      const out: T[] = []
      for await (const x of it) out.push(x)
      return out
    }
    expect((await all(ex.terms())).map((t) => t.slug)).toEqual(['ب'])
    expect((await all(ex.authors())).map((a) => a.slug)).toEqual(['ت'])
    // The fake answers /posts and /pages alike.
    expect(new Set((await all(ex.documents())).map((d) => d.slug))).toEqual(new Set(['س']))
  })
})

describe('REST response size cap (S07-03)', () => {
  const streaming = (bytes: number, headers: Record<string, string> = {}) => {
    let sent = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= bytes) return c.close()
        const n = Math.min(1024 * 1024, bytes - sent)
        sent += n
        c.enqueue(new Uint8Array(n).fill(0x20))
      },
      cancel() {
        cancelled = true
      },
    })
    const fetch = (async () => new Response(body, { status: 200, headers })) as unknown as typeof globalThis.fetch
    return { fetch, sent: () => sent, cancelled: () => cancelled }
  }

  it('stops reading an endless body past the cap', async () => {
    const s = streaming(80 * 1024 * 1024)
    const ex = new RestExtractor({ url: 'https://example.com/', fetch: s.fetch, lookup: publicLookup, sleep: noSleep })
    const err = await ex.probe().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RestError)
    expect((err as RestError).code).toBe('REST_TOO_LARGE')
    expect(s.cancelled()).toBe(true)
    expect(s.sent()).toBeLessThan(70 * 1024 * 1024)
  })

  it('refuses a body whose Content-Length is over the cap without reading it', async () => {
    const s = streaming(1024, { 'content-length': String(100 * 1024 * 1024) })
    const ex = new RestExtractor({ url: 'https://example.com/', fetch: s.fetch, lookup: publicLookup, sleep: noSleep })
    const err = await ex.probe().catch((e: unknown) => e)
    expect((err as RestError).code).toBe('REST_TOO_LARGE')
    expect(s.sent()).toBeLessThanOrEqual(1024)
  })
})

describe('DownloadCache (F9: preview downloads media once)', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  const fake = () => {
    const calls: string[] = []
    const download = async (url: string): Promise<DownloadResult> => {
      calls.push(url)
      return { bytes: Buffer.from(`bytes of ${url}`), finalUrl: url, redirects: 0, sourceHostException: false, contentType: 'image/png' }
    }
    return { download, calls }
  }

  it('serves the second request for a URL from disk', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-dlc-'))
    const cache = await DownloadCache.create(root)
    const f = fake()
    const preview = cache.wrap(f.download)
    const real = cache.wrap(f.download)
    const a = await preview('https://example.com/a.png')
    const b = await real('https://example.com/a.png')
    await real('https://example.com/b.png')
    expect(f.calls).toEqual(['https://example.com/a.png', 'https://example.com/b.png'])
    expect(b.bytes.equals(a.bytes)).toBe(true)
    expect(b).toMatchObject({ finalUrl: 'https://example.com/a.png', contentType: 'image/png', sourceHostException: false })
  })

  it('removes its files on dispose and starts empty after a killed run', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-dlc-'))
    const dir = path.join(root, '.wp2payload', 'cache', 'media')
    const first = await DownloadCache.create(root)
    await first.wrap(fake().download)('https://example.com/a.png')
    expect(await readdir(dir)).toHaveLength(1)
    // A killed run never disposed: the next command must not reuse those files.
    const f = fake()
    const next = await DownloadCache.create(root)
    expect(await readdir(dir)).toHaveLength(0)
    await next.wrap(f.download)('https://example.com/a.png')
    expect(f.calls).toHaveLength(1)
    await next.dispose()
    expect(existsSync(dir)).toBe(false)
  })

  it('downloads again when a cached file has gone missing', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-dlc-'))
    const cache = await DownloadCache.create(root)
    const f = fake()
    const get = cache.wrap(f.download)
    await get('https://example.com/a.png')
    await rm(path.join(root, '.wp2payload', 'cache', 'media', '1'))
    await get('https://example.com/a.png')
    expect(f.calls).toHaveLength(2)
  })
})
