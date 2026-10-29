import type { CollectionSlug } from 'payload'
import type { IRDocument, IRSeo } from '../ir/types.js'
import type { CountAction, Issue, ReportSink, SecurityFinding } from '../report/types.js'
import { withRetry, type RetryOptions } from '../state/retry.js'
import { resolve } from '../state/store.js'
import { transformDocument, type TransformContext, type TransformedDocument } from '../transform/index.js'
import type { UrlResolver } from '../transform/types.js'
import { buildUrlResolver } from '../transform/urls.js'
import { describeCollection, type CollectionShape, type TargetField } from './fields.js'
import type { DocumentTarget, DocumentWritten, IdKind, IdMap, LoaderContext } from './types.js'
import { upsertByWpMeta, type PayloadId } from './wpmeta.js'

const PHASE = 'documents'
// Never written: only used to tell "links to a document of this run that is not written yet"
// apart from "links to something that is not migrated at all".
const PLACEHOLDER = '__wp2payload_forward__'

export interface DocumentsLoaderOptions {
  /** IR doc type → target. Other types are skipped with DOC_TYPE_UNMAPPED (once per type). */
  targets: Record<string, DocumentTarget>
  transform: Omit<TransformContext, 'report' | 'dryRun' | 'lexical'>
  /** All media of the source, for the URL resolver. */
  media: Iterable<{ wpId: number; sourceUrl: string }>
  /** All permalinks of this run (from the spill). */
  documents: Iterable<{ wpId: number; type: string; link: string }>
  /** Config `seo.field`, default 'meta'. `target.fields.seo` overrides it per collection. */
  seoField?: string
  /** Unset when media is not mapped: images then fall back as unmigrated media, never queried. */
  mediaCollection?: CollectionSlug
  retry?: RetryOptions
  /** Resume: already written in this run → skipped. */
  done?: (type: string, wpId: number) => boolean
  /** Called once per document with its final result. */
  onDocument?: (r: DocumentWritten) => void
  /** Checked before each document; iteration stops when it returns true. */
  shouldStop?: () => boolean
}

interface Deferred {
  id: PayloadId
  action: 'created' | 'updated'
  links: boolean
  parent: boolean
  externalLinks: number
}

