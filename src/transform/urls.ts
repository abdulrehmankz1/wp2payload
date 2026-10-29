import type { WpId } from '../ir/types.js'
import type { IdKind, IdMap } from '../loaders/types.js'
import type { UrlResolver } from './types.js'

export interface SiteUrlResolver extends UrlResolver {
  /** Relative, or on the source site's host (www and scheme ignored). */
  isOldSite(url: string): boolean
}

export interface UrlResolverInput {
  siteOrigin: string
  media: Iterable<{ wpId: WpId; sourceUrl: string }>
  documents: Iterable<{ wpId: WpId; type: IdKind; link: string }>
  ids: IdMap
  /** IR document type → Payload collection slug, e.g. `{ post: 'posts', page: 'pages' }`. */
  docCollections: Record<string, string>
}

// Query parameters WordPress uses to address content without pretty permalinks; others are noise.
const WP_QUERY = ['p', 'page_id', 'attachment_id', 'cat', 'tag', 'post_type', 'name', 'pagename']

// One WordPress derived-file suffix: size (-300x200), retina (@2x), big-image (-scaled),
// rotation (-rotated) or image-editor (-e1234567890123).
const VARIANT = /(?:-\d{1,5}x\d{1,5}|@[1-9]x|-scaled|-rotated|-e\d{10,13})$/i
// A source URL itself can be the big-image or rotated copy; its original name maps to it too.
const SOURCE_VARIANT = /-(?:scaled|rotated)$/i
const MAX_STRIPS = 8

/**
 * Old URL → migrated reference (doc 2.3 step 3). IDs are looked up when a URL is resolved, not
 * when the resolver is built, so documents loaded later in the same run still resolve.
 */
export function buildUrlResolver(input: UrlResolverInput): SiteUrlResolver {
  const base = input.siteOrigin.endsWith('/') ? input.siteOrigin : `${input.siteOrigin}/`
  const siteHost = hostKey(new URL(base))

  const media = new Map<string, WpId>()
  const derived: [string, WpId][] = []
  for (const m of input.media) {
    const key = urlKey(m.sourceUrl, base)
    if (key === undefined) continue
    media.set(key, m.wpId)
    const original = withStem(key, (stem) => stem.replace(SOURCE_VARIANT, ''))
    if (original !== key) derived.push([original, m.wpId])
  }
  // Exact source URLs always win over a derived original name.
  for (const [key, wpId] of derived) if (!media.has(key)) media.set(key, wpId)

  const docs = new Map<string, { wpId: WpId; type: IdKind }>()
  for (const d of input.documents) {
    const entry = { wpId: d.wpId, type: d.type }
    const key = urlKey(d.link, base, true)
    if (key !== undefined) docs.set(key, entry)
    // Plain-permalink forms reach the same document whatever the permalink setting was.
    for (const param of d.type === 'page' ? ['page_id', 'p'] : ['p']) {
      const plain = urlKey(`?${param}=${d.wpId}`, base, true)
      if (plain !== undefined && !docs.has(plain)) docs.set(plain, entry)
    }
  }

  const findDoc = (url: string) => {
    const key = urlKey(url, base, true)
    if (key === undefined) return undefined
    const exact = docs.get(key)
    if (exact) return exact
    // Paged post or page (/slug/2/): the trailing page number addresses the same document.
    const paged = /^(.*[^/])\/\d{1,6}$/.exec(key)
    return paged && paged[1] !== siteHost ? docs.get(paged[1]!) : undefined
  }

  return {
    media(url) {
      let key = urlKey(url, base)
      // Strip one suffix at a time, so the nearest original wins (banner-1200x400-300x100 → banner-1200x400).
      for (let i = 0; key !== undefined && i <= MAX_STRIPS; i++) {
        const wpId = media.get(key)
        if (wpId !== undefined) return input.ids.get('media', wpId)
        const next = withStem(key, (stem) => stem.replace(VARIANT, ''))
        key = next === key ? undefined : next
      }
      return undefined
    },
    doc(url) {
      const entry = findDoc(url)
      if (!entry) return undefined
      const relationTo = input.docCollections[entry.type]
      const value = input.ids.get(entry.type, entry.wpId)
      return relationTo === undefined || value === undefined ? undefined : { relationTo, value }
    },
    isOldSite(url) {
      const u = parse(url, base)
      return u !== undefined && hostKey(u) === siteHost
    },
  }
}

function parse(url: string, base: string): URL | undefined {
  try {
    const u = new URL(url.trim(), base)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : undefined
  } catch {
    return undefined
  }
}

const hostKey = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '') + (u.port ? `:${u.port}` : '')

/**
 * Comparison key, `undefined` if not http(s). Ignores scheme, www, host case, trailing slashes,
 * `/index.php`, fragment and non-WordPress query params; the path is percent-decoded and NFC
 * normalised. `fold` also lower-cases the path: WordPress slugs are case-insensitive, file
 * paths (media) are not.
 */
export function urlKey(url: string, base: string, fold = false): string | undefined {
  const u = parse(url, base)
  if (!u) return undefined
  let path = u.pathname
  try {
    path = decodeURIComponent(path)
  } catch {
    // Malformed escapes: compare the raw path.
  }
  path = path.normalize('NFC').replace(/\/index\.php(?=\/|$)/i, '')
  let end = path.length
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--
  path = path.slice(0, end) || '/'
  if (fold) path = path.toLowerCase()
  const query = WP_QUERY.flatMap((k) => {
    const v = u.searchParams.get(k)
    return v === null ? [] : [`${k}=${fold ? v.toLowerCase() : v}`]
  })
  return `${hostKey(u)}${path}${query.length > 0 ? `?${query.join('&')}` : ''}`
}

/** Applies `fn` to the file stem (name without extension) of a key's path. */
function withStem(key: string, fn: (stem: string) => string): string {
  const q = key.indexOf('?')
  const path = q === -1 ? key : key.slice(0, q)
  const dot = path.lastIndexOf('.')
  if (dot <= path.lastIndexOf('/')) return key
  return fn(path.slice(0, dot)) + path.slice(dot) + (q === -1 ? '' : key.slice(q))
}
