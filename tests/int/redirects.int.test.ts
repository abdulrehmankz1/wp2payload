import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { redirectsPlugin } from '@payloadcms/plugin-redirects'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadRedirects, type RedirectsOptions } from '../../src/loaders/redirects.js'
import type { LoaderContext, RedirectSource } from '../../src/loaders/types.js'
import { MemoryReport } from '../../src/report/types.js'

// Real Payload 3.92 + SQLite with @payloadcms/plugin-redirects (spec 06 AC-B2, AC-B4).

const SITE = 'https://example.test'

interface Instance {
  payload: Payload
  dir: string
  close(): Promise<void>
}

async function start(plugin: Parameters<typeof redirectsPlugin>[0]): Promise<Instance> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-redir-'))
  const config = buildConfig({
    secret: 'test-secret-not-real',
    telemetry: false,
    db: sqliteAdapter({ client: { url: `file:${path.join(dir, 'test.db').replace(/\\/g, '/')}` }, push: true }),
    collections: [
      { slug: 'posts', fields: [{ name: 'title', type: 'text' }] },
      { slug: 'pages', fields: [{ name: 'title', type: 'text' }] },
      { slug: 'notes', fields: [{ name: 'title', type: 'text' }] },
    ],
    plugins: [redirectsPlugin(plugin)],
    logger: { options: { level: 'error' } },
  })
  const payload = await getPayload({ config, key: dir })
  return {
    payload,
    dir,
    async close() {
      await payload.db.destroy?.()
      ;(payload.db as { client?: { close?: () => void } }).client?.close?.()
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
      }
    },
  }
}

function context(payload: Payload, dryRun = false): { ctx: LoaderContext; report: MemoryReport } {
  const report = new MemoryReport()
  return {
    report,
    ctx: { payload, site: 'https://example.test', dryRun, ids: { get: () => undefined, set: () => {} }, report, collections: { media: 'media' } },
  }
}

const opts = (root: string): RedirectsOptions => ({ siteUrl: SITE, paths: { post: '/posts/:slug', page: '/:slug' }, collection: 'redirects', root, retry: { attempts: 1 } })

interface RedirectDoc {
  from: string
  type?: string
  to: { type: string; reference?: unknown; url?: string | null }
}

async function all(payload: Payload): Promise<RedirectDoc[]> {
  const res = await payload.find({ collection: 'redirects', depth: 0, limit: 100, sort: 'from', overrideAccess: true })
  return res.docs as unknown as RedirectDoc[]
}

describe('loadRedirects plugin mode, polymorphic (collections: posts, pages)', () => {
  let inst: Instance
  let sources: RedirectSource[]
  beforeAll(async () => {
    inst = await start({ collections: ['posts', 'pages'], redirectTypes: ['301', '302'] })
    const post = await inst.payload.create({ collection: 'posts', data: { title: 'Hello' } })
    const page = await inst.payload.create({ collection: 'pages', data: { title: 'About' } })
    const note = await inst.payload.create({ collection: 'notes', data: { title: 'Note' } })
    sources = [
      { type: 'post', wpId: 10, link: `${SITE}/2024/01/hello/`, slug: 'hello', collection: 'posts', id: post.id },
      { type: 'page', wpId: 20, link: `${SITE}/?page_id=20`, slug: 'about', collection: 'pages', id: page.id },
      { type: 'post', wpId: 30, link: `${SITE}/2024/01/note/`, slug: 'note', collection: 'notes', id: note.id }, // not referenceable
    ]
  })
  afterAll(async () => {
    await inst?.close()
  })

  it('dry run plans the redirects and writes nothing', async () => {
    const { ctx, report } = context(inst.payload, true)
    const res = await loadRedirects(ctx, sources, opts(inst.dir))
    expect(res).toEqual({ count: 3, conflicts: 0 })
    expect(report.summary['redirects']).toEqual({ created: 3 })
    expect(await all(inst.payload)).toEqual([])
    await expect(stat(path.join(inst.dir, '.wp2payload'))).rejects.toThrow()
  })

  it('creates references with the polymorphic shape, a custom URL fallback and type 301', async () => {
    const { ctx, report } = context(inst.payload)
    const res = await loadRedirects(ctx, sources, opts(inst.dir))
    expect(report.errors).toEqual([])
    expect(res).toEqual({ count: 3, conflicts: 0 })
    const docs = await all(inst.payload)
    expect(docs.map((d) => ({ from: d.from, type: d.type, to: d.to }))).toEqual([
      { from: '/2024/01/hello', type: '301', to: expect.objectContaining({ type: 'reference', reference: { relationTo: 'posts', value: sources[0]?.id } }) },
      { from: '/2024/01/note', type: '301', to: expect.objectContaining({ type: 'custom', url: '/posts/note' }) },
      { from: '/?page_id=20', type: '301', to: expect.objectContaining({ type: 'reference', reference: { relationTo: 'pages', value: sources[1]?.id } }) },
    ])
  })

  it('re-run creates no duplicates', async () => {
    const { ctx, report } = context(inst.payload)
    const res = await loadRedirects(ctx, sources, opts(inst.dir))
    expect(res).toEqual({ count: 0, conflicts: 0 })
    expect(report.summary['redirects']).toEqual({ skipped: 3 })
    expect(await all(inst.payload)).toHaveLength(3)
  })

  it('leaves a conflicting existing redirect untouched and reports it', async () => {
    await inst.payload.create({ collection: 'redirects', data: { from: '/2023/old', type: '302', to: { type: 'custom', url: '/somewhere' } }, overrideAccess: true })
    const { ctx, report } = context(inst.payload)
    const res = await loadRedirects(ctx, [{ ...(sources[0] as RedirectSource), wpId: 11, link: `${SITE}/2023/old/` }], opts(inst.dir))
    expect(res).toEqual({ count: 0, conflicts: 1 })
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toMatchObject({ code: 'REDIRECT_CONFLICT', doc: 'post:11' })
    expect(report.errors[0]?.detail).toContain('/somewhere')
    const kept = (await all(inst.payload)).find((d) => d.from === '/2023/old')
    expect(kept).toMatchObject({ type: '302', to: { type: 'custom', url: '/somewhere' } })
  })
})

