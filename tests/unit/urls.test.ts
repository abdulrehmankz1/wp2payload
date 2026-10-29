import { describe, expect, it } from 'vitest'
import type { IdKind, IdMap } from '../../src/loaders/types.js'
import type { PayloadId } from '../../src/loaders/wpmeta.js'
import { buildUrlResolver, urlKey } from '../../src/transform/urls.js'

function idMap(entries: [IdKind, number, PayloadId][] = []): IdMap {
  const m = new Map(entries.map(([k, w, id]) => [`${k}:${w}`, id]))
  return { get: (k, w) => m.get(`${k}:${w}`), set: (k, w, id) => void m.set(`${k}:${w}`, id) }
}

const UP = 'https://oldsite.test/wp-content/uploads/2021/04'

function setup(ids = idMap([['media', 10, 100], ['media', 11, 'abc'], ['post', 5, 50], ['page', 6, 60]])) {
  return buildUrlResolver({
    siteOrigin: 'https://oldsite.test',
    media: [
      { wpId: 10, sourceUrl: `${UP}/photo-scaled.jpg` },
      { wpId: 11, sourceUrl: `${UP}/caf%C3%A9.png` },
      { wpId: 12, sourceUrl: `${UP}/unmigrated.jpg` },
    ],
    documents: [
      { wpId: 5, type: 'post', link: 'https://oldsite.test/2021/04/hello-world/' },
      { wpId: 6, type: 'page', link: 'https://oldsite.test/about/' },
      { wpId: 7, type: 'product', link: 'https://oldsite.test/shop/x/' },
    ],
    ids,
    docCollections: { post: 'posts', page: 'pages' },
  })
}

describe('urlKey', () => {
  it('ignores scheme, www, host case, trailing slash, query noise and fragment', () => {
    const k = urlKey('https://oldsite.test/a/b/', 'https://oldsite.test/')
    for (const u of ['http://WWW.OldSite.test/a/b', 'https://oldsite.test/a/b?utm_source=x#top', '/a/b/', '//oldsite.test/a/b']) {
      expect(urlKey(u, 'https://oldsite.test/')).toBe(k)
    }
  })

  it('percent-decodes paths and keeps WordPress content query params', () => {
    expect(urlKey('/caf%C3%A9/', 'https://o.test/')).toBe(urlKey('/café', 'https://o.test/'))
    expect(urlKey('/A/B', 'https://o.test/', true)).toBe('o.test/a/b')
    expect(urlKey('/A/B', 'https://o.test/')).toBe('o.test/A/B')
    expect(urlKey('/?p=5&utm=1', 'https://o.test/')).toBe('o.test/?p=5')
    expect(urlKey('/bad%E0%A4%A', 'https://o.test/')).toBe('o.test/bad%E0%A4%A')
  })

  it('rejects non-http schemes and garbage', () => {
    expect(urlKey('mailto:a@b.test', 'https://o.test/')).toBeUndefined()
    expect(urlKey('http://[bad', 'https://o.test/')).toBeUndefined()
  })
})

describe('buildUrlResolver media', () => {
  const r = setup()

  it('resolves the source URL and its scheme/www variants', () => {
    expect(r.media(`${UP}/photo-scaled.jpg`)).toBe(100)
    expect(r.media('http://www.oldsite.test/wp-content/uploads/2021/04/photo-scaled.jpg?ver=2')).toBe(100)
    expect(r.media('/wp-content/uploads/2021/04/photo-scaled.jpg')).toBe(100)
  })

  it('maps WordPress size variants back to the original', () => {
    for (const f of ['photo.jpg', 'photo-300x200.jpg', 'photo-1024x768@2x.jpg', 'photo-e1612345678901.jpg', 'photo-e1612345678901-150x150.jpg', 'photo-rotated.jpg']) {
      expect(r.media(`${UP}/${f}`), f).toBe(100)
    }
    expect(r.media(`${UP}/café-300x300.png`)).toBe('abc')
  })

  it('does not match other files, other months or other hosts', () => {
    expect(r.media(`${UP}/photo-1.jpg`)).toBeUndefined()
    expect(r.media('https://oldsite.test/wp-content/uploads/2021/05/photo.jpg')).toBeUndefined()
    expect(r.media('https://cdn.test/wp-content/uploads/2021/04/photo.jpg')).toBeUndefined()
  })

  it('returns undefined for media not in the IdMap yet, and resolves once it is', () => {
    const ids = idMap()
    const lazy = setup(ids)
    expect(lazy.media(`${UP}/unmigrated.jpg`)).toBeUndefined()
    ids.set('media', 12, 120)
    expect(lazy.media(`${UP}/unmigrated-300x300.jpg`)).toBe(120)
  })

  it('strips one suffix at a time so the nearest original wins', () => {
    const near = buildUrlResolver({
      siteOrigin: 'https://o.test',
      media: [
        { wpId: 1, sourceUrl: 'https://o.test/u/banner.jpg' },
        { wpId: 2, sourceUrl: 'https://o.test/u/banner-1200x400.jpg' },
      ],
      documents: [],
      ids: idMap([['media', 1, 'one'], ['media', 2, 'two']]),
      docCollections: {},
    })
    expect(near.media('https://o.test/u/banner.jpg')).toBe('one')
    expect(near.media('https://o.test/u/banner-1200x400.jpg')).toBe('two')
    expect(near.media('https://o.test/u/banner-300x100.jpg')).toBe('one')
    expect(near.media('https://o.test/u/banner-1200x400-300x100.jpg')).toBe('two')
  })

  it('keeps media paths case-sensitive but NFC-normalised', () => {
    expect(r.media(`${UP}/Photo.jpg`)).toBeUndefined()
    expect(r.media(`${UP}/café.png`)).toBe('abc')
  })

  it('stays fast on a pathological suffix chain', () => {
    const t0 = performance.now()
    expect(r.media(`${UP}/x${'-1x1'.repeat(20_000)}.jpg`)).toBeUndefined()
    expect(performance.now() - t0).toBeLessThan(200)
  })
})

