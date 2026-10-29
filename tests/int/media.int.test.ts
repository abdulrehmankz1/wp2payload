import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { IRMedia } from '../../src/ir/types.js'
import { loadMedia } from '../../src/loaders/media.js'
import type { IdKind, LoaderContext } from '../../src/loaders/types.js'
import { MemoryReport } from '../../src/report/types.js'
import { MediaError, SecurityError } from '../../src/security/index.js'
import { startPayload, type TestPayload } from './harness.js'

const FIXTURES = path.resolve('tests/fixtures/hacked-media')
const SITE = 'https://oldsite.test'

let t: TestPayload
let root: string
beforeAll(async () => {
  t = await startPayload()
})
afterAll(async () => {
  await t?.close()
})
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-media-root-'))
  for (const doc of (await t.payload.find({ collection: 'media', limit: 1000 })).docs) {
    await t.payload.delete({ collection: 'media', id: doc.id })
  }
  return () => rm(root, { recursive: true, force: true })
})

const item = (wpId: number, file: string, over: Partial<IRMedia> = {}): IRMedia => ({
  wpId,
  sourceUrl: `${SITE}/wp-content/uploads/2021/04/${file}`,
  filename: file,
  mimeType: 'image/jpeg',
  ...over,
})

function setup(over: Partial<LoaderContext> = {}) {
  const map = new Map<string, string | number>()
  const report = new MemoryReport()
  const downloads: string[] = []
  const ctx: LoaderContext = {
    payload: t.payload,
    site: SITE,
    dryRun: false,
    ids: { get: (k: IdKind, id) => map.get(`${k}:${id}`), set: (k, id, v) => void map.set(`${k}:${id}`, v) },
    report,
    collections: { media: 'media', category: 'categories', post_tag: 'tags', author: 'authors' },
    ...over,
  }
  const opts = {
    root,
    sourceUrl: SITE,
    retry: { baseMs: 1 },
    download: async (url: string) => {
      downloads.push(url)
      const name = decodeURIComponent(url.split('/').pop() ?? '')
      if (name === 'missing.jpg') throw new MediaError('MEDIA_404', `404 for ${url}`, 404)
      if (name === 'internal.jpg') throw new SecurityError('SEC_SSRF_BLOCKED', 'blocked private address')
      return { bytes: await readFile(path.join(FIXTURES, name)), finalUrl: url, redirects: 0, sourceHostException: false }
    },
  }
  return { ctx, report, opts, downloads, map }
}

const mediaDocs = async () => (await t.payload.find({ collection: 'media', limit: 100, depth: 0 })).docs as Record<string, any>[]

