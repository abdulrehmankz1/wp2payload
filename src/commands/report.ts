import path from 'node:path'
import type { Env } from '../config/types.js'
import { renderSecurityReportHtml, SECURITY_HTML_PATH } from '../report/security-html.js'
import { formatSummary } from '../report/summary.js'
import { readReport, REPORT_PATH, ReportCorruptError, writeAtomic } from '../report/write.js'
import { colorEnabled, formatLine } from '../ui/output.js'

export interface ReportOptions {
  cwd?: string
  /** Print the raw report.json instead of the summary. */
  json?: boolean
  /**
   * Export the report as HTML: `true` for `.wp2payload/security-report.html`, or a path, resolved
   * against `cwd` (the CLI resolves it against the folder the user typed it in).
   */
  html?: boolean | string
  verbose?: boolean
  /** wp2payload version, shown in the HTML report. */
  version?: string
  log?: (line: string) => void
  env?: Env
}

// `wp2payload report [--json | --html [path]]`: reprints or exports the last run's report. Returns the process exit code.
export async function runReport(opts: ReportOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const log = opts.log ?? console.log
  const color = colorEnabled(process.stdout, opts.env ?? process.env)
  if (opts.json && opts.html) {
    log(formatLine('fail', '--json and --html cannot be used together', 'Pick one: --json prints report.json, --html writes the HTML report.', color))
    return 2
  }
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
  if (opts.html) {
    const target = path.resolve(cwd, typeof opts.html === 'string' ? opts.html : SECURITY_HTML_PATH)
    // The export must never replace the data it was made from.
    if (target === path.resolve(cwd, REPORT_PATH) || path.extname(target).toLowerCase() === '.json') {
      log(formatLine('fail', `Will not write HTML to ${path.basename(target)}`, 'Pass a path ending in .html, or no path for .wp2payload/security-report.html.', color))
      return 2
    }
    await writeAtomic(target, renderSecurityReportHtml(report, opts.version ? { version: opts.version } : {}))
    const shown = path.relative(cwd, target)
    log(formatLine('ok', `Wrote ${shown && !shown.startsWith('..') && !path.isAbsolute(shown) ? shown.split(path.sep).join('/') : target}`, undefined, color))
    return 0
  }
  if (opts.json) {
    // JSON.stringify escapes C0 only; escape C1 and bidi controls too so the output stays inert.
    log(JSON.stringify(report, null, 2).replace(/[\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))
    return 0
  }
  const summaryOpts = opts.verbose ? { color, reportPath: REPORT_PATH, verbose: true } : { color, reportPath: REPORT_PATH }
  for (const line of formatSummary(report, summaryOpts)) log(line)
  return 0
}
