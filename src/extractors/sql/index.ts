import path from 'node:path'
import type { Extractor, IRAuthor, IRDocument, IRMedia, IRTerm, SourceInfo } from '../../ir/types.js'
import type { Issue } from '../../report/types.js'
import { normaliseSlug, toPlainText } from '../rest/decode.js'
import { NOT_CONTENT_TYPES, mapStatus, pageBuilder, type SeoPluginOption } from '../rest/index.js'
import { ReusableRun } from '../rest/reusable.js'
import { INTERNAL_TYPES, SEO_KEYS, isoDate, mapSeoMeta, positiveId } from '../postmeta.js'
import { DumpError, readDump, type DumpEvent, type SqlValue } from './dump.js'

export { DumpError } from './dump.js'

// A SQL dump plus the uploads folder as a source (doc F12, "backup mode"). The dump is read as
// text, never run; only the columns below are kept, so password hashes and emails never leave
// the parser. Media is read from the uploads folder, so nothing is downloaded.

export interface SqlExtractorOptions {
  file: string
  /** The dump is a slice of `file` (database.sql inside a .wpress backup). */
  range?: { start: number; length: number }
  tablePrefix?: string
  statuses?: string[]
  seoPlugin?: SeoPluginOption
  maxBytes?: number
  onWarning?: (issue: Issue) => void
}

const TABLES = ['options', 'users', 'posts', 'postmeta', 'terms', 'term_taxonomy', 'term_relationships'] as const
type Table = (typeof TABLES)[number]
// Only these columns are kept; anything else in a row (user_pass, user_email...) is dropped unread.
const COLUMNS: Record<Table, readonly string[]> = {
  options: ['option_name', 'option_value'],
  users: ['ID', 'user_login', 'user_nicename', 'display_name'],
  posts: ['ID', 'post_author', 'post_date', 'post_date_gmt', 'post_content', 'post_title', 'post_excerpt', 'post_status', 'comment_status', 'post_name', 'post_modified', 'post_modified_gmt', 'post_parent', 'guid', 'menu_order', 'post_type', 'post_mime_type'],
  postmeta: ['post_id', 'meta_key', 'meta_value'],
  terms: ['term_id', 'name', 'slug'],
  term_taxonomy: ['term_taxonomy_id', 'term_id', 'taxonomy', 'description', 'parent'],
  term_relationships: ['object_id', 'term_taxonomy_id'],
}
// The column order of a default WordPress install, for dumps that have no CREATE TABLE.
const DEFAULT_ORDER: Record<Table, readonly string[]> = {
  options: ['option_id', 'option_name', 'option_value', 'autoload'],
  users: ['ID', 'user_login', 'user_pass', 'user_nicename', 'user_email', 'user_url', 'user_registered', 'user_activation_key', 'user_status', 'display_name'],
  posts: ['ID', 'post_author', 'post_date', 'post_date_gmt', 'post_content', 'post_title', 'post_excerpt', 'post_status', 'comment_status', 'ping_status', 'post_password', 'post_name', 'to_ping', 'pinged', 'post_modified', 'post_modified_gmt', 'post_content_filtered', 'post_parent', 'guid', 'menu_order', 'post_type', 'post_mime_type', 'comment_count'],
  postmeta: ['meta_id', 'post_id', 'meta_key', 'meta_value'],
  terms: ['term_id', 'name', 'slug', 'term_group'],
  term_taxonomy: ['term_taxonomy_id', 'term_id', 'taxonomy', 'description', 'parent', 'count'],
  term_relationships: ['object_id', 'term_taxonomy_id', 'term_order'],
}
const OPTIONS = new Set(['siteurl', 'home', 'blogname', 'permalink_structure', 'upload_url_path', 'show_on_front', 'page_on_front'])
const META_KEYS = new Set([
  '_thumbnail_id', '_wp_attached_file', '_wp_attachment_image_alt', '_elementor_edit_mode',
  '_yoast_wpseo_meta-robots-noindex', 'rank_math_robots',
  ...Object.values(SEO_KEYS).flatMap((k) => Object.values(k)),
])
const UNRESOLVED_SAMPLE = 5

