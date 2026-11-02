import path from 'node:path'
import type { Extractor, IRAuthor, IRDocument, IRMedia, IRSeo, IRTerm, SourceInfo } from '../../ir/types.js'
import type { Issue } from '../../report/types.js'
import { normaliseSlug, toPlainText } from '../rest/decode.js'
import { NOT_CONTENT_TYPES, filenameOf, mapStatus, pageBuilder, type SeoPluginOption } from '../rest/index.js'
import { ReusableRun } from '../rest/reusable.js'
import { readWxr, text, WxrError, type XmlNode } from './xml.js'

export { WxrError } from './xml.js'

// WordPress export file (Tools → Export) as a source (doc F11). Emits the same IR as the REST
// source: short fields as plain text, slugs decoded, block markup kept for the transform.

export interface WxrExtractorOptions {
  file: string
  statuses?: string[]
  /** Config `seo.plugin` (doc 4.5). Default 'auto'. */
  seoPlugin?: SeoPluginOption
  maxBytes?: number
  onWarning?: (issue: Issue) => void
}

/** What one pass over the file learns before documents are read. */
interface WxrIndex {
  siteUrl: string
  siteName: string
  authors: Map<string, number>
  /** `${taxonomy}\0${nicename as written}` → term id. */
  terms: Map<string, number>
  blocks: Map<number, { status: string; html: string }>
  counts: Required<Pick<SourceInfo['counts'], 'posts' | 'pages' | 'media' | 'categories' | 'tags' | 'users'>>
  other: Map<string, number>
  seo: { yoast: boolean; rankmath: boolean }
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', m4v: 'video/mp4', mp3: 'audio/mpeg',
}
// Editor and site internals that exports include but nobody would call content.
const INTERNAL_TYPES = new Set(['revision', 'custom_css', 'customize_changeset', 'oembed_cache', 'user_request'])
const SEO_KEYS = {
  yoast: { title: '_yoast_wpseo_title', description: '_yoast_wpseo_metadesc', canonical: '_yoast_wpseo_canonical', image: '_yoast_wpseo_opengraph-image-id' },
  rankmath: { title: 'rank_math_title', description: 'rank_math_description', canonical: 'rank_math_canonical_url', image: 'rank_math_facebook_image_id' },
} as const
const UNRESOLVED_SAMPLE = 5

export class WxrExtractor implements Extractor {
  readonly name = 'wxr' as const
  readonly #file: string
  readonly #statuses: Set<string>
  readonly #seoPlugin: SeoPluginOption
  readonly #maxBytes: number | undefined
  #onWarning: ((issue: Issue) => void) | undefined
  #index: Promise<WxrIndex> | undefined

  constructor(o: WxrExtractorOptions) {
    this.#file = path.resolve(o.file)
    this.#statuses = new Set(o.statuses ?? ['publish'])
    this.#seoPlugin = o.seoPlugin ?? 'auto'
    this.#maxBytes = o.maxBytes
    this.#onWarning = o.onWarning
  }

  setWarningSink(sink: ((issue: Issue) => void) | undefined): void {
    this.#onWarning = sink
  }

  async probe(): Promise<SourceInfo> {
    const ix = await this.#indexOnce()
    const info: SourceInfo = { siteUrl: ix.siteUrl, counts: { ...ix.counts } }
    if (ix.seo.yoast) info.seoPlugin = 'yoast'
    else if (ix.seo.rankmath) info.seoPlugin = 'rankmath'
    const other = [...ix.other].map(([type, count]) => ({ type, count }))
    if (other.length) info.unmigratedTypes = other
    return info
  }

  async *media(): AsyncIterable<IRMedia> {
    for await (const item of this.#items()) {
      if (text(item, 'wp:post_type') !== 'attachment') continue
      const sourceUrl = (text(item, 'wp:attachment_url') ?? '').trim()
      const wpId = id(text(item, 'wp:post_id'))
      if (!sourceUrl || wpId === undefined) continue
      const filename = filenameOf(sourceUrl)
      const out: IRMedia = { wpId, sourceUrl, filename, mimeType: MIME[path.extname(filename).slice(1).toLowerCase()] ?? 'application/octet-stream' }
      const link = text(item, 'link')?.trim()
      if (link) out.link = link
      const alt = postmeta(item).get('_wp_attachment_image_alt')
      if (alt) out.alt = toPlainText(alt)
      const caption = text(item, 'excerpt:encoded')
      if (caption) out.caption = toPlainText(caption)
      yield out
    }
  }

