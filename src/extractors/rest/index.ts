import { lookup as dnsLookup } from 'node:dns/promises'
import type { Extractor, IRAuthor, IRDocument, IRMedia, IRSeo, IRTerm, SourceInfo } from '../../ir/types.js'
import { RestClient } from './client.js'
import { toPlainText } from './decode.js'
import { RestError, type LookupFn } from './net.js'

export { RestError } from './net.js'
export { decodeEntities } from './decode.js'

export interface RestExtractorOptions {
  url: string
  auth?: { user: string; appPassword: string }
  statuses?: IRDocument['status'][]
  fetch?: typeof fetch
  lookup?: LookupFn
  timeoutMs?: number
  maxRetries?: number
  perPage?: number
  sleep?: (ms: number) => Promise<void>
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const pos = (v: unknown): number | undefined => {
  const n = num(v)
  return n !== undefined && n > 0 ? n : undefined
}
const nested = (v: unknown, key: string): string | undefined => (isObj(v) ? str(v[key]) : undefined)
const iso = (gmt: unknown, fallback: unknown): string => {
  const g = str(gmt)
  if (g) return g.endsWith('Z') ? g : `${g}Z`
  const f = str(fallback)
  return f ? new Date(f).toISOString() : new Date(0).toISOString()
}

export class RestExtractor implements Extractor {
  readonly name = 'rest' as const
  readonly #c: RestClient
  readonly #statuses: IRDocument['status'][]
  readonly #perPage: number

