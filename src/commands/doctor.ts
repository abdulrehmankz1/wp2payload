import type { Env } from '../config/types.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig, type ResolvedConfig } from '../config/index.js'
import { checkNodeVersion, checkPayloadInstalled, type CheckResult } from '../doctor/checks.js'
import { RestError, RestExtractor } from '../extractors/rest/index.js'
import { openSource } from '../extractors/source.js'
import { DumpError, SqlExtractor } from '../extractors/sql/index.js'
import { WxrError, WxrExtractor } from '../extractors/wxr/index.js'
import type { SourceInfo } from '../ir/types.js'
import { clean } from '../report/summary.js'
import { formatLine } from '../ui/output.js'

export interface DoctorOptions {
  cwd?: string
  configPath?: string
  env?: Env
  log?: (line: string) => void
  // Injected in tests so the source check needs no network.
  createExtractor?: (source: Extract<ResolvedConfig['source'], { type: 'rest' }>) => Pick<RestExtractor, 'probe' | 'rankMathHeadless'>
  createWxrExtractor?: (file: string) => Pick<WxrExtractor, 'probe'>
  createSqlExtractor?: (file: string, tablePrefix: string) => Pick<SqlExtractor, 'probe'>
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
    const info = await (opts.createSqlExtractor ?? ((f, prefix) => new SqlExtractor({ file: f, tablePrefix: prefix })))(file, source.tablePrefix).probe()
    const counts = Object.entries(info.counts).map(([kind, n]) => `${n} ${kind}`).join(', ')
    results.push({ status: 'ok', title: `Backup of ${clean(info.siteUrl)}`, detail: `${counts}\nSEO plugin: ${clean(info.seoPlugin ?? 'none detected')}` }, ...unmigrated(info))
  } catch (error) {
    if (!(error instanceof DumpError)) throw error
    results.push({ status: 'fail', title: error.message })
  }
  const uploads = path.resolve(cwd, source.uploadsDir)
  if (!existsSync(uploads)) results.push({ status: 'fail', title: `Uploads folder not found: ${uploads}`, detail: 'Point source.uploadsDir at wp-content/uploads from the backup.' })
  else results.push({ status: 'ok', title: `Uploads folder ${source.uploadsDir}` })
  return results
}

async function checkWpress(config: ResolvedConfig, opts: DoctorOptions): Promise<CheckResult[]> {
  try {
    const info = await (await openSource(config, opts.cwd ?? process.cwd())).extractor.probe()
    const counts = Object.entries(info.counts).map(([kind, n]) => `${n} ${kind}`).join(', ')
    return [{ status: 'ok', title: `Backup of ${clean(info.siteUrl)}`, detail: `${counts}\nSEO plugin: ${clean(info.seoPlugin ?? 'none detected')}` }, ...unmigrated(info)]
  } catch (error) {
    if (!(error instanceof DumpError)) throw error
    return [{ status: 'fail', title: error.message }]
  }
}

async function checkSource(config: ResolvedConfig, opts: DoctorOptions): Promise<CheckResult[]> {
  const { source } = config
  if (source.type === 'wxr') return checkWxr(path.resolve(opts.cwd ?? process.cwd(), source.file), opts)
  if (source.type === 'sql') return checkSql(source, opts)
  if (source.type === 'wpress') return checkWpress(config, opts)
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
  const results: CheckResult[] = [checkNodeVersion(), await checkPayloadInstalled(cwd)]
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