type Row = Record<string, string | null>
interface PostInfo {
  id: number
  type: string
  status: string
  name: string
  parent: number
  author: number
  date: string
  title: string
  excerpt: string
  guid: string
  mime: string
}
interface SqlIndex {
  options: Map<string, string>
  users: Row[]
  terms: IRTerm[]
  /** object id → term ids (categories first, by term id, as WordPress orders them). */
  postTerms: Map<number, number[]>
  categoriesOf: Map<number, number[]>
  meta: Map<number, Map<string, string>>
  posts: Map<number, PostInfo>
  blocks: Map<number, { status: string; html: string }>
  other: Map<string, number>
  seo: { yoast: boolean; rankmath: boolean }
}

export class SqlExtractor implements Extractor {
  readonly name = 'sql' as const
  readonly #file: string
  readonly #range: { start: number; length: number } | undefined
  readonly #prefix: string
  readonly #statuses: Set<string>
  readonly #seoPlugin: SeoPluginOption
  readonly #maxBytes: number | undefined
  #onWarning: ((issue: Issue) => void) | undefined
  #index: Promise<SqlIndex> | undefined

  constructor(o: SqlExtractorOptions) {
    this.#file = path.resolve(o.file)
    this.#range = o.range
    this.#prefix = o.tablePrefix ?? 'wp_'
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
    const count = (types: string[], statuses?: Set<string>) =>
      [...ix.posts.values()].filter((p) => types.includes(p.type) && (!statuses || statuses.has(p.status))).length
    const info: SourceInfo = {
      siteUrl: siteUrlOf(ix),
      counts: {
        posts: count(['post'], this.#statuses),
        pages: count(['page'], this.#statuses),
        media: count(['attachment']),
        categories: ix.terms.filter((t) => t.taxonomy === 'category').length,
        tags: ix.terms.filter((t) => t.taxonomy === 'post_tag').length,
        users: ix.users.length,
      },
    }
    if (ix.seo.yoast) info.seoPlugin = 'yoast'
    else if (ix.seo.rankmath) info.seoPlugin = 'rankmath'
    const other = [...ix.other].map(([type, n]) => ({ type, count: n }))
    if (other.length) info.unmigratedTypes = other
    return info
  }

  async *media(): AsyncIterable<IRMedia> {
    const ix = await this.#indexOnce()
    const base = uploadsUrl(ix)
    for (const p of ix.posts.values()) {
      if (p.type !== 'attachment') continue
      const meta = ix.meta.get(p.id)
      const file = meta?.get('_wp_attached_file')
      if (!file) continue
      const out: IRMedia = {
        wpId: p.id,
        sourceUrl: `${base}/${file.split('/').map(encodeURIComponent).join('/')}`,
        localPath: file,
        filename: path.posix.basename(file),
        mimeType: p.mime || 'application/octet-stream',
      }
      const alt = meta?.get('_wp_attachment_image_alt')
      if (alt) out.alt = toPlainText(alt)
      if (p.excerpt) out.caption = toPlainText(p.excerpt)
      yield out
    }
  }

  async *terms(): AsyncIterable<IRTerm> {
    yield* (await this.#indexOnce()).terms
  }

  async *authors(): AsyncIterable<IRAuthor> {
    for (const u of (await this.#indexOnce()).users) {
      const wpId = positiveId(u['ID'] ?? undefined)
      if (wpId === undefined) continue
      yield { wpId, slug: normaliseSlug(u['user_nicename'] || (u['user_login'] ?? '').toLowerCase()), displayName: toPlainText(u['display_name'] || u['user_login'] || '') }
    }
  }

  async *documents(): AsyncIterable<IRDocument> {
    const ix = await this.#indexOnce()
    for (const [type, n] of ix.other) {
      this.#onWarning?.({ code: 'DOC_TYPE_UNMAPPED', detail: `Post type "${type}" (${n} item${n === 1 ? '' : 's'}) was not migrated: the SQL source migrates posts and pages` })
    }
    const plugin = this.#seoPlugin === 'auto' ? (ix.seo.yoast ? 'yoast' : ix.seo.rankmath ? 'rankmath' : 'none') : this.#seoPlugin
    const reusable = new ReusableRun(async (ref) => {
      const block = ix.blocks.get(ref)
      if (!block) return { reason: 'not found (deleted, or not a reusable block)' }
      if (block.status !== 'publish') return { reason: `not published (${block.status.slice(0, 20)})` }
      return { html: block.html }
    })
    const links = new Permalinks(ix)
    const unresolved: string[] = []
    try {
      for await (const row of this.#rows('posts')) {
        const type = row['post_type']
        if (type !== 'post' && type !== 'page') continue
        const raw = row['post_status'] ?? ''
        if (!this.#statuses.has(raw)) continue
        const wpId = positiveId(row['ID'] ?? undefined)
        if (wpId === undefined) continue
        const meta = ix.meta.get(wpId) ?? new Map<string, string>()
        const html = row['post_content'] ?? ''
        const { status, original } = mapStatus(raw)
        const info: Record<string, unknown> = { contentFormat: 'raw' }
        if (original) info.wpStatus = original
        const builder = meta.get('_elementor_edit_mode') === 'builder' ? 'Elementor' : pageBuilder(html, '')
        if (builder) info.pageBuilder = builder
        const order = Number(row['menu_order'])
        if (Number.isSafeInteger(order) && order !== 0) info.menu_order = order
        if (row['comment_status']) info.comment_status = row['comment_status']
        const publishedAt = isoDate(row['post_date_gmt'] ?? undefined, row['post_date'] ?? undefined)
        const doc: IRDocument = {
          wpId,
          type,
          status,
          slug: normaliseSlug(row['post_name'] ?? ''),
          title: toPlainText(row['post_title'] ?? ''),
          html,
          link: links.of(wpId),
          publishedAt,
          modifiedAt: row['post_modified_gmt'] || row['post_modified'] ? isoDate(row['post_modified_gmt'] ?? undefined, row['post_modified'] ?? undefined) : publishedAt,
          termWpIds: ix.postTerms.get(wpId) ?? [],
          meta: info,
        }
        if (row['post_excerpt']) doc.excerpt = toPlainText(row['post_excerpt'])
        const author = positiveId(row['post_author'] ?? undefined)
        if (author !== undefined) doc.authorWpId = author
        const thumb = positiveId(meta.get('_thumbnail_id'))
        if (thumb !== undefined) doc.featuredMediaWpId = thumb
        const parent = positiveId(row['post_parent'] ?? undefined)
        if (parent !== undefined) doc.parentWpId = parent
        doc.html = await reusable.inline(doc)
        if (plugin !== 'none') {
          const seo = mapSeoMeta(meta, SEO_KEYS[plugin], { title: doc.title, sitename: toPlainText(ix.options.get('blogname') ?? ''), excerpt: doc.excerpt ?? '' })
          if (seo.unresolved && unresolved.length <= UNRESOLVED_SAMPLE) unresolved.push(`${doc.type}:${doc.wpId}`)
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
          detail: `SEO titles or descriptions with template variables wp2payload cannot fill were left out (${sample}); set them in Payload.`,
        })
      }
    }
  }

  /** Rows of one table as objects holding only COLUMNS. */
  async *#rows(table: Table): AsyncIterable<Row> {
    for await (const e of this.#events(new Set([table]))) if (e.kind === 'row') yield pick(table, e)
  }

  #events(tables: Set<Table>): AsyncIterable<DumpEvent> {
    const names = new Set([...tables].map((t) => this.#prefix + t))
    return readDump(this.#file, { tables: names, ...(this.#maxBytes !== undefined ? { maxBytes: this.#maxBytes } : {}), ...(this.#range ? { range: this.#range } : {}) })
  }

  #indexOnce(): Promise<SqlIndex> {
    this.#index ??= this.#buildIndex()
    return this.#index
  }

  async #buildIndex(): Promise<SqlIndex> {
    const ix: SqlIndex = {
      options: new Map(), users: [], terms: [], postTerms: new Map(), categoriesOf: new Map(),
      meta: new Map(), posts: new Map(), blocks: new Map(), other: new Map(), seo: { yoast: false, rankmath: false },
    }
    const names = new Map<number, number>() // term id → term_taxonomy_id
    const taxonomy: Row[] = []
    const relations: [number, number][] = []
    const termRows = new Map<number, Row>()
    const tables = new Set<string>()
    for await (const e of this.#events(new Set(TABLES))) {
      if (e.kind === 'table') {
        tables.add(e.table)
        continue
      }
      const table = e.table.slice(this.#prefix.length) as Table
      const r = pick(table, e)
      switch (table) {
        case 'options':
          if (r['option_name'] && OPTIONS.has(r['option_name'])) ix.options.set(r['option_name'], r['option_value'] ?? '')
          break
        case 'users':
          ix.users.push(r)
          break
        case 'postmeta': {
          const id = positiveId(r['post_id'] ?? undefined)
          const key = r['meta_key'] ?? ''
          if (key.startsWith('_yoast_wpseo_')) ix.seo.yoast = true
          else if (key.startsWith('rank_math_')) ix.seo.rankmath = true
          if (id === undefined || !META_KEYS.has(key)) break
          let m = ix.meta.get(id)
          if (!m) ix.meta.set(id, (m = new Map()))
          if (!m.has(key)) m.set(key, r['meta_value'] ?? '')
          break
        }
        case 'posts': {
          const id = positiveId(r['ID'] ?? undefined)
          if (id === undefined) break
          const type = r['post_type'] ?? ''
          const status = r['post_status'] ?? ''
          ix.posts.set(id, {
            id, type, status, name: r['post_name'] ?? '', parent: positiveId(r['post_parent'] ?? undefined) ?? 0,
            author: positiveId(r['post_author'] ?? undefined) ?? 0, date: r['post_date'] ?? '', title: type === 'attachment' ? r['post_title'] ?? '' : '',
            excerpt: type === 'attachment' ? r['post_excerpt'] ?? '' : '', guid: r['guid'] ?? '', mime: r['post_mime_type'] ?? '',
          })
          if (type === 'wp_block') ix.blocks.set(id, { status, html: r['post_content'] ?? '' })
          else if (type && !NOT_CONTENT_TYPES.has(type) && !INTERNAL_TYPES.has(type) && !type.startsWith('wp_') && status !== 'trash' && status !== 'auto-draft' && status !== 'inherit') {
            const name = toPlainText(type).slice(0, 64)
            ix.other.set(name, (ix.other.get(name) ?? 0) + 1)
          }
          break
        }
        case 'terms': {
          const id = positiveId(r['term_id'] ?? undefined)
          if (id !== undefined) termRows.set(id, r)
          break
        }
        case 'term_taxonomy':
          taxonomy.push(r)
          break
        case 'term_relationships': {
          const object = positiveId(r['object_id'] ?? undefined)
          const tt = positiveId(r['term_taxonomy_id'] ?? undefined)
          if (object !== undefined && tt !== undefined) relations.push([object, tt])
          break
        }
      }
    }
    if (!tables.has(`${this.#prefix}posts`)) {
      const found = [...tables].filter((t) => t.endsWith('posts') && tables.has(`${t.slice(0, -5)}options`)).map((t) => t.slice(0, -5))
      throw new DumpError(
        'DUMP_NO_WORDPRESS',
        found.length
          ? `The dump has no ${this.#prefix}posts table. Its WordPress tables use the prefix ${found.map((p) => `"${p}"`).join(', ')}: set source.tablePrefix.`
          : 'The dump has no WordPress tables (no posts table found).',
      )
    }
    // Terms: only categories and tags, with parents as term ids.
    const taxOf = new Map<number, string>() // term_taxonomy_id → taxonomy
    const termOf = new Map<number, number>() // term_taxonomy_id → term id
    for (const t of taxonomy) {
      const tt = positiveId(t['term_taxonomy_id'] ?? undefined)
      const termId = positiveId(t['term_id'] ?? undefined)
      const tax = t['taxonomy'] ?? ''
      if (tt === undefined || termId === undefined || (tax !== 'category' && tax !== 'post_tag')) continue
      taxOf.set(tt, tax)
      termOf.set(tt, termId)
      const row = termRows.get(termId)
      if (!row || names.has(termId)) continue
      names.set(termId, tt)
      const term: IRTerm = { wpId: termId, taxonomy: tax, name: toPlainText(row['name'] ?? ''), slug: normaliseSlug(row['slug'] ?? '') }
      const parent = positiveId(t['parent'] ?? undefined)
      if (parent !== undefined && parent !== termId) term.parentWpId = parent
      if (t['description']) term.description = toPlainText(t['description'])
      ix.terms.push(term)
    }
    for (const [object, tt] of relations) {
      const termId = termOf.get(tt)
      if (termId === undefined) continue
      const list = ix.postTerms.get(object) ?? []
      if (!list.includes(termId)) list.push(termId)
      ix.postTerms.set(object, list)
      if (taxOf.get(tt) === 'category') {
        const cats = ix.categoriesOf.get(object) ?? []
        cats.push(termId)
        ix.categoriesOf.set(object, cats)
      }
    }
    for (const cats of ix.categoriesOf.values()) cats.sort((a, b) => a - b)
    if (!/^https?:\/\//i.test(siteUrlOf(ix))) throw new DumpError('DUMP_NO_WORDPRESS', 'The dump has no http(s) site address (home or siteurl option).')
    return ix
  }
}

function pick(table: Table, e: Extract<DumpEvent, { kind: 'row' }>): Row {
  const order = e.columns && e.columns.length === e.values.length ? e.columns : DEFAULT_ORDER[table]
  const out: Row = {}
  for (const col of COLUMNS[table]) {
    const i = order.indexOf(col)
    out[col] = i >= 0 ? (e.values[i] as SqlValue) ?? null : null
  }
  return out
}

const trimSlash = (s: string) => s.replace(/\/+$/, '')
const siteUrlOf = (ix: SqlIndex) => trimSlash(ix.options.get('home') || ix.options.get('siteurl') || '')

function uploadsUrl(ix: SqlIndex): string {
  const custom = ix.options.get('upload_url_path')
  return trimSlash(custom || `${trimSlash(ix.options.get('siteurl') || siteUrlOf(ix))}/wp-content/uploads`)
}

/**
 * Old URLs from the permalink settings, as WordPress builds them: the structure tags for posts,
 * the parent path for pages. A dump has no rendered links, and redirects and link rewriting need them.
 */
class Permalinks {
  readonly #ix: SqlIndex
  readonly #home: string
  readonly #structure: string
  readonly #slugs = new Map<number, { slug: string; parent?: number }>()

  constructor(ix: SqlIndex) {
    this.#ix = ix
    this.#home = siteUrlOf(ix)
    this.#structure = ix.options.get('permalink_structure') ?? ''
    for (const t of ix.terms) this.#slugs.set(t.wpId, { slug: encodeSlug(t.slug), ...(t.parentWpId !== undefined ? { parent: t.parentWpId } : {}) })
  }

  of(id: number): string {
    const p = this.#ix.posts.get(id)
    if (!p) return ''
    const front = this.#ix.options.get('show_on_front') === 'page' && this.#ix.options.get('page_on_front') === String(id)
    if (front) return `${this.#home}/`
    if (!this.#structure) return p.type === 'page' ? `${this.#home}/?page_id=${id}` : `${this.#home}/?p=${id}`
    if (p.type === 'page') {
      const parts: string[] = []
      const seen = new Set<number>()
      for (let cur: PostInfo | undefined = p; cur && !seen.has(cur.id); cur = cur.parent ? this.#ix.posts.get(cur.parent) : undefined) {
        seen.add(cur.id)
        parts.unshift(cur.name)
      }
      return `${this.#home}/${parts.join('/')}/`
    }
    const [date = '', time = ''] = p.date.split(' ')
    const [year = '', month = '', day = ''] = date.split('-')
    const [hour = '', minute = '', second = ''] = time.split(':')
    const author = this.#ix.users.find((u) => u['ID'] === String(p.author))
    const tags: Record<string, string> = {
      '%year%': year, '%monthnum%': month, '%day%': day, '%hour%': hour, '%minute%': minute, '%second%': second,
      '%post_id%': String(id), '%postname%': p.name, '%category%': this.#categoryPath(id), '%author%': author?.['user_nicename'] ?? '',
    }
    return this.#home + this.#structure.replace(/%[a-z_]+%/g, (t) => tags[t] ?? t)
  }

  #categoryPath(id: number): string {
    const first = this.#ix.categoriesOf.get(id)?.[0]
    const parts: string[] = []
    const seen = new Set<number>()
    for (let cur = first; cur !== undefined && !seen.has(cur); cur = this.#slugs.get(cur)?.parent) {
      seen.add(cur)
      parts.unshift(this.#slugs.get(cur)?.slug ?? '')
    }
    return parts.join('/') || 'uncategorized'
  }
}

/** Term slugs are stored percent-encoded; IR slugs are decoded, links need the stored form. */
const encodeSlug = (slug: string) => encodeURIComponent(slug).replace(/%2F/gi, '-')
