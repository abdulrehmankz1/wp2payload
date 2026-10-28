import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RestExtractor, RestError, decodeEntities } from '../../src/extractors/rest/index.js'

const post = JSON.parse(readFileSync(new URL('../fixtures/rest/post.json', import.meta.url), 'utf8')) as Record<string, unknown>

const PASSWORD = 'abcd EFGH 1234 ijkl'
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
const loopLookup = async () => [{ address: '127.0.0.1', family: 4 }]
const noSleep = async () => {}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }
type Handler = (url: URL, init: RequestInit | undefined, n: number) => Reply | Promise<Reply>

function makeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fn = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const r = await handler(new URL(String(input)), init, calls.length)
    return new Response(r.body === undefined ? '{}' : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...r.headers },
    })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const make = (h: Handler, extra: Partial<ConstructorParameters<typeof RestExtractor>[0]> = {}) => {
  const f = makeFetch(h)
  const ex = new RestExtractor({
    url: 'https://example.com/',
    fetch: f.fn,
    lookup: publicLookup,
    sleep: noSleep,
    ...extra,
  })
  return { ex, ...f }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('A &amp; B &#8217; &#x41; &nbsp;&bogus;')).toBe('A & B ’ A  &bogus;')
  })
})

describe('pagination (AC-S3-1)', () => {
  it('streams 3 pages and stops at X-WP-TotalPages', async () => {
    const { ex, calls } = make((url) => {
      const page = Number(url.searchParams.get('page'))
      return {
        body: [{ id: page, slug: `t${page}`, name: `T${page}`, parent: 0 }],
        headers: { 'x-wp-totalpages': '3' },
      }
    }, { perPage: 1 })
    const seen: number[] = []
    for await (const t of ex.terms()) {
      if (t.taxonomy === 'category') seen.push(t.wpId)
      if (seen.length === 3 && t.taxonomy === 'category') break
    }
    expect(seen).toEqual([1, 2, 3])
    const catCalls = calls.filter((c) => c.url.includes('/categories'))
    expect(catCalls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2', '3'])
    expect(catCalls.every((c) => new URL(c.url).searchParams.get('per_page') === '1')).toBe(true)
  })

  it('is lazy: nothing is fetched until iterated, one page at a time', async () => {
    const { ex, calls } = make(() => ({ body: [], headers: { 'x-wp-totalpages': '1' } }))
    const it = ex.media()
    expect(calls).toHaveLength(0)
    await collect(it)
    expect(calls).toHaveLength(1)
  })

  it('probe reads counts, seo plugin; no version guessing', async () => {
    const { ex } = make((url) => {
      if (url.pathname === '/wp-json/') {
        return { body: { name: 'Site', url: 'https://example.com', namespaces: ['wp/v2', 'yoast/v1'] } }
      }
      if (url.pathname.endsWith('/users')) return { status: 401, body: {} }
      return { body: [], headers: { 'x-wp-total': '7' } }
    })
    const info = await ex.probe()
    expect(info.seoPlugin).toBe('yoast')
    expect(info.wpVersion).toBeUndefined()
    expect(info.counts).toEqual({ posts: 7, pages: 7, media: 7, categories: 7, tags: 7 })
  })
})

describe('mapping (AC-S3-2)', () => {
  it('maps an authenticated post (raw content) including Yoast', async () => {
    const { ex, calls } = make(
      (url) => ({ body: url.pathname.endsWith('/posts') ? [post] : [], headers: { 'x-wp-totalpages': '1' } }),
      { auth: { user: 'ed', appPassword: PASSWORD } },
    )
    const docs = await collect(ex.documents())
    expect(docs).toHaveLength(1)
    expect(docs[0]).toEqual({
      wpId: 42,
      type: 'post',
      status: 'publish',
      slug: 'hello-world',
      title: "Tom & Jerry’s Adventure",
      html: '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->',
      link: 'https://example.com/hello-world/',
      publishedAt: '2024-03-01T09:00:00Z',
      modifiedAt: '2024-03-02T10:00:00Z',
      authorWpId: 3,
      termWpIds: [5, 6, 9],
      seo: {
        title: 'Hello & welcome - Example',
        description: 'A description',
        canonical: 'https://example.com/hello-world/',
        noindex: true,
      },
      meta: { contentFormat: 'raw', format: 'standard' },
    })
    expect(calls[0]?.url).toContain('context=edit')
  })

  it('falls back to rendered content unauthenticated and flags it', async () => {
    const unauth = { ...post, content: { rendered: '<p>Hi</p>' }, title: { rendered: 'A &amp; B' }, excerpt: { rendered: '<p>Ex</p>' } }
    const { ex, calls } = make((url) => ({ body: url.pathname.endsWith('/pages') ? [{ ...unauth, type: 'page', parent: 4, featured_media: 8 }] : [], headers: { 'x-wp-totalpages': '1' } }))
    const docs = await collect(ex.documents())
    expect(docs[0]).toMatchObject({ type: 'page', html: '<p>Hi</p>', title: 'A & B', excerpt: 'Ex', parentWpId: 4, featuredMediaWpId: 8 })
    expect(docs[0]?.meta.contentFormat).toBe('rendered')
    expect(calls[0]?.url).not.toContain('context=edit')
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('maps terms, media and authors', async () => {
    const { ex } = make((url) => {
      const p = url.pathname
      if (p.endsWith('/categories')) return { body: [{ id: 5, name: 'R&amp;D', slug: 'rd', parent: 2, description: '' }], headers: { 'x-wp-totalpages': '1' } }
      if (p.endsWith('/tags')) return { body: [{ id: 9, name: 'tag', slug: 'tag', parent: 0 }], headers: { 'x-wp-totalpages': '1' } }
      if (p.endsWith('/media')) return { body: [{ id: 8, source_url: 'https://example.com/wp-content/uploads/2024/a%20b.jpg', mime_type: 'image/jpeg', alt_text: 'Alt &amp; text', caption: { rendered: '<p>Cap &#8217;s</p>' } }], headers: { 'x-wp-totalpages': '1' } }
      return { body: [{ id: 3, slug: 'ed', name: 'Ed &amp; Co', email: 'ed@example.com' }], headers: { 'x-wp-totalpages': '1' } }
    })
    expect(await collect(ex.terms())).toEqual([
      { wpId: 5, taxonomy: 'category', name: 'R&D', slug: 'rd', parentWpId: 2 },
      { wpId: 9, taxonomy: 'post_tag', name: 'tag', slug: 'tag' },
    ])
    expect(await collect(ex.media())).toEqual([
      { wpId: 8, sourceUrl: 'https://example.com/wp-content/uploads/2024/a%20b.jpg', filename: 'a b.jpg', mimeType: 'image/jpeg', alt: 'Alt & text', caption: 'Cap ’s' },
    ])
    // unauthenticated: no email
    expect(await collect(ex.authors())).toEqual([{ wpId: 3, slug: 'ed', displayName: 'Ed & Co' }])
  })

  it('rejects non-publish statuses without credentials', () => {
    expect(() => new RestExtractor({ url: 'https://example.com', statuses: ['draft'] })).toThrow(/credentials/)
  })
})

describe('Yoast collection bug (found against the live fixture)', () => {
  const shared = { title: 'Hello world! - Site', canonical: 'https://example.com/hello-world/' }
  const item = (id: number, slug: string) => ({
    id, slug, status: 'publish', type: 'post', link: `https://example.com/${slug}/`,
    title: { rendered: slug }, content: { rendered: '' }, date_gmt: '2020-01-01T00:00:00', modified_gmt: '2020-01-01T00:00:00',
    yoast_head_json: shared,
  })

  it('re-reads the single item when the list canonical belongs to another post', async () => {
    const { ex, calls } = make((url) => {
      if (url.pathname === '/wp-json/wp/v2/posts') return { body: [item(1, 'hello-world'), item(2, 'image-alignment')], headers: { 'x-wp-totalpages': '1' } }
      if (url.pathname === '/wp-json/wp/v2/posts/2') {
        expect(url.searchParams.get('_fields')).toBe('yoast_head_json')
        return { body: { yoast_head_json: { title: 'Own title', canonical: 'https://example.com/image-alignment/' } } }
      }
      return { body: [], headers: { 'x-wp-totalpages': '1' } }
    })
    const docs = await collect(ex.documents())
    expect(docs.map((d) => d.seo?.title)).toEqual(['Hello world! - Site', 'Own title'])
    // Post 1's list data already matched its own URL, so only post 2 was re-read.
    expect(calls.filter((c) => /\/posts\/\d+/.test(new URL(c.url).pathname))).toHaveLength(1)
  })
})

describe('transport security (AC-S3-3)', () => {
  it('rejects http for a public host before any request', async () => {
    const { ex, calls } = make(() => ({ body: {} }), { url: 'http://example.com' })
    await expect(ex.probe()).rejects.toThrow(/Refusing plain http.*https:\/\/example\.com/)
    expect(calls).toHaveLength(0)
  })

  it('rejects http when any resolved address is public', async () => {
    const { ex } = make(() => ({ body: {} }), {
      url: 'http://mixed.test',
      lookup: async () => [{ address: '10.0.0.1', family: 4 }, { address: '8.8.8.8', family: 4 }],
    })
    await expect(ex.probe()).rejects.toBeInstanceOf(RestError)
  })

  it.each(['http://127.0.0.1:8080', 'http://localhost:8080', 'http://wordpress', 'http://[::1]:8080'])(
    'allows http for loopback/private: %s',
    async (url) => {
      const { ex, calls } = make(() => ({ body: { namespaces: [] }, headers: { 'x-wp-total': '1' } }), {
        url,
        lookup: loopLookup,
      })
      await ex.probe()
      expect(calls.length).toBeGreaterThan(0)
    },
  )

  it.each(['10.1.2.3', '172.16.0.5', '192.168.1.9', 'fd12::1'])('treats %s as private', async (address) => {
    const { ex } = make(() => ({ body: {} }), { url: 'http://site.local', lookup: async () => [{ address, family: 4 }] })
    await expect(ex.probe()).resolves.toBeDefined()
  })

  it('does not treat 172.32.x as private', async () => {
    const { ex } = make(() => ({ body: {} }), { url: 'http://site.test', lookup: async () => [{ address: '172.32.0.1', family: 4 }] })
    await expect(ex.probe()).rejects.toThrow(/Refusing plain http/)
  })

  it('rejects a cross-origin redirect and never forwards credentials there', async () => {
    const { ex, calls } = make(() => ({ status: 302, headers: { location: 'https://evil.example.net/wp-json/' } }), {
      auth: { user: 'ed', appPassword: PASSWORD },
    })
    await expect(ex.probe()).rejects.toThrow(/another origin/)
    expect(calls).toHaveLength(1)
  })

  it('rejects a downgrade to http as another origin', async () => {
    const { ex } = make(() => ({ status: 301, headers: { location: 'http://example.com/wp-json/' } }))
    await expect(ex.probe()).rejects.toThrow(/another origin/)
  })

  it('follows up to 3 same-origin redirects, rejects the 4th', async () => {
    const ok = make((url, _i, n) => (n <= 3 ? { status: 301, headers: { location: `/r${n}` } } : { body: { namespaces: [] }, headers: { 'x-wp-total': '0' } }))
    await expect(ok.ex.probe()).resolves.toBeDefined()

    const bad = make((_u, _i, n) => ({ status: 301, headers: { location: `/r${n}` } }))
    await expect(bad.ex.probe()).rejects.toThrow(/more than 3 times/)
  })

  it('retries on 503 then succeeds, honouring Retry-After', async () => {
    const waits: number[] = []
    const { ex, calls } = make((_u, _i, n) => (n === 1 ? { status: 503, headers: { 'retry-after': '2' } } : n === 2 ? { status: 429 } : { body: [], headers: { 'x-wp-totalpages': '1' } }), {
      sleep: async (ms) => { waits.push(ms) },
    })
    await collect(ex.media())
    expect(calls).toHaveLength(3)
    expect(waits).toEqual([2000, 1000]) // Retry-After, then exponential backoff (500 * 2^1)
  })

  it('gives up after maxRetries', async () => {
    const { ex, calls } = make(() => ({ status: 500 }), { maxRetries: 2 })
    await expect(collect(ex.media())).rejects.toThrow(/500/)
    expect(calls).toHaveLength(3)
  })

  it('does not retry on 400', async () => {
    const { ex, calls } = make(() => ({ status: 400 }))
    await expect(collect(ex.media())).rejects.toThrow(/400/)
    expect(calls).toHaveLength(1)
  })

  it('retries network errors', async () => {
    let n = 0
    const fn = (async () => {
      if (++n === 1) throw new TypeError('fetch failed')
      return new Response('[]', { headers: { 'x-wp-totalpages': '1' } })
    }) as unknown as typeof fetch
    const ex = new RestExtractor({ url: 'https://example.com', fetch: fn, lookup: publicLookup, sleep: noSleep })
    await collect(ex.media())
    expect(n).toBe(2)
  })

  it('aborts on timeout', async () => {
    const fn = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener('abort', () => rej(init.signal?.reason))
      })) as unknown as typeof fetch
    const ex = new RestExtractor({ url: 'https://example.com', fetch: fn, lookup: publicLookup, sleep: noSleep, timeoutMs: 20, maxRetries: 0 })
    await expect(ex.probe()).rejects.toThrow(/timed out after 20 ms/)
  })
})