// `collections: ['posts']` is still an array, so the plugin stores `{ relationTo, value }`; a
// non-polymorphic reference needs `relationTo: 'posts'` via the plugin's field override.
const singleRelation: NonNullable<Parameters<typeof redirectsPlugin>[0]> = {
  collections: ['posts'],
  overrides: {
    fields: ({ defaultFields }) =>
      defaultFields.map((f) =>
        f.type === 'group' && 'name' in f && f.name === 'to'
          ? { ...f, fields: f.fields.map((g) => (g.type === 'relationship' && g.name === 'reference' ? { ...g, relationTo: 'posts' as const } : g)) }
          : f,
      ) as typeof defaultFields,
  },
}

describe('loadRedirects plugin mode, single collection', () => {
  it('a one-element collections array is still polymorphic', async () => {
    const inst = await start({ collections: ['posts'] })
    try {
      const post = await inst.payload.create({ collection: 'posts', data: { title: 'Hello' } })
      const { ctx, report } = context(inst.payload)
      await loadRedirects(ctx, [{ type: 'post', wpId: 1, link: `${SITE}/hello/`, slug: 'x', collection: 'posts', id: post.id }], opts(inst.dir))
      expect(report.errors).toEqual([])
      expect((await all(inst.payload))[0]?.to.reference).toEqual({ relationTo: 'posts', value: post.id })
    } finally {
      await inst.close()
    }
  })
})

describe('loadRedirects plugin mode, non-polymorphic reference (relationTo: posts)', () => {
  let inst: Instance
  beforeAll(async () => {
    inst = await start(singleRelation)
  })
  afterAll(async () => {
    await inst?.close()
  })

  it('stores the plain id as reference and skips a type without a pattern for the fallback', async () => {
    const post = await inst.payload.create({ collection: 'posts', data: { title: 'Hello' } })
    const page = await inst.payload.create({ collection: 'pages', data: { title: 'About' } })
    const { ctx, report } = context(inst.payload)
    const res = await loadRedirects(
      ctx,
      [
        { type: 'post', wpId: 1, link: `${SITE}/?p=1`, slug: 'hello', collection: 'posts', id: post.id },
        { type: 'page', wpId: 2, link: `${SITE}/old-about/`, slug: 'about', collection: 'pages', id: page.id }, // custom URL
        { type: 'event', wpId: 3, link: `${SITE}/e/`, slug: 'e', collection: 'pages', id: page.id }, // no pattern, not referenceable
      ],
      opts(inst.dir),
    )
    expect(report.errors).toEqual([])
    expect(res).toEqual({ count: 2, conflicts: 0 })
    expect(report.warnings.map((w) => w.code)).toEqual(['REDIRECT_SKIPPED'])
    const docs = await all(inst.payload)
    expect(docs.map((d) => ({ from: d.from, to: d.to }))).toEqual([
      { from: '/?p=1', to: expect.objectContaining({ type: 'reference', reference: post.id }) },
      { from: '/old-about', to: expect.objectContaining({ type: 'custom', url: '/about' }) },
    ])
    expect(docs[0]?.type).toBeUndefined() // no redirectTypes configured
  })
})