/** Collects what one transform reports, so the loader decides what reaches the real report. */
class BufferSink implements ReportSink {
  readonly warnings: Issue[] = []
  readonly errors: Issue[] = []
  readonly findings: SecurityFinding[] = []
  count(_phase: string, _action: CountAction): void {}
  warning(issue: Issue): void {
    this.warnings.push(issue)
  }
  error(issue: Issue): void {
    this.errors.push(issue)
  }
  finding(finding: SecurityFinding): void {
    this.findings.push(finding)
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Documents phase (doc 2.3 steps 1-5, spec 05 AC-A1..A5). Pass 1 transforms and upserts every
 * document by wpMeta. A document whose content links to a document of this run that has no
 * Payload ID yet, or whose page has a parent, is deferred; pass 2 (the relationship pass)
 * re-reads `source()` and patches content and parent by ID once every document exists.
 *
 * Report dedup: security findings (and their quarantine files) are reported in pass 1 only;
 * quarantine names are content hashes, so pass 2 re-transforming reuses the same files. Warnings
 * of a document whose content is re-transformed in pass 2 are discarded in pass 1 and taken from
 * pass 2 only, so the report holds each finding once and only the final link warnings.
 */
export async function loadDocuments(
  ctx: LoaderContext,
  source: () => AsyncIterable<IRDocument>,
  opts: DocumentsLoaderOptions,
): Promise<{ deferred: number; stopped: boolean }> {
  const docCollections: Record<string, string> = {}
  for (const [type, t] of Object.entries(opts.targets)) docCollections[type] = t.collection
  const media = [...opts.media]
  const documents = [...opts.documents]

  const real = buildUrlResolver({ siteOrigin: opts.transform.siteOrigin, media, documents, ids: ctx.ids, docCollections })
  // Documents of this run always resolve here. Media stays real in a write run so media warnings
  // are unchanged; a dry run uploads nothing, so media of this run counts as migrated there too.
  const placeholderIds: IdMap = {
    get: (kind, wpId) =>
      ctx.ids.get(kind, wpId) ?? (Object.hasOwn(docCollections, kind) || (ctx.dryRun && kind === 'media') ? PLACEHOLDER : undefined),
    set: () => {},
  }
  const anticipating = buildUrlResolver({ siteOrigin: opts.transform.siteOrigin, media, documents, ids: placeholderIds, docCollections })

  const shapes = new Map<string, CollectionShape>()
  const shapeOf = (slug: CollectionSlug) => {
    let s = shapes.get(slug)
    if (!s) shapes.set(slug, (s = describeCollection(ctx.payload, slug)))
    return s
  }
  const warnedOnce = new Set<string>()
  const once = (key: string, issue: Issue) => {
    if (warnedOnce.has(key)) return
    warnedOnce.add(key)
    ctx.report.warning(issue)
  }

  // Reference lookups: state cache first, then the database (the cache may be cold, ADR-0004).
  const misses = new Set<string>()
  const lookup = async (kind: IdKind, collection: CollectionSlug, wpId: number): Promise<PayloadId | undefined> => {
    const cached = ctx.ids.get(kind, wpId)
    if (cached !== undefined || misses.has(`${kind}:${wpId}`)) return cached
    const found = await resolve(ctx, kind, collection, wpId)
    if (found === undefined) misses.add(`${kind}:${wpId}`)
    return found
  }

  const transform = async (doc: IRDocument, shape: CollectionShape, contentField: TargetField | undefined, resolver: UrlResolver, report: ReportSink) => {
    const editor = contentField?.editor ?? { blocks: {}, linkRel: false }
    return transformDocument(doc, {
      ...opts.transform,
      report,
      dryRun: ctx.dryRun,
      lexical: {
        resolver,
        mediaCollection: opts.mediaCollection ?? '',
        blocks: editor.blocks,
        // Empty means "no rel": written only when the target link feature has a `rel` field.
        externalLinkRel: editor.linkRel ? opts.transform.externalLinkRel : '',
      },
    })
  }

  const forward = (buf: BufferSink, { warnings, findings }: { warnings: boolean; findings: boolean }) => {
    if (warnings) for (const w of buf.warnings) ctx.report.warning(w)
    for (const e of buf.errors) ctx.report.error(e)
    if (findings) for (const f of buf.findings) ctx.report.finding(f)
  }

  const fail = (doc: IRDocument, stage: string, error: unknown) => {
    ctx.report.count(PHASE, 'errors')
    ctx.report.error({ code: 'DOC_WRITE_FAILED', detail: `${doc.type} ${doc.wpId} "${doc.slug}" (${stage}): ${message(error)}`, doc: `${doc.type}:${doc.wpId}` })
    opts.onDocument?.({ type: doc.type, wpId: doc.wpId, action: 'errors', externalLinks: 0 })
  }

  const deferred = new Map<string, Deferred>()
  let stopped = false

  // Pass 1.
  for await (const doc of source()) {
    if (opts.shouldStop?.()) {
      stopped = true
      break
    }
    // Own keys only: a post type named `constructor` or `__proto__` must not find a target.
    const target = Object.hasOwn(opts.targets, doc.type) ? opts.targets[doc.type] : undefined
    if (!target) {
      ctx.report.count(PHASE, 'skipped')
      once(`type:${doc.type}`, { code: 'DOC_TYPE_UNMAPPED', detail: `Post type "${doc.type}" has no target collection in the config and was not migrated` })
      continue
    }
    if (opts.done?.(doc.type, doc.wpId)) {
      ctx.report.count(PHASE, 'skipped')
      opts.onDocument?.({ type: doc.type, wpId: doc.wpId, action: 'skipped', externalLinks: 0 })
      continue
    }

    let shape: CollectionShape
    let mapper: Mapper
    let forwardLinks = false
    const buf = new BufferSink()
    let out: TransformedDocument
    try {
      shape = shapeOf(target.collection)
      mapper = new Mapper(ctx, opts, target, shape, once, lookup)
      const contentField = mapper.contentField()
      // Dry run writes nothing, so documents of this run count as migrated for link warnings.
      const resolver: UrlResolver = ctx.dryRun
        ? anticipating
        : {
            media: (url) => real.media(url),
            isOldSite: (url) => real.isOldSite(url),
            doc(url) {
              const found = real.doc(url)
              if (found === undefined && anticipating.doc(url) !== undefined) forwardLinks = true
              return found
            },
          }
      out = await transform(doc, shape, contentField, resolver, buf)
    } catch (error) {
      forward(buf, { warnings: true, findings: true })
      fail(doc, 'transform', error)
      continue
    }

    const parent = !ctx.dryRun && mapper.wantsParent(doc)
    const willRetransform = forwardLinks
    // Findings now, warnings only if pass 2 will not produce them again.
    forward(buf, { warnings: !willRetransform, findings: true })

    try {
      const data = await mapper.data(doc, out)
      if (ctx.dryRun) {
        const existing = await resolve(ctx, doc.type, target.collection, doc.wpId)
        const action = existing === undefined ? 'created' : 'updated'
        ctx.report.count(PHASE, action)
        opts.onDocument?.({ type: doc.type, wpId: doc.wpId, action, externalLinks: out.externalLinks })
        continue
      }
      const res = await withRetry(
        () => upsertByWpMeta(ctx.payload, { collection: target.collection, meta: { site: ctx.site, wpId: doc.wpId, link: doc.link }, data }),
        opts.retry,
      )
      ctx.ids.set(doc.type, doc.wpId, res.id)
      ctx.report.count(PHASE, res.action)
      if (willRetransform || parent) {
        deferred.set(`${doc.type}:${doc.wpId}`, { id: res.id, action: res.action, links: willRetransform, parent, externalLinks: out.externalLinks })
      } else {
        opts.onDocument?.({ type: doc.type, wpId: doc.wpId, action: res.action, externalLinks: out.externalLinks })
      }
    } catch (error) {
      // Not written, so no pass 2: the pass-1 warnings are final.
      if (willRetransform) forward(buf, { warnings: true, findings: false })
      fail(doc, 'write', error)
    }
  }

  const total = deferred.size
  if (stopped || total === 0) return { deferred: total, stopped }

  // Pass 2: relationship patch. Counts were taken in pass 1; one action per document.
  for await (const doc of source()) {
    if (deferred.size === 0) break
    const key = `${doc.type}:${doc.wpId}`
    const d = deferred.get(key)
    if (!d) continue
    if (opts.shouldStop?.()) {
      stopped = true
      break
    }
    deferred.delete(key)
    const target = opts.targets[doc.type] as DocumentTarget
    const shape = shapeOf(target.collection)
    const mapper = new Mapper(ctx, opts, target, shape, once, lookup)
    const data: Record<string, unknown> = {}
    let externalLinks = d.externalLinks
    const buf = new BufferSink()
    let forwarded = false
    try {
      if (d.links) {
        const contentField = mapper.contentField()
        const out = await transform(doc, shape, contentField, real, buf)
        // Findings were reported in pass 1; only the final warnings count.
        forward(buf, { warnings: true, findings: false })
        forwarded = true
        externalLinks = out.externalLinks
        if (contentField) data[contentField.name] = out.content
      }
      if (d.parent) Object.assign(data, await mapper.parentData(doc))
      if (shape.drafts) data['_status'] = statusOf(doc)
      if (Object.keys(data).length > 0) {
        await withRetry(
          () => ctx.payload.update({ collection: target.collection, id: d.id, data: data as never, depth: 0, overrideAccess: true }),
          opts.retry,
        )
      }
      opts.onDocument?.({ type: doc.type, wpId: doc.wpId, action: d.action, externalLinks })
    } catch (error) {
      if (d.links && !forwarded) forward(buf, { warnings: true, findings: false })
      // The document exists (counted in pass 1) but its links or parent are stale: report it and
      // hand 'errors' to onDocument so a resume writes it again.
      ctx.report.error({ code: 'DOC_WRITE_FAILED', detail: `${doc.type} ${doc.wpId} "${doc.slug}" (relationship pass): ${message(error)}`, doc: key })
      opts.onDocument?.({ type: doc.type, wpId: doc.wpId, action: 'errors', externalLinks })
    }
  }
  if (!stopped) {
    // Deferred but not yielded again by source(): the pass-1 write stands.
    for (const [key, d] of deferred) {
      const [type, wpId] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))]
      opts.onDocument?.({ type, wpId, action: d.action, externalLinks: d.externalLinks })
    }
  }
  return { deferred: total, stopped }
}

