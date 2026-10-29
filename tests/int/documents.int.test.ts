import { existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IRDocument } from '../../src/ir/types.js'
import { loadDocuments, type DocumentsLoaderOptions } from '../../src/loaders/documents.js'
import { describeCollection } from '../../src/loaders/fields.js'
import type { DocumentWritten, IdKind, LoaderContext } from '../../src/loaders/types.js'
import { findByWpMeta, upsertByWpMeta, type PayloadId } from '../../src/loaders/wpmeta.js'
import { MemoryReport } from '../../src/report/types.js'
import { startDocumentsPayload, type DocumentsTestPayload } from './documents-harness.js'

const ORIGIN = 'https://oldsite.test'
// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

let t: DocumentsTestPayload
beforeAll(async () => {
  t = await startDocumentsPayload()
})
afterAll(async () => {
  await t?.close()
})

function mkCtx(site: string, over: Partial<LoaderContext> = {}) {
  const map = new Map<string, PayloadId>()
  const report = new MemoryReport()
  const ctx: LoaderContext = {
    payload: t.payload,
    site,
    dryRun: false,
    ids: { get: (k: IdKind, id) => map.get(`${k}:${id}`), set: (k, id, v) => void map.set(`${k}:${id}`, v) },
    report,
    collections: { media: 'media', category: 'categories', post_tag: 'tags', author: 'authors' },
    ...over,
  }
  return { ctx, report, map }
}

const doc = (wpId: number, type: string, slug: string, over: Partial<IRDocument> = {}): IRDocument => ({
  wpId,
  type,
  status: 'publish',
  slug,
  title: slug.toUpperCase(),
  html: `<p>${slug} body</p>`,
  link: `${ORIGIN}/${slug}/`,
  publishedAt: '2021-04-01T10:00:00.000Z',
  modifiedAt: '2021-04-02T10:00:00.000Z',
  termWpIds: [],
  meta: {},
  ...over,
})

function options(docs: IRDocument[], over: Partial<DocumentsLoaderOptions> = {}): DocumentsLoaderOptions {
  return {
    targets: {
      post: { collection: 'posts', fields: { featuredImage: 'heroImage' } },
      page: { collection: 'pages', fields: {} },
      note: { collection: 'notes', fields: {} },
    },
    transform: { siteOrigin: ORIGIN, embedHosts: ['youtube.com'], externalLinkRel: 'noopener nofollow', transformers: [], root: t.dir },
    media: [{ wpId: 50, sourceUrl: `${ORIGIN}/wp-content/uploads/2021/04/hero.png` }],
    documents: docs.map((d) => ({ wpId: d.wpId, type: d.type, link: d.link })),
    mediaCollection: 'media',
    retry: { attempts: 1 },
    ...over,
  }
}

const source = (docs: IRDocument[]) => () =>
  (async function* () {
    yield* docs
  })()

/** Authors, terms and one media item, written the way the earlier phases do. */
async function seedRefs(ctx: LoaderContext) {
  const put = async (kind: IdKind, collection: 'authors' | 'categories' | 'tags', wpId: number, name: string) => {
    const r = await upsertByWpMeta(t.payload, { collection, meta: { site: ctx.site, wpId }, data: { name, slug: name } })
    ctx.ids.set(kind, wpId, r.id)
    return r.id
  }
  const author = await put('author', 'authors', 7, 'ann')
  const cat1 = await put('category', 'categories', 11, 'news')
  const cat2 = await put('category', 'categories', 12, 'tech')
  const tag = await put('post_tag', 'tags', 21, 'tips')
  const existing = await findByWpMeta(t.payload, 'media', ctx.site, 50)
  const media =
    existing ??
    (
      await t.payload.create({
        collection: 'media',
        data: { alt: 'Hero', wpMeta: { site: ctx.site, wpId: 50, importedAt: new Date().toISOString() } } as never,
        file: { data: PNG, mimetype: 'image/png', name: 'hero.png', size: PNG.length },
      })
    ).id
  ctx.ids.set('media', 50, media)
  return { author, cat1, cat2, tag, media }
}

const read = async (collection: 'posts' | 'pages', id: PayloadId) =>
  (await t.payload.findByID({ collection, id, depth: 0, draft: true })) as unknown as Record<string, unknown>

