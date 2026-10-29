import type { MemoryReport, ReportJson, SecurityFinding, Severity } from './types.js'

export interface BuildMeta {
  /** siteKey() of the source. */
  site: string
  dryRun: boolean
  startedAt: Date
  /** Defaults to now. */
  finishedAt?: Date
  stopped?: ReportJson['stopped']
  redirects?: ReportJson['redirects']
}

export const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 }

/** Turns what the loaders reported into report.json (doc 4.9). Copies everything, adds nothing. */
export function buildReport(report: MemoryReport, meta: BuildMeta): ReportJson {
  const finished = meta.finishedAt ?? new Date()
  const ms = Math.max(0, finished.getTime() - meta.startedAt.getTime())
  const findings: SecurityFinding[] = report.findings
    .map((f) => ({ ...f }))
    // Array.prototype.sort is stable, so findings keep their order within a severity.
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const severity: Record<Severity, number> = { high: 0, medium: 0, low: 0 }
  for (const f of findings) severity[f.severity]++

  const json: ReportJson = {
    version: 1,
    dryRun: meta.dryRun,
    site: meta.site,
    startedAt: meta.startedAt.toISOString(),
    durationSec: Math.round(ms / 100) / 10,
    summary: structuredClone(report.summary),
    warnings: report.warnings.map((i) => ({ ...i })),
    errors: report.errors.map((i) => ({ ...i })),
    security: { summary: severity, findings },
  }
  if (meta.redirects) json.redirects = { ...meta.redirects }
  if (meta.stopped) json.stopped = { ...meta.stopped }
  return json
}