const statusOf = (doc: IRDocument) => (doc.status === 'publish' ? 'published' : 'draft')

type Once = (key: string, issue: Issue) => void
type Lookup = (kind: IdKind, collection: CollectionSlug, wpId: number) => Promise<PayloadId | undefined>

/** IR document → Payload data for one target collection, writing only fields that exist. */
class Mapper {
  readonly #missing: string[] = []

  constructor(
    private readonly ctx: LoaderContext,
    private readonly opts: DocumentsLoaderOptions,
    private readonly target: DocumentTarget,
    private readonly shape: CollectionShape,
    private readonly once: Once,
    private readonly lookup: Lookup,
  ) {}

  private name(irField: string): string {
    return this.target.fields[irField] ?? irField
  }

  /** Target field for an IR field if it exists with the expected kind; warns once otherwise. */
  private field(irField: string, kinds: TargetField['kind'][], fields = this.shape.fields, prefix = ''): TargetField | undefined {
    const name = prefix ? irField : this.name(irField)
    const f = fields.get(name)
    if (f && kinds.includes(f.kind)) return f
    const path = `${prefix}${name}`
    this.once(`field:${this.shape.slug}:${path}`, {
      code: 'FIELD_NOT_IN_TARGET',
      detail: f
        ? `Collection "${this.shape.slug}" field "${path}" is ${f.type}, not ${kinds.join(' or ')}; ${irField} is not written`
        : `Collection "${this.shape.slug}" has no field "${path}"; ${irField} is not written`,
    })
    return undefined
  }

