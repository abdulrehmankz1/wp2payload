import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RestExtractor, type SeoPluginOption } from '../../src/extractors/rest/index.js'
import { MAX_HEAD_CHARS, parseRankMathHead } from '../../src/extractors/rest/rankmath.js'
import type { Issue } from '../../src/report/types.js'

// Recorded from the local fixture (Rank Math 1.0.280, Headless CMS Support on), gravatar hash zeroed.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/rest/rankmath/${name}`, import.meta.url), 'utf8')) as Record<string, unknown>
const recordedPost = fixture('gethead-post.json')
const recordedNotFound = fixture('gethead-not-found.json')
const noRoute = fixture('no-route.json')

const head = (inner: string) => `<link rel="canonical" href="https://example.com/a/" />${inner}`

describe('parseRankMathHead (AC-2)', () => {
  it('reads the recorded fixture head', () => {
    expect(parseRankMathHead(recordedPost.head as string)).toEqual({
      title: 'RM custom title - wp2payload fixture',
      description: 'Rank Math description for the markup post.',
      canonical: 'http://localhost:8080/markup-html-tags-and-formatting/',
    })
  })

  it('sets noindex from the robots tokens', () => {
    expect(parseRankMathHead(head('<meta name="robots" content="follow, noindex"/>'))?.noindex).toBe(true)
    expect(parseRankMathHead(head('<meta name="ROBOTS" content="NOINDEX,nofollow"/>'))?.noindex).toBe(true)
    expect(parseRankMathHead(head('<meta name="robots" content="index, follow, noindexfoo"/>'))?.noindex).toBeUndefined()
  })

  it('title falls back og:title, then twitter:title, then <title>', () => {
    const all = '<title>T</title><meta name="twitter:title" content="TW"><meta property="og:title" content="OG">'
    expect(parseRankMathHead(head(all))?.title).toBe('OG')
    expect(parseRankMathHead(head('<title>T</title><meta name="twitter:title" content="TW">'))?.title).toBe('TW')
    expect(parseRankMathHead(head('<title>T &amp; U</title><meta property="og:title" content="  ">'))?.title).toBe('T & U')
  })

  it('first occurrence wins', () => {
    const s = parseRankMathHead(
      '<link rel="canonical" href="https://example.com/1/"><link rel="canonical" href="https://evil.example/2/">' +
        '<meta name="description" content="one"><meta name="description" content="two">' +
        '<meta property="og:title" content="A"><meta property="og:title" content="B">',
    )
    expect(s).toEqual({ canonical: 'https://example.com/1/', description: 'one', title: 'A' })
  })

  it('matches rel as a case-insensitive token list', () => {
    expect(parseRankMathHead('<link rel="Alternate CANONICAL" href="https://example.com/x/">')?.canonical).toBe('https://example.com/x/')
    expect(parseRankMathHead('<link rel="canonicalish" href="https://example.com/x/"><meta property="og:url" content="https://example.com/x/">')?.canonical).toBeUndefined()
  })

  it('decodes entities exactly once', () => {
    const s = parseRankMathHead(head('<meta name="description" content="Tom &amp;amp; Jerry &#8217;s &lt;b&gt;"><meta property="og:title" content="R&amp;D">'))
    expect(s?.description).toBe('Tom &amp; Jerry ’s <b>')
    expect(s?.title).toBe('R&D')
  })

  it('missing fields stay missing', () => {
    expect(parseRankMathHead(head(''))).toEqual({ canonical: 'https://example.com/a/' })
    expect(parseRankMathHead(head('<meta name="description"><meta property="og:title">'))).toEqual({ canonical: 'https://example.com/a/' })
  })

  it("rejects a head that does not identify a page (Rank Math's 404 head)", () => {
    expect(parseRankMathHead(recordedNotFound.head as string)).toBeUndefined()
    expect(parseRankMathHead('<meta name="description" content="x">')).toBeUndefined()
    // og:url alone identifies the page; the canonical is then left out.
    expect(parseRankMathHead('<meta property="og:url" content="https://example.com/a/"><meta property="og:title" content="T">')).toEqual({ title: 'T' })
  })
})

