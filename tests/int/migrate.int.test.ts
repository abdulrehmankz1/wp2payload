import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/index.js'
import type { Extractor, IRAuthor, IRDocument, IRTerm } from '../../src/ir/types.js'
import { siteKey } from '../../src/loaders/wpmeta.js'
import { isFirstRun, runPipeline, type PipelineOptions } from '../../src/migrate/run.js'
import { StateStore } from '../../src/state/store.js'
import { startDocumentsPayload, type DocumentsTestPayload } from './documents-harness.js'

// The runner end to end against real Payload: phase order, dry run, idempotent re-runs, resume
// from an interrupted state, --only and the error-rate stop (spec 05 AC-D1..D4).

let t: DocumentsTestPayload
let root: string
beforeAll(async () => {
  t = await startDocumentsPayload()
})
afterAll(async () => {
  await t?.close()
})

async function* each<T>(items: T[]): AsyncIterable<T> {
  for (const x of items) yield x
}

const terms: IRTerm[] = [
  { wpId: 10, taxonomy: 'category', name: 'News', slug: 'news' },
  { wpId: 11, taxonomy: 'post_tag', name: 'Tips', slug: 'tips' },
]
const authors: IRAuthor[] = [
  { wpId: 1, slug: 'ana', displayName: 'Ana' },
  { wpId: 2, slug: 'nobody', displayName: 'No Posts' },
]

function doc(origin: string, wpId: number, type: string, over: Partial<IRDocument> = {}): IRDocument {
  return {
    wpId,
    type,
    status: 'publish',
    slug: `${type}-${wpId}`,
    title: `${type} ${wpId}`,
    html: `<!-- wp:paragraph --><p>Body ${wpId}</p><!-- /wp:paragraph -->`,
    link: `${origin}/${type}-${wpId}/`,
    publishedAt: '2021-04-01T10:00:00.000Z',
    modifiedAt: '2021-04-01T10:00:00.000Z',
    termWpIds: [10, 11],
    authorWpId: 1,
    meta: {},
    ...over,
  }
}

function extractor(origin: string, docs: IRDocument[]): Extractor {
  return {
    name: 'rest',
    probe: async () => ({ siteUrl: origin, counts: {} }),
    media: () => each([]),
    terms: () => each(terms),
    authors: () => each(authors),
    documents: () => each(docs),
  }
}

function setup(origin: string, docs: IRDocument[], collections?: Record<string, { to: string }>) {
  const config = resolveConfig({
    source: { type: 'rest', url: origin },
    collections: collections ?? {
      post: { to: 'posts', fields: { featuredImage: 'heroImage' } },
      page: { to: 'pages' },
      category: { to: 'categories' },
      post_tag: { to: 'tags' },
      author: { to: 'authors' },
      media: { to: 'media' },
    },
  })
  const site = siteKey(origin)
  const run = (over: Partial<PipelineOptions> = {}) =>
    runPipeline({ root, config, payload: t.payload, extractor: extractor(origin, docs), site, dryRun: false, ...over })
  return { config, site, run }
}

const count = async (collection: 'posts' | 'pages' | 'authors', site: string) =>
  (await t.payload.count({ collection, where: { 'wpMeta.site': { equals: site } }, overrideAccess: true })).totalDocs