function links(state: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    const node = n as { type?: string; fields?: Record<string, unknown>; children?: unknown[]; root?: unknown }
    if (node.type === 'link' && node.fields) out.push(node.fields)
    if (node.root) walk(node.root)
    for (const c of node.children ?? []) walk(c)
  }
  walk(state)
  return out
}

describe('describeCollection', () => {
  it('reads fields, drafts, editor blocks and link rel from the sanitized config', () => {
    const posts = describeCollection(t.payload, 'posts')
    expect(posts.drafts).toBe(true)
    expect(posts.fields.get('categories')).toMatchObject({ kind: 'relationship', hasMany: true, relationTo: 'categories' })
    expect(posts.fields.get('heroImage')).toMatchObject({ kind: 'relationship', type: 'upload', hasMany: false })
    expect([...(posts.fields.get('meta')?.fields?.keys() ?? [])]).toEqual(['title', 'description', 'image'])
    expect(posts.fields.get('content')?.editor).toEqual({ blocks: { embed: 'embed', wpRawHtml: 'wpRawHtml' }, linkRel: true })
    const pages = describeCollection(t.payload, 'pages')
    expect(pages.drafts).toBe(false)
    expect(pages.fields.get('content')?.editor).toEqual({ blocks: {}, linkRel: false })
  })
})