describe('parseRankMathHead with hostile heads (AC-6)', () => {
  it('refuses a head over the size cap', () => {
    const big = head('<meta name="description" content="d">') + ' '.repeat(MAX_HEAD_CHARS)
    expect(parseRankMathHead(big)).toBeUndefined()
  })

  it('ignores metadata inside script, style, noscript and template', () => {
    const s = parseRankMathHead(
      '<script type="application/ld+json">{"x":"<meta name=\\"description\\" content=\\"evil\\"><link rel=canonical href=https://evil.example/>"}</script>' +
        '<style>/* <meta property="og:title" content="evil"> */</style>' +
        '<noscript><meta name="robots" content="noindex"><title>evil</title></noscript>' +
        '<template><template><meta name="description" content="evil"></template></template>' +
        '<link rel="canonical" href="https://example.com/ok/"><meta name="description" content="good"><title>Good</title>',
    )
    expect(s).toEqual({ canonical: 'https://example.com/ok/', description: 'good', title: 'Good' })
  })

  it('an unclosed script swallows the rest instead of leaking fake tags', () => {
    expect(parseRankMathHead('<link rel="canonical" href="https://example.com/a/"><script><meta name="description" content="evil">')).toEqual({
      canonical: 'https://example.com/a/',
    })
  })

  it.each(['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', '/relative/', '//evil.example/', 'https://exa mple.com/', 'https://example.com/\u0000x', 'vbscript:x'])(
    'drops canonical %j',
    (href) => {
      const s = parseRankMathHead(`<link rel="canonical" href="${href}"><meta property="og:url" content="https://example.com/a/">`)
      expect(s?.canonical).toBeUndefined()
    },
  )

  it('decoded javascript: entity tricks are still dropped', () => {
    const s = parseRankMathHead('<link rel="canonical" href="&#106;avascript:alert(1)"><meta property="og:url" content="https://example.com/a/">')
    expect(s?.canonical).toBeUndefined()
  })

  it('normalises control characters and whitespace', () => {
    const s = parseRankMathHead(head('<meta name="description" content="a\u0000b&#1;c\u0085d e\n\t f"><meta property="og:title" content="&#x7f;T&#13;itle">'))
    expect(s?.description).toBe('a b c d e f')
    expect(s?.title).toBe('T itle')
  })

  it('survives deep nesting and junk markup', () => {
    const deep = '<div>'.repeat(20_000) + '<meta name="description" content="deep">' + '</span>'.repeat(100) + '<!-- <meta name="robots" content="noindex"> --><![CDATA[x]]><?php ?>'
    expect(parseRankMathHead(head(deep))).toEqual({ canonical: 'https://example.com/a/', description: 'deep' })
  })
})

// ---------------------------------------------------------------------------------------------

type Reply = { status?: number; body?: unknown }
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

const postItem = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  slug: `p${id}`,
  status: 'publish',
  link: `https://example.com/p${id}/`,
  title: { rendered: `P${id}` },
  content: { rendered: '' },
  date_gmt: '2020-01-01T00:00:00',
  modified_gmt: '2020-01-01T00:00:00',
  ...extra,
})

const yoast = (id: number) => ({ title: `Yoast ${id}`, canonical: `https://example.com/p${id}/` })
const rmHead = (id: number) => ({
  success: true,
  head: `<meta name="description" content="RM desc ${id}"/><link rel="canonical" href="https://example.com/p${id}/" /><meta property="og:title" content="RM ${id}" />`,
})

function site(opts: {
  posts: Record<string, unknown>[]
  namespaces?: string[]
  getHead?: (url: string) => Reply
  seoPlugin?: SeoPluginOption
}) {
  const calls: URL[] = []
  const warnings: Issue[] = []
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input))
    calls.push(url)
    let r: Reply
    if (url.pathname === '/wp-json/') r = { body: { url: 'https://example.com', namespaces: opts.namespaces ?? ['wp/v2', 'rankmath/v1'] } }
    else if (url.pathname === '/wp-json/rankmath/v1/getHead') r = opts.getHead ? opts.getHead(url.searchParams.get('url') ?? '') : { status: 404, body: noRoute }
    else if (url.pathname === '/wp-json/wp/v2/posts') r = { body: opts.posts }
    else if (url.pathname === '/wp-json/wp/v2/pages') r = { body: [] }
    else r = { body: [] }
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json', 'x-wp-totalpages': '1' } })
  }) as unknown as typeof fetch
  const ex = new RestExtractor({
    url: 'https://example.com',
    fetch: fetchFn,
    lookup: publicLookup,
    sleep: async () => {},
    maxRetries: 1,
    ...(opts.seoPlugin ? { seoPlugin: opts.seoPlugin } : {}),
    onWarning: (i) => warnings.push(i),
  })
  const headCalls = () => calls.filter((u) => u.pathname === '/wp-json/rankmath/v1/getHead')
  return { ex, calls, warnings, headCalls }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const byId = (id: number) => (url: string): Reply => (url === `https://example.com/p${id}/` ? { body: rmHead(id) } : { body: { success: false } })