  constructor(o: RestExtractorOptions) {
    this.#c = new RestClient({
      url: o.url,
      ...(o.auth ? { auth: o.auth } : {}),
      fetch: o.fetch ?? globalThis.fetch,
      lookup: o.lookup ?? ((h) => dnsLookup(h, { all: true })),
      timeoutMs: o.timeoutMs ?? 30_000,
      maxRetries: o.maxRetries ?? 3,
      sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    })
    this.#statuses = o.statuses ?? ['publish']
    this.#perPage = Math.min(Math.max(o.perPage ?? 100, 1), 100)
    if (!this.#c.authenticated && this.#statuses.some((s) => s !== 'publish')) {
      throw new RestError(
        'REST_AUTH_REQUIRED',
        'Statuses other than publish need credentials. Set WP_USER and WP_APP_PASSWORD, or migrate published content only.',
      )
    }
  }

  async probe(): Promise<SourceInfo> {
    const root = await this.#c.get('/wp-json/')
    const body = isObj(root.json) ? root.json : {}
    const namespaces = Array.isArray(body.namespaces) ? body.namespaces : []
    const counts: SourceInfo['counts'] = {}
    const endpoints = [
      ['posts', 'posts'], ['pages', 'pages'], ['media', 'media'],
      ['categories', 'categories'], ['tags', 'tags'], ['users', 'users'],
    ] as const
    for (const [key, ep] of endpoints) {
      try {
        const r = await this.#c.get(`/wp-json/wp/v2/${ep}`, { per_page: 1 })
        const raw = r.headers.get('x-wp-total')
        const total = Number(raw)
        if (raw !== null && Number.isFinite(total)) counts[key] = total
      } catch (e) {
        // Some collections (users) are hidden from anonymous callers; omit those counts.
        if (!(e instanceof RestError && (e.status === 401 || e.status === 403 || e.status === 404))) throw e
      }
    }
    const info: SourceInfo = { siteUrl: str(body.url) ?? this.#c.site.base, counts }
    if (namespaces.includes('yoast/v1')) info.seoPlugin = 'yoast'
    else if (namespaces.includes('rankmath/v1')) info.seoPlugin = 'rankmath'
    return info
  }

  async *media(): AsyncIterable<IRMedia> {
    for await (const m of this.#pages('/wp-json/wp/v2/media', {})) {
      const sourceUrl = str(m.source_url)
      if (!sourceUrl) continue
      const out: IRMedia = {
        wpId: num(m.id) ?? 0,
        sourceUrl,
        filename: filenameOf(sourceUrl),
        mimeType: str(m.mime_type) ?? 'application/octet-stream',
      }
      const alt = str(m.alt_text)
      if (alt) out.alt = toPlainText(alt)
      const cap = nested(m.caption, 'raw') ?? nested(m.caption, 'rendered')
      if (cap) out.caption = toPlainText(cap)
      yield out
    }
  }

  async *terms(): AsyncIterable<IRTerm> {
    for (const [ep, taxonomy] of [['categories', 'category'], ['tags', 'post_tag']] as const) {
      for await (const t of this.#pages(`/wp-json/wp/v2/${ep}`, {})) {
        const out: IRTerm = {
          wpId: num(t.id) ?? 0,
          taxonomy,
          name: toPlainText(str(t.name) ?? ''),
          slug: str(t.slug) ?? '',
        }
        const parent = pos(t.parent)
        if (parent !== undefined) out.parentWpId = parent
        const desc = str(t.description)
        if (desc) out.description = toPlainText(desc)
        yield out
      }
    }
  }

  async *authors(): AsyncIterable<IRAuthor> {
    let edit = this.#c.authenticated
    let source: AsyncIterable<Json>
    // Editors usually cannot list users with context=edit (403): fall back to the public view.
    if (edit) {
      try {
        const it = this.#pages('/wp-json/wp/v2/users', { context: 'edit' })[Symbol.asyncIterator]()
        source = chain(await it.next(), it)
      } catch (e) {
        if (!(e instanceof RestError && e.status === 403)) throw e
        edit = false
        source = this.#pages('/wp-json/wp/v2/users', {})
      }
    } else {
      source = this.#pages('/wp-json/wp/v2/users', {})
    }
    for await (const u of source) {
      const out: IRAuthor = {
        wpId: num(u.id) ?? 0,
        slug: str(u.slug) ?? '',
        displayName: toPlainText(str(u.name) ?? ''),
      }
      const email = str(u.email)
      if (edit && email) out.email = email
      yield out
    }
  }

  async *documents(): AsyncIterable<IRDocument> {
    const query: Record<string, string> = { status: this.#statuses.join(',') }
    if (this.#c.authenticated) query.context = 'edit'
    for (const [ep, type] of [['posts', 'post'], ['pages', 'page']] as const) {
      for await (const p of this.#pages(`/wp-json/wp/v2/${ep}`, query)) {
        yield mapDocument(p, type)
      }
    }
  }

  /** Stream a collection page by page; never holds more than one page. */
  async *#pages(path: string, query: Record<string, string>): AsyncGenerator<Json> {
    for (let page = 1; ; page++) {
      const r = await this.#c.get(path, { ...query, per_page: this.#perPage, page })
      const items = Array.isArray(r.json) ? r.json : []
      for (const it of items) if (isObj(it)) yield it
      const rawTotal = r.headers.get('x-wp-totalpages')
      const totalPages = Number(rawTotal)
      const known = rawTotal !== null && Number.isFinite(totalPages)
      if (known ? page >= totalPages : items.length < this.#perPage) return
    }
  }
}

async function* chain(first: IteratorResult<Json>, it: AsyncIterator<Json>): AsyncGenerator<Json> {
  let cur = first
  while (!cur.done) {
    yield cur.value
    cur = await it.next()
  }
}

function filenameOf(sourceUrl: string): string {
  try {
    const last = new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last)
  } catch {
    return sourceUrl.split('/').pop() ?? sourceUrl
  }
}

function mapStatus(s: string | undefined): { status: IRDocument['status']; original?: string } {
  if (s === 'publish' || s === 'draft' || s === 'private' || s === 'future') return { status: s }
  return { status: 'draft', original: s ?? 'unknown' } // pending etc.
}

function mapSeo(raw: unknown): IRSeo | undefined {
  if (!isObj(raw)) return undefined
  const seo: IRSeo = {}
  const title = str(raw.title)
  if (title) seo.title = toPlainText(title)
  const desc = str(raw.description) ?? str(raw.og_description)
  if (desc) seo.description = toPlainText(desc)
  const canonical = str(raw.canonical)
  if (canonical) seo.canonical = canonical
  if (isObj(raw.robots) && raw.robots.index === 'noindex') seo.noindex = true
  const og = Array.isArray(raw.og_image) ? raw.og_image[0] : undefined
  const ogId = isObj(og) ? pos(og.id) : undefined // Yoast rarely exposes an id; only use one if present
  if (ogId !== undefined) seo.ogImageWpId = ogId
  return Object.keys(seo).length > 0 ? seo : undefined
}

function mapDocument(p: Json, type: 'post' | 'page'): IRDocument {
  const rawHtml = nested(p.content, 'raw')
  const html = rawHtml ?? nested(p.content, 'rendered') ?? ''
  const { status, original } = mapStatus(str(p.status))
  const excerptSrc = nested(p.excerpt, 'raw') ?? nested(p.excerpt, 'rendered')
  const meta: Record<string, unknown> = { contentFormat: rawHtml !== undefined ? 'raw' : 'rendered' }
  if (original) meta.wpStatus = original
  for (const k of ['format', 'sticky', 'template', 'menu_order', 'comment_status'] as const) {
    if (p[k] !== undefined && p[k] !== '') meta[k] = p[k]
  }
  if (isObj(p.meta) && Object.keys(p.meta).length > 0) meta.restMeta = p.meta

  const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [])
  const doc: IRDocument = {
    wpId: num(p.id) ?? 0,
    type: str(p.type) ?? type,
    status,
    slug: str(p.slug) ?? '',
    title: toPlainText(nested(p.title, 'raw') ?? nested(p.title, 'rendered') ?? ''),
    html,
    link: str(p.link) ?? '',
    publishedAt: iso(p.date_gmt, p.date),
    modifiedAt: iso(p.modified_gmt, p.modified),
    termWpIds: [...ids(p.categories), ...ids(p.tags)],
    meta,
  }
  if (excerptSrc) doc.excerpt = toPlainText(excerptSrc)
  const author = pos(p.author)
  if (author !== undefined) doc.authorWpId = author
  const media = pos(p.featured_media)
  if (media !== undefined) doc.featuredMediaWpId = media
  const parent = pos(p.parent)
  if (parent !== undefined) doc.parentWpId = parent
  const seo = mapSeo(p.yoast_head_json)
  if (seo) doc.seo = seo
  return doc
}