  async *terms(): AsyncIterable<IRTerm> {
    const categories: { node: XmlNode; parent: string }[] = []
    const slugs = new Map<string, number>()
    for await (const r of readWxr(this.#file, this.#readOpts())) {
      if (r.name === 'wp:category') {
        const wpId = id(text(r.node, 'wp:term_id'))
        const nicename = text(r.node, 'wp:category_nicename') ?? ''
        if (wpId === undefined) continue
        slugs.set(nicename, wpId)
        categories.push({ node: r.node, parent: text(r.node, 'wp:category_parent') ?? '' })
      } else if (r.name === 'wp:tag') {
        const term = mapTerm(r.node, 'post_tag', 'wp:tag_slug', 'wp:tag_name', 'wp:tag_description')
        if (term) yield term
      } else if (r.name === 'item') {
        break
      }
    }
    // Parents are named by slug and may come after their children.
    for (const { node, parent } of categories) {
      const term = mapTerm(node, 'category', 'wp:category_nicename', 'wp:cat_name', 'wp:category_description')
      if (!term) continue
      const parentWpId = parent ? slugs.get(parent) : undefined
      if (parentWpId !== undefined && parentWpId !== term.wpId) term.parentWpId = parentWpId
      yield term
    }
  }

  async *authors(): AsyncIterable<IRAuthor> {
    for await (const r of readWxr(this.#file, this.#readOpts())) {
      if (r.name === 'item') break
      if (r.name !== 'wp:author') continue
      const wpId = id(text(r.node, 'wp:author_id'))
      const login = text(r.node, 'wp:author_login')
      if (wpId === undefined || !login) continue
      // Doc 12.9: the email is in the file but never read.
      yield { wpId, slug: normaliseSlug(login.toLowerCase()), displayName: toPlainText(text(r.node, 'wp:author_display_name') || login) }
    }
  }

  async *documents(): AsyncIterable<IRDocument> {
    const ix = await this.#indexOnce()
    for (const [type, count] of ix.other) {
      this.#onWarning?.({
        code: 'DOC_TYPE_UNMAPPED',
        detail: `Post type "${type}" (${count} item${count === 1 ? '' : 's'}) was not migrated: the WXR source migrates posts and pages`,
      })
    }
    const plugin = this.#seoPlugin === 'auto' ? (ix.seo.yoast ? 'yoast' : ix.seo.rankmath ? 'rankmath' : 'none') : this.#seoPlugin
    const reusable = new ReusableRun(async (ref) => {
      const block = ix.blocks.get(ref)
      if (!block) return { reason: 'not found (deleted, or not a reusable block)' }
      if (block.status !== 'publish') return { reason: `not published (${block.status.slice(0, 20)})` }
      return { html: block.html }
    })
    const unresolved: string[] = []
    try {
      for await (const item of this.#items()) {
        const type = text(item, 'wp:post_type')
        if (type !== 'post' && type !== 'page') continue
        const raw = text(item, 'wp:status') ?? ''
        if (!this.#statuses.has(raw)) continue
        const doc = mapDocument(item, type, raw, ix)
        if (!doc) continue
        doc.html = await reusable.inline(doc)
        if (plugin !== 'none') {
          const seo = mapSeo(postmeta(item), SEO_KEYS[plugin], { title: doc.title, sitename: ix.siteName, excerpt: doc.excerpt ?? '' })
          if (seo.unresolved && unresolved.length < UNRESOLVED_SAMPLE + 1) unresolved.push(`${doc.type}:${doc.wpId}`)
          if (seo.value) doc.seo = seo.value
        }
        yield doc
      }
    } finally {
      const missing = reusable.warning()
      if (missing) this.#onWarning?.(missing)
      if (unresolved.length) {
        const sample = unresolved.slice(0, UNRESOLVED_SAMPLE).join(', ') + (unresolved.length > UNRESOLVED_SAMPLE ? ', ...' : '')
        this.#onWarning?.({
          code: 'SEO_TEMPLATE_UNRESOLVED',
          detail: `SEO titles or descriptions with template variables wp2payload cannot fill were left out (${sample}); set them in Payload, or migrate from the live site, where WordPress fills them in.`,
        })
      }
    }
  }

  #readOpts() {
    return this.#maxBytes !== undefined ? { maxBytes: this.#maxBytes } : {}
  }

  async *#items(): AsyncIterable<XmlNode> {
    for await (const r of readWxr(this.#file, this.#readOpts())) if (r.name === 'item') yield r.node
  }

  #indexOnce(): Promise<WxrIndex> {
    this.#index ??= this.#buildIndex()
    return this.#index
  }

  async #buildIndex(): Promise<WxrIndex> {
    const ix: WxrIndex = {
      siteUrl: '', siteName: '', authors: new Map(), terms: new Map(), blocks: new Map(),
      counts: { posts: 0, pages: 0, media: 0, categories: 0, tags: 0, users: 0 }, other: new Map(), seo: { yoast: false, rankmath: false },
    }
    let base = ''
    let blog = ''
    let link = ''
    let version = false
    for await (const r of readWxr(this.#file, this.#readOpts())) {
      const n = r.node
      switch (r.name) {
        case 'wp:wxr_version': version = true; break
        case 'wp:base_site_url': base = n.text.trim(); break
        case 'wp:base_blog_url': blog = n.text.trim(); break
        case 'link': link = n.text.trim(); break
        case 'title': ix.siteName = toPlainText(n.text); break
        case 'wp:author': {
          const wpId = id(text(n, 'wp:author_id'))
          const login = text(n, 'wp:author_login')
          if (wpId !== undefined && login) ix.authors.set(login, wpId)
          ix.counts.users++
          break
        }
        case 'wp:category':
        case 'wp:tag': {
          const tax = r.name === 'wp:category' ? 'category' : 'post_tag'
          const wpId = id(text(n, 'wp:term_id'))
          const nicename = text(n, tax === 'category' ? 'wp:category_nicename' : 'wp:tag_slug')
          if (wpId !== undefined && nicename !== undefined) ix.terms.set(`${tax}\0${nicename}`, wpId)
          ix.counts[tax === 'category' ? 'categories' : 'tags']++
          break
        }
        case 'item': {
          const type = text(n, 'wp:post_type') ?? ''
          const status = text(n, 'wp:status') ?? ''
          if (type === 'attachment') ix.counts.media++
          else if (type === 'post' || type === 'page') {
            if (this.#statuses.has(status)) ix.counts[type === 'post' ? 'posts' : 'pages']++
            for (const key of postmeta(n).keys()) {
              if (key.startsWith('_yoast_wpseo_')) ix.seo.yoast = true
              else if (key.startsWith('rank_math_')) ix.seo.rankmath = true
            }
          } else if (type === 'wp_block') {
            const wpId = id(text(n, 'wp:post_id'))
            if (wpId !== undefined) ix.blocks.set(wpId, { status, html: text(n, 'content:encoded') ?? '' })
          } else if (type && !NOT_CONTENT_TYPES.has(type) && !INTERNAL_TYPES.has(type) && !type.startsWith('wp_') && status !== 'trash' && status !== 'auto-draft') {
            const name = toPlainText(type).slice(0, 64)
            ix.other.set(name, (ix.other.get(name) ?? 0) + 1)
          }
          break
        }
      }
    }
    if (!version && !base) throw new WxrError('WXR_INVALID', 'Not a WordPress export: no wp:wxr_version or wp:base_site_url.')
    ix.siteUrl = blog || link || base
    if (!/^https?:\/\//i.test(ix.siteUrl)) throw new WxrError('WXR_INVALID', 'The export has no http(s) site address (wp:base_blog_url).')
    return ix
  }
}

const id = (v: string | undefined): number | undefined => {
  const n = v !== undefined && /^\s*\d{1,15}\s*$/.test(v) ? Number(v) : undefined
  return n !== undefined && n > 0 ? n : undefined
}

/** Post meta as written; the first value wins, as get_post_meta(..., true) does. */
function postmeta(item: XmlNode): Map<string, string> {
  const out = new Map<string, string>()
  for (const k of item.kids) {
    if (k.name !== 'wp:postmeta') continue
    const key = text(k, 'wp:meta_key')
    if (key !== undefined && !out.has(key)) out.set(key, text(k, 'wp:meta_value') ?? '')
  }
  return out
}

function mapTerm(n: XmlNode, taxonomy: string, slugTag: string, nameTag: string, descTag: string): IRTerm | undefined {
  const wpId = id(text(n, 'wp:term_id'))
  if (wpId === undefined) return undefined
  const term: IRTerm = { wpId, taxonomy, name: toPlainText(text(n, nameTag) ?? ''), slug: normaliseSlug(text(n, slugTag) ?? '') }
  const desc = text(n, descTag)
  if (desc) term.description = toPlainText(desc)
  return term
}

/** `2026-10-01 10:00:00` (GMT) to ISO; drafts carry zeros there, so the local date is used then. */
function isoDate(gmt: string | undefined, local: string | undefined): string {
  for (const v of [gmt, local]) {
    const m = v?.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/)
    if (m && !m[1]!.startsWith('0000')) {
      const d = new Date(`${m[1]}T${m[2]}Z`)
      if (!Number.isNaN(d.getTime())) return d.toISOString()
    }
  }
  return new Date(0).toISOString()
}

