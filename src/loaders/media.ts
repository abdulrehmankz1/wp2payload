import type { IRMedia } from '../ir/types.js'
import type { SecurityFinding } from '../report/types.js'
import { MediaError, SecurityError, inspectMedia, safeDownload, writeQuarantine, type DownloadResult } from '../security/index.js'
import { withRetry, type RetryOptions } from '../state/retry.js'
import type { LoaderContext } from './types.js'
import { findByWpMeta, upsertByWpMeta, type PayloadId } from './wpmeta.js'

const PHASE = 'media'

export interface MediaLoaderOptions {
  root: string // project folder; quarantine goes under <root>/.wp2payload/quarantine
  sourceUrl: string // configured source.url: the only host allowed the local/http exception
  allowedHosts?: readonly string[]
  allowSvg?: boolean
  reencode?: boolean
  maxFileSizeMB?: number
  concurrency?: number
  /** Checked before each item: Ctrl+C or the error-rate stop (doc 2.8). */
  shouldStop?: () => boolean
  retry?: RetryOptions
  // Injected in tests; defaults to the guarded downloader.
  download?: (url: string) => Promise<DownloadResult>
  /** Wraps the downloader, e.g. to reuse the first-run preview's downloads. */
  wrapDownload?: (download: (url: string) => Promise<DownloadResult>) => (url: string) => Promise<DownloadResult>
}

/**
 * Media first (doc 2.3): download through the SSRF guard, verify by content, re-encode, hash the
 * original bytes, then upsert. Already-migrated items only get their alt/caption refreshed, so a
 * resumed run does not download them again. A file whose hash already exists under another
 * WordPress ID is reused, not uploaded twice (doc 2.5).
 */
