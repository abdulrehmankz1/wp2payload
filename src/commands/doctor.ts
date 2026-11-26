import type { Env } from '../config/types.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig, type ResolvedConfig } from '../config/index.js'
import { checkNodeVersion, checkPayloadInstalled, type CheckResult } from '../doctor/checks.js'
import { RestError, RestExtractor } from '../extractors/rest/index.js'
import { openUploadsArchives } from '../extractors/archive/index.js'
import { openSource, type OpenedSource } from '../extractors/source.js'
import { DumpError, SqlExtractor } from '../extractors/sql/index.js'
import { WxrError, WxrExtractor } from '../extractors/wxr/index.js'
import type { SourceInfo } from '../ir/types.js'
import { clean } from '../report/summary.js'
import { accountsCheck, type AccountsCheck } from '../payload/accounts.js'
import { loadPayloadConfig } from '../payload/boot.js'
import { formatLine } from '../ui/output.js'

export interface DoctorOptions {
  cwd?: string
  configPath?: string
  env?: Env
  log?: (line: string) => void
  // Injected in tests so the source check needs no network.
  createExtractor?: (source: Extract<ResolvedConfig['source'], { type: 'rest' }>) => Pick<RestExtractor, 'probe' | 'rankMathHeadless'>
  createWxrExtractor?: (file: string) => Pick<WxrExtractor, 'probe'>
  createSqlExtractor?: (file: string, tablePrefix: string | undefined) => Pick<SqlExtractor, 'probe'>
  /** Reads the user's Payload config without starting Payload (tests inject one). */
  loadPayloadConfig?: (cwd: string, env: Env) => Promise<{ collections: readonly { slug: string; auth?: unknown }[] }>
}

const defaultPayloadConfig: NonNullable<DoctorOptions['loadPayloadConfig']> = async (cwd, env) =>
  (await loadPayloadConfig(env['PAYLOAD_CONFIG_PATH'] ? { cwd, configPath: env['PAYLOAD_CONFIG_PATH'] } : { cwd })).config

/**
 * SEC-01: the same account check migrate runs before writing, from the Payload config alone (doctor
 * never connects to the database). Exit code 2 when authors would become login accounts unasked.
 */
async function checkAccounts(config: ResolvedConfig, opts: DoctorOptions, payloadOk: boolean): Promise<AccountsCheck[]> {
  if (config.collections['author'] === undefined && !config.authors.createAccounts) return []
  let collections: readonly { slug: string; auth?: unknown }[]
  try {
    ;({ collections } = await (opts.loadPayloadConfig ?? defaultPayloadConfig)(opts.cwd ?? process.cwd(), opts.env ?? process.env))
  } catch (error) {
    // A failed Payload check already says what to fix first.
    if (!payloadOk) return []
    const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0]
    return [{ status: 'warn', title: 'Could not read the Payload config, so author accounts were not checked', detail: `${reason}\nmigrate runs this check before it writes anything.` }]
  }
  const check = accountsCheck(config, (slug) => Boolean(collections.find((c) => c.slug === slug)?.auth), { inviteUsers: false })
  return check ? [check] : []
}

const defaultExtractor: NonNullable<DoctorOptions['createExtractor']> = (source) =>
  new RestExtractor(source.auth ? { url: source.url, auth: source.auth } : { url: source.url })

function unmigrated(info: SourceInfo): CheckResult[] {
  if (!info.unmigratedTypes?.length) return []
  return [{
    status: 'warn',
    title: 'Some content types will not be migrated',
    detail: `${info.unmigratedTypes.map((t) => `${t.count} ${clean(t.type)}`).join(', ')}\nwp2payload migrates posts, pages, media, terms and authors.`,
  }]
}

async function checkWxr(file: string, opts: DoctorOptions): Promise<CheckResult[]> {
  try {
    const info = await (opts.createWxrExtractor ?? ((f) => new WxrExtractor({ file: f })))(file).probe()
    const counts = Object.entries(info.counts).map(([kind, n]) => `${n} ${kind}`).join(', ')
    return [
      { status: 'ok', title: `Export of ${clean(info.siteUrl)}`, detail: `${counts}\nSEO plugin: ${clean(info.seoPlugin ?? 'none detected')}` },
      ...unmigrated(info),
      // An export holds the content, not the files.
      {
        status: 'warn',
        title: 'Media is downloaded from the site',
        detail: `${clean(new URL(info.siteUrl).host)} must still be online for media to migrate.\nFor a local copy (localhost, LocalWP), set url in the source to its address.`,
      },
    ]
  } catch (error) {
    if (!(error instanceof WxrError)) throw error
    return [{ status: 'fail', title: error.message }]
  }
}