describe('loadRedirects plugin mode, review fixes (redirectTypes without 301)', () => {
  let inst: Instance
  beforeAll(async () => {
    inst = await start({ collections: ['posts', 'pages'], redirectTypes: ['302', '308'] })
  })
  afterAll(async () => {
    await inst?.close()
  })

  it('stores from decoded (NFC), picks 308, and skips the front page', async () => {
    const post = await inst.payload.create({ collection: 'posts', data: { title: 'Café' } })
    const home = await inst.payload.create({ collection: 'pages', data: { title: 'Home' } })
    const { ctx, report } = context(inst.payload)
    const res = await loadRedirects(
      ctx,
      [
        { type: 'post', wpId: 1, link: `${SITE}/2024/cafe%CC%81/`, slug: 'caf%c3%a9', collection: 'posts', id: post.id },
        { type: 'page', wpId: 2, link: `${SITE}/`, slug: 'home', collection: 'pages', id: home.id }, // static front page
      ],
      opts(inst.dir),
    )
    expect(res).toEqual({ count: 1, conflicts: 0 })
    expect(report.warnings.map((w) => w.detail)).toEqual(['page:2: / is the front page'])
    const docs = await all(inst.payload)
    expect(docs.map((d) => ({ from: d.from, type: d.type }))).toEqual([{ from: '/2024/café', type: '308' }])
  })

  it('rejects a second document with the same new path, counted as rejected', async () => {
    const a = await inst.payload.create({ collection: 'posts', data: { title: 'A' } })
    const b = await inst.payload.create({ collection: 'posts', data: { title: 'B' } })
    const { ctx, report } = context(inst.payload)
    const res = await loadRedirects(
      ctx,
      [
        { type: 'post', wpId: 10, link: `${SITE}/2020/dup/`, slug: 'dup', collection: 'posts', id: a.id },
        { type: 'post', wpId: 11, link: `${SITE}/2021/dup/`, slug: 'dup', collection: 'posts', id: b.id },
      ],
      opts(inst.dir),
    )
    expect(res).toEqual({ count: 1, conflicts: 1 })
    expect(report.summary['redirects']).toEqual({ created: 1, rejected: 1 })
    expect(report.errors[0]).toMatchObject({ code: 'REDIRECT_CONFLICT', doc: 'post:11' })
    expect((await all(inst.payload)).some((d) => d.from === '/2021/dup')).toBe(false)
  })

  it('repoints an existing redirect whose document was deleted', async () => {
    const gone = await inst.payload.create({ collection: 'posts', data: { title: 'Gone' } })
    await inst.payload.create({
      collection: 'redirects',
      data: { from: '/old-gone', type: '302', to: { type: 'reference', reference: { relationTo: 'posts', value: gone.id } } },
      overrideAccess: true,
    })
    await inst.payload.delete({ collection: 'posts', id: gone.id, overrideAccess: true })
    const now = await inst.payload.create({ collection: 'posts', data: { title: 'Now' } })
    const source: RedirectSource = { type: 'post', wpId: 20, link: `${SITE}/old-gone/`, slug: 'now', collection: 'posts', id: now.id }

    const dry = context(inst.payload, true)
    expect(await loadRedirects(dry.ctx, [source], opts(inst.dir))).toEqual({ count: 1, conflicts: 0 })
    expect(dry.report.summary['redirects']).toEqual({ updated: 1 })

    const { ctx, report } = context(inst.payload)
    expect(await loadRedirects(ctx, [source], opts(inst.dir))).toEqual({ count: 1, conflicts: 0 })
    expect(report.summary['redirects']).toEqual({ updated: 1 })
    const doc = (await all(inst.payload)).find((d) => d.from === '/old-gone')
    expect(doc?.to.reference).toEqual({ relationTo: 'posts', value: now.id })
    expect(doc?.type).toBe('308')
  })
})