describe('runPipeline', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-migrate-'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('dry run writes nothing, then a real run writes everything once', async () => {
    const origin = 'https://one.test'
    const docs = [doc(origin, 100, 'post'), doc(origin, 101, 'post'), doc(origin, 200, 'page')]
    const { config, site, run } = setup(origin, docs)

    expect(await isFirstRun(t.payload, config, site)).toBe(true)
    const dry = await run({ dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(dry.summary['documents']).toEqual({ created: 3 })
    expect(await count('posts', site)).toBe(0)
    expect(existsSync(path.join(root, '.wp2payload', 'state.json'))).toBe(false)

    const first = await run()
    expect(first.stopped).toBeUndefined()
    expect(first.summary['documents']).toEqual({ created: 3 })
    // Doc 12.9: only users with content are migrated.
    expect(first.summary['authors']).toEqual({ created: 1, skipped: 1 })
    expect(await count('posts', site)).toBe(2)
    expect(await count('pages', site)).toBe(1)
    expect(await isFirstRun(t.payload, config, site)).toBe(false)
    // The spill (raw source content) never stays behind; .wp2payload ignores itself in git.
    expect(existsSync(path.join(root, '.wp2payload', 'cache', 'documents.jsonl'))).toBe(false)
    expect(await readFile(path.join(root, '.wp2payload', '.gitignore'), 'utf8')).toContain('*')

    const again = await run()
    expect(again.summary['documents']).toEqual({ updated: 3 })
    expect(await count('posts', site)).toBe(2)
  })

  it('a re-run after an interruption processes everything again, without duplicates', async () => {
    const origin = 'https://two.test'
    const docs = [doc(origin, 100, 'post'), doc(origin, 101, 'post'), doc(origin, 102, 'post')]
    const { site, run } = setup(origin, docs)
    let seen = 0
    const first = await run({ interrupted: () => ++seen > 3 })
    expect(first.stopped?.reason).toMatch(/Interrupted/)
    const resumed = await run()
    expect(resumed.stopped).toBeUndefined()
    expect(resumed.summary['documents']).toEqual({ created: 3 })
    expect(await count('posts', site)).toBe(3)
    const fresh = await run({ fresh: true })
    expect(fresh.summary['documents']).toEqual({ updated: 3 })
  })

  it('drops a cached ID map when the database has nothing from the site (wiped or switched)', async () => {
    const origin = 'https://stale.test'
    const { site, run } = setup(origin, [doc(origin, 100, 'post')])
    const state = await StateStore.open(root, site)
    state.set('author', 1, 999_999)
    state.set('category', 10, 999_998)
    await state.flush()
    const report = await run()
    expect(report.errors).toEqual([])
    const post = (await t.payload.find({ collection: 'posts', where: { 'wpMeta.site': { equals: site } }, depth: 0, overrideAccess: true })).docs[0] as Record<string, unknown>
    expect(post['author']).not.toBe(999_999)
    expect(post['categories']).not.toContain(999_998)
  })

  it('skips kinds the config does not map, and ignores post types named like object properties', async () => {
    const origin = 'https://minimal.test'
    const docs = [doc(origin, 100, 'post'), doc(origin, 101, 'constructor'), doc(origin, 102, '__proto__')]
    const { site, run } = setup(origin, docs, { post: { to: 'posts' }, media: { to: 'media' } })
    const report = await run()
    expect(report.errors).toEqual([])
    expect(report.summary['terms']).toBeUndefined()
    expect(report.summary['authors']).toBeUndefined()
    expect(report.summary['documents']).toEqual({ created: 1, skipped: 2 })
    expect(report.warnings.filter((w) => w.code === 'DOC_TYPE_UNMAPPED')).toHaveLength(2)
    expect(await count('posts', site)).toBe(1)

    // Media not mapped either: images are reported as not migrated, never queried.
    const bare = 'https://bare.test'
    const withImages = [doc(bare, 300, 'post', { featuredMediaWpId: 7, seo: { title: 'T', ogImageWpId: 7 }, termWpIds: [] })]
    const minimal = setup(bare, withImages, { post: { to: 'posts', fields: { featuredImage: 'heroImage' } } } as never)
    const r2 = await minimal.run()
    expect(r2.errors).toEqual([])
    expect(r2.summary['media']).toBeUndefined()
    expect(r2.summary['documents']).toEqual({ created: 1 })
  })

  it('--only keeps links to documents outside the selection', async () => {
    const origin = 'https://links.test'
    const docs = [
      doc(origin, 100, 'post'),
      doc(origin, 200, 'page', { html: `<!-- wp:paragraph --><p><a href="${origin}/post-100/">see</a></p><!-- /wp:paragraph -->`, termWpIds: [] }),
    ]
    const { site, run } = setup(origin, docs)
    await run()
    const targeted = await run({ only: ['pages'] })
    expect(targeted.warnings.filter((w) => w.code === 'LINK_NOT_MIGRATED')).toEqual([])
    const page = (await t.payload.find({ collection: 'pages', where: { 'wpMeta.site': { equals: site } }, depth: 0, overrideAccess: true })).docs[0]
    expect(JSON.stringify(page)).toContain('"linkType":"internal"')
  })

  it('writes redirects for every migrated document, and --only redirects rebuilds them in full', async () => {
    const origin = 'https://redir.test'
    const docs = [
      doc(origin, 100, 'post', { link: `${origin}/2021/04/hello/`, slug: 'hello' }),
      doc(origin, 101, 'post', { link: `${origin}/2021/04/world/`, slug: 'world' }),
    ]
    const { run } = setup(origin, docs)
    const file = path.join(root, '.wp2payload', 'redirects.json')
    const first = await run()
    expect(first.redirects).toEqual({ count: 2, conflicts: 0, file: '.wp2payload/redirects.json' })
    const all = JSON.parse(await readFile(file, 'utf8')) as { destination: string }[]
    expect(all.map((r) => r.destination).sort()).toEqual(['/posts/hello', '/posts/world'])

    // No documents are written here, yet the file keeps every redirect.
    const rebuilt = await run({ only: ['redirects'] })
    expect(Object.keys(rebuilt.summary)).toEqual(['redirects'])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(all)
  })

  it('--only limits phases and document types', async () => {
    const origin = 'https://three.test'
    const docs = [doc(origin, 100, 'post'), doc(origin, 200, 'page')]
    const { site, run } = setup(origin, docs)
    const report = await run({ only: ['pages'] })
    expect(Object.keys(report.summary)).toEqual(['documents'])
    expect(await count('pages', site)).toBe(1)
    expect(await count('posts', site)).toBe(0)
  })

  it('stops a phase when more than 10% of it fails, keeping state for a resume', async () => {
    const origin = 'https://four.test'
    // `notes` requires `summary`, which WordPress never provides: every write fails.
    const docs = Array.from({ length: 30 }, (_unused, i) => {
      const { authorWpId: _author, ...note } = doc(origin, 500 + i, 'note', { termWpIds: [] })
      return note
    })
    const { site, run } = setup(origin, docs, { note: { to: 'notes' }, media: { to: 'media' } })
    const report = await run({ only: ['documents'] })
    expect(report.stopped?.phase).toBe('documents')
    expect(report.summary['documents']?.errors).toBe(20)
    const state = await StateStore.open(root, site)
    expect(state.phase('documents').status).toBe('in_progress')
  })
})
