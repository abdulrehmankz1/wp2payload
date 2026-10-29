import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IRTerm } from '../../src/ir/types.js'
import { loadTerms } from '../../src/loaders/terms.js'
import type { IdKind, LoaderContext } from '../../src/loaders/types.js'
import { findByWpMeta } from '../../src/loaders/wpmeta.js'
import { MemoryReport } from '../../src/report/types.js'
import { resolve } from '../../src/state/store.js'
import { startPayload, type TestPayload } from './harness.js'

let t: TestPayload
beforeAll(async () => {
  t = await startPayload()
})
afterAll(async () => {
  await t?.close()
})

function mkCtx(site: string, over: Partial<LoaderContext> = {}) {
  const map = new Map<string, string | number>()
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
const cat = (wpId: number, slug: string, parentWpId?: number): IRTerm => ({
  wpId,
  taxonomy: 'category',
  name: slug.toUpperCase(),
  slug,
  ...(parentWpId !== undefined ? { parentWpId } : {}),
})
const count = async (c: 'categories' | 'tags' | 'authors') => (await t.payload.count({ collection: c })).totalDocs
const parentOf = async (id: unknown) =>
  ((await t.payload.findByID({ collection: 'categories', id: id as number, depth: 0 })) as { parent?: unknown }).parent ?? null

describe('loadTerms', () => {
  it('writes parents before children (child listed first) and re-runs idempotently', async () => {
    const site = 'https://hier.test'
    const input: IRTerm[] = [cat(3, 'grandchild', 2), cat(2, 'child', 1), cat(1, 'root'), { wpId: 10, taxonomy: 'post_tag', name: 'T', slug: 't' }]
    const a = mkCtx(site)
    await loadTerms(a.ctx, input)
    expect(a.report.summary['terms']).toEqual({ created: 4 })
    const root = await findByWpMeta(t.payload, 'categories', site, 1)
    const child = await findByWpMeta(t.payload, 'categories', site, 2)
    const grand = await findByWpMeta(t.payload, 'categories', site, 3)
    expect(await parentOf(grand)).toBe(child)
    expect(await parentOf(child)).toBe(root)
    expect(await parentOf(root)).toBeNull()

    const before = await count('categories')
    const b = mkCtx(site)
    await loadTerms(
      b.ctx,
      (async function* () {
        yield* input
      })(),
    )
    expect(b.report.summary['terms']).toEqual({ updated: 4 })
    expect(await count('categories')).toBe(before)
    expect(b.map.get('category:3')).toBe(grand)
  })

  it('missing parent: written as root with a warning', async () => {
    const a = mkCtx('https://miss.test')
    await loadTerms(a.ctx, [cat(5, 'orphan', 999)])
    expect(a.report.warnings.map((w) => w.code)).toContain('TERM_PARENT_MISSING')
    expect(await parentOf(await findByWpMeta(t.payload, 'categories', 'https://miss.test', 5))).toBeNull()
  })

  it('cycle: broken with a warning, all written, no hang', async () => {
    const a = mkCtx('https://cyc.test')
    await loadTerms(a.ctx, [cat(1, 'a', 2), cat(2, 'b', 3), cat(3, 'c', 1), cat(4, 'self', 4)])
    expect(a.report.summary['terms']).toEqual({ created: 4 })
    expect(a.report.warnings.filter((w) => w.code === 'TERM_PARENT_CYCLE')).toHaveLength(2)
  })

  it('skips custom taxonomies with a warning', async () => {
    const a = mkCtx('https://tax.test')
    await loadTerms(a.ctx, [{ wpId: 1, taxonomy: 'genre', name: 'G', slug: 'g' }])
    expect(a.report.summary['terms']).toEqual({ skipped: 1 })
    expect(a.report.warnings[0]?.code).toBe('TERM_TAXONOMY_UNSUPPORTED')
  })

  it('dry run writes nothing but counts created vs updated', async () => {
    const site = 'https://dry.test'
    await loadTerms(mkCtx(site).ctx, [cat(1, 'x')])
    const cats = await count('categories')
    const tags = await count('tags')
    const d = mkCtx(site, { dryRun: true })
    await loadTerms(d.ctx, [cat(1, 'x'), cat(2, 'y', 1), { wpId: 9, taxonomy: 'post_tag', name: 'n', slug: 'n' }])
    expect(d.report.summary['terms']).toEqual({ updated: 1, created: 2 })
    expect(await count('categories')).toBe(cats)
    expect(await count('tags')).toBe(tags)
  })

  it('retries a failing write 3 times, then reports an error and continues', async () => {
    let attempts = 0
    const flaky = new Proxy(t.payload, {
      get(target, prop, recv) {
        if (prop === 'create') {
          return async (args: { data: { slug?: string } }) => {
            if (args.data.slug === 'bad') {
              attempts++
              throw new Error('db down')
            }
            return (target.create as (a: unknown) => Promise<unknown>).call(target, args)
          }
        }
        return Reflect.get(target, prop, recv)
      },
    })
    const a = mkCtx('https://fail.test', { payload: flaky })
    await loadTerms(a.ctx, [cat(1, 'bad'), cat(2, 'good')], { retry: { baseMs: 1 } })
    expect(attempts).toBe(3)
    expect(a.report.summary['terms']).toEqual({ errors: 1, created: 1 })
    expect(a.report.errors[0]?.code).toBe('TERM_WRITE_FAILED')
  })
})

describe('resolve (AC-A2)', () => {
  it('falls back to the database when the cache is empty and fills the cache', async () => {
    const site = 'https://resolve.test'
    const a = mkCtx(site)
    await loadTerms(a.ctx, [cat(1, 'r')])
    const fresh = mkCtx(site) // empty cache = deleted state file
    expect(fresh.ctx.ids.get('category', 1)).toBeUndefined()
    const id = await resolve(fresh.ctx, 'category', 'categories', 1)
    expect(id).toBe(a.map.get('category:1'))
    expect(fresh.ctx.ids.get('category', 1)).toBe(id)
    expect(await resolve(fresh.ctx, 'category', 'categories', 404)).toBeUndefined()
  })
})