describe('buildUrlResolver documents', () => {
  const r = setup()

  it('resolves permalinks to internal references', () => {
    expect(r.doc('http://www.oldsite.test/2021/04/hello-world')).toEqual({ relationTo: 'posts', value: 50 })
    expect(r.doc('/about#team')).toEqual({ relationTo: 'pages', value: 60 })
  })

  it('resolves plain-permalink forms', () => {
    expect(r.doc('https://oldsite.test/?p=5')).toEqual({ relationTo: 'posts', value: 50 })
    expect(r.doc('/?page_id=6')).toEqual({ relationTo: 'pages', value: 60 })
  })

  it('matches slugs case-insensitively and NFC-normalised', () => {
    expect(r.doc('https://oldsite.test/2021/04/Hello-World/')).toEqual({ relationTo: 'posts', value: 50 })
    const uni = buildUrlResolver({
      siteOrigin: 'https://o.test',
      media: [],
      documents: [{ wpId: 1, type: 'post', link: 'https://o.test/caf%C3%A9/' }],
      ids: idMap([['post', 1, 'p1']]),
      docCollections: { post: 'posts' },
    })
    expect(uni.doc('https://o.test/CAFÉ/')).toEqual({ relationTo: 'posts', value: 'p1' })
  })

  it('resolves index.php forms and paged URLs', () => {
    expect(r.doc('https://oldsite.test/index.php?p=5')).toEqual({ relationTo: 'posts', value: 50 })
    expect(r.doc('/index.php/about/')).toEqual({ relationTo: 'pages', value: 60 })
    expect(r.doc('/about/2/')).toEqual({ relationTo: 'pages', value: 60 })
    expect(r.doc('/2021/04/hello-world/3')).toEqual({ relationTo: 'posts', value: 50 })
    expect(r.doc('/2/')).toBeUndefined()
  })

  it('builds plain-permalink keys under a subdirectory install', () => {
    const sub = buildUrlResolver({
      siteOrigin: 'https://site.test/blog',
      media: [],
      documents: [{ wpId: 7, type: 'post', link: 'https://site.test/blog/hello/' }],
      ids: idMap([['post', 7, 70]]),
      docCollections: { post: 'posts' },
    })
    expect(sub.doc('/blog/?p=7')).toEqual({ relationTo: 'posts', value: 70 })
    expect(sub.doc('https://site.test/blog/index.php?p=7')).toEqual({ relationTo: 'posts', value: 70 })
    expect(sub.doc('hello')).toEqual({ relationTo: 'posts', value: 70 })
  })

  it('returns undefined for unknown, unmapped-collection or unmigrated documents', () => {
    expect(r.doc('/nope/')).toBeUndefined()
    expect(r.doc('/shop/x/')).toBeUndefined()
    expect(setup(idMap()).doc('/about/')).toBeUndefined()
  })

  it('tells old-site URLs from external ones', () => {
    expect(r.isOldSite('/anything')).toBe(true)
    expect(r.isOldSite('http://WWW.oldsite.test/x')).toBe(true)
    expect(r.isOldSite('https://other.test/x')).toBe(false)
    expect(r.isOldSite('https://oldsite.test.evil.test/x')).toBe(false)
    expect(r.isOldSite('mailto:a@oldsite.test')).toBe(false)
  })
})
