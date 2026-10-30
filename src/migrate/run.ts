import { rm } from 'node:fs/promises'
import type { CollectionSlug, Payload } from 'payload'
import type { ResolvedConfig } from '../config/index.js'
import type { Extractor, IRDocument, IRMedia, IRTerm } from '../ir/types.js'
import { loadAuthors } from '../loaders/authors.js'
import { loadDocuments } from '../loaders/documents.js'
import { loadMedia } from '../loaders/media.js'
import { loadRedirects } from '../loaders/redirects.js'
import { loadTerms } from '../loaders/terms.js'
import type { DocumentTarget, LoaderContext, RedirectSource } from '../loaders/types.js'
import { buildReport } from '../report/build.js'
import { MemoryReport, type ReportJson } from '../report/types.js'
import { resolve, StateStore } from '../state/store.js'
import { errorRateExceeded, flagLinkHeavy } from './guards.js'
import { DocumentSpill, spillPath } from './spill.js'
import { ensureWorkDir } from './workdir.js'

export const PHASES = ['media', 'terms', 'authors', 'documents', 'redirects'] as const
export type Phase = (typeof PHASES)[number]

// Collection keys that are not document types (doc 4.6).
const NON_DOCUMENT = new Set(['media', 'category', 'post_tag', 'author'])

export interface PipelineOptions {
  root: string
  config: ResolvedConfig
  payload: Payload
  extractor: Extractor
  site: string
  dryRun: boolean
  /** Phases or document types to run; empty means all. */
  only?: readonly string[]
  limit?: number
  concurrency?: number
  fresh?: boolean
  allowSvg?: boolean
  allowEmbedHosts?: readonly string[]
  /** Set by Ctrl+C; checked between items. */
  interrupted?: () => boolean
  onPhase?: (phase: Phase, status: 'start' | 'skip' | 'done', why?: string) => void
}

/**
 * One pass over all phases in doc 2.3 order. Item failures are reported, never thrown; a fatal
 * error (source or database gone) stops the run with `stopped` set, so a report is always written.
 *
 * Resume model: every run processes every selected item again. The state file caches WordPress →
 * Payload IDs, so items that are already migrated cost a lookup and an update, not a download,
 * and nothing can be skipped by mistake. Findings are rebuilt on every run, so the report and
 * `--fail-on-security` always cover the whole site (ADR-0004: the database is the source of truth).
 */