async function checkSql(source: Extract<ResolvedConfig['source'], { type: 'sql' }>, opts: DoctorOptions): Promise<CheckResult[]> {
  const cwd = opts.cwd ?? process.cwd()
  const results: CheckResult[] = []
  try {
    const file = path.resolve(cwd, source.file)
    const create = opts.createSqlExtractor ?? ((f, prefix) => new SqlExtractor({ file: f, ...(prefix !== undefined ? { tablePrefix: prefix } : {}) }))
    const info = await create(file, source.tablePrefix).probe()
    const counts = Object.entries(info.counts).map(([kind, n]) => `${n} ${kind}`).join(', ')
    results.push({ status: 'ok', title: `Backup of ${clean(info.siteUrl)}`, detail: `${counts}\nSEO plugin: ${clean(info.seoPlugin ?? 'none detected')}` }, ...prefixCheck(info), ...unmigrated(info))
  } catch (error) {
    if (!(error instanceof DumpError)) throw error
    results.push({ status: 'fail', title: error.message })
  }
  if (source.uploads !== undefined) {
    // UpdraftPlus uploads archives: indexed and checked against the archive rules, not unpacked.
    const files = Array.isArray(source.uploads) ? source.uploads : [source.uploads]
    try {
      const opened = await openUploadsArchives(files.map((f) => path.resolve(cwd, f)), { media: false, maxMediaBytes: 0 })
      await opened.close()
      results.push({ status: 'ok', title: `Uploads archive${files.length === 1 ? '' : 's'}: ${opened.uploads} files` })
    } catch (error) {
      if (!(error instanceof DumpError)) throw error
      results.push(failed(error))
    }
    return results
  }
  const dir = source.uploadsDir as string
  const uploads = path.resolve(cwd, dir)
  if (!existsSync(uploads)) results.push({ status: 'fail', title: `Uploads folder not found: ${uploads}`, detail: 'Point source.uploadsDir at wp-content/uploads from the backup.' })
  else results.push({ status: 'ok', title: `Uploads folder ${dir}` })
  return results
}

/** The table prefix a dump is read with, and where it came from (a backup's prefix need not be wp_). */
function prefixCheck(info: SourceInfo): CheckResult[] {
  const p = info.tablePrefix
  if (!p) return []
  const where = p.from === 'config' ? 'source.tablePrefix' : p.from === 'wp-config.php' ? "from the backup's wp-config.php" : 'detected from the dump'
  const title = `Table prefix ${p.value} (${where})`
  // The note says why wp-config.php was not used: worth a look, since a hacked site's may be altered.
  return [p.note ? { status: 'warn', title, detail: p.note } : { status: 'ok', title }]
}

/** A source error as a check: its first line is the title, the rest (next step, code) the detail. */
function failed(error: Error): CheckResult {
  const [title = error.message, ...rest] = error.message.split('\n')
  return rest.length ? { status: 'fail', title, detail: rest.join('\n') } : { status: 'fail', title }
}

/** .wpress, zip and tar backups: opened as migrate opens them, without unpacking media. */
async function checkBackup(config: ResolvedConfig, opts: DoctorOptions): Promise<CheckResult[]> {
  let source: OpenedSource | undefined
  try {
    source = await openSource(config, opts.cwd ?? process.cwd(), { media: false })
    const info = await source.extractor.probe()
    const counts = Object.entries(info.counts).map(([kind, n]) => `${n} ${kind}`).join(', ')
    const results: CheckResult[] = [
      { status: 'ok', title: `Backup of ${clean(info.siteUrl)}`, detail: `${counts}\nSEO plugin: ${clean(info.seoPlugin ?? 'none detected')}` },
      // A .wpress backup always uses its own fixed prefix: nothing to show.
      ...(config.source.type === 'archive' ? prefixCheck(info) : []),
      ...unmigrated(info),
    ]
    if (source.uploadFiles === 0) {
      results.push({ status: 'warn', title: 'The backup has no uploads folder', detail: 'No media will be migrated. Duplicator and hand-made archives keep it in wp-content/uploads.' })
    } else if (source.uploadFiles !== undefined) {
      results.push({ status: 'ok', title: `Uploads in the backup: ${source.uploadFiles} files` })
    }
    return results
  } catch (error) {
    if (!(error instanceof DumpError)) throw error
    return [failed(error)]
  } finally {
    await source?.close?.()
  }
}

