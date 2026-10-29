import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Payload } from 'payload'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { escapeSource, hasDotSegment, isNormalisedPath, isPatternReserved, isReserved, loadRedirects, newPathOf, nextRedirect, oldPathOf, pluginFromOf, type NextRedirect, type RedirectsOptions } from '../../src/loaders/redirects.js'
import type { LoaderContext, RedirectSource } from '../../src/loaders/types.js'
import { MemoryReport } from '../../src/report/types.js'

const SITE = 'https://example.test'
const PATHS = { post: '/posts/:slug', page: '/:slug' }

function fakeCtx(dryRun = false): { ctx: LoaderContext; report: MemoryReport } {
  const report = new MemoryReport()
  const payload = { collections: {} } as unknown as Payload // no redirects collection → file mode
  const ctx: LoaderContext = {
    payload,
    site: 'https://example.test',
    dryRun,
    ids: { get: () => undefined, set: () => {} },
    report,
    collections: { media: 'media' },
  }
  return { ctx, report }
}

const src = (over: Partial<RedirectSource>): RedirectSource => ({
  type: 'post',
  wpId: 1,
  link: `${SITE}/2024/01/hello/`,
  slug: 'hello',
  collection: 'posts',
  id: 1,
  ...over,
})

describe('oldPathOf', () => {
  it('keeps the encoded path, drops the trailing slash, ignores www and scheme', () => {
    expect(oldPathOf('http://www.example.test/2024/01/caf%C3%A9/', SITE)).toEqual({ pathname: '/2024/01/caf%C3%A9', search: '' })
    expect(oldPathOf('https://example.test/', SITE)).toEqual({ pathname: '/', search: '' })
  })
  it('keeps the query of plain permalinks and the subdirectory', () => {
    expect(oldPathOf('https://example.test/blog/?p=123', 'https://example.test/blog')).toEqual({ pathname: '/blog', search: '?p=123' })
    expect(oldPathOf('https://example.test/blog/hello/', 'https://example.test/blog/')).toEqual({ pathname: '/blog/hello', search: '' })
  })
  it('rejects off-site, empty and non-http links', () => {
    expect(oldPathOf('https://other.test/hello/', SITE)).toHaveProperty('skip')
    expect(oldPathOf('', SITE)).toHaveProperty('skip')
    expect(oldPathOf('mailto:a@example.test', SITE)).toHaveProperty('skip')
    expect(oldPathOf('https://example.test:8443/x', SITE)).toHaveProperty('skip')
  })
})

describe('newPathOf / escapeSource / nextRedirect', () => {
  it('encodes the slug once, per segment', () => {
    expect(newPathOf('/posts/:slug', 'hello')).toBe('/posts/hello')
    expect(newPathOf('/posts/:slug', 'caf%c3%a9')).toBe('/posts/caf%C3%A9') // WordPress-encoded slug is not double-encoded
    expect(newPathOf('/posts/:slug', 'a b(c)')).toBe('/posts/a%20b%28c%29')
    expect(newPathOf('/:slug', 'parent/child')).toBe('/parent/child')
  })
  it('decodes plugin-mode from per segment, NFC, keeping malformed escapes', () => {
    expect(pluginFromOf({ pathname: '/2024/cafe%CC%81', search: '' })).toBe('/2024/café')
    expect(pluginFromOf({ pathname: '/a%2Fb/%E0%A4', search: '?p=1' })).toBe('/a/b/%E0%A4?p=1')
  })
  it('reserves framework and well-known paths segment-wise', () => {
    for (const p of ['/admin', '/admin/x', '/API/v1', '/_next/static/x.js', '/next', '/favicon.ico', '/robots.txt/', '/sitemap.xml']) expect(isReserved(p), p).toBe(true)
    for (const p of ['/administrator-tips', '/apis', '/sitemap.xml.gz', '/blog/admin']) expect(isReserved(p), p).toBe(false)
    expect(isReserved('/cms/collections', ['/cms'])).toBe(true)
    expect(isReserved('/x', ['/'])).toBe(false)
  })
  it('reserves routes derived from redirects.paths and /search', () => {
    for (const p of ['/posts', '/Posts/', '/posts/page', '/posts/page/2', '/search', '/SEARCH/']) expect(isPatternReserved(p, PATHS), p).toBe(true)
    for (const p of ['/posts/hello', '/posts/pages', '/page', '/page/2', '/searching']) expect(isPatternReserved(p, PATHS), p).toBe(false)
  })
  it('detects dot segments, encoded too, and unnormalised paths', () => {
    for (const slug of ['.', '..', '%2e', '%2E%2E', 'a/../b']) expect(hasDotSegment(slug), slug).toBe(true)
    for (const slug of ['...', 'a.b', '.hidden']) expect(hasDotSegment(slug), slug).toBe(false)
    expect(isNormalisedPath('/posts/hello')).toBe(true)
    expect(isNormalisedPath('/posts/%2E%2E')).toBe(false)
    expect(isNormalisedPath('/posts/../admin')).toBe(false)
  })
  it('escapes path-to-regexp syntax', () => {
    expect(escapeSource('/a:b(c)*+{x}?')).toBe(String.raw`/a\:b\(c\)\*\+\{x\}\?`)
  })
  it('matches with or without the trailing slash and uses has for queries', () => {
    expect(nextRedirect({ pathname: '/2024/01/hello', search: '' }, '/posts/hello')).toEqual({ source: '/2024/01/hello{/}?', destination: '/posts/hello', permanent: true })
    expect(nextRedirect({ pathname: '/', search: '?p=12.3' }, '/posts/x')).toEqual({
      source: '/',
      destination: '/posts/x',
      permanent: true,
      has: [{ type: 'query', key: 'p', value: String.raw`12\.3` }],
    })
  })
})

