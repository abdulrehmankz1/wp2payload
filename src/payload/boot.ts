import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as nodeModule from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Payload, SanitizedConfig } from 'payload'
import type { Env } from '../config/types.js'
import { SUPPORTED_PAYLOAD_MAJOR } from '../doctor/checks.js'
import { PayloadBootError } from './errors.js'

// Boots the USER's Payload, never wp2payload's own dev copy (spec 05 Decisions). Everything
// Payload-side is resolved from the project folder so the process holds exactly one Payload
// module instance: the one the user's config imports. The steps mirror Payload's own bin
// (node_modules/payload/bin.js and dist/bin/index.js) but take `cwd` explicitly instead of
// reading process.cwd(), so callers and tests never need process.chdir (unsupported in workers).

export interface BootOptions {
  cwd: string
  configPath?: string
}

export interface BootedPayload {
  payload: Payload
  configPath: string
  close(): Promise<void>
}

const NOT_INSTALLED_FIX = 'Run wp2payload inside your Payload project, where payload is installed.'
// Same list as payload/dist/config/find.js (payloadConfigFileNames).
const CONFIG_FILE_NAMES = ['payload.config.js', 'payload.config.ts']

interface PackageJson {
  version?: string
  exports?: Record<string, unknown>
  module?: string
  main?: string
}

interface ProjectPayload {
  // Real path (pnpm symlinks resolved): Node's ESM loader uses real paths too, so the entry
  // URL below is the same module the user's config gets from `import 'payload'`.
  dir: string
  version: string
  entryUrl: string
}

function readPackage(file: string): PackageJson {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as PackageJson
}

/**
 * The folder of package `name` as Node would find it from `fromDir`. Walks Node's own lookup
 * paths instead of resolving `name/package.json`, which packages may not export (payload and
 * get-tsconfig do not).
 */
function findPackageDir(fromDir: string, name: string): string | undefined {
  const lookup = createRequire(path.join(fromDir, 'noop.js')).resolve.paths(name) ?? []
  for (const nodeModules of lookup) {
    const dir = path.join(nodeModules, name)
    if (existsSync(path.join(dir, 'package.json'))) return realpathSync(dir)
  }
  return undefined
}

function pickTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (!entry || typeof entry !== 'object') return undefined
  const conditions = entry as Record<string, unknown>
  for (const key of ['import', 'node', 'default']) {
    const target = pickTarget(conditions[key])
    if (target) return target
  }
  return undefined
}

/** The ESM import target of a package export (e.g. "." or "./node"), as a file URL. */
function exportUrl(pkgDir: string, subpath: string): string {
  const pkg = readPackage(path.join(pkgDir, 'package.json'))
  const exportsField = pkg.exports
  let target: string | undefined
  if (exportsField && typeof exportsField === 'object') {
    const keys = Object.keys(exportsField)
    const conditionsAtRoot = keys.length > 0 && keys.every((key) => !key.startsWith('.'))
    if (conditionsAtRoot) target = subpath === '.' ? pickTarget(exportsField) : undefined
    else target = pickTarget(exportsField[subpath])
  } else if (subpath === '.') {
    target = pkg.module ?? pkg.main
  }
  if (!target) throw new Error(`package export "${subpath}" not found in ${pkgDir}`)
  return pathToFileURL(path.join(pkgDir, target)).href
}

function resolveProjectPayload(cwd: string): ProjectPayload {
  const dir = findPackageDir(cwd, 'payload')
  if (!dir) {
    throw new PayloadBootError('PAYLOAD_NOT_INSTALLED', `Payload is not installed in ${cwd}. ${NOT_INSTALLED_FIX}`)
  }
  const version = readPackage(path.join(dir, 'package.json')).version ?? '0.0.0'
  const major = Number(version.split('.')[0])
  if (major !== SUPPORTED_PAYLOAD_MAJOR) {
    throw new PayloadBootError(
      'PAYLOAD_VERSION_UNSUPPORTED',
      `Payload ${version} is installed, but wp2payload supports Payload ${SUPPORTED_PAYLOAD_MAJOR}. Upgrade the project to Payload ${SUPPORTED_PAYLOAD_MAJOR}.`,
    )
  }
  return { dir, version, entryUrl: exportUrl(dir, '.') }
}

