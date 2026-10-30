import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Payload } from 'payload'
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig, type ResolvedConfig } from '../config/index.js'
import type { Env } from '../config/types.js'
import { RestError, RestExtractor } from '../extractors/rest/index.js'
import type { Extractor, IRDocument } from '../ir/types.js'
import { siteKey } from '../loaders/wpmeta.js'
import { DownloadCache } from '../migrate/download-cache.js'
import { documentTypes, isFirstRun, OnlyError, runPipeline, selectPhases, type Phase } from '../migrate/run.js'
import { StateCorruptError } from '../state/store.js'
import { bootPayload } from '../payload/boot.js'
import { PayloadBootError } from '../payload/errors.js'
import { preflight } from '../payload/preflight.js'
import { exitCode } from '../report/exit.js'
import { clean, formatSummary } from '../report/summary.js'
import type { ReportJson, Severity } from '../report/types.js'
import { writeReport } from '../report/write.js'
import { colorEnabled, formatLine } from '../ui/output.js'

export interface MigrateOptions {
  cwd?: string
  configPath?: string
  dryRun?: boolean
  only?: string[]
  limit?: number
  concurrency?: number
  fresh?: boolean
  strict?: boolean
  failOnSecurity?: Severity
  allowSvg?: boolean
  allowEmbedHosts?: string[]
  yes?: boolean
  verbose?: boolean
  env?: Env
  log?: (line: string) => void
  /** Interactive confirmation; defaults to a readline prompt when stdin is a TTY. */
  confirm?: (question: string) => Promise<boolean>
  isTTY?: boolean
  // Injected in tests.
  createExtractor?: (config: ResolvedConfig) => Extractor
  boot?: (cwd: string, configPath?: string) => Promise<{ payload: Payload; configPath?: string; close(): Promise<void> }>
}

