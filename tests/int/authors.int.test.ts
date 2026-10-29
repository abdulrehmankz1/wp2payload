import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IRAuthor } from '../../src/ir/types.js'
import { loadAuthors } from '../../src/loaders/authors.js'
import type { IdKind, LoaderContext } from '../../src/loaders/types.js'
import { MemoryReport } from '../../src/report/types.js'
import { startPayload, type TestPayload } from './harness.js'

let t: TestPayload
beforeAll(async () => {
  t = await startPayload()
})
afterAll(async () => {
  await t?.close()
})

function mkCtx(site: string, dryRun = false) {
  const map = new Map<string, string | number>()
  const report = new MemoryReport()
  const ctx: LoaderContext = {
    payload: t.payload,
    site,
    dryRun,
    ids: { get: (k: IdKind, id) => map.get(`${k}:${id}`), set: (k, id, v) => void map.set(`${k}:${id}`, v) },
    report,
    collections: { media: 'media', category: 'categories', post_tag: 'tags', author: 'authors' },
  }
  return { ctx, report, map }
}
const users: IRAuthor[] = [
  { wpId: 1, slug: 'ann', displayName: 'Ann', email: 'ann@example.com' },
  { wpId: 2, slug: 'bob', displayName: 'Bob' },
  { wpId: 3, slug: 'eve', displayName: 'Eve' },
]
const count = async () => (await t.payload.count({ collection: 'authors' })).totalDocs

describe('loadAuthors', () => {
  it('migrates only included users, reports the rest, never writes email', async () => {
    const a = mkCtx('https://auth.test')
    await loadAuthors(a.ctx, users, { include: new Set([1, 2]) })
    expect(a.report.summary['authors']).toEqual({ created: 2, skipped: 1 })
    expect(a.report.warnings).toHaveLength(1)
    expect(a.report.warnings[0]).toMatchObject({ code: 'AUTHOR_NOT_MIGRATED', doc: 'author:3' })
    expect(JSON.stringify(a.report.warnings)).not.toMatch(/eve/i)
    const ann = await t.payload.findByID({ collection: 'authors', id: a.map.get('author:1') as number })
    expect(ann).toMatchObject({ name: 'Ann', slug: 'ann' })
    expect(JSON.stringify(ann)).not.toContain('ann@example.com')
  })

  it('re-run is idempotent with the same ids', async () => {
    const a = mkCtx('https://auth2.test')
    await loadAuthors(a.ctx, users)
    const n = await count()
    const b = mkCtx('https://auth2.test')
    await loadAuthors(b.ctx, users)
    expect(b.report.summary['authors']).toEqual({ updated: 3 })
    expect(await count()).toBe(n)
    expect(b.map.get('author:2')).toBe(a.map.get('author:2'))
  })

  it('dry run writes nothing', async () => {
    const n = await count()
    const d = mkCtx('https://auth3.test', true)
    await loadAuthors(d.ctx, users)
    expect(d.report.summary['authors']).toEqual({ created: 3 })
    expect(await count()).toBe(n)
  })
})