describe('RestExtractor with Rank Math (AC-2)', () => {
  it('auto: reads getHead per document with its permalink and sets seo', async () => {
    const s = site({ posts: [postItem(1), postItem(2)], getHead: (u) => ({ body: rmHead(Number(/p(\d+)/.exec(u)?.[1])) }) })
    await s.ex.probe()
    const docs = await collect(s.ex.documents())
    expect(docs.map((d) => d.seo)).toEqual([
      { title: 'RM 1', description: 'RM desc 1', canonical: 'https://example.com/p1/' },
      { title: 'RM 2', description: 'RM desc 2', canonical: 'https://example.com/p2/' },
    ])
    expect(s.headCalls().map((u) => u.searchParams.get('url'))).toEqual(['https://example.com/p1/', 'https://example.com/p2/'])
    expect(s.warnings).toEqual([])
  })

  it('auto without probe(): fetches the namespaces lazily, once', async () => {
    const s = site({ posts: [postItem(1), postItem(2)], getHead: () => ({ body: rmHead(1) }) })
    await collect(s.ex.documents())
    expect(s.calls.filter((u) => u.pathname === '/wp-json/')).toHaveLength(1)
    expect(s.headCalls()).toHaveLength(2)
  })

  it('auto: no rankmath/v1 namespace means no getHead calls', async () => {
    const s = site({ posts: [postItem(1)], namespaces: ['wp/v2'], getHead: () => ({ body: rmHead(1) }) })
    const docs = await collect(s.ex.documents())
    expect(docs[0]?.seo).toBeUndefined()
    expect(s.headCalls()).toHaveLength(0)
  })

  it('auto: Yoast data wins and Rank Math is not asked', async () => {
    const s = site({ posts: [postItem(1, { yoast_head_json: yoast(1) })], getHead: () => ({ body: rmHead(1) }) })
    const docs = await collect(s.ex.documents())
    expect(docs[0]?.seo).toEqual({ title: 'Yoast 1', canonical: 'https://example.com/p1/' })
    expect(s.headCalls()).toHaveLength(0)
  })

  it("does not put Rank Math's 404 head on a document whose link it cannot resolve", async () => {
    const s = site({ posts: [postItem(7, { link: 'https://example.com/?p=7' })], getHead: () => ({ body: recordedNotFound }) })
    const docs = await collect(s.ex.documents())
    expect(docs[0]?.seo).toBeUndefined()
    expect(s.warnings.map((w) => w.code)).toEqual(['SEO_FETCH_FAILED'])
  })
})

describe('Rank Math failures (AC-3)', () => {
  it('headless off: one warning with the setting, no further getHead calls, documents still migrate', async () => {
    const s = site({ posts: [postItem(1), postItem(2), postItem(3)] })
    const docs = await collect(s.ex.documents())
    expect(docs).toHaveLength(3)
    expect(docs.every((d) => d.seo === undefined)).toBe(true)
    expect(s.headCalls()).toHaveLength(1)
    expect(s.warnings).toHaveLength(1)
    expect(s.warnings[0]?.code).toBe('SEO_RANKMATH_HEADLESS_OFF')
    expect(s.warnings[0]?.detail).toContain('Rank Math → General Settings → Others → Headless CMS Support')
  })

  it('headless state resets per run (a later documents() call asks again)', async () => {
    const s = site({ posts: [postItem(1)] })
    await collect(s.ex.documents())
    await collect(s.ex.documents())
    expect(s.headCalls()).toHaveLength(2)
    expect(s.warnings.map((w) => w.code)).toEqual(['SEO_RANKMATH_HEADLESS_OFF', 'SEO_RANKMATH_HEADLESS_OFF'])
  })

  it('a plain 404 (not rest_no_route) is a per-document failure, not headless off', async () => {
    const s = site({ posts: [postItem(1), postItem(2)], getHead: () => ({ status: 404, body: { code: 'not_found' } }) })
    await collect(s.ex.documents())
    expect(s.headCalls()).toHaveLength(2)
    expect(s.warnings.map((w) => w.code)).toEqual(['SEO_FETCH_FAILED'])
  })

  it('per-document failures: those docs get no SEO, one aggregated warning after the iterator ends', async () => {
    const s = site({
      posts: [postItem(1), postItem(2), postItem(3), postItem(4)],
      getHead: (u) => {
        if (u.endsWith('/p1/')) return { body: rmHead(1) }
        if (u.endsWith('/p2/')) return { status: 500, body: {} }
        if (u.endsWith('/p3/')) return { body: { success: false } }
        return { body: { success: true, head: '<meta name="description" content="x">' + ' '.repeat(MAX_HEAD_CHARS) } }
      },
    })
    const docs: string[] = []
    for await (const d of s.ex.documents()) {
      docs.push(d.seo?.title ?? '-')
      expect(s.warnings).toEqual([]) // nothing until the end
    }
    expect(docs).toEqual(['RM 1', '-', '-', '-'])
    expect(s.warnings).toHaveLength(1)
    expect(s.warnings[0]).toMatchObject({ code: 'SEO_FETCH_FAILED' })
    expect(s.warnings[0]?.detail).toMatch(/3 documents \(post:2, post:3, post:4\)/)
  })

  it('caps the sample of failed documents in the warning', async () => {
    const s = site({ posts: [1, 2, 3, 4, 5, 6, 7].map((i) => postItem(i)), getHead: () => ({ body: { success: false } }) })
    await collect(s.ex.documents())
    expect(s.warnings[0]?.detail).toMatch(/7 documents \(post:1, post:2, post:3, post:4, post:5, \.\.\.\)/)
  })

  it('still reports failures when the consumer stops early', async () => {
    const s = site({ posts: [postItem(1), postItem(2)], getHead: () => ({ body: {} }) })
    for await (const _ of s.ex.documents()) break
    expect(s.warnings.map((w) => w.code)).toEqual(['SEO_FETCH_FAILED'])
  })

  it('setWarningSink redirects warnings to the current run', async () => {
    const s = site({ posts: [postItem(1)] })
    const later: Issue[] = []
    s.ex.setWarningSink((i) => later.push(i))
    await collect(s.ex.documents())
    expect(s.warnings).toEqual([])
    expect(later.map((w) => w.code)).toEqual(['SEO_RANKMATH_HEADLESS_OFF'])
  })
})