describe('loadRedirects (file mode)', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-redirects-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const opts = (): RedirectsOptions => ({ siteUrl: SITE, paths: PATHS, collection: 'redirects', root })
  const readEntries = async (): Promise<NextRedirect[]> => JSON.parse(await readFile(path.join(root, '.wp2payload', 'redirects.json'), 'utf8')) as NextRedirect[]

  it('writes sorted Next.js redirects and counts them', async () => {
    const { ctx, report } = fakeCtx()
    const res = await loadRedirects(
      ctx,
      [
        src({ wpId: 2, link: `${SITE}/2024/02/zeta/`, slug: 'zeta', id: 2 }),
        src({ wpId: 1, link: `${SITE}/2024/01/al:pha/`, slug: 'alpha', id: 1 }),
        src({ type: 'page', wpId: 3, link: `${SITE}/?page_id=3`, slug: 'about', collection: 'pages', id: 3 }),
      ],
      opts(),
    )
    expect(res).toEqual({ count: 3, conflicts: 0, file: '.wp2payload/redirects.json' })
    expect(await readEntries()).toEqual([
      { source: '/', destination: '/about', permanent: true, has: [{ type: 'query', key: 'page_id', value: '3' }] },
      { source: String.raw`/2024/01/al\:pha{/}?`, destination: '/posts/alpha', permanent: true },
      { source: '/2024/02/zeta{/}?', destination: '/posts/zeta', permanent: true },
    ])
    expect(report.summary['redirects']).toEqual({ created: 3 })
    expect(report.errors).toEqual([])
  })

  it('skips unchanged paths, off-site links and types without a pattern', async () => {
    const { ctx, report } = fakeCtx()
    const res = await loadRedirects(
      ctx,
      [
        src({ type: 'page', link: `${SITE}/about/`, slug: 'about', collection: 'pages' }), // /about → /about
        src({ wpId: 2, link: 'https://elsewhere.test/hello/', id: 2 }),
        src({ wpId: 3, link: '', id: 3 }),
        src({ type: 'product', wpId: 4, link: `${SITE}/shop/a/`, slug: 'a', id: 4 }),
        src({ type: 'product', wpId: 5, link: `${SITE}/shop/b/`, slug: 'b', id: 5 }),
      ],
      opts(),
    )
    expect(res.count).toBe(0)
    expect(report.summary['redirects']).toEqual({ skipped: 5 })
    const skipped = report.warnings.filter((w) => w.code === 'REDIRECT_SKIPPED')
    expect(skipped.map((w) => w.doc)).toEqual(['post:2', 'post:3', undefined]) // product warned once
    expect(await readEntries()).toEqual([])
  })

  it('reports both documents on old-path and new-path conflicts and keeps the first', async () => {
    const { ctx, report } = fakeCtx()
    const res = await loadRedirects(
      ctx,
      [
        src({ wpId: 1, link: `${SITE}/hello/`, slug: 'one', id: 1 }),
        src({ wpId: 2, link: `${SITE}/hello`, slug: 'two', id: 2 }), // same old path (slash ignored)
        src({ wpId: 3, link: `${SITE}/other/`, slug: 'one', id: 3 }), // same new path, other document
        src({ wpId: 1, link: `${SITE}/?p=1`, slug: 'one', id: 1 }), // same document again: fine
      ],
      opts(),
    )
    expect(res).toMatchObject({ count: 2, conflicts: 2 })
    expect(report.summary['redirects']).toEqual({ created: 2, rejected: 2 }) // conflicts never count as errors
    expect(report.errors.map((e) => e.code)).toEqual(['REDIRECT_CONFLICT', 'REDIRECT_CONFLICT'])
    expect(report.errors[0]?.detail).toContain('post:1')
    expect(report.errors[0]?.detail).toContain('post:2')
    expect(report.errors[1]?.detail).toContain('/posts/one')
    expect(report.errors[1]?.detail).toContain('post:3')
    expect((await readEntries()).map((e) => e.source)).toEqual(['/', '/hello{/}?'])
  })

  it('dry run plans the same counts and writes no file', async () => {
    const { ctx, report } = fakeCtx(true)
    const res = await loadRedirects(ctx, [src({})], opts())
    expect(res).toEqual({ count: 1, conflicts: 0 })
    expect(report.summary['redirects']).toEqual({ created: 1 })
    await expect(stat(path.join(root, '.wp2payload'))).rejects.toThrow()
  })

  it('accepts async iterables and stops when asked', async () => {
    const { ctx } = fakeCtx()
    let n = 0
    async function* gen(): AsyncGenerator<RedirectSource> {
      yield src({ wpId: 1, id: 1 })
      yield src({ wpId: 2, link: `${SITE}/b/`, slug: 'b', id: 2 })
    }
    const res = await loadRedirects(ctx, gen(), { ...opts(), shouldStop: () => ++n > 1 })
    expect(res).toEqual({ count: 1, conflicts: 0 }) // stopped early: no partial file
    await expect(stat(path.join(root, '.wp2payload', 'redirects.json'))).rejects.toThrow()
  })

  it('never redirects the front page, also under a subdirectory', async () => {
    const { ctx, report } = fakeCtx()
    const res = await loadRedirects(
      ctx,
      [
        src({ type: 'page', wpId: 1, link: `${SITE}/blog/`, slug: 'home', collection: 'pages', id: 1 }),
        src({ type: 'page', wpId: 2, link: `${SITE}/`, slug: 'home2', collection: 'pages', id: 2 }),
        src({ type: 'page', wpId: 3, link: `${SITE}/blog/?page_id=3`, slug: 'three', collection: 'pages', id: 3 }), // query: not the front page
      ],
      { ...opts(), siteUrl: `${SITE}/blog` },
    )
    expect(res.count).toBe(1)
    expect(report.warnings.map((w) => w.detail)).toEqual(['page:1: /blog is the front page', 'page:2: / is the front page'])
  })

  it('skips reserved old and new paths', async () => {
    const { ctx, report } = fakeCtx()
    const res = await loadRedirects(
      ctx,
      [
        src({ wpId: 1, link: `${SITE}/admin/`, slug: 'a', id: 1 }),
        src({ wpId: 2, link: `${SITE}/_next/static/x/`, slug: 'b', id: 2 }),
        src({ wpId: 3, link: `${SITE}/robots.txt`, slug: 'c', id: 3 }),
        src({ wpId: 4, link: `${SITE}/cms/x/`, slug: 'd', id: 4 }),
        src({ type: 'page', wpId: 5, link: `${SITE}/?page_id=5`, slug: 'api', collection: 'pages', id: 5 }), // new path /api
        src({ wpId: 6, link: `${SITE}/administrator-tips/`, slug: 'tips', id: 6 }),
      ],
      { ...opts(), reserved: ['/cms'] },
    )
    expect(res.count).toBe(1)
    expect(report.warnings.map((w) => w.doc)).toEqual(['post:1', 'post:2', 'post:3', 'post:4', 'page:5'])
    expect(report.warnings[4]?.detail).toContain('new path /api')
  })

  it('rejects old paths that shadow a document, which also rules out loops', async () => {
    const { ctx, report } = fakeCtx()
    const res = await loadRedirects(
      ctx,
      [
        // Swap: A lived at /b and moves to /a, B lived at /a and moves to /b → a loop if both were written.
        src({ type: 'page', wpId: 1, link: `${SITE}/b/`, slug: 'a', collection: 'pages', id: 1 }),
        src({ type: 'page', wpId: 2, link: `${SITE}/a/`, slug: 'b', collection: 'pages', id: 2 }),
        // A post whose old path is the new home of page "about" (listed later: sources are the full set).
        src({ wpId: 3, link: `${SITE}/about/`, slug: 'x', id: 3 }),
        src({ type: 'page', wpId: 4, link: `${SITE}/?page_id=4`, slug: 'about', collection: 'pages', id: 4 }),
      ],
      opts(),
    )
    expect(res).toMatchObject({ count: 1, conflicts: 3 })
    expect(report.errors.map((e) => e.doc)).toEqual(['page:1', 'page:2', 'post:3'])
    expect(report.errors[2]?.detail).toContain('unreachable')
    expect((await readEntries()).map((e) => e.destination)).toEqual(['/about'])
  })

  it('skips empty slugs and never puts the raw link in report details', async () => {
    const { ctx, report } = fakeCtx()
    await loadRedirects(
      ctx,
      [
        src({ wpId: 1, link: 'https://user:secret@example.test/x/?token=abc', slug: '', id: 1 }),
        src({ wpId: 2, link: 'https://other.test/y/?token=abc', id: 2 }),
        src({ wpId: 3, link: 'https://user:secret@example.test/hello/', slug: 'one', id: 3 }),
        src({ wpId: 4, link: 'https://user:secret@example.test/hello/', slug: 'two', id: 4 }),
      ],
      opts(),
    )
    expect(report.warnings[0]?.detail).toBe('post:1: empty slug')
    const details = [...report.warnings, ...report.errors].map((i) => i.detail).join('\n')
    expect(report.errors).toHaveLength(1)
    expect(details).not.toMatch(/secret|token|other\.test|example\.test/)
  })

  it('skips dot-segment slugs and reserved pattern prefixes', async () => {
    const { ctx, report } = fakeCtx()
    const res = await loadRedirects(
      ctx,
      [
        src({ wpId: 1, link: `${SITE}/x/`, slug: '..', id: 1 }),
        src({ wpId: 2, link: `${SITE}/y/`, slug: '%2E%2E', id: 2 }),
        src({ wpId: 3, link: `${SITE}/posts/`, slug: 'c', id: 3 }),
        src({ wpId: 4, link: `${SITE}/posts/page/2/`, slug: 'd', id: 4 }),
        src({ wpId: 5, link: `${SITE}/search/`, slug: 'e', id: 5 }),
        src({ type: 'page', wpId: 6, link: `${SITE}/?page_id=6`, slug: 'x', collection: 'pages', id: 6 }),
      ],
      { ...opts(), paths: { ...PATHS, page: '/:slug/../admin' } },
    )
    expect(res.count).toBe(0)
    expect(report.warnings.map((w) => w.detail)).toEqual([
      'post:1: slug has a dot segment',
      'post:2: slug has a dot segment',
      'post:3: /posts is a reserved path',
      'post:4: /posts/page/2 is a reserved path',
      'post:5: /search is a reserved path',
      'page:6: new path /x/../admin is not a normalised path',
    ])
  })

  it('compares paths case-insensitively, like Next.js sources', async () => {
    const { ctx, report } = fakeCtx()
    const res = await loadRedirects(
      ctx,
      [
        src({ wpId: 1, link: `${SITE}/Posts/B/`, slug: 'a', id: 1 }),
        src({ wpId: 2, link: `${SITE}/POSTS/A/`, slug: 'b', id: 2 }),
        src({ wpId: 3, link: `${SITE}/Hello/`, slug: 'c', id: 3 }),
        src({ wpId: 4, link: `${SITE}/hello`, slug: 'd', id: 4 }),
        src({ wpId: 5, link: `${SITE}/2024/x/`, slug: 'E', id: 5 }),
        src({ wpId: 6, link: `${SITE}/2024/y/`, slug: 'e', id: 6 }),
        src({ type: 'page', wpId: 7, link: `${SITE}/About/`, slug: 'about', collection: 'pages', id: 7 }), // same path: no self-redirect
      ],
      opts(),
    )
    expect(res).toMatchObject({ count: 2, conflicts: 4 })
    expect(report.errors.map((e) => e.doc)).toEqual(['post:1', 'post:2', 'post:4', 'post:6'])
    expect(report.summary['redirects']).toEqual({ created: 2, rejected: 4, skipped: 1 })
    expect((await readEntries()).map((e) => e.destination)).toEqual(['/posts/E', '/posts/c'])
  })
})