  contentField(): TargetField | undefined {
    return this.field('content', ['richText'])
  }

  wantsParent(doc: IRDocument): boolean {
    if (doc.parentWpId === undefined || doc.parentWpId === 0) return false
    return this.field('parent', ['relationship']) !== undefined
  }

  /** Relationship value for `f` pointing to `collection`, or undefined if `f` cannot hold it. */
  private relation(f: TargetField, collection: string, ids: PayloadId[]): unknown {
    const poly = Array.isArray(f.relationTo)
    if (poly ? !(f.relationTo as string[]).includes(collection) : f.relationTo !== collection) {
      this.once(`rel:${this.shape.slug}:${f.name}:${collection}`, {
        code: 'FIELD_NOT_IN_TARGET',
        detail: `Collection "${this.shape.slug}" field "${f.name}" does not relate to "${collection}"; it is not written`,
      })
      return undefined
    }
    const values = poly ? ids.map((value) => ({ relationTo: collection, value })) : ids
    return f.hasMany ? values : values[0]
  }

  private async ref(kind: IdKind, collection: CollectionSlug, wpId: number): Promise<PayloadId | undefined> {
    const id = await this.lookup(kind, collection, wpId)
    if (id === undefined) this.#missing.push(`${kind} ${wpId}`)
    return id
  }

  async data(doc: IRDocument, out: TransformedDocument): Promise<Record<string, unknown>> {
    const { collections } = this.ctx
    const data: Record<string, unknown> = {}
    const put = (irField: string, kinds: TargetField['kind'][], value: unknown) => {
      if (value === undefined) return
      const f = this.field(irField, kinds)
      if (f) data[f.name] = value
    }
    // WordPress allows posts without a title; Payload templates usually require one. Use what the
    // WordPress admin shows for them.
    let title = out.title
    if (!title.trim()) {
      title = '(no title)'
      this.ctx.report.warning({ code: 'TITLE_EMPTY', doc: `${doc.type}:${doc.wpId}`, detail: 'The WordPress title was empty; written as "(no title)"' })
    }
    put('title', ['text'], title)
    put('slug', ['text'], doc.slug)
    const content = this.contentField()
    if (content) data[content.name] = out.content
    put('excerpt', ['text'], out.excerpt || undefined)
    put('publishedAt', ['date'], doc.publishedAt || undefined)

    const relate = async (irField: string, kind: IdKind, collection: CollectionSlug | undefined, wpIds: number[]) => {
      if (wpIds.length === 0 || collection === undefined) return
      const f = this.field(irField, ['relationship'])
      if (!f) return
      const ids: PayloadId[] = []
      for (const w of wpIds) {
        const id = await this.ref(kind, collection, w)
        if (id !== undefined) ids.push(id)
      }
      if (ids.length === 0) return
      const value = this.relation(f, collection, ids)
      if (value !== undefined) data[f.name] = value
    }
    if (doc.authorWpId) await relate('author', 'author', collections.author, [doc.authorWpId])
    if (doc.featuredMediaWpId) await relate('featuredImage', 'media', this.opts.mediaCollection, [doc.featuredMediaWpId])

    // WordPress term IDs are unique across taxonomies; the taxonomy is found by where the ID is.
    const cats: number[] = []
    const tags: number[] = []
    // Only mapped taxonomies are looked up; a missing target field is still reported by relate().
    const catTo = collections.category
    const tagTo = collections.post_tag
    for (const w of catTo || tagTo ? doc.termWpIds : []) {
      if (catTo && (await this.lookup('category', catTo, w)) !== undefined) cats.push(w)
      else if (tagTo && (await this.lookup('post_tag', tagTo, w)) !== undefined) tags.push(w)
      else this.#missing.push(`term ${w}`)
    }
    await relate('categories', 'category', collections.category, cats)
    await relate('tags', 'post_tag', collections.post_tag, tags)

    if (out.seo) Object.assign(data, await this.seo(out.seo, doc))
    if (this.shape.drafts) data['_status'] = statusOf(doc)
    else if (doc.status !== 'publish') {
      // Without drafts every document is live: say so once instead of publishing drafts silently.
      this.once(`status:${this.shape.slug}`, {
        code: 'STATUS_NOT_KEPT',
        detail: `Collection "${this.shape.slug}" has no drafts; ${doc.status} WordPress content is written as live documents. Enable versions.drafts to keep it unpublished`,
      })
    }
    this.reportMissing(doc)
    return data
  }

