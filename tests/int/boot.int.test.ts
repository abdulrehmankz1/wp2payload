import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as nodeModule from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/index.js'
import { bootPayload, findPayloadConfig, type BootedPayload } from '../../src/payload/boot.js'
import { PayloadBootError } from '../../src/payload/errors.js'
import { preflight } from '../../src/payload/preflight.js'

// The fixture is a user-style Payload project (TypeScript config, path alias, relative .ts
// import, Lexical editor). It has no node_modules of its own: Node's lookup walks up to the
// repo's node_modules, so `payload` resolves from the fixture folder like in a real project.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const projectDir = path.join(repoRoot, 'tests/fixtures/payload-project')
const envFile = path.join(projectDir, '.env')
// Inside the repo (so payload still resolves) but gitignored.
const repoTmp = path.join(repoRoot, '.tmp')
// __NEXT_PROCESSED_ENV: Next's env loader sets it and then skips every later load, in children too.
const ENV_KEYS = ['PAYLOAD_SECRET', 'DATABASE_URI', 'FIXTURE_MEDIA_DIR', 'DISABLE_PAYLOAD_HMR', '__NEXT_PROCESSED_ENV'] as const

const posix = (p: string) => p.split(path.sep).join('/')
const sqliteUrl = (dir: string) => `file:${posix(path.join(dir, 'fixture.db'))}`

async function removeDir(dir: string | undefined): Promise<void> {
  if (!dir) return
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch (error) {
    // Windows can hold the SQLite file briefly after close; the OS temp cleaner removes it.
    if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
  }
}

async function bootError(promise: Promise<unknown>): Promise<PayloadBootError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PayloadBootError)
    return error as PayloadBootError
  }
  throw new Error('expected bootPayload to fail')
}

let dataDir: string
let booted: BootedPayload | undefined
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-boot-'))
  await mkdir(repoTmp, { recursive: true })
  // .env files are gitignored, so the fixture's is written here, with fake values only.
  await writeFile(
    envFile,
    [
      'PAYLOAD_SECRET=fixture-secret-not-real',
      `DATABASE_URI=${sqliteUrl(dataDir)}`,
      `FIXTURE_MEDIA_DIR=${posix(path.join(dataDir, 'media'))}`,
      '',
    ].join('\n'),
  )
  for (const key of ENV_KEYS) delete process.env[key]
  // Booted first: Payload's loadEnv (Next's loader) reads .env once per process.
  booted = await bootPayload({ cwd: projectDir })
})

afterAll(async () => {
  await booted?.close()
  await rm(envFile, { force: true })
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await removeDir(dataDir)
})

describe('bootPayload', () => {
  it('finds the TypeScript config through the tsconfig @payload-config alias and loads .env', () => {
    expect(booted!.configPath).toBe(path.join(projectDir, 'src', 'payload.config.ts'))
    expect(process.env.DATABASE_URI).toBe(sqliteUrl(dataDir))
    expect(Object.keys(booted!.payload.collections)).toEqual(expect.arrayContaining(['posts', 'media']))
  })

  it('returns a working Payload: create and find a document', async () => {
    const payload = booted!.payload
    const created = await payload.create({
      collection: 'posts' as never,
      data: { title: 'Hello', wpMeta: { site: 'https://example.test', wpId: 1 } } as never,
    })
    const found = await payload.find({ collection: 'posts' as never, where: { 'wpMeta.wpId': { equals: 1 } } })
    expect(found.totalDocs).toBe(1)
    expect(found.docs[0]).toMatchObject({ id: created.id, title: 'Hello' })
  })

  it('preflight passes for the fixture and fails for a collection it does not have', () => {
    const config = resolveConfig({
      source: { type: 'rest', url: 'https://example.test' },
      collections: { post: { to: 'posts' }, media: { to: 'media' }, category: { to: 'categories' } },
    })
    const results = preflight(booted!.payload, config)
    expect(results.map((r) => [r.status, r.title])).toEqual([
      ['ok', 'Collection posts (WordPress post)'],
      ['ok', 'Collection media (WordPress media)'],
      ['fail', 'Collection categories (WordPress category) does not exist in Payload'],
    ])
  })

  it('fails with PAYLOAD_NOT_INSTALLED outside a project with payload', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-nopayload-'))
    try {
      const error = await bootError(bootPayload({ cwd: dir }))
      expect(error.code).toBe('PAYLOAD_NOT_INSTALLED')
      expect(error.exitCode).toBe(1)
      expect(error.message).toContain('Run wp2payload inside your Payload project, where payload is installed')
    } finally {
      await removeDir(dir)
    }
  })

  it('fails with PAYLOAD_CONFIG_NOT_FOUND for a folder without a config', async () => {
    const dir = await mkdtemp(path.join(repoTmp, 'boot-empty-'))
    try {
      const error = await bootError(bootPayload({ cwd: dir }))
      expect(error.code).toBe('PAYLOAD_CONFIG_NOT_FOUND')
      expect(error.message).toContain('PAYLOAD_CONFIG_PATH')
      const explicit = await bootError(bootPayload({ cwd: dir, configPath: 'nope/payload.config.ts' }))
      expect(explicit.code).toBe('PAYLOAD_CONFIG_NOT_FOUND')
      expect(explicit.message).toContain(path.join(dir, 'nope', 'payload.config.ts'))
    } finally {
      await removeDir(dir)
    }
  })

  it('wraps a config that throws in PAYLOAD_BOOT_FAILED with the original message', async () => {
    const dir = await mkdtemp(path.join(repoTmp, 'boot-broken-'))
    try {
      await writeFile(path.join(dir, 'payload.config.ts'), "const reason: string = 'config exploded'\nthrow new Error(reason)\n")
      const error = await bootError(bootPayload({ cwd: dir }))
      expect(error.code).toBe('PAYLOAD_BOOT_FAILED')
      expect(error.message).toContain('config exploded')
      expect(error.message).toContain(path.join(dir, 'payload.config.ts'))
    } finally {
      await removeDir(dir)
    }
  })
})

