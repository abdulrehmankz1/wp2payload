import type { Payload } from 'payload'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/index.js'
import { wpMetaField } from '../../src/loaders/wpmeta.js'
import { preflight } from '../../src/payload/preflight.js'

// preflight reads only payload.collections[slug].config, so plain objects stand in for Payload.
type FakeField = Record<string, unknown>
function fakePayload(collections: Record<string, { fields: FakeField[]; upload?: unknown }>): Payload {
  return {
    collections: Object.fromEntries(Object.entries(collections).map(([slug, config]) => [slug, { config: { slug, ...config } }])),
  } as unknown as Payload
}

const config = (collections: Record<string, { to: string }>) =>
  resolveConfig({ source: { type: 'rest', url: 'https://example.test' }, collections })

const title: FakeField = { name: 'title', type: 'text' }

describe('preflight', () => {
  it('passes every mapped collection that has wpMeta, with media as an upload collection', () => {
    const payload = fakePayload({
      posts: { fields: [title, wpMetaField as FakeField] },
      media: { fields: [wpMetaField as FakeField], upload: { staticDir: 'media' } },
    })
    const results = preflight(payload, config({ post: { to: 'posts' }, media: { to: 'media' } }))
    expect(results).toEqual([
      { status: 'ok', title: 'Collection posts (WordPress post)' },
      { status: 'ok', title: 'Collection media (WordPress media)' },
    ])
  })

  it('fails a missing collection with both fixes', () => {
    const [result] = preflight(fakePayload({}), config({ post_tag: { to: 'tags' } }))
    expect(result).toMatchObject({ status: 'fail', title: 'Collection tags (WordPress post_tag) does not exist in Payload' })
    expect(result!.detail).toContain('Add a collection with slug tags or change collections.post_tag.to')
  })

  it('fails a collection without wpMeta and shows the wpMetaField snippet', () => {
    const [result] = preflight(fakePayload({ posts: { fields: [title] } }), config({ post: { to: 'posts' } }))
    expect(result).toMatchObject({ status: 'fail', title: 'Collection posts (WordPress post) has no wpMeta field' })
    expect(result!.detail).toContain("import { wpMetaField } from 'wp2payload'")
  })

  it('fails a wpMeta group missing site or wpId, or with the wrong types', () => {
    const group = (fields: FakeField[]) => ({ name: 'wpMeta', type: 'group', fields })
    const run = (wpMeta: FakeField) => preflight(fakePayload({ posts: { fields: [wpMeta] } }), config({ post: { to: 'posts' } }))[0]
    expect(run(group([{ name: 'site', type: 'text' }]))!.title).toContain('without wpId')
    expect(run(group([]))!.title).toContain('without site and wpId')
    expect(run(group([{ name: 'site', type: 'text' }, { name: 'wpId', type: 'text' }]))!.title).toContain('wpMeta.wpId of type text')
    expect(run({ name: 'wpMeta', type: 'json' })!.title).toContain('not a group')
  })

  it('finds wpMeta inside layout fields (row, collapsible, unnamed tab) but not inside a named tab', () => {
    const inRow = { type: 'row', fields: [wpMetaField] }
    const inTab = { type: 'tabs', tabs: [{ label: 'Meta', fields: [{ type: 'collapsible', fields: [wpMetaField] }] }] }
    const inNamedTab = { type: 'tabs', tabs: [{ name: 'meta', fields: [wpMetaField] }] }
    const statuses = [inRow, inTab, inNamedTab].map(
      (field) => preflight(fakePayload({ posts: { fields: [field] } }), config({ post: { to: 'posts' } }))[0]!.status,
    )
    expect(statuses).toEqual(['ok', 'ok', 'fail'])
  })

  it('fails media mapped to a collection that is not an upload collection', () => {
    const [result] = preflight(fakePayload({ media: { fields: [wpMetaField as FakeField] } }), config({ media: { to: 'media' } }))
    expect(result).toMatchObject({ status: 'fail', title: 'Collection media (WordPress media) is not an upload collection' })
  })
})