  /**
   * Yoast always emits the post's own permalink as canonical. Copied as is, every document would
   * point search engines at the old URL, so only canonicals to other sites are kept.
   */
  private offSite(url: string | undefined, doc: IRDocument): string | undefined {
    if (!url) return undefined
    const parse = (u: string) => {
      try {
        return new URL(u)
      } catch {
        return undefined
      }
    }
    const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '')
    const target = parse(url)
    const site = parse(this.opts.transform.siteOrigin)
    if (!target || (target.protocol !== 'https:' && target.protocol !== 'http:')) return undefined
    if (site && host(target) === host(site)) return undefined
    // Kept, but listed: an off-site canonical is also a known SEO-hijack trick on hacked sites.
    this.ctx.report.warning({ code: 'SEO_CANONICAL_OFFSITE', doc: `${doc.type}:${doc.wpId}`, detail: `Canonical points to ${host(target)}; check it is intended` })
    return target.href
  }

  private async seo(seo: IRSeo, doc: IRDocument): Promise<Record<string, unknown>> {
    const name = this.target.fields['seo'] ?? this.opts.seoField ?? 'meta'
    const values: [string, TargetField['kind'][], unknown][] = [
      ['title', ['text'], seo.title || undefined],
      ['description', ['text'], seo.description || undefined],
      ['canonical', ['text'], this.offSite(seo.canonical, doc)],
      ['noindex', ['checkbox'], seo.noindex],
    ]
    const present = values.filter(([, , v]) => v !== undefined)
    if (present.length === 0 && seo.ogImageWpId === undefined) return {}
    const group = this.shape.fields.get(name)
    if (!group || group.kind !== 'group' || !group.fields) {
      this.once(`field:${this.shape.slug}:${name}`, {
        code: 'FIELD_NOT_IN_TARGET',
        detail: `Collection "${this.shape.slug}" has no group field "${name}"; SEO is not written`,
      })
      return {}
    }
    const sub: Record<string, unknown> = {}
    for (const [key, kinds, v] of present) {
      const f = this.field(key, kinds, group.fields, `${name}.`)
      if (f) sub[f.name] = v
    }
    if (seo.ogImageWpId) {
      const f = this.field('image', ['relationship'], group.fields, `${name}.`)
      const media = this.opts.mediaCollection
      const id = f && media ? await this.ref('media', media, seo.ogImageWpId) : undefined
      const value = f && media && id !== undefined ? this.relation(f, media, [id]) : undefined
      if (f && value !== undefined) sub[f.name] = value
    }
    return Object.keys(sub).length > 0 ? { [name]: sub } : {}
  }

  async parentData(doc: IRDocument): Promise<Record<string, unknown>> {
    const f = this.field('parent', ['relationship'])
    if (!f || !doc.parentWpId) return {}
    const id = await this.ref(doc.type, this.target.collection, doc.parentWpId)
    this.reportMissing(doc)
    const value = id === undefined ? undefined : this.relation(f, this.target.collection, [id])
    return value === undefined ? {} : { [f.name]: value }
  }

  /** One aggregated warning per document, not one per reference. */
  private reportMissing(doc: IRDocument): void {
    if (this.#missing.length === 0) return
    // In a dry run nothing was written in earlier phases, so missing references say nothing.
    if (!this.ctx.dryRun) {
      this.ctx.report.warning({
        code: 'REFERENCE_NOT_MIGRATED',
        detail: `Not migrated, left out: ${this.#missing.join(', ')}`,
        doc: `${doc.type}:${doc.wpId}`,
      })
    }
    this.#missing.length = 0
  }
}
