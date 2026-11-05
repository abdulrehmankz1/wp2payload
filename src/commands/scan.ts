import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig, resolveConfig, type ResolvedConfig } from '../config/index.js'
import type { Env } from '../config/types.js'
import { isSourceError, openSource, type OpenedSource } from '../extractors/source.js'
import { ensureWorkDir } from '../migrate/workdir.js'
import { SEVERITY_RANK } from '../report/build.js'
import { clean, formatDuration, issueLines, securityLines } from '../report/summary.js'
import type { Severity } from '../report/types.js'
import { renderScanHtml } from '../scan/html.js'
import { runScan, type ScanReport } from '../scan/run.js'
import { STATE_DIR } from '../state/store.js'
import { colorEnabled, formatLine } from '../ui/output.js'

export interface ScanCommandOptions {
  cwd?: string
  configPath?: string
  /** A site URL, export file or backup to scan instead of the configured source. */
  target?: string
  /** SQL dumps given as a target: the uploads folder next to it. */
  uploads?: string
  media?: boolean
  limit?: number
  concurrency?: number
  allowSvg?: boolean
  allowEmbedHosts?: string[]
  failOnSecurity?: Severity
  json?: boolean
  verbose?: boolean
  version?: string
  env?: Env
  log?: (line: string) => void
  // Injected in tests.
  open?: (config: ResolvedConfig, cwd: string) => Promise<OpenedSource>
}

export const SCAN_JSON = 'scan.json'
export const SCAN_HTML = 'scan.html'

/** The source a target names: a URL is a live site, otherwise the file extension decides. */
export function sourceFor(target: string, cwd: string, uploads: string | undefined, env: Env): { source: Record<string, unknown>; media?: false } {
  if (/^https?:\/\//i.test(target)) {
    const auth = env['WP_USER'] && env['WP_APP_PASSWORD'] ? { auth: { user: env['WP_USER'], appPassword: env['WP_APP_PASSWORD'] } } : {}
    return { source: { type: 'rest', url: target, ...auth } }
  }
  const lower = target.toLowerCase()
  if (lower.endsWith('.wpress')) return { source: { type: 'wpress', file: target } }
  if (lower.endsWith('.xml')) return { source: { type: 'wxr', file: target } }
  if (lower.endsWith('.sql') || lower.endsWith('.sql.gz')) {
    const dir = uploads ?? path.join(path.dirname(target), 'uploads')
    // Without an uploads folder the content is still scanned; the media is not.
    return { source: { type: 'sql', file: target, uploadsDir: dir }, ...(existsSync(path.resolve(cwd, dir)) ? {} : { media: false as const }) }
  }
  throw new ConfigError(`Cannot tell what ${JSON.stringify(target)} is. Pass a site URL (https://...), an export file (.xml), a SQL dump (.sql, .sql.gz) or a .wpress backup.`)
}

/** `wp2payload scan` (doc F18). Returns the process exit code: 0, 1 source failed, 2 usage, 4 findings at --fail-on-security. */
export async function runScanCommand(opts: ScanCommandOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const log = opts.log ?? console.log
  const env = opts.env ?? process.env
  const color = colorEnabled(process.stdout, env)

  let config: ResolvedConfig
  let media = opts.media !== false
  try {
    if (opts.target) {
      const t = sourceFor(opts.target, cwd, opts.uploads, env)
      if (t.media === false && media) {
        media = false
        log(formatLine('warn', 'No uploads folder next to the dump: media is not checked', 'Pass --uploads <dir> to check it.'))
      }
      config = resolveConfig({ source: t.source }, env)
    } else {
      const file = opts.configPath ?? DEFAULT_CONFIG_FILE
      if (!opts.configPath && !existsSync(path.resolve(cwd, file))) {
        log(formatLine('fail', `No ${DEFAULT_CONFIG_FILE} found`, 'Pass what to scan: wp2payload scan https://example.com (or an export file or backup).'))
        return 2
      }
      config = await loadConfig(file, cwd, env)
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    log(formatLine('fail', opts.target ? error.message : 'Invalid configuration', opts.target ? undefined : error.message))
    return error.exitCode
  }

  let report: ScanReport
  try {
    const source = await (opts.open ?? openSource)(config, cwd)
    const info = await source.extractor.probe()
    const siteUrl = source.configuredUrl ?? info.siteUrl
    log(formatLine('ok', `${source.label} ${clean(info.siteUrl)}`))
    report = await runScan({
      root: cwd,
      config,
      source,
      info,
      siteUrl,
      media,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      allowSvg: opts.allowSvg === true,
      allowEmbedHosts: opts.allowEmbedHosts ?? [],
      onPhase: (phase, status) => {
        if (status === 'start') log(`${phase}...`)
      },
    })
  } catch (error) {
    if (!isSourceError(error)) throw error
    const [title = error.message, ...rest] = error.message.split('\n')
    log(rest.length ? formatLine('fail', title, rest.join('\n')) : formatLine('fail', title))
    return 1
  }

  const dir = await ensureWorkDir(cwd)
  await writeFile(path.join(dir, SCAN_JSON), JSON.stringify(report, null, 2) + '\n', 'utf8')
  await writeFile(path.join(dir, SCAN_HTML), renderScanHtml(report, { version: opts.version ?? 'dev' }), 'utf8')

  if (opts.json) log(JSON.stringify(report, null, 2))
  else for (const line of formatScan(report, { color, verbose: opts.verbose === true })) log(line)

  if (opts.failOnSecurity) {
    const min = SEVERITY_RANK[opts.failOnSecurity]
    if (report.security.findings.some((f) => SEVERITY_RANK[f.severity] >= min)) return 4
  }
  return 0
}

export function formatScan(r: ScanReport, opts: { color: boolean; verbose: boolean }): string[] {
  const paint = (code: number, text: string) => (opts.color ? `\u001b[${code}m${text}\u001b[0m` : text)
  const d = r.documents
  const builders = Object.entries(d.pageBuilders).map(([k, n]) => `${n} built with ${clean(k)}`).join(', ')
  const m = r.media
  const lines = [
    paint(1, `Scan of ${clean(r.site)} finished in ${formatDuration(r.durationSec)}. Nothing was migrated.`),
    '',
    ` documents     ${d.scanned} scanned${builders ? ` (${builders})` : ''}`,
    ` media         ${m.skipped ? 'not checked' : `${m.scanned} checked: ${m.clean} clean, ${m.rejected} rejected, ${m.errors} unreadable`}`,
    ` SEO           ${d.seo.title} titles, ${d.seo.description} descriptions${d.seo.noindex ? `, ${d.seo.noindex} noindex` : ''}`,
  ]
  const other = r.inventory.unmigratedTypes
  if (other?.length) lines.push(` not migrated  ${other.map((t) => `${t.count} ${clean(t.type)}`).join(', ')}`)
  lines.push('', ...issueLines('Warnings', r.warnings, 33, '!', opts.verbose, paint), ...issueLines('Errors', r.errors, 31, '✖', opts.verbose, paint))
  lines.push('', ...securityLines(r.security.findings, opts.color))
  lines.push(`Report: ${STATE_DIR}/${SCAN_HTML} (data in ${STATE_DIR}/${SCAN_JSON})`)
  return lines
}