describe('findPayloadConfig (Payload findConfig rules, explicit cwd)', () => {
  const noTsconfig = () => null

  it('takes PAYLOAD_CONFIG_PATH relative to cwd', async () => {
    const cwd = path.join(repoTmp, 'any')
    expect(await findPayloadConfig(cwd, noTsconfig, { PAYLOAD_CONFIG_PATH: 'cfg/payload.config.ts' })).toBe(
      path.join(cwd, 'cfg', 'payload.config.ts'),
    )
  })

  it('takes the @payload-config path alias relative to baseUrl', async () => {
    const tsconfig = () => ({
      path: path.join(projectDir, 'tsconfig.json'),
      config: { compilerOptions: { baseUrl: '.', paths: { '@payload-config': ['./src/payload.config.ts'] } } },
    })
    expect(await findPayloadConfig(projectDir, tsconfig, {})).toBe(path.join(projectDir, 'src', 'payload.config.ts'))
  })

  it('searches src when tsconfig has no alias', async () => {
    const tsconfig = () => ({ path: path.join(projectDir, 'tsconfig.json'), config: { compilerOptions: {} } })
    expect(await findPayloadConfig(projectDir, tsconfig, {})).toBe(path.join(projectDir, 'src', 'payload.config.ts'))
  })
})

// vitest transforms imports itself, which could hide a real tsx or Lexical loader problem.
// This boots the same project from a plain `node` child process instead.
const canStripTypes = typeof nodeModule.registerHooks === 'function'

describe.skipIf(!canStripTypes)('bootPayload in a plain node process', () => {
  it('boots, writes, reads and exits by itself after close()', async () => {
    const childData = await mkdtemp(path.join(os.tmpdir(), 'wp2p-boot-child-'))
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URI: sqliteUrl(childData), NODE_ENV: 'development' }
      // PAYLOAD_SECRET and FIXTURE_MEDIA_DIR must come from the fixture's .env, not from us.
      delete env.PAYLOAD_SECRET
      delete env.FIXTURE_MEDIA_DIR
      delete env.DISABLE_PAYLOAD_HMR
      delete env.__NEXT_PROCESSED_ENV
      const child = spawn(
        process.execPath,
        ['--experimental-transform-types', '--no-warnings', path.join(projectDir, 'boot-smoke.mjs'), repoRoot],
        { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(`child did not exit within 50s (close() left a handle open?)\n${stderr}`))
        }, 50_000)
        child.on('exit', (exitCode) => {
          clearTimeout(timer)
          resolve(exitCode)
        })
      })
      expect(code, stderr).toBe(0)
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '))
      expect(line, stdout + stderr).toBeDefined()
      expect(JSON.parse(line!.slice('RESULT '.length))).toEqual({
        configPath: path.join(projectDir, 'src', 'payload.config.ts'),
        created: true,
        found: 1,
      })
    } finally {
      await removeDir(childData)
    }
  })
})