export async function loadMedia(
  ctx: LoaderContext,
  media: AsyncIterable<IRMedia> | Iterable<IRMedia>,
  opts: MediaLoaderOptions,
): Promise<void> {
  const source = new URL(opts.sourceUrl)
  const base =
    opts.download ??
    ((url: string) =>
      safeDownload(url, {
        sourceHost: source.hostname,
        ...(source.port ? { sourcePort: Number(source.port) } : {}),
        allowedHosts: opts.allowedHosts ?? [],
        maxBytes: (opts.maxFileSizeMB ?? 50) * 1024 * 1024,
      }))
  const download = opts.wrapDownload ? opts.wrapDownload(base) : base
  let exceptionReported = false
  // Uploads in flight by original hash, so two items with the same bytes in one batch
  // share one document instead of racing past findBySha.
  const inflight = new Map<string, Promise<PayloadId | undefined>>()

  const one = async (m: IRMedia): Promise<void> => {
    const collection = ctx.collections.media
    try {
      // The database decides (ADR-0004): a cached ID may point at a wiped or deleted document.
      const own = await findByWpMeta(ctx.payload, collection, ctx.site, m.wpId)
      if (own !== undefined) {
        ctx.ids.set('media', m.wpId, own)
        if (!ctx.dryRun) {
          await withRetry(() => ctx.payload.update({ collection, id: own, data: describe(m) as never, depth: 0, overrideAccess: true }), opts.retry)
        }
        ctx.report.count(PHASE, 'updated')
        return
      }
      // A cached ID with no own document is a reuse of another item's file (same bytes).
      // Keep it when that document still exists; never overwrite its alt or caption.
      const cached = ctx.ids.get('media', m.wpId)
      if (cached !== undefined && (await exists(ctx, cached))) {
        ctx.report.count(PHASE, 'reused')
        return
      }
      if (m.localPath) {
        // SQL-dump mode reads from the uploads folder inside its sandbox (v1.1).
        ctx.report.count(PHASE, 'errors')
        ctx.report.error({ code: 'MEDIA_LOCAL_UNSUPPORTED', media: m.wpId, detail: 'Local media files are supported from v1.1, with the SQL backup source' })
        return
      }

      const got = await download(m.sourceUrl)
      if (got.sourceHostException && !exceptionReported) {
        exceptionReported = true
        ctx.report.warning({ code: 'MEDIA_SOURCE_HOST_EXCEPTION', detail: `Media from ${source.host} was fetched over a local or private address (doc 12.6)` })
      }

      const inspected = await inspectMedia({
        bytes: got.bytes,
        filename: m.filename,
        declaredMime: m.mimeType,
        allowSvg: opts.allowSvg ?? false,
        reencode: opts.reencode ?? true,
      })
      if (!inspected.ok) {
        const finding: SecurityFinding = { ...inspected.finding, media: m.wpId, file: m.sourceUrl }
        if (!ctx.dryRun) {
          finding.quarantine = await writeQuarantine(opts.root, { kind: 'files', name: inspected.quarantine.name, bytes: inspected.quarantine.bytes, finding })
        }
        ctx.report.finding(finding)
        ctx.report.count(PHASE, 'rejected')
        return
      }
      for (const f of inspected.findings) ctx.report.finding({ ...f, media: m.wpId })

      const pending = inflight.get(inspected.sha256)
      const duplicate = pending ? await pending : await findBySha(ctx, inspected.sha256)
      if (duplicate !== undefined) {
        ctx.ids.set('media', m.wpId, duplicate)
        ctx.report.count(PHASE, 'reused')
        return
      }
      if (ctx.dryRun) {
        ctx.report.count(PHASE, 'created')
        return
      }
      const upload = withRetry(
        () =>
          upsertByWpMeta(ctx.payload, {
            collection,
            meta: { site: ctx.site, wpId: m.wpId, link: m.sourceUrl, sha256: inspected.sha256 },
            data: describe(m),
            file: { data: inspected.output, mimetype: inspected.mime, name: inspected.filename, size: inspected.output.length },
          }),
        opts.retry,
      )
      inflight.set(
        inspected.sha256,
        upload.then((r) => r.id, () => undefined),
      )
      const res = await upload
      ctx.ids.set('media', m.wpId, res.id)
      ctx.report.count(PHASE, res.action)
    } catch (error) {
      if (error instanceof SecurityError) {
        ctx.report.finding({ code: error.code, severity: 'high', action: 'rejected', media: m.wpId, file: m.sourceUrl, detail: error.message })
        ctx.report.count(PHASE, 'rejected')
        return
      }
      ctx.report.count(PHASE, 'errors')
      const code = error instanceof MediaError ? error.code : 'MEDIA_WRITE_FAILED'
      ctx.report.error({ code, media: m.wpId, detail: `${m.sourceUrl}: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  await pool(media, opts.concurrency ?? 4, one, opts.shouldStop)
}

function describe(m: IRMedia): Record<string, unknown> {
  return { alt: m.alt ?? null, caption: m.caption ?? null }
}

async function exists(ctx: LoaderContext, id: PayloadId): Promise<boolean> {
  const doc = await ctx.payload.findByID({ collection: ctx.collections.media, id, depth: 0, disableErrors: true, overrideAccess: true })
  return doc != null
}

async function findBySha(ctx: LoaderContext, sha256: string): Promise<PayloadId | undefined> {
  const found = await ctx.payload.find({
    collection: ctx.collections.media,
    where: { and: [{ 'wpMeta.site': { equals: ctx.site } }, { 'wpMeta.sha256': { equals: sha256 } }] },
    limit: 1,
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })
  return (found.docs[0] as { id?: PayloadId } | undefined)?.id
}

// Bounded concurrency without buffering the whole source (doc 1.7: memory stays flat).
async function pool<T>(
  items: AsyncIterable<T> | Iterable<T>,
  size: number,
  run: (item: T) => Promise<void>,
  stop?: () => boolean,
): Promise<void> {
  const active = new Set<Promise<void>>()
  for await (const item of items) {
    if (stop?.()) break
    const p: Promise<void> = run(item).finally(() => active.delete(p))
    active.add(p)
    if (active.size >= size) await Promise.race(active)
  }
  await Promise.all(active)
}
