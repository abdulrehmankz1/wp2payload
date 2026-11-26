import path from 'node:path'
import type { Extractor, IRAuthor, IRDocument, IRMedia, IRTerm, SourceInfo, TablePrefixInfo } from '../../ir/types.js'
import type { Issue } from '../../report/types.js'
import { normaliseSlug, toPlainText } from '../rest/decode.js'
import { NOT_CONTENT_TYPES, mapStatus, pageBuilder, type SeoPluginOption } from '../rest/index.js'
import { ReusableRun } from '../rest/reusable.js'
import { INTERNAL_TYPES, SEO_KEYS, isoDate, mapSeoMeta, positiveId } from '../postmeta.js'
import { DumpError, readDump, type DumpEvent, type DumpInput, type SqlValue } from './dump.js'
import { TABLE_PREFIX, type WpConfigPrefix } from './prefix.js'

export { DumpError, type DumpInput } from './dump.js'

// A SQL dump plus the uploads folder as a source (doc F12, "backup mode"). The dump is read as
// text, never run; only the columns below are kept, so password hashes and emails never leave
// the parser. Media is read from the uploads folder, so nothing is downloaded.

export interface SqlExtractorOptions {
  /** A dump file, or a dump read in place from a zip backup. */
  file: string | DumpInput
  /** The dump is a slice of `file` (database.sql inside a .wpress backup). */
  range?: { start: number; length: number }
  /** The configured prefix. Left out, it is detected: from `wpConfig` when the dump agrees, else from the dump's tables. */
  tablePrefix?: string
  /** `$table_prefix` from the backup's wp-config.php (archives), read as text. */
  wpConfig?: WpConfigPrefix
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
  readonly #file: string | DumpInput
  readonly #range: { start: number; length: number } | undefined
  readonly #configured: string | undefined
  readonly #wpConfig: WpConfigPrefix | undefined
  /** The prefix in use: set by the index (configured or detected) before any rows are read again. */
  #prefix = ''
  #prefixInfo: TablePrefixInfo | undefined
  readonly #statuses: Set<string>
  readonly #seoPlugin: SeoPluginOption
  readonly #maxBytes: number | undefined
  #onWarning: ((issue: Issue) => void) | undefined
  #index: Promise<SqlIndex> | undefined

