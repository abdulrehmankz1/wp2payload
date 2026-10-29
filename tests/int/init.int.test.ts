import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runInit } from '../../src/commands/init.js'
import { resolveConfig } from '../../src/config/index.js'
import type { IRDocument } from '../../src/ir/types.js'
import { loadDocuments } from '../../src/loaders/documents.js'
import { describeCollection } from '../../src/loaders/fields.js'
import type { DocumentWritten, IdKind, LoaderContext } from '../../src/loaders/types.js'
import { upsertByWpMeta, type PayloadId } from '../../src/loaders/wpmeta.js'
import { MemoryReport } from '../../src/report/types.js'
import { bootPayload, type BootedPayload } from '../../src/payload/boot.js'
import { preflight } from '../../src/payload/preflight.js'

// AC-A3: the files `init --scaffold` writes boot in a real Payload 3.92 project and pass preflight
// with the default config. The project sits in the repo's gitignored .tmp/ so `payload` and the
// Payload packages resolve from the repo's node_modules, like in a user's project.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const repoTmp = path.join(repoRoot, '.tmp')
// __NEXT_PROCESSED_ENV: Next's env loader sets it and then skips every later load.
const ENV_KEYS = ['PAYLOAD_SECRET', 'DATABASE_URI', 'DISABLE_PAYLOAD_HMR', '__NEXT_PROCESSED_ENV'] as const
const posix = (p: string) => p.split(path.sep).join('/')

const PAYLOAD_CONFIG = `import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { wp2payloadCollections } from './collections/wp2payload'

export default buildConfig({
  secret: process.env.PAYLOAD_SECRET || '',
  telemetry: false,
  editor: lexicalEditor(),
  db: sqliteAdapter({ client: { url: process.env.DATABASE_URI || '' }, push: true }),
  collections: [...wp2payloadCollections],
  logger: { options: { level: 'error' } },
})
`

let projectDir: string
let dataDir: string
let booted: BootedPayload | undefined
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

async function removeDir(dir: string | undefined): Promise<void> {
  if (!dir) return
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    // Windows can hold the SQLite file briefly after close.
    if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
  }
}

beforeAll(async () => {
  await mkdir(repoTmp, { recursive: true })
  projectDir = await mkdtemp(path.join(repoTmp, 'init-'))
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-init-'))
  await mkdir(path.join(projectDir, 'src'))
  await writeFile(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'init-project', private: true, type: 'module' }))
  const lines: string[] = []
  expect(await runInit({ cwd: projectDir, scaffold: true, yes: true, log: (l) => lines.push(l) })).toBe(0)
  await writeFile(path.join(projectDir, 'src', 'payload.config.ts'), PAYLOAD_CONFIG)
  // .env files are gitignored, so it is written here, with fake values only.
  await writeFile(path.join(projectDir, '.env'), `PAYLOAD_SECRET=init-secret-not-real\nDATABASE_URI=file:${posix(path.join(dataDir, 'init.db'))}\n`)
  for (const key of ENV_KEYS) delete process.env[key]
  booted = await bootPayload({ cwd: projectDir, configPath: 'src/payload.config.ts' })
})

afterAll(async () => {
  await booted?.close()
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await removeDir(projectDir)
  await removeDir(dataDir)
})