describe('seo.plugin selection (AC-4)', () => {
  const both = () => [postItem(1, { yoast_head_json: yoast(1) }), postItem(2)]

  it("'none' drops all SEO and calls nothing extra", async () => {
    const s = site({ posts: both(), seoPlugin: 'none', getHead: byId(2) })
    const docs = await collect(s.ex.documents())
    expect(docs.map((d) => d.seo)).toEqual([undefined, undefined])
    expect(s.headCalls()).toHaveLength(0)
    expect(s.calls.some((u) => u.pathname === '/wp-json/')).toBe(false)
  })

  it("'yoast' never calls Rank Math", async () => {
    const s = site({ posts: both(), seoPlugin: 'yoast', getHead: byId(2) })
    const docs = await collect(s.ex.documents())
    expect(docs.map((d) => d.seo?.title)).toEqual(['Yoast 1', undefined])
    expect(s.headCalls()).toHaveLength(0)
  })

  it("'rankmath' ignores yoast_head_json and needs no namespace", async () => {
    const s = site({ posts: [postItem(1, { yoast_head_json: yoast(1) })], seoPlugin: 'rankmath', namespaces: ['wp/v2'], getHead: byId(1) })
    const docs = await collect(s.ex.documents())
    expect(docs[0]?.seo).toEqual({ title: 'RM 1', description: 'RM desc 1', canonical: 'https://example.com/p1/' })
    // No Yoast single-item re-read either.
    expect(s.calls.some((u) => /\/posts\/\d+/.test(u.pathname))).toBe(false)
  })

  it('auto with mixed docs: Yoast where present, Rank Math elsewhere', async () => {
    const s = site({ posts: both(), getHead: byId(2) })
    const docs = await collect(s.ex.documents())
    expect(docs.map((d) => d.seo?.title)).toEqual(['Yoast 1', 'RM 2'])
  })
})

describe('rankMathHeadless (doctor, AC-5)', () => {
  it('asks getHead with the site URL and reads the route state', async () => {
    const on = site({ posts: [], getHead: () => ({ body: rmHead(1) }) })
    expect(await on.ex.rankMathHeadless()).toBe('on')
    expect(on.headCalls()[0]?.searchParams.get('url')).toBe('https://example.com/')
    expect(await site({ posts: [] }).ex.rankMathHeadless()).toBe('off')
    expect(await site({ posts: [], getHead: () => ({ status: 403, body: { code: 'rest_forbidden' } }) }).ex.rankMathHeadless()).toBe('unknown')
  })
})

describe('short fields reach the IR as plain text (S07-01)', () => {
  it('drops unclosed tags, comments and scripts that a regex strip would let through', async () => {
    const { toPlainText } = await import('../../src/extractors/rest/decode.js')
    expect(toPlainText('Hi <img src=x onerror=alert(1)')).toBe('Hi')
    expect(toPlainText('a <script>alert(1)</script>b')).toBe('a b')
    expect(toPlainText('a <!-- b')).toBe('a')
    // Decoded once: an encoded tag in a title is a literal, which consumers escape.
    expect(toPlainText('Use &lt;b&gt; tags')).toBe('Use <b> tags')
    expect(toPlainText('evil\u202etxt.exe')).not.toContain('\u202e')
  })
})