describe('loadDocuments', () => {
  it('maps fields that exist, forward links and parents resolve in pass 2, re-run creates nothing', async () => {
    const site = 'https://map.test'
    const a = mkCtx(site)
    const refs = await seedRefs(a.ctx)
    const docs = [
      // Links forward to the page below and to itself; carries a script (one finding, once).
      doc(1, 'post', 'first', {
        html: `<p>See <a href="${ORIGIN}/about/">about</a> and <a href="https://ext.test/x">ext</a>.</p><script>alert(1)</script><p>Gone: <a href="${ORIGIN}/nope/">nope</a></p>`,
        excerpt: 'Short <b>excerpt</b>',
        authorWpId: 7,
        termWpIds: [11, 12, 21, 999],
        featuredMediaWpId: 50,
        seo: { title: 'SEO title', description: 'SEO desc', canonical: `${ORIGIN}/first/`, ogImageWpId: 50 },
      }),
      doc(2, 'post', 'draft-one', { status: 'draft' }),
      doc(3, 'page', 'child', { parentWpId: 4, termWpIds: [11] }),
      doc(4, 'page', 'about'),
      doc(5, 'attachment', 'x'),
      doc(6, 'attachment', 'y'),
    ]
    const written: DocumentWritten[] = []
    const res = await loadDocuments(a.ctx, source(docs), options(docs, { onDocument: (r) => written.push(r) }))
    expect(res).toEqual({ deferred: 2, stopped: false })
    expect(a.report.summary['documents']).toEqual({ created: 4, skipped: 2 })
    expect(a.report.errors).toEqual([])

    const post = await read('posts', a.map.get('post:1')!)
    expect(post).toMatchObject({
      title: 'FIRST',
      slug: 'first',
      _status: 'published',
      publishedAt: '2021-04-01T10:00:00.000Z',
      author: refs.author,
      categories: [refs.cat1, refs.cat2],
      tags: [refs.tag],
      heroImage: refs.media,
      meta: { title: 'SEO title', description: 'SEO desc', image: refs.media },
    })
    expect(post['excerpt']).toBeUndefined()
    expect(links(post['content'])).toEqual([
      { linkType: 'internal', newTab: false, doc: { relationTo: 'pages', value: a.map.get('page:4') } },
      { linkType: 'custom', newTab: false, url: 'https://ext.test/x', rel: 'noopener nofollow' },
      { linkType: 'custom', newTab: false, url: `${ORIGIN}/nope/` },
    ])
    expect((await read('posts', a.map.get('post:2')!))['_status']).toBe('draft')
    const child = await read('pages', a.map.get('page:3')!)
    expect(child['parent']).toBe(a.map.get('page:4'))

    const codes = (doc: string) => a.report.warnings.filter((w) => w.doc === doc).map((w) => w.code)
    // Final link warnings only: the forward link is gone, the never-migrated one stays once.
    expect(codes('post:1').filter((c) => c === 'LINK_NOT_MIGRATED')).toEqual(['LINK_NOT_MIGRATED'])
    expect(codes('post:1')).toContain('REFERENCE_NOT_MIGRATED')
    const scripts = a.report.findings.filter((f) => f.doc === 'post:1' && f.code === 'SEC_SCRIPT_TAG')
    expect(scripts).toHaveLength(1)
    expect(existsSync(path.join(t.dir, '.wp2payload', 'quarantine', scripts[0]!.quarantine!))).toBe(true)
    const once = a.report.warnings.filter((w) => !w.doc).map((w) => `${w.code} ${w.detail}`)
    expect(once.filter((w) => w.startsWith('DOC_TYPE_UNMAPPED'))).toHaveLength(1)
    expect(once.some((w) => w.includes('"posts" has no field "excerpt"'))).toBe(true)
    expect(once.some((w) => w.includes('"meta.canonical"'))).toBe(true)
    expect(once.some((w) => w.includes('"pages" has no field "categories"'))).toBe(true)
    expect(new Set(once).size).toBe(once.length)

    // One final result per migrated document; deferred ones after pass 2.
    expect(written.map((w) => `${w.type}:${w.wpId}:${w.action}`).sort()).toEqual(['page:3:created', 'page:4:created', 'post:1:created', 'post:2:created'])
    expect(written.find((w) => w.wpId === 1)?.externalLinks).toBe(1)

    const before = (await t.payload.count({ collection: 'posts' })).totalDocs + (await t.payload.count({ collection: 'pages' })).totalDocs
    const b = mkCtx(site)
    await seedRefs(b.ctx)
    await loadDocuments(b.ctx, source(docs), options(docs))
    expect(b.report.summary['documents']).toEqual({ updated: 4, skipped: 2 })
    const after = (await t.payload.count({ collection: 'posts' })).totalDocs + (await t.payload.count({ collection: 'pages' })).totalDocs
    expect(after).toBe(before)
    expect(b.map.get('post:1')).toBe(a.map.get('post:1'))
    expect(b.report.findings.filter((f) => f.code === 'SEC_SCRIPT_TAG')).toHaveLength(1)
  })

  it('dry run writes nothing, counts the same and treats documents of the run as migrated', async () => {
    const site = 'https://dry.test'
    const docs = [doc(1, 'post', 'one', { html: `<p><a href="${ORIGIN}/two/">two</a></p>` }), doc(2, 'page', 'two', { parentWpId: 1 })]
    const { ctx, report } = mkCtx(site, { dryRun: true })
    const res = await loadDocuments(ctx, source(docs), options(docs))
    expect(res).toEqual({ deferred: 0, stopped: false })
    expect(report.summary['documents']).toEqual({ created: 2 })
    expect(report.warnings.filter((w) => w.code === 'LINK_NOT_MIGRATED' || w.code === 'REFERENCE_NOT_MIGRATED')).toEqual([])
    expect(await findByWpMeta(t.payload, 'posts', site, 1)).toBeUndefined()
    expect(await findByWpMeta(t.payload, 'pages', site, 2)).toBeUndefined()
  })

  it('resume skips done documents; shouldStop stops; write failures are reported and the run continues', async () => {
    const site = 'https://fail.test'
    const docs = [doc(1, 'post', 'kept'), doc(2, 'note', 'needs-summary'), doc(3, 'post', 'after')]
    const { ctx, report } = mkCtx(site)
    const written: DocumentWritten[] = []
    await loadDocuments(ctx, source(docs), options(docs, { done: (type, wpId) => type === 'post' && wpId === 1, onDocument: (r) => written.push(r) }))
    expect(report.summary['documents']).toEqual({ skipped: 1, errors: 1, created: 1 })
    expect(report.errors).toMatchObject([{ code: 'DOC_WRITE_FAILED', doc: 'note:2' }])
    expect(written.map((w) => `${w.wpId}:${w.action}`)).toEqual(['1:skipped', '2:errors', '3:created'])
    expect(await findByWpMeta(t.payload, 'posts', site, 1)).toBeUndefined()

    const s = mkCtx(site)
    let n = 0
    const res = await loadDocuments(s.ctx, source(docs), options(docs, { shouldStop: () => n++ >= 1 }))
    expect(res.stopped).toBe(true)
    expect(s.report.summary['documents']).toEqual({ created: 1 })
  })
})