describe('loadMedia', () => {
  it('stores clean files under regenerated names with the original-bytes hash', async () => {
    const { ctx, report, opts } = setup()
    await loadMedia(ctx, [item(1, 'ok.jpg', { alt: 'A photo' }), item(2, 'ok.png', { mimeType: 'image/png' })], opts)
    expect(report.summary.media).toEqual({ created: 2 })
    const docs = await mediaDocs()
    expect(docs).toHaveLength(2)
    const jpg = docs.find((d) => d.wpMeta.wpId === 1)!
    expect(jpg.alt).toBe('A photo')
    expect(jpg.filename).toMatch(/^ok-[0-9a-f]{8}\.jpg$/)
    expect(jpg.wpMeta).toMatchObject({ site: SITE, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), link: `${SITE}/wp-content/uploads/2021/04/ok.jpg` })
  })

  it('rejects an executable upload, quarantines it and creates nothing', async () => {
    const { ctx, report, opts } = setup()
    await loadMedia(ctx, [item(3, 'logo.jpg.php')], opts)
    expect(await mediaDocs()).toHaveLength(0)
    expect(report.summary.media).toEqual({ rejected: 1 })
    const f = report.findings[0]!
    expect(f).toMatchObject({ severity: 'high', action: 'rejected', media: 3 })
    expect(f.quarantine).toBeTruthy()
    expect(existsSync(path.join(root, '.wp2payload', 'quarantine', f.quarantine!))).toBe(true)
  })

  it('stores a PHP-in-JPEG polyglot only after re-encoding strips the payload', async () => {
    const { ctx, opts } = setup()
    await loadMedia(ctx, [item(4, 'polyglot.jpg')], opts)
    const [doc] = await mediaDocs()
    const stored = await readFile(path.join(t.dir, 'media', doc!.filename))
    expect(stored.includes(Buffer.from('<?php'))).toBe(false)
  })

  it('reuses a file whose original bytes were already migrated', async () => {
    const { ctx, report, opts, map } = setup()
    await loadMedia(ctx, [item(5, 'ok.gif', { mimeType: 'image/gif' }), item(6, 'ok.gif', { mimeType: 'image/gif' })], { ...opts, concurrency: 1 })
    expect(report.summary.media).toEqual({ created: 1, reused: 1 })
    expect(await mediaDocs()).toHaveLength(1)
    expect(map.get('media:6')).toEqual(map.get('media:5'))
  })

  it('re-runs without downloading again and without duplicates', async () => {
    const first = setup()
    await loadMedia(first.ctx, [item(7, 'ok.webp', { mimeType: 'image/webp' })], first.opts)
    const second = setup() // fresh id cache: state file lost, database still knows
    await loadMedia(second.ctx, [item(7, 'ok.webp', { mimeType: 'image/webp', alt: 'New alt' })], second.opts)
    expect(second.downloads).toEqual([])
    expect(second.report.summary.media).toEqual({ updated: 1 })
    const docs = await mediaDocs()
    expect(docs).toHaveLength(1)
    expect(docs[0]!.alt).toBe('New alt')
  })

  it('dry run downloads and inspects but writes no documents and no quarantine', async () => {
    const { ctx, report, opts } = setup({ dryRun: true })
    await loadMedia(ctx, [item(8, 'ok.jpg'), item(9, 'shell.phtml')], opts)
    expect(await mediaDocs()).toHaveLength(0)
    expect(report.summary.media).toEqual({ created: 1, rejected: 1 })
    expect(report.findings[0]!.quarantine).toBeUndefined()
    expect(existsSync(path.join(root, '.wp2payload'))).toBe(false)
  })

  it('reports download failures and SSRF blocks, then keeps going', async () => {
    const { ctx, report, opts } = setup()
    await loadMedia(ctx, [item(10, 'missing.jpg'), item(11, 'internal.jpg'), item(12, 'ok.jpg')], opts)
    expect(report.summary.media).toEqual({ errors: 1, rejected: 1, created: 1 })
    expect(report.errors[0]).toMatchObject({ code: 'MEDIA_404', media: 10 })
    expect(report.findings[0]).toMatchObject({ code: 'SEC_SSRF_BLOCKED', media: 11, action: 'rejected' })
  })

  // Review F1: the state cache survives a wiped database; the database must win.
  it('recreates media when the cached ID points at a document that no longer exists', async () => {
    const { ctx, report, opts, map } = setup()
    map.set('media:14', 999_999)
    await loadMedia(ctx, [item(14, 'ok.jpg')], opts)
    expect(report.summary.media).toEqual({ created: 1 })
    expect(report.errors).toEqual([])
    expect(map.get('media:14')).not.toBe(999_999)
  })

  // Review F2: a reused item must not rewrite the shared document's alt text on later runs.
  it('keeps a reused file as reused on re-run without overwriting the owner alt text', async () => {
    const first = setup()
    const items = () => [item(15, 'ok.png', { mimeType: 'image/png', alt: 'Owner alt' }), item(16, 'ok.png', { mimeType: 'image/png', alt: 'Copy alt' })]
    await loadMedia(first.ctx, items(), { ...first.opts, concurrency: 1 })
    const second = setup()
    for (const [k, v] of first.map) second.map.set(k, v) // same state file
    await loadMedia(second.ctx, items(), { ...second.opts, concurrency: 1 })
    expect(second.report.summary.media).toEqual({ updated: 1, reused: 1 })
    expect(second.downloads).toEqual([])
    const docs = await mediaDocs()
    expect(docs).toHaveLength(1)
    expect(docs[0]!.alt).toBe('Owner alt')
  })

  // Review F3: two items with identical bytes processed concurrently create one document.
  it('does not upload the same bytes twice when duplicates run concurrently', async () => {
    const { ctx, report, opts } = setup()
    await loadMedia(ctx, [item(17, 'ok.jpg'), item(18, 'ok.jpg'), item(19, 'ok.jpg')], { ...opts, concurrency: 4 })
    expect(await mediaDocs()).toHaveLength(1)
    expect(report.summary.media).toEqual({ created: 1, reused: 2 })
  })

  it('never stores EXIF GPS data', async () => {
    const { ctx, opts } = setup()
    await loadMedia(ctx, [item(13, 'exif-gps.jpg')], opts)
    const [doc] = await mediaDocs()
    const sharp = (await import('sharp')).default
    const meta = await sharp(await readFile(path.join(t.dir, 'media', doc!.filename))).metadata()
    expect(meta.exif).toBeUndefined()
    expect((await readdir(path.join(t.dir, 'media'))).length).toBeGreaterThan(0)
  })
})
