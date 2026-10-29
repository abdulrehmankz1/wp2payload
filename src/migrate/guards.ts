import type { CountAction, MemoryReport, ReportSink } from '../report/types.js'
import { linkHeavyFinding } from '../security/content/index.js'

// Doc 2.8: a phase stops when more than 10% of its items fail, so a wrong config does not
// produce thousands of bad writes. The minimum keeps one early failure from stopping a run.
export const ERROR_RATE = 0.1
export const ERROR_RATE_MIN_ITEMS = 20

export function errorRateExceeded(counts: Partial<Record<CountAction, number>> | undefined): boolean {
  if (!counts) return false
  // Only attempted writes: skipped, reused and rejected items say nothing about a wrong config.
  const errors = counts.errors ?? 0
  const total = (counts.created ?? 0) + (counts.updated ?? 0) + errors
  return total >= ERROR_RATE_MIN_ITEMS && errors / total > ERROR_RATE
}

/** Stop signal for loaders: true once the phase in `report` has crossed the threshold. */
export function phaseGuard(report: MemoryReport, phase: string): () => boolean {
  return () => errorRateExceeded(report.summary[phase])
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Doc 12.5: flag documents with far more external links than the site's median post. */
export function flagLinkHeavy(report: ReportSink, counts: ReadonlyMap<string, number>): void {
  const m = median([...counts.values()])
  for (const [doc, n] of counts) {
    const finding = linkHeavyFinding(n, m, doc)
    if (finding) report.finding(finding)
  }
}
