import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { CollectionSlug, Payload } from 'payload'
import { authOf } from '../loaders/authors.js'
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig, type ResolvedConfig } from '../config/index.js'
import type { Env } from '../config/types.js'
import { isSourceError, openSource, type OpenedSource } from '../extractors/source.js'
import type { Extractor } from '../ir/types.js'
import { siteKey } from '../loaders/wpmeta.js'
import { loadApprovals } from '../review/store.js'
import { DownloadCache } from '../migrate/download-cache.js'
import { documentTypes, isFirstRun, OnlyError, runPipeline, selectPhases, type Phase } from '../migrate/run.js'
import { StateCorruptError } from '../state/store.js'
import { bootPayload } from '../payload/boot.js'
import { PayloadBootError } from '../payload/errors.js'
import { preflight } from '../payload/preflight.js'
import { exitCode } from '../report/exit.js'
import { clean, formatSummary } from '../report/summary.js'
import type { ReportJson, Severity } from '../report/types.js'
import { writeReport, writeSecurityReport } from '../report/write.js'
import { colorEnabled, formatLine } from '../ui/output.js'

export interface MigrateOptions {
  cwd?: string
  configPath?: string
  dryRun?: boolean
  only?: string[]
  limit?: number
  concurrency?: number
  fresh?: boolean
  /** Write only documents modified at or after this time. */
  since?: Date
  strict?: boolean
  failOnSecurity?: Severity
  allowSvg?: boolean
  allowEmbedHosts?: string[]
  /** Send password-set emails to users created in an auth collection (doc 2.6). */
  inviteUsers?: boolean
  /** Allow author emails in the report; by default it holds no email addresses. */
  includePii?: boolean
  yes?: boolean
  verbose?: boolean
  /** wp2payload version, shown in the HTML security report. */
  version?: string
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
  // Usage errors before anything connects (doc 2.8).
  try {
    selectPhases(opts.only, documentTypes(config))
  } catch (error) {
    if (!(error instanceof OnlyError)) throw error
    log(formatLine('fail', error.message))
    return error.exitCode
  }

  // Doc 2.8: an unreachable source fails before anything is written.
  let source: OpenedSource
  // The configured URL wins; without one, an export file or dump names its own site.
  let siteUrl: string
  let opened: OpenedSource | undefined
  try {
    source = opened = opts.createExtractor
      ? { extractor: opts.createExtractor(config), trustSiteHost: config.source.type === 'rest', label: 'WordPress at', ...(config.source.type === 'rest' ? { configuredUrl: config.source.url } : {}) }
      : await openSource(config, cwd)
    const info = await source.extractor.probe()
    siteUrl = source.configuredUrl ?? info.siteUrl
    log(formatLine('ok', `${source.label} ${clean(info.siteUrl)}`))
  } catch (error) {
    // Unset when openSource itself failed; it cleans up after itself then.
    await opened?.close?.()
    if (!isSourceError(error)) throw error
    const [title = error.message, ...rest] = error.message.split('\n')
    log(rest.length ? formatLine('fail', title, rest.join('\n')) : formatLine('fail', title))
    return 1
  }

  let booted: { payload: Payload; configPath?: string; close(): Promise<void> }
  try {
    booted = await (opts.boot ?? ((c, p) => bootPayload(p ? { cwd: c, configPath: p } : { cwd: c })))(cwd, env['PAYLOAD_CONFIG_PATH'])
  } catch (error) {
    await source.close?.()
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
    const invite = inviteCheck(booted.payload, config, opts.inviteUsers === true)
    if (invite) {
      log(formatLine(invite.status, invite.title, invite.detail))
      if (invite.status === 'fail') return 1
    }

    const site = siteKey(siteUrl)
    const approvals = await loadApprovals(cwd)
    const approved = approvals.fragments.size + approvals.hosts.length
    if (approved) log(formatLine('ok', `Using ${approved} approval${approved === 1 ? '' : 's'} from wp2payload review`))
    if (opts.since) log(formatLine('ok', `Writing only documents changed since ${opts.since.toISOString()}`))
    const pipeline = (dryRun: boolean) =>
      runPipeline({
        root: cwd,
        config,
        payload: booted.payload,
        extractor: source.extractor,
        site,
        siteUrl,
        approvals,
        ...(opts.since ? { since: opts.since } : {}),
        trustSiteHost: source.trustSiteHost,
        ...(source.readLocalMedia ? { readLocalMedia: source.readLocalMedia } : {}),
        dryRun,
        ...(opts.only ? { only: opts.only } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
        fresh: opts.fresh === true,
        allowSvg: opts.allowSvg === true,
        allowEmbedHosts: opts.allowEmbedHosts ?? [],
        inviteUsers: opts.inviteUsers === true,
        includePii: opts.includePii === true,
        ...(downloadCache ? { downloadCache } : {}),
        interrupted: () => interrupted,
        onPhase: (phase, status, why) => progress(log, phase, status, why, opts.verbose === true),
      })

    const finish = async (json: ReportJson) => {
      await writeReport(cwd, json)
      // Doc 12.11: the security block points at the HTML report, the client deliverable.
      const reportPath = await writeSecurityReport(cwd, json, opts.version ? { version: opts.version } : {})
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
    if (config.source.type === 'rest' && config.source.auth) log(formatLine('warn', 'Revoke the Application Password when you are done', 'Users → Profile → Application Passwords in WordPress.'))
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
    await source.close?.()
  }
}

/**
 * Doc 2.6: what `--invite-users` will do with this Payload. Without an email adapter Payload writes
 * emails to its log, recipient included, so inviting then fails before anything is written.
 */
export function inviteCheck(
  payload: Payload,
  config: ResolvedConfig,
  inviteUsers: boolean,
): { status: 'ok' | 'warn' | 'fail'; title: string; detail?: string } | undefined {
  const to = config.collections['author']?.to as CollectionSlug | undefined
  const auth = to !== undefined && authOf(payload, to) !== undefined
  if (!auth) {
    return inviteUsers
      ? { status: 'warn', title: '--invite-users has no effect', detail: `Authors are not mapped into an auth collection${to ? ` (${to} has no auth)` : ''}, so no accounts are created.` }
      : undefined
  }
  // A warning, not ok: on a hacked site the attacker's user wrote the spam posts and gets an account too.
  const review = 'These accounts can log in. Every one created is listed in the report as AUTHOR_ACCOUNT_CREATED; check each is a real person before go-live.'
  if (!inviteUsers) {
    return {
      status: 'warn',
      title: `Authors become login accounts in ${to}`,
      detail: `${review} Each new account gets a random password. Add --invite-users to email a password-set link, or users can use "Forgot password".`,
    }
  }
  if (!payload.config.email) {
    return {
      status: 'fail',
      title: '--invite-users needs an email adapter in your Payload config',
      detail: 'Without one Payload only logs emails. Add email: nodemailerAdapter(...) or resendAdapter(...) to payload.config.ts, or run without --invite-users.',
    }
  }
  return {
    status: 'warn',
    title: `Authors become login accounts in ${to}, each emailed a password-set link`,
    detail: `${review} Only accounts created by this run are emailed; re-runs send nothing.`,
  }
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