function mapDocument(item: XmlNode, type: 'post' | 'page', rawStatus: string, ix: WxrIndex): IRDocument | undefined {
  const wpId = id(text(item, 'wp:post_id'))
  if (wpId === undefined) return undefined
  const html = text(item, 'content:encoded') ?? ''
  const meta = postmeta(item)
  const { status, original } = mapStatus(rawStatus)
  const info: Record<string, unknown> = { contentFormat: 'raw' }
  if (original) info.wpStatus = original
  const builder = meta.get('_elementor_edit_mode') === 'builder' ? 'Elementor' : pageBuilder(html, '')
  if (builder) info.pageBuilder = builder
  if (text(item, 'wp:is_sticky')?.trim() === '1') info.sticky = true
  const order = Number(text(item, 'wp:menu_order'))
  if (Number.isSafeInteger(order) && order !== 0) info.menu_order = order
  const comments = text(item, 'wp:comment_status')
  if (comments) info.comment_status = comments

  const publishedAt = isoDate(text(item, 'wp:post_date_gmt'), text(item, 'wp:post_date'))
  const termWpIds: number[] = []
  for (const k of item.kids) {
    if (k.name !== 'category') continue
    const tax = k.attrs['domain']
    const termId = tax === 'category' || tax === 'post_tag' ? ix.terms.get(`${tax}\0${k.attrs['nicename'] ?? ''}`) : undefined
    if (termId !== undefined && !termWpIds.includes(termId)) termWpIds.push(termId)
  }
  const doc: IRDocument = {
    wpId,
    type,
    status,
    slug: normaliseSlug(text(item, 'wp:post_name') ?? ''),
    title: toPlainText(text(item, 'title') ?? ''),
    html,
    link: text(item, 'link')?.trim() ?? '',
    publishedAt,
    modifiedAt: text(item, 'wp:post_modified_gmt') || text(item, 'wp:post_modified') ? isoDate(text(item, 'wp:post_modified_gmt'), text(item, 'wp:post_modified')) : publishedAt,
    termWpIds,
    meta: info,
  }
  const excerpt = text(item, 'excerpt:encoded')
  if (excerpt) doc.excerpt = toPlainText(excerpt)
  const author = ix.authors.get(text(item, 'dc:creator')?.trim() ?? '')
  if (author !== undefined) doc.authorWpId = author
  const thumb = id(meta.get('_thumbnail_id'))
  if (thumb !== undefined) doc.featuredMediaWpId = thumb
  const parent = id(text(item, 'wp:post_parent'))
  if (parent !== undefined) doc.parentWpId = parent
  return doc
}