async function checkSource(config: ResolvedConfig, opts: DoctorOptions): Promise<CheckResult[]> {
  const { source } = config
  if (source.type === 'wxr') return checkWxr(path.resolve(opts.cwd ?? process.cwd(), source.file), opts)
  if (source.type === 'sql') return checkSql(source, opts)
  if (source.type === 'wpress' || source.type === 'archive') return checkBackup(config, opts)
  try {
    const extractor = (opts.createExtractor ?? defaultExtractor)(source)
    const info = await extractor.probe()
    const counts = Object.entries(info.counts)
      .map(([kind, n]) => `${n} ${kind}`)
      .join(', ')
    const results: CheckResult[] = [
      // siteUrl comes from the site itself: a hacked site must not reach the terminal raw.
      { status: 'ok', title: `WordPress at ${clean(info.siteUrl)}`, detail: `${counts || 'no counts available'}\nSEO plugin: ${clean(info.seoPlugin ?? 'none detected')}` },
    ]
    results.push(...unmigrated(info))
    const plugin = config.seo.plugin
    if (plugin === 'rankmath' || (plugin === 'auto' && info.seoPlugin === 'rankmath')) {
      // Rank Math SEO is only readable through getHead, which needs its headless setting (spec 07).
      if ((await extractor.rankMathHeadless()) === 'off') {
        results.push({
          status: 'warn',
          title: 'Rank Math SEO will not be migrated',
          detail: 'Turn on Rank Math → General Settings → Others → Headless CMS Support, then run doctor again.',
        })
      }
    }
    if (source.auth) {
      // Doc 12.8: least privilege, and the credential should not outlive the migration.
      results.push({
        status: 'warn',
        title: 'Revoke the Application Password after the migration',
        detail: 'Users → Profile → Application Passwords in WordPress.',
      })
    }
    return results
  } catch (error) {
    if (!(error instanceof RestError)) throw error
    const [title = error.message, ...rest] = error.message.split('\n')
    return [rest.length ? { status: 'fail', title, detail: rest.join('\n') } : { status: 'fail', title }]
  }
}

// Checks the environment without writing anything. Returns the process exit code.
export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const log = opts.log ?? console.log
  const payloadCheck = await checkPayloadInstalled(cwd)
  const results: CheckResult[] = [checkNodeVersion(), payloadCheck]
  let exitCode = 0

  const configFile = opts.configPath ?? DEFAULT_CONFIG_FILE
  if (!opts.configPath && !existsSync(path.resolve(cwd, configFile))) {
    results.push({
      status: 'warn',
      title: `No ${DEFAULT_CONFIG_FILE} found, source checks skipped`,
      detail: 'Create one with defineConfig (see the README), or pass --config <path>.',
    })
  } else {
    try {
      const config = await loadConfig(configFile, cwd, opts.env ?? process.env)
      results.push({ status: 'ok', title: `Config ${configFile}` }, ...(await checkSource(config, opts)))
      const accounts = await checkAccounts(config, opts, payloadCheck.status === 'ok')
      results.push(...accounts)
      if (accounts.some((a) => a.exitCode === 2)) exitCode = 2
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      results.push({ status: 'fail', title: 'Invalid configuration', detail: error.message })
      exitCode = error.exitCode
    }
  }

  for (const r of results) log(formatLine(r.status, r.title, r.detail))
  const failed = results.filter((r) => r.status === 'fail').length
  log('')
  log(failed === 0 ? 'All checks passed.' : `${failed} check${failed === 1 ? '' : 's'} failed.`)
  // Exit code precedence (doc 4.3): invalid config (2) wins over other failures (1).
  return exitCode || (failed === 0 ? 0 : 1)
}