export async function runPipeline(o: PipelineOptions): Promise<ReportJson> {
  const startedAt = new Date()
  const report = new MemoryReport()
  o.extractor.setWarningSink?.((issue) => report.warning(issue))
  await ensureWorkDir(o.root)
  const state = await StateStore.open(o.root, o.site)
  // A cache from another database (wiped, or switched) would point relationships at the wrong rows.
  if (o.fresh || (await isFirstRun(o.payload, o.config, o.site))) state.clear()
  const save = async () => {
    // A dry run never writes the state file; it still reads the cache.
    if (!o.dryRun) await state.flush()
  }

  const { collections } = o.config
  const slug = (kind: string) => (Object.hasOwn(collections, kind) ? (collections[kind]!.to as CollectionSlug) : undefined)
  const kinds = { media: slug('media'), category: slug('category'), post_tag: slug('post_tag'), author: slug('author') }
  const ctx: LoaderContext = {
    payload: o.payload,
    site: o.site,
    dryRun: o.dryRun,
    ids: state,
    report,
    collections: {
      // Only the media loader uses this, and it runs only when media is mapped.
      media: kinds.media ?? ('media' as CollectionSlug),
      ...(kinds.category ? { category: kinds.category } : {}),
      ...(kinds.post_tag ? { post_tag: kinds.post_tag } : {}),
      ...(kinds.author ? { author: kinds.author } : {}),
    },
  }

  const targets: Record<string, DocumentTarget> = Object.create(null)
  for (const kind of documentTypes(o.config)) {
    const c = collections[kind]!
    targets[kind] = { collection: c.to as CollectionSlug, fields: c.fields ?? {} }
  }
  const { phases, types } = selectPhases(o.only, Object.keys(targets))

  let stopped: ReportJson['stopped']
  let current: Phase | 'extract' = 'extract'
  const shouldStop = () => {
    if (stopped) return true
    if (o.interrupted?.()) stopped = { phase: current, reason: 'Interrupted. Run migrate again to continue; migrated items are not written twice.' }
    else if (current !== 'extract' && errorRateExceeded(report.summary[current]))
      stopped = { phase: current, reason: `More than 10% of ${current} failed; stopped so a wrong config does not write bad data` }
    return stopped !== undefined
  }

  let spill: DocumentSpill | undefined
  const links = new Map<string, number>()
  // Documents planned in a dry run (they have no Payload ID yet).
  const planned = new Set<string>()
  let redirects: ReportJson['redirects']
  try {
    // Every document is extracted, even with --only or --limit: the URL resolver needs every
    // permalink, or a targeted run would turn correct internal links back into old-site URLs.
    spill = await DocumentSpill.write(o.root, o.extractor.documents(), shouldStop)
    // The resolver also needs every media URL when the media phase is not selected.
    const media: IRMedia[] = []
    for await (const m of o.extractor.media()) {
      if (shouldStop()) break
      media.push(m)
    }
    const authorsWithContent = spill.authors

    // `enabled` false or a string: the phase is off, and the string says why.
    const run = async (phase: Phase, enabled: boolean | string, body: () => Promise<number | undefined>) => {
      if (shouldStop()) return
      if (!phases.has(phase) || enabled !== true) {
        o.onPhase?.(phase, 'skip', enabled === true ? 'not selected' : enabled || 'not mapped in collections')
        return
      }
      current = phase
      o.onPhase?.(phase, 'start')
      state.updatePhase(phase, { status: 'in_progress' })
      await save()
      const total = await body()
      if (shouldStop()) return
      o.onPhase?.(phase, 'done')
      state.updatePhase(phase, { status: 'done', ...(total !== undefined ? { processed: total, total } : {}) })
      await save()
    }

    await run('media', kinds.media !== undefined, async () => {
      const m = o.config.media
      await loadMedia(ctx, media, {
        root: o.root,
        sourceUrl: sourceUrl(o.config),
        allowedHosts: m.allowedHosts,
        allowSvg: o.allowSvg ?? false,
        reencode: m.reencode,
        maxFileSizeMB: m.maxFileSizeMB,
        concurrency: o.concurrency ?? 4,
        shouldStop,
      })
      return media.length
    })
    await run('terms', kinds.category !== undefined || kinds.post_tag !== undefined, async () => {
      await loadTerms(ctx, mappedTerms(o.extractor.terms(), ctx), { shouldStop })
      return undefined
    })
    await run('authors', kinds.author !== undefined, async () => {
      // Doc 12.9: only users with migrated content.
      await loadAuthors(ctx, o.extractor.authors(), { include: authorsWithContent, shouldStop })
      return undefined
    })

    await run('documents', Object.keys(targets).length > 0, async () => {
      const entries = spill!.entries
      let processed = 0
      const sec = o.config.security
      await loadDocuments(ctx, () => selected(spill!.read(), types, o.limit), {
        targets,
        transform: {
          siteOrigin: sourceUrl(o.config),
          embedHosts: [...sec.embedHosts, ...(o.allowEmbedHosts ?? [])],
          externalLinkRel: sec.externalLinkRel,
          transformers: o.config.transformers,
          root: o.root,
        },
        media,
        documents: entries,
        seoField: o.config.seo.field,
        ...(kinds.media ? { mediaCollection: kinds.media } : {}),
        onDocument: (r) => {
          if (r.action !== 'errors' && r.action !== 'skipped') {
            links.set(`${r.type}:${r.wpId}`, r.externalLinks)
            planned.add(`${r.type}:${r.wpId}`)
          }
          state.updatePhase('documents', { processed: ++processed })
          if (!o.dryRun) void state.flushIfDue()
        },
        shouldStop,
      })
      return processed
    })

    // Doc 2.3 step 6, after every document has its Payload ID.
    await run('redirects', o.config.redirects.enabled || 'redirects.enabled is false', async () => {
      // Every migrated document of the site with a Payload ID, not only this run's: redirects.json is rewritten in
      // full, and `--only redirects` regenerates it from what the database holds.
      const sources: RedirectSource[] = []
      for (const e of spill!.entries) {
        const key = `${e.type}:${e.wpId}`
        const target = Object.hasOwn(targets, e.type) ? targets[e.type] : undefined
        // A document that failed this run but exists from an earlier one keeps its redirect.
        if (!target) continue
        // A dry run has no IDs for new documents; the loader writes nothing then, so any value counts.
        const id = (await resolve(ctx, e.type, target.collection, e.wpId)) ?? (o.dryRun && planned.has(key) ? DRY_RUN_ID : undefined)
        if (id !== undefined) sources.push({ ...e, collection: target.collection, id })
      }
      const r = o.config.redirects
      const routes = o.payload.config.routes as { admin?: string; api?: string } | undefined
      const result = await loadRedirects(ctx, sources, {
        siteUrl: sourceUrl(o.config),
        paths: r.paths,
        collection: r.collection as CollectionSlug,
        root: o.root,
        // Payload's own routes must never be shadowed by a hostile permalink.
        reserved: [routes?.admin, routes?.api].filter((p): p is string => typeof p === 'string' && p.startsWith('/')),
        shouldStop,
      })
      redirects = { count: result.count, conflicts: result.conflicts, ...(result.file ? { file: result.file } : {}) }
      return sources.length
    })
  } catch (error) {
    // Source or database failures outside per-item handling: keep what was done, report why.
    const reason = error instanceof Error ? error.message.split('\n')[0]! : String(error)
    report.error({ code: 'RUN_FAILED', detail: `${current}: ${reason}` })
    stopped = { phase: current, reason }
  } finally {
    // The spill holds raw source content; it is rebuilt on every run, so it never stays behind.
    // By path, not by handle: a failed extraction leaves no handle but may leave a partial file.
    await rm(spillPath(o.root), { force: true })
    await save()
  }

  flagLinkHeavy(report, links)
  return buildReport(report, {
    site: o.site,
    dryRun: o.dryRun,
    startedAt,
    finishedAt: new Date(),
    ...(stopped ? { stopped } : {}),
    ...(redirects ? { redirects } : {}),
  })
}