describe('auth (AC-S3-4)', () => {
  const auth = { user: 'editor', appPassword: PASSWORD }

  it('sends Basic auth to the configured origin', async () => {
    const { ex, calls } = make(() => ({ body: [], headers: { 'x-wp-totalpages': '1' } }), { auth })
    await collect(ex.media())
    const h = (calls[0]?.init?.headers as Record<string, string>).Authorization
    expect(h).toBe('Basic ' + Buffer.from(`editor:${PASSWORD}`).toString('base64'))
  })

  it('401 gives the doc 8.5 message with no credential in the error', async () => {
    const { ex } = make(() => ({ status: 401 }), { auth })
    let err: unknown
    try {
      await ex.probe()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(RestError)
    const e = err as RestError
    expect(e.message).toBe(
      'Could not reach https://example.com/wp-json (401 Unauthorized)\n' +
        'Check WP_USER and WP_APP_PASSWORD. Application Passwords are under Users → Profile in WordPress 5.6+.',
    )
    const b64 = Buffer.from(`editor:${PASSWORD}`).toString('base64')
    const dump = JSON.stringify(e, Object.getOwnPropertyNames(e)) + e.message + (e.stack ?? '') + String(e)
    for (const secret of [PASSWORD, b64, 'editor:']) expect(dump).not.toContain(secret)
  })

  it('404 on wp-json says the API is disabled or the URL is wrong', async () => {
    const { ex } = make(() => ({ status: 404 }))
    await expect(ex.probe()).rejects.toThrow(/REST API is disabled or the URL is wrong/)
  })

  it('network failure errors carry no credentials', async () => {
    const fn = (async () => { throw new TypeError(`boom ${PASSWORD}`) }) as unknown as typeof fetch
    const ex = new RestExtractor({ url: 'https://example.com', auth, fetch: fn, lookup: publicLookup, sleep: noSleep, maxRetries: 0 })
    const e = (await ex.probe().catch((x: unknown) => x)) as RestError
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e)) + e.stack).not.toContain(PASSWORD)
  })

  it('authors falls back to public view when users context=edit is 403', async () => {
    const { ex } = make((url) =>
      url.searchParams.get('context') === 'edit'
        ? { status: 403 }
        : { body: [{ id: 3, slug: 'ed', name: 'Ed' }], headers: { 'x-wp-totalpages': '1' } },
      { auth },
    )
    expect(await collect(ex.authors())).toEqual([{ wpId: 3, slug: 'ed', displayName: 'Ed' }])
  })

  it('rejects credentials embedded in the URL', () => {
    expect(() => new RestExtractor({ url: 'https://u:p@example.com' })).toThrow(/WP_USER/)
  })
})