  constructor(o: SqlExtractorOptions) {
    this.#file = typeof o.file === 'string' ? path.resolve(o.file) : o.file
    this.#range = o.range
    this.#configured = o.tablePrefix
    this.#wpConfig = o.wpConfig
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
    if (this.#prefixInfo) info.tablePrefix = { ...this.#prefixInfo }
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
    const explicit = this.#configured
    const hint = explicit === undefined && this.#wpConfig?.status === 'found' ? this.#wpConfig.prefix : undefined
    let scan = await this.#scan(explicit ?? hint)
    let prefix: string
    let from: TablePrefixInfo['from']
    let note: string | undefined
    if (explicit === undefined && this.#wpConfig?.status === 'invalid') note = `wp-config.php was ignored: ${this.#wpConfig.reason}`
    if (explicit !== undefined) {
      if (!scan.seen.get(explicit)?.has('posts')) {
        const found = scan.installs()
        throw new DumpError(
          'DUMP_NO_WORDPRESS',
          found.length
            ? `The dump has no ${explicit}posts table. Its WordPress tables use the prefix ${quoted(found)}: set source.tablePrefix to it, or leave tablePrefix out to detect it.`
            : 'The dump has no WordPress tables (no posts table found).',
        )
      }
      prefix = explicit
      from = 'config'
    } else if (hint !== undefined && scan.installs().includes(hint)) {
      // wp-config.php names the install this backup belongs to, also when the dump holds others.
      prefix = hint
      from = 'wp-config.php'
    } else {
      if (hint !== undefined) {
        note = `wp-config.php was ignored: the dump has no complete set of tables with its prefix ${quoted([hint])}`
        // Rows were read for the wp-config.php prefix only; read again for every install.
        scan = await this.#scan(undefined)
      }
      const installs = scan.installs()
      if (installs.length > 1) {
        throw new DumpError(
          'DUMP_MULTIPLE_SITES',
          `The dump holds more than one WordPress site, with the table prefixes ${quoted(installs)}${scan.stopped ? ' (and maybe more)' : ''}.\nSet source.tablePrefix to the one to migrate (for wp2payload scan, pass --table-prefix).`,
        )
      }
      if (installs.length === 0) {
        const partial = [...scan.seen].filter(([, t]) => t.has('posts')).map(([p]) => p)
        throw new DumpError(
          'DUMP_NO_WORDPRESS',
          partial.length
            ? `The dump has no complete WordPress tables: the prefix ${quoted(partial)} has a posts table but not both postmeta and options.\nIf this is the site, set source.tablePrefix to it.`
            : 'The dump has no WordPress tables (no posts table found).',
        )
      }
      prefix = installs[0]!
      from = 'dump'
    }
    this.#prefix = prefix
    this.#prefixInfo = { value: prefix, from, ...(note ? { note } : {}) }
    const ix = (scan.builders.get(prefix) ?? new IndexBuilder()).finish()
    if (!/^https?:\/\//i.test(siteUrlOf(ix))) throw new DumpError('DUMP_NO_WORDPRESS', 'The dump has no http(s) site address (home or siteurl option).')
    return ix
  }

  /**
   * One pass over the dump: the tables seen under every prefix, and an index per prefix of the rows
   * read. With `only`, rows are read for that prefix alone. Without it every install is indexed, and
   * the pass stops as soon as a second complete install shows up (the run is refused then), so a
   * multisite dump is not read to the end.
   */
  async #scan(only: string | undefined): Promise<TableScan> {
    const seen = new Map<string, Set<Table>>()
    const builders = new Map<string, IndexBuilder>()
    const installs = () => [...seen].filter(([, t]) => INSTALL_TABLES.every((name) => t.has(name))).map(([p]) => p)
    let stopped = false
    const tables = {
      has: (name: string) => {
        const s = splitTable(name)
        return s !== undefined && (only === undefined || s.prefix === only)
      },
    }
    const opts = { tables, ...(this.#maxBytes !== undefined ? { maxBytes: this.#maxBytes } : {}), ...(this.#range ? { range: this.#range } : {}) }
    for await (const e of readDump(this.#file, opts)) {
      const s = splitTable(e.table)
      if (!s) continue
      if (e.kind === 'table') {
        let names = seen.get(s.prefix)
        if (!names) seen.set(s.prefix, (names = new Set()))
        names.add(s.table)
        if (only === undefined && installs().length > 1) {
          stopped = true
          break
        }
        continue
      }
      let b = builders.get(s.prefix)
      if (!b) builders.set(s.prefix, (b = new IndexBuilder()))
      b.add(s.table, pick(s.table, e))
    }
    return { seen, builders, installs, stopped }
  }
}

/** The tables that make a prefix a WordPress install. */
const INSTALL_TABLES: readonly Table[] = ['posts', 'postmeta', 'options']

interface TableScan {
  seen: Map<string, Set<Table>>
  builders: Map<string, IndexBuilder>
  /** Prefixes that have every table of INSTALL_TABLES, in dump order. */
  installs(): string[]
  /** The pass stopped early, at the second install. */
  stopped: boolean
}

/** Prefixes for a message: they passed TABLE_PREFIX, so they are safe to print. */
const quoted = (prefixes: string[]) =>
  prefixes.slice(0, 10).map((p) => `"${p}"`).join(', ') + (prefixes.length > 10 ? ` and ${prefixes.length - 10} more` : '')

/** A table name as prefix and WordPress table (`wp_2_posts` is `wp_2_` + `posts`); undefined for any other table. */
export function splitTable(name: string): { prefix: string; table: Table } | undefined {
  // No name in TABLES ends with another one, so at most one can match.
  for (const table of TABLES) {
    if (name.length <= table.length || !name.endsWith(table)) continue
    const prefix = name.slice(0, -table.length)
    return TABLE_PREFIX.test(prefix) ? { prefix, table } : undefined
  }
  return undefined
}

/** The index of one install, built row by row. */
class IndexBuilder {
  readonly #ix: SqlIndex = {
    options: new Map(), users: [], terms: [], postTerms: new Map(), categoriesOf: new Map(),
    meta: new Map(), posts: new Map(), blocks: new Map(), other: new Map(), seo: { yoast: false, rankmath: false },
  }
  readonly #names = new Map<number, number>() // term id → term_taxonomy_id
  readonly #taxonomy: Row[] = []
  readonly #relations: [number, number][] = []
  readonly #termRows = new Map<number, Row>()

  add(table: Table, r: Row): void {
    const ix = this.#ix
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
        if (id !== undefined) this.#termRows.set(id, r)
        break
      }
      case 'term_taxonomy':
        this.#taxonomy.push(r)
        break
      case 'term_relationships': {
        const object = positiveId(r['object_id'] ?? undefined)
        const tt = positiveId(r['term_taxonomy_id'] ?? undefined)
        if (object !== undefined && tt !== undefined) this.#relations.push([object, tt])
        break
      }
    }
  }

  finish(): SqlIndex {
    const ix = this.#ix
    // Terms: only categories and tags, with parents as term ids.
    const taxOf = new Map<number, string>() // term_taxonomy_id → taxonomy
    const termOf = new Map<number, number>() // term_taxonomy_id → term id
    for (const t of this.#taxonomy) {
      const tt = positiveId(t['term_taxonomy_id'] ?? undefined)
      const termId = positiveId(t['term_id'] ?? undefined)
      const tax = t['taxonomy'] ?? ''
      if (tt === undefined || termId === undefined || (tax !== 'category' && tax !== 'post_tag')) continue
      taxOf.set(tt, tax)
      termOf.set(tt, termId)
      const row = this.#termRows.get(termId)
      if (!row || this.#names.has(termId)) continue
      this.#names.set(termId, tt)
      const term: IRTerm = { wpId: termId, taxonomy: tax, name: toPlainText(row['name'] ?? ''), slug: normaliseSlug(row['slug'] ?? '') }
      const parent = positiveId(t['parent'] ?? undefined)
      if (parent !== undefined && parent !== termId) term.parentWpId = parent
      if (t['description']) term.description = toPlainText(t['description'])
      ix.terms.push(term)
    }
    for (const [object, tt] of this.#relations) {
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
