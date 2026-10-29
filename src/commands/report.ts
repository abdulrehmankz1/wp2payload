import type { Env } from '../config/types.js'
import { formatSummary } from '../report/summary.js'
import { readReport, REPORT_PATH, ReportCorruptError } from '../report/write.js'
import { colorEnabled, formatLine } from '../ui/output.js'

export interface ReportOptions {
  cwd?: string
  /** Print the raw report.json instead of the summary. */
  json?: boolean
  verbose?: boolean
  log?: (line: string) => void
  env?: Env
}

// `wp2payload report [--json]`: reprints the last run's summary. Returns the process exit code.
export async function runReport(opts: ReportOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const log = opts.log ?? console.log
  const color = colorEnabled(process.stdout, opts.env ?? process.env)
  let report
  try {
    report = await readReport(cwd)
  } catch (error) {
    if (!(error instanceof ReportCorruptError)) throw error
    log(formatLine('fail', 'The last report cannot be read', error.message, color))
    return 1
  }
  if (!report) {
    log('No report yet. Run `wp2payload migrate --dry-run` first.')
    return 1
  }
  if (opts.json) {
    // JSON.stringify escapes C0 only; escape C1 and bidi controls too so the output stays inert.
    log(JSON.stringify(report, null, 2).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))
    return 0
  }
  const summaryOpts = opts.verbose ? { color, reportPath: REPORT_PATH, verbose: true } : { color, reportPath: REPORT_PATH }
  for (const line of formatSummary(report, summaryOpts)) log(line)
  return 0
}