describe('init --scaffold in a real Payload project (AC-A3)', () => {
  it('passes preflight with the default config', () => {
    const results = preflight(booted!.payload, resolveConfig({ source: { type: 'rest', url: 'https://x.test' } }))
    expect(results.filter((r) => r.status !== 'ok')).toEqual([])
    expect(results).toHaveLength(6)
  })

  it('gives posts and pages the fields the documents loader writes into', () => {
    const posts = describeCollection(booted!.payload, 'posts' as never)
    const pages = describeCollection(booted!.payload, 'pages' as never)
    expect(posts.fields.get('heroImage')).toMatchObject({ kind: 'relationship', relationTo: 'media' })
    expect(posts.fields.get('categories')).toMatchObject({ hasMany: true, relationTo: 'categories' })
    expect(posts.fields.get('tags')).toMatchObject({ hasMany: true, relationTo: 'tags' })
    expect(posts.fields.get('excerpt')).toMatchObject({ kind: 'text' })
    expect(pages.fields.get('parent')).toMatchObject({ kind: 'relationship', relationTo: 'pages' })
    for (const shape of [posts, pages]) {
      expect(shape.drafts).toBe(true)
      expect(shape.fields.get('content')?.editor).toEqual({ blocks: { embed: 'embed', wpRawHtml: 'wpRawHtml' }, linkRel: true })
      expect(shape.fields.get('publishedAt')).toMatchObject({ kind: 'date' })
      expect(shape.fields.get('author')).toMatchObject({ kind: 'relationship', relationTo: 'authors', hasMany: false })
      const meta = shape.fields.get('meta')?.fields
      expect([...(meta?.keys() ?? [])]).toEqual(['title', 'description', 'image', 'canonical', 'noindex'])
      expect(meta?.get('canonical')).toMatchObject({ kind: 'text' })
      expect(meta?.get('noindex')).toMatchObject({ kind: 'checkbox' })
      expect(meta?.get('image')).toMatchObject({ kind: 'relationship', relationTo: 'media' })
    }
  })

  it('stores and finds a document by wpMeta', async () => {
    const payload = booted!.payload
    await payload.create({ collection: 'tags' as never, data: { name: 'News', slug: 'news', wpMeta: { site: 'https://x.test', wpId: 7 } } as never })
    const found = await payload.find({ collection: 'tags' as never, where: { 'wpMeta.wpId': { equals: 7 } } })
    expect(found.docs[0]).toMatchObject({ name: 'News' })
  })

  it('type-checks as plain Payload 3 code', async () => {
    // Strict, like a user's project; the generated files use no wp2payload types.
    const tsconfig = path.join(projectDir, 'tsconfig.json')
    const files = path.join(projectDir, 'src', 'collections', 'wp2payload', '*.ts')
    await writeFile(
      tsconfig,
      JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: [posix(files)],
      }),
    )
    const tsc = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
    const run = spawnSync(process.execPath, [tsc, '-p', tsconfig], { cwd: projectDir, encoding: 'utf8' })
    expect(run.status, run.stdout + run.stderr).toBe(0)
  })
})

describe('access on the preset (anonymous visitors)', () => {
  it('reads published posts only; reads taxonomy, authors and media; cannot write', async () => {
    const payload = booted!.payload
    const site = 'https://access.test'
    const meta = (wpId: number) => ({ site, wpId })
    await payload.create({ collection: 'posts' as never, data: { title: 'Live', _status: 'published', wpMeta: meta(1) } as never })
    await payload.create({ collection: 'posts' as never, data: { title: 'Hidden', _status: 'draft', wpMeta: meta(2) } as never, draft: true })
    const where = { 'wpMeta.site': { equals: site } }
    const anonymous = await payload.find({ collection: 'posts' as never, where, overrideAccess: false })
    expect(anonymous.docs.map((d) => (d as { title?: string }).title)).toEqual(['Live'])
    const all = await payload.find({ collection: 'posts' as never, where, overrideAccess: true })
    expect(all.totalDocs).toBe(2)

    for (const collection of ['categories', 'tags', 'authors', 'media']) {
      await expect(payload.find({ collection: collection as never, overrideAccess: false })).resolves.toBeDefined()
    }
    await expect(
      payload.create({ collection: 'tags' as never, data: { name: 'nope' } as never, overrideAccess: false }),
    ).rejects.toThrow(/not allowed/i)
  })
})

