import { existsSync } from 'node:fs'
import path from 'node:path'
import { ConfigError, DEFAULT_CONFIG_FILE, loadConfig, type ResolvedConfig } from '../config/index.js'
import { checkNodeVersion, checkPayloadInstalled, type CheckResult } from '../doctor/checks.js'
import { RestError, RestExtractor } from '../extractors/rest/index.js'
import { formatLine } from '../ui/output.js'

export interface DoctorOptions {
  cwd?: string
  configPath?: string
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  // Injected in tests so the source check needs no network.
  createExtractor?: (source: Extract<ResolvedConfig['source'], { type: 'rest' }>) => Pick<RestExtractor, 'probe'>
}

const defaultExtractor: NonNullable<DoctorOptions['createExtractor']> = (source) =>
  new RestExtractor(source.auth ? { url: source.url, auth: source.auth } : { url: source.url })

async function checkSource(config: ResolvedConfig, opts: DoctorOptions): Promise<CheckResult[]> {
  const { source } = config
  if (source.type !== 'rest') {
    return [{ status: 'warn', title: `Source type "${source.type}" is not supported yet`, detail: 'Only the REST source works in this version.' }]
  }
  try {
    const info = await (opts.createExtractor ?? defaultExtractor)(source).probe()
    const counts = Object.entries(info.counts)
      .map(([kind, n]) => `${n} ${kind}`)
      .join(', ')
    const results: CheckResult[] = [
      { status: 'ok', title: `WordPress at ${info.siteUrl}`, detail: `${counts || 'no counts available'}\nSEO plugin: ${info.seoPlugin ?? 'none detected'}` },
    ]
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
