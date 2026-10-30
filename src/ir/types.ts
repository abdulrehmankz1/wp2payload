// Intermediate representation (doc Section 2.3, ADR-0003). Every extractor emits these
// shapes; transformers and loaders only see IR. Owner-decided contract: change only
// through a design note, because custom transformers will depend on it.

export type WpId = number

export interface IRMedia {
  wpId: WpId
  sourceUrl: string
  localPath?: string // set by the sql extractor (file already on disk)
  filename: string
  mimeType: string
  alt?: string
  caption?: string
}

export interface IRTerm {
  wpId: WpId
  taxonomy: 'category' | 'post_tag' | (string & {})
  name: string
  slug: string
  parentWpId?: WpId
  description?: string
}

export interface IRAuthor {
  wpId: WpId
  slug: string
  displayName: string
  email?: string // only used if mapping into an auth collection
}

export interface IRSeo {
  title?: string
  description?: string
  canonical?: string
  noindex?: boolean
  ogImageWpId?: WpId
}

export interface IRDocument {
  wpId: WpId
  type: 'post' | 'page' | (string & {})
  status: 'publish' | 'draft' | 'private' | 'future'
  slug: string
  // Short fields (title, excerpt, SEO) are plain text: decoded, markup removed. They can still
  // contain a literal `<` (a post about HTML), so consumers must escape them.
  title: string
  html: string // raw content, block comments intact
  excerpt?: string
  link: string // original permalink, used for redirects
  publishedAt: string // ISO 8601, UTC
  modifiedAt: string
  authorWpId?: WpId
  featuredMediaWpId?: WpId
  termWpIds: WpId[]
  parentWpId?: WpId // page hierarchy
  seo?: IRSeo
  meta: Record<string, unknown>
}

export interface SourceInfo {
  siteUrl: string
  wpVersion?: string
  counts: Partial<Record<'posts' | 'pages' | 'media' | 'categories' | 'tags' | 'users', number>>
  seoPlugin?: 'yoast' | 'rankmath'
}

export interface Extractor {
  name: 'rest' | 'wxr' | 'sql'
  probe(): Promise<SourceInfo> // site URL, WP version, counts, detected SEO plugin
  media(): AsyncIterable<IRMedia>
  terms(): AsyncIterable<IRTerm>
  authors(): AsyncIterable<IRAuthor>
  documents(): AsyncIterable<IRDocument>
  /** Optional: where non-fatal source problems go (e.g. SEO not readable). The runner sets it per run. */
  setWarningSink?(sink: ((issue: { code: string; detail: string; doc?: string }) => void) | undefined): void
}