describe('documents loader against the preset (spec 06 review)', () => {
  const ORIGIN = 'https://oldsite.test'
  const doc = (wpId: number, type: 'post' | 'page', over: Partial<IRDocument> = {}): IRDocument => ({
    wpId,
    type,
    status: 'publish',
    slug: `${type}-${wpId}`,
    title: `${type} ${wpId}`,
    html: `<p>Hello <a href="https://elsewhere.test/" rel="sponsored">friend</a></p><iframe src="https://www.youtube.com/embed/abc"></iframe><table><tr><td>cell</td></tr></table>`,
    link: `${ORIGIN}/${type}-${wpId}/`,
    publishedAt: '2021-04-01T10:00:00.000Z',
    modifiedAt: '2021-04-02T10:00:00.000Z',
    authorWpId: 7,
    termWpIds: [],
    seo: { title: 'SEO', description: 'Desc', canonical: 'https://syndicated.test/canonical/', noindex: true },
    meta: {},
    ...over,
  })

  it('has every field the loader writes, so a first run reports no FIELD_NOT_IN_TARGET', async () => {
    const payload = booted!.payload
    const site = 'https://oldsite.test'
    const ids = new Map<string, PayloadId>()
    const report = new MemoryReport()
    const ctx: LoaderContext = {
      payload,
      site,
      dryRun: false,
      ids: { get: (k: IdKind, id) => ids.get(`${k}:${id}`), set: (k, id, v) => void ids.set(`${k}:${id}`, v) },
      report,
      collections: { media: 'media' as never, category: 'categories' as never, post_tag: 'tags' as never, author: 'authors' as never },
    }
    const author = await upsertByWpMeta(payload, { collection: 'authors' as never, meta: { site, wpId: 7 }, data: { name: 'Ann', slug: 'ann' } })
    ctx.ids.set('author', 7, author.id)

    // WordPress pages have no excerpt (the page type does not support one), so the REST source sends none.
    const docs = [doc(100, 'post', { excerpt: 'Short' }), doc(200, 'page', { status: 'draft' })]
    const written: DocumentWritten[] = []
    await loadDocuments(ctx, () => (async function* () { yield* docs })(), {
      // The preset mapping from the generated wp2payload.config.ts (BLOG_PRESET).
      targets: {
        post: { collection: 'posts' as never, fields: { content: 'content', excerpt: 'excerpt', featuredImage: 'heroImage' } },
        page: { collection: 'pages' as never, fields: { content: 'content', parent: 'parent' } },
      },
      transform: { siteOrigin: ORIGIN, embedHosts: ['www.youtube.com'], externalLinkRel: 'nofollow noopener', transformers: [], root: dataDir },
      media: [],
      documents: docs.map((d) => ({ wpId: d.wpId, type: d.type, link: d.link })),
      mediaCollection: 'media' as never,
      retry: { attempts: 1 },
      onDocument: (r) => written.push(r),
    })

    expect(report.errors).toEqual([])
    expect(report.warnings.filter((w) => w.code === 'FIELD_NOT_IN_TARGET')).toEqual([])
    expect(written).toHaveLength(2)

    for (const [collection, wpId, status] of [['posts', 100, 'published'], ['pages', 200, 'draft']] as const) {
      const found = await payload.find({ collection: collection as never, where: { 'wpMeta.wpId': { equals: wpId } }, draft: true, depth: 0 })
      const stored = found.docs[0] as Record<string, unknown>
      expect(stored).toMatchObject({
        _status: status,
        author: author.id,
        publishedAt: '2021-04-01T10:00:00.000Z',
        meta: { title: 'SEO', description: 'Desc', canonical: 'https://syndicated.test/canonical/', noindex: true },
      })
      const blocks = JSON.stringify(stored['content'])
      expect(blocks).toContain('"blockType":"embed"')
      expect(blocks).toContain('"blockType":"wpRawHtml"')
      expect(blocks).toContain('"rel":"nofollow noopener"')
    }
  })
})