/**
 * SEO from post meta. Exports hold what the editor typed, so Yoast (`%%title%%`) and Rank Math
 * (`%title%`) variables are filled for the common ones; a field with any other variable is left out.
 */
function mapSeo(
  meta: Map<string, string>,
  keys: (typeof SEO_KEYS)[keyof typeof SEO_KEYS],
  vars: { title: string; sitename: string; excerpt: string },
): { value?: IRSeo; unresolved: boolean } {
  const known: Record<string, string> = { title: vars.title, sitename: vars.sitename, sep: '-', page: '', excerpt: vars.excerpt }
  let unresolved = false
  const fill = (v: string | undefined): string | undefined => {
    if (!v?.trim()) return undefined
    let out = toPlainText(v)
    out = out.replace(/%%([a-z_]+)%%|%([a-z_]+)%/gi, (whole, a?: string, b?: string) => {
      const name = (a ?? b ?? '').toLowerCase()
      return Object.hasOwn(known, name) ? known[name]! : whole
    })
    if (/%%[a-z_]+%%|%[a-z_]+%/i.test(out)) {
      unresolved = true
      return undefined
    }
    return out.replace(/\s+/g, ' ').trim() || undefined
  }
  const seo: IRSeo = {}
  const title = fill(meta.get(keys.title))
  if (title) seo.title = title
  const description = fill(meta.get(keys.description))
  if (description) seo.description = description
  const canonical = meta.get(keys.canonical)?.trim()
  if (canonical) seo.canonical = canonical
  const noindex = keys.title.startsWith('_yoast') ? meta.get('_yoast_wpseo_meta-robots-noindex') === '1' : /"noindex"/.test(meta.get('rank_math_robots') ?? '')
  if (noindex) seo.noindex = true
  const image = id(meta.get(keys.image))
  if (image !== undefined) seo.ogImageWpId = image
  return Object.keys(seo).length ? { value: seo, unresolved } : { unresolved }
}