/** A dependency of the project's payload (tsx, get-tsconfig): with pnpm it resolves only from payload's own folder. */
function payloadDependencyUrl(payload: ProjectPayload, name: string, subpath: string): string {
  const dir = findPackageDir(payload.dir, name)
  if (!dir) throw new Error(`${name} (a dependency of payload) was not found from ${payload.dir}; reinstall the project's dependencies`)
  return exportUrl(dir, subpath)
}

interface TsconfigResult {
  path: string
  config: { compilerOptions?: { baseUrl?: string; rootDir?: string; paths?: Record<string, string[]> } }
}
type GetTsconfig = (searchPath?: string) => TsconfigResult | null

function findUp(dir: string, fileNames: string[]): string | undefined {
  let current = path.resolve(dir)
  for (;;) {
    for (const name of fileNames) {
      const file = path.join(current, name)
      if (existsSync(file)) return file
    }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Payload's findConfig (payload/dist/config/find.js) with `cwd` in place of process.cwd().
 * Reimplemented rather than called because theirs reads process.cwd() and the nearest
 * tsconfig of the process, and chdir is unavailable in worker threads. It uses Payload's own
 * get-tsconfig so tsconfig `extends` and comments parse the same way.
 */
export async function findPayloadConfig(cwd: string, getTsconfig: GetTsconfig, env: Env = process.env): Promise<string | undefined> {
  const fromEnv = env.PAYLOAD_CONFIG_PATH
  if (fromEnv) return path.resolve(cwd, fromEnv)

  const production = env.NODE_ENV === 'production'
  const searchPaths: (string | undefined)[] = []
  const tsconfig = getTsconfig(cwd)
  if (tsconfig) {
    const options = tsconfig.config.compilerOptions ?? {}
    const rootPath = path.resolve(path.dirname(tsconfig.path), options.baseUrl ?? '')
    const aliased = options.paths?.['@payload-config']?.[0]
    const configPath = aliased ? path.resolve(rootPath, aliased) : undefined
    if (configPath && ['.js', '.ts'].includes(path.extname(configPath))) return configPath
    const srcPath = options.rootDir ?? path.resolve(cwd, 'src')
    const outPath = path.resolve(cwd, 'dist')
    searchPaths.push(configPath, ...(production ? [outPath] : []), srcPath, rootPath)
  } else {
    searchPaths.push(cwd)
  }
  for (const dir of searchPaths) {
    if (!dir) continue
    const found = findUp(dir, CONFIG_FILE_NAMES)
    if (found) return found
  }
  return production
    ? findUp(path.resolve(cwd, 'dist'), ['payload.config.js'])
    : findUp(path.resolve(cwd, 'src'), CONFIG_FILE_NAMES)
}

// Registered once per process, like Payload's bin, from the project's payload package.
const LEXICAL_HOOKS = Symbol.for('wp2payload.lexicalLoaderRegistered')

async function registerLexicalLoader(payload: ProjectPayload): Promise<void> {
  const flags = globalThis as { [LEXICAL_HOOKS]?: boolean }
  if (flags[LEXICAL_HOOKS]) return
  // Lexical 0.50's Node entry points use top-level dynamic imports that can stall under tsx;
  // Payload's loader selects the static development/production exports instead.
  const loaderUrl = pathToFileURL(path.join(payload.dir, 'lexicalLoader.mjs')).href
  const condition = process.env.NODE_ENV === 'production' ? 'production' : 'development'
  if (typeof nodeModule.registerHooks === 'function') {
    const { initialize, resolve } = (await import(loaderUrl)) as {
      initialize(condition: string): void
      resolve: nodeModule.ResolveHookSync
    }
    initialize(condition)
    nodeModule.registerHooks({ resolve })
  } else {
    nodeModule.register(loaderUrl, { data: condition })
  }
  flags[LEXICAL_HOOKS] = true
}

interface TsxApi {
  register(options: { namespace: string; tsconfig?: string | false }): {
    import(specifier: string, parent: string): Promise<unknown>
    unregister(): Promise<void>
  }
}

function hasCollections(value: unknown): value is SanitizedConfig {
  return typeof value === 'object' && value !== null && 'collections' in value
}

async function unwrapConfig(mod: unknown): Promise<SanitizedConfig> {
  // `export default buildConfig(...)` is a Promise; a CommonJS project adds one more `default`.
  let value: unknown = await (mod as { default?: unknown }).default
  if (!hasCollections(value) && value && typeof value === 'object' && 'default' in value) {
    value = await (value as { default: unknown }).default
  }
  if (!hasCollections(value)) throw new Error('the config file has no default export from buildConfig()')
  return value
}

function bootFailed(configPath: string, error: unknown): PayloadBootError {
  // Only the error's own message: never the environment or the config's values.
  const reason = error instanceof Error ? error.message : String(error)
  return new PayloadBootError(
    'PAYLOAD_BOOT_FAILED',
    `Payload could not start from ${configPath}: ${reason}. Fix the config, then check that "payload run" works in this project.`,
    { cause: error },
  )
}

function loadProjectEnv(loadEnv: (dir?: string) => void, cwd: string): void {
  // Payload's loadEnv() reads process.cwd() (and walks up when nothing is found); with an
  // explicit folder it reads that folder only, always with development files included.
  if (path.resolve(cwd) === path.resolve(process.cwd())) loadEnv()
  else loadEnv(cwd)
}

let namespaceCount = 0

export async function bootPayload(opts: BootOptions): Promise<BootedPayload> {
  const cwd = path.resolve(opts.cwd)
  const project = resolveProjectPayload(cwd)

  // Env first, as Payload's bin does: .env may set PAYLOAD_CONFIG_PATH, NODE_ENV and the values the config reads.
  const { loadEnv } = (await import(exportUrl(project.dir, './node'))) as { loadEnv(dir?: string): void }
  loadProjectEnv(loadEnv, cwd)

  let configPath: string | undefined
  if (opts.configPath) {
    configPath = path.resolve(cwd, opts.configPath)
  } else {
    const { getTsconfig } = (await import(payloadDependencyUrl(project, 'get-tsconfig', '.'))) as {
      getTsconfig: GetTsconfig
    }
    configPath = await findPayloadConfig(cwd, getTsconfig)
  }
  if (!configPath || !existsSync(configPath)) {
    const where = configPath ? `${configPath} does not exist` : `no payload.config.ts or payload.config.js was found in ${cwd}`
    throw new PayloadBootError(
      'PAYLOAD_CONFIG_NOT_FOUND',
      `Payload config not found: ${where}. Run wp2payload in your Payload project folder, or set PAYLOAD_CONFIG_PATH to the config file.`,
    )
  }

  await registerLexicalLoader(project)
  process.env.DISABLE_PAYLOAD_HMR = 'true'

  let payload: Payload
  let unregister: (() => Promise<void>) | undefined
  try {
    const tsx = (await import(payloadDependencyUrl(project, 'tsx', './esm/api'))) as TsxApi
    // One tsx namespace for the config AND payload itself, as Payload's bin runs everything in
    // a tsImport namespace. getPayload then comes from the same module instance the config's
    // buildConfig and hooks use. tsx tags namespaced URLs, so a plain `import 'payload'`
    // elsewhere in the process is a different instance: take runtime values from `payload`.
    const tsconfig = findUp(path.dirname(configPath), ['tsconfig.json'])
    const api = tsx.register({ namespace: `wp2payload-${process.pid}-${namespaceCount++}`, tsconfig: tsconfig ?? false })
    unregister = () => api.unregister()
    const configUrl = pathToFileURL(configPath).href
    const config = await unwrapConfig(await api.import(configUrl, configUrl))
    const payloadModule = (await api.import(project.entryUrl, configUrl)) as {
      getPayload(options: { config: SanitizedConfig; key?: string }): Promise<Payload>
    }
    payload = await payloadModule.getPayload({ config, key: configPath })
  } catch (error) {
    await unregister?.().catch(() => undefined)
    throw bootFailed(configPath, error)
  }

  let closed = false
  return {
    payload,
    configPath,
    async close() {
      if (closed) return
      closed = true
      try {
        if (typeof payload.destroy === 'function') await payload.destroy()
        else await payload.db?.destroy?.()
        // The SQLite adapter's destroy keeps the libsql client open, which holds the process.
        ;(payload.db as { client?: { close?: () => void } } | undefined)?.client?.close?.()
      } finally {
        await unregister?.()
      }
    },
  }
}
