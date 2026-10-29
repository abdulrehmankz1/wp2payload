import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findByWpMeta, siteKey, upsertByWpMeta } from '../../src/loaders/wpmeta.js'
import { startPayload, type TestPayload } from './harness.js'

let t: TestPayload
beforeAll(async () => {
  t = await startPayload()
})
afterAll(async () => {
  await t?.close()
})

describe('upsertByWpMeta', () => {
  const site = siteKey('https://OldSite.com/')

  it('creates once, then updates the same document on re-run', async () => {
    const first = await upsertByWpMeta(t.payload, { collection: 'tags', meta: { site, wpId: 7 }, data: { name: 'News', slug: 'news' } })
    const second = await upsertByWpMeta(t.payload, { collection: 'tags', meta: { site, wpId: 7 }, data: { name: 'News!', slug: 'news' } })
    expect(first.action).toBe('created')
    expect(second).toEqual({ id: first.id, action: 'updated' })
    const all = await t.payload.find({ collection: 'tags', where: { 'wpMeta.wpId': { equals: 7 } } })
    expect(all.totalDocs).toBe(1)
    expect(all.docs[0]).toMatchObject({ name: 'News!', wpMeta: { site: 'https://oldsite.com', wpId: 7 } })
  })

  it('keeps the same WordPress ID from two different sites apart', async () => {
    const a = await upsertByWpMeta(t.payload, { collection: 'tags', meta: { site: 'https://a.test', wpId: 1 }, data: { name: 'A' } })
    const b = await upsertByWpMeta(t.payload, { collection: 'tags', meta: { site: 'https://b.test', wpId: 1 }, data: { name: 'B' } })
    expect(a.id).not.toEqual(b.id)
    expect(await findByWpMeta(t.payload, 'tags', 'https://a.test', 1)).toEqual(a.id)
  })
})

describe('siteKey', () => {
  it('normalises case and trailing slashes but keeps a subdirectory install', () => {
    expect(siteKey('HTTPS://Example.com/')).toBe('https://example.com')
    expect(siteKey('https://example.com/blog/')).toBe('https://example.com/blog')
  })
})