/** `wp2payload migrate` (doc 4.1-4.3). Returns the process exit code. */
export async function runMigrate(opts: MigrateOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const log = opts.log ?? console.log
  const env = opts.env ?? process.env
  const color = colorEnabled(process.stdout, env)

  let config: ResolvedConfig
  try {
    config = await loadConfig(opts.configPath ?? DEFAULT_CONFIG_FILE, cwd, env)
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    log(formatLine('fail', 'Invalid configuration', error.message))
    return error.exitCode
  }
  if (config.source.type !== 'rest') {
    log(formatLine('fail', `Source type "${config.source.type}" is not supported yet`, 'Only the REST source works in this version.'))
    return 1
  }
  // Usage errors before anything connects (doc 2.8).
  try {
    selectPhases(opts.only, documentTypes(config))
  } catch (error) {
    if (!(error instanceof OnlyError)) throw error
    log(formatLine('fail', error.message))
    return error.exitCode
  }

  // Doc 2.8: an unreachable source fails before anything is written.
  const extractor = (opts.createExtractor ?? defaultExtractor)(config)
  try {
    const info = await extractor.probe()
    log(formatLine('ok', `WordPress at ${clean(info.siteUrl)}`))
  } catch (error) {
    if (!(error instanceof RestError)) throw error
    const [title = error.message, ...rest] = error.message.split('\n')
    log(rest.length ? formatLine('fail', title, rest.join('\n')) : formatLine('fail', title))
    return 1
  }

  let booted: { payload: Payload; configPath?: string; close(): Promise<void> }
  try {
    booted = await (opts.boot ?? ((c, p) => bootPayload(p ? { cwd: c, configPath: p } : { cwd: c })))(cwd, env['PAYLOAD_CONFIG_PATH'])
  } catch (error) {
    if (!(error instanceof PayloadBootError)) throw error
    log(formatLine('fail', error.message))
    return error.exitCode
  }
  // User code runs from here on; say which file it was (a config can be found in a parent folder).
  if (booted.configPath) log(formatLine('ok', `Payload config ${path.relative(cwd, booted.configPath) || booted.configPath}`))

  // Ctrl+C: finish the current item, save state, report what was done. A second Ctrl+C exits at once.
  let interrupted = false
  const onSigint = () => {
    if (interrupted) process.exit(130)
    interrupted = true
    log(formatLine('warn', 'Stopping after the current item. Press Ctrl+C again to quit now.'))
  }
  process.on('SIGINT', onSigint)

  let downloadCache: DownloadCache | undefined
  try {
    const checks = preflight(booted.payload, config)
    const failed = checks.filter((c) => c.status === 'fail')
    for (const c of opts.verbose ? checks : failed) log(formatLine(c.status, c.title, c.detail))
    if (failed.length) return 1

    const site = siteKey(config.source.url)
    const pipeline = (dryRun: boolean) =>
      runPipeline({
        root: cwd,
        config,
        payload: booted.payload,
        extractor,
        site,
        dryRun,
        ...(opts.only ? { only: opts.only } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        fresh: opts.fresh === true,
        allowSvg: opts.allowSvg === true,
        allowEmbedHosts: opts.allowEmbedHosts ?? [],
        ...(downloadCache ? { downloadCache } : {}),
        interrupted: () => interrupted,
        onPhase: (phase, status, why) => progress(log, phase, status, why, opts.verbose === true),
      })

    const finish = async (json: ReportJson) => {
      const reportPath = await writeReport(cwd, json)
      for (const line of formatSummary(json, { color, reportPath, verbose: opts.verbose === true })) log(line)
      return exitCode({ report: json, strict: opts.strict === true, ...(opts.failOnSecurity ? { failOnSecurity: opts.failOnSecurity } : {}) })
    }

    if (opts.dryRun) return await finish(await pipeline(true))

    // Doc 4.2: the first real run previews and asks; the check reads the database, not the state file.
    if (!opts.yes && (await isFirstRun(booted.payload, config, site))) {
      const tty = opts.isTTY ?? process.stdin.isTTY === true
      if (!tty && !opts.confirm) {
        log(formatLine('fail', 'First run needs confirmation', 'Nothing from this site is in the database yet. Run with --dry-run to preview, then --yes to write (for CI).'))
        return 1
      }
      log('First run for this site. Previewing with a dry run before writing anything.')
      downloadCache = await DownloadCache.create(cwd)
      const preview = await pipeline(true)
      const code = await finish(preview)
      if (preview.stopped) return code
      const ok = await (opts.confirm ?? ask)('Write this to the database? [y/N] ')
      if (!ok) {
        log('Nothing was written.')
        return 0
      }
    }
    const code = await finish(await pipeline(false))
    // Doc 12.8: the credential should not outlive the migration.
    if (config.source.auth) log(formatLine('warn', 'Revoke the Application Password when you are done', 'Users → Profile → Application Passwords in WordPress.'))
    return code
  } catch (error) {
    if (error instanceof StateCorruptError) {
      log(formatLine('fail', 'The state file cannot be read', error.message))
      return 1
    }
    throw error
  } finally {
    process.off('SIGINT', onSigint)
    await downloadCache?.dispose()
    await booted.close()
  }
}

const defaultExtractor = (config: ResolvedConfig): Extractor => {
  if (config.source.type !== 'rest') throw new Error('unreachable: only REST is supported')
  const { url, auth } = config.source
  // The config schema accepts any status string; the extractor maps unknown ones to draft.
  // Warnings go to the report through setWarningSink, called by the runner once its report exists.
  return new RestExtractor({ url, ...(auth ? { auth } : {}), statuses: config.statuses as IRDocument['status'][], seoPlugin: config.seo.plugin })
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  // In a TTY readline takes Ctrl+C itself; treat it as "no" instead of hanging on the prompt.
  const abort = new AbortController()
  rl.once('SIGINT', () => abort.abort())
  try {
    return /^y(es)?$/i.test((await rl.question(question, { signal: abort.signal })).trim())
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') return false
    throw error
  } finally {
    rl.close()
  }
}

function progress(log: (l: string) => void, phase: Phase, status: 'start' | 'skip' | 'done', why: string | undefined, verbose: boolean) {
  if (status === 'start') log(`${phase}...`)
  // A phase left out of `collections` is worth saying every time; --only choices only with --verbose.
  else if (status === 'skip' && (verbose || why === 'not mapped in collections')) log(`${phase}: skipped, ${why ?? 'not selected'}`)
}