const DRY_RUN_ID = 'dry-run'

/** IR document types the config maps (everything in `collections` except media, terms and authors). */
export function documentTypes(config: ResolvedConfig): string[] {
  return Object.keys(config.collections).filter((kind) => !NON_DOCUMENT.has(kind))
}

/** `--only media,posts`: phase names, or document types (which imply the documents phase). */
export function selectPhases(only: readonly string[] | undefined, docTypes: readonly string[]): {
  phases: Set<Phase>
  types: Set<string> | undefined
} {
  if (!only || only.length === 0) return { phases: new Set(PHASES), types: undefined }
  const phases = new Set<Phase>()
  const types = new Set<string>()
  for (const raw of only) {
    const name = raw.trim().toLowerCase()
    if ((PHASES as readonly string[]).includes(name)) phases.add(name as Phase)
    else {
      // Accept plurals the way people type them: posts, pages.
      const type = docTypes.find((t) => t === name || `${t}s` === name)
      if (!type) throw new OnlyError(raw, docTypes)
      phases.add('documents')
      types.add(type)
    }
  }
  return { phases, types: types.size ? types : undefined }
}

export class OnlyError extends Error {
  readonly exitCode = 2 as const
  constructor(value: string, docTypes: readonly string[]) {
    super(`--only: unknown phase or type "${value}". Use ${[...PHASES, ...docTypes.map((t) => `${t}s`)].join(', ')}.`)
    this.name = 'OnlyError'
  }
}

/** Document types chosen with --only, then the first `limit` of them. */
async function* selected(docs: AsyncIterable<IRDocument>, types: Set<string> | undefined, limit?: number): AsyncIterable<IRDocument> {
  let n = 0
  for await (const d of docs) {
    if (types && !types.has(d.type)) continue
    if (limit !== undefined && n >= limit) return
    n++
    yield d
  }
}

/** Terms of taxonomies with no target collection are left out silently; the phase reports the rest. */
async function* mappedTerms(terms: AsyncIterable<IRTerm>, ctx: LoaderContext): AsyncIterable<IRTerm> {
  for await (const t of terms) {
    if (t.taxonomy === 'category' && !ctx.collections.category) continue
    if (t.taxonomy === 'post_tag' && !ctx.collections.post_tag) continue
    yield t
  }
}

function sourceUrl(config: ResolvedConfig): string {
  return config.source.type === 'rest' ? config.source.url : ''
}

/** Doc 4.2: first run = no document in the database carries this source's wpMeta.site. */
export async function isFirstRun(payload: Payload, config: ResolvedConfig, site: string): Promise<boolean> {
  for (const c of Object.values(config.collections)) {
    const slug = c.to as CollectionSlug
    if (!payload.collections[slug]) continue
    const { totalDocs } = await payload.count({ collection: slug, where: { 'wpMeta.site': { equals: site } }, overrideAccess: true })
    if (totalDocs > 0) return false
  }
  return true
}
