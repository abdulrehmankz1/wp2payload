import type { ResolvedConfig } from '../config/index.js'
import type { OpenedSource } from '../extractors/source.js'
import type { IRMedia, SourceInfo } from '../ir/types.js'
import { flagLinkHeavy } from '../migrate/guards.js'
import { MemoryReport, type Issue, type SecurityFinding, type Severity } from '../report/types.js'
import { MediaError, SecurityError, inspectMedia, safeDownload } from '../security/index.js'
import { secureDocument } from '../transform/index.js'

// `wp2payload scan` (doc F18): the security and content health of a source, without Payload and
// without writing anything but the report. Documents run through the same scan and sanitizer as
// a migration, and media through the same download guard and verification.

export interface ScanOptions {
  root: string
  config: ResolvedConfig
  source: OpenedSource
  info: SourceInfo
  siteUrl: string
  /** Download or read and verify every media file (default true). */
  media?: boolean
  limit?: number
  concurrency?: number
  allowSvg?: boolean
  allowEmbedHosts?: readonly string[]
  onPhase?: (phase: 'media' | 'documents', status: 'start' | 'done', count: number) => void
}

export interface ScanReport {
  version: 1
  kind: 'scan'
  source: ResolvedConfig['source']['type']
  site: string
  startedAt: string
  durationSec: number
  inventory: Pick<SourceInfo, 'counts' | 'seoPlugin' | 'unmigratedTypes'>
  documents: {
    scanned: number
    byType: Record<string, number>
    pageBuilders: Record<string, number>
    /** Documents carrying an SEO title, description or noindex. */
    seo: { title: number; description: number; noindex: number }
  }
  media: { scanned: number; clean: number; rejected: number; errors: number; skipped: boolean }
  warnings: Issue[]
  errors: Issue[]
  security: { summary: Record<Severity, number>; findings: SecurityFinding[] }
}

export async function runScan(o: ScanOptions): Promise<ScanReport> {
  const started = new Date()
  const report = new MemoryReport()
  o.source.extractor.setWarningSink?.((issue) => report.warning(issue))
  const out: ScanReport = {
    version: 1,
    kind: 'scan',
    source: o.config.source.type,
    site: o.siteUrl,
    startedAt: started.toISOString(),
    durationSec: 0,
    inventory: { counts: o.info.counts, ...(o.info.seoPlugin ? { seoPlugin: o.info.seoPlugin } : {}), ...(o.info.unmigratedTypes ? { unmigratedTypes: o.info.unmigratedTypes } : {}) },
    documents: { scanned: 0, byType: {}, pageBuilders: {}, seo: { title: 0, description: 0, noindex: 0 } },
    media: { scanned: 0, clean: 0, rejected: 0, errors: 0, skipped: o.media === false },
    warnings: report.warnings,
    errors: report.errors,
    security: { summary: { high: 0, medium: 0, low: 0 }, findings: report.findings },
  }

  if (o.media !== false) {
    o.onPhase?.('media', 'start', 0)
    await scanMedia(o, report, out.media)
    o.onPhase?.('media', 'done', out.media.scanned)
  }

  o.onPhase?.('documents', 'start', 0)
  const sec = o.config.security
  const links = new Map<string, number>()
  for await (const doc of o.source.extractor.documents()) {
    const { externalLinks } = await secureDocument(doc, {
      siteOrigin: o.siteUrl,
      embedHosts: [...sec.embedHosts, ...(o.allowEmbedHosts ?? [])],
      externalLinkRel: sec.externalLinkRel,
      transformers: o.config.transformers,
      report,
      root: o.root,
      dryRun: true,
    })
    links.set(`${doc.type}:${doc.wpId}`, externalLinks)
    const d = out.documents
    d.scanned++
    d.byType[doc.type] = (d.byType[doc.type] ?? 0) + 1
    const builder = doc.meta['pageBuilder']
    if (typeof builder === 'string') d.pageBuilders[builder] = (d.pageBuilders[builder] ?? 0) + 1
    if (doc.seo?.title) d.seo.title++
    if (doc.seo?.description) d.seo.description++
    if (doc.seo?.noindex) d.seo.noindex++
    if (o.limit !== undefined && d.scanned >= o.limit) break
  }
  flagLinkHeavy(report, links)
  o.onPhase?.('documents', 'done', out.documents.scanned)

  for (const f of report.findings) out.security.summary[f.severity]++
  out.durationSec = (Date.now() - started.getTime()) / 1000
  return out
}

async function scanMedia(o: ScanOptions, report: MemoryReport, counts: ScanReport['media']): Promise<void> {
  const m = o.config.media
  const maxBytes = m.maxFileSizeMB * 1024 * 1024
  // The same trust as a migration: the source-host exception only for a host the user named.
  const site = new URL(o.siteUrl)
  const trusted = o.source.trustSiteHost
  const download = (url: string) =>
    safeDownload(url, {
      sourceHost: trusted ? site.hostname : '',
      ...(trusted && site.port ? { sourcePort: Number(site.port) } : {}),
      allowedHosts: trusted ? m.allowedHosts : [...m.allowedHosts, site.hostname],
      maxBytes,
    })
  let exceptionReported = false

  const one = async (item: IRMedia) => {
    counts.scanned++
    try {
      let bytes: Buffer
      if (item.localPath !== undefined && o.source.readLocalMedia) bytes = await o.source.readLocalMedia(item.localPath, maxBytes)
      else {
        const got = await download(item.sourceUrl)
        if (got.sourceHostException && !exceptionReported) {
          exceptionReported = true
          report.warning({ code: 'MEDIA_SOURCE_HOST_EXCEPTION', detail: `Media from ${site.host} was fetched over a local or private address (doc 12.6)` })
        }
        bytes = got.bytes
      }
      const inspected = await inspectMedia({ bytes, filename: item.filename, declaredMime: item.mimeType, allowSvg: o.allowSvg ?? false, reencode: m.reencode })
      if (!inspected.ok) {
        report.finding({ ...inspected.finding, media: item.wpId, file: item.sourceUrl })
        counts.rejected++
        return
      }
      for (const f of inspected.findings) report.finding({ ...f, media: item.wpId })
      counts.clean++
    } catch (error) {
      if (error instanceof SecurityError) {
        report.finding({ code: error.code, severity: 'high', action: 'rejected', media: item.wpId, file: item.sourceUrl, detail: error.message })
        counts.rejected++
      } else if (error instanceof MediaError) {
        report.error({ code: error.code, media: item.wpId, detail: error.message })
        counts.errors++
      } else throw error
    }
  }

  const inflight = new Set<Promise<void>>()
  for await (const item of o.source.extractor.media()) {
    const p = one(item).finally(() => inflight.delete(p))
    inflight.add(p)
    if (inflight.size >= (o.concurrency ?? 4)) await Promise.race(inflight)
  }
  await Promise.all(inflight)
}
