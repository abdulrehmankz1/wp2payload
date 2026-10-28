import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, defineConfig, loadConfig, resolveConfig } from '../../src/config/index.js'

const fixtures = resolve(import.meta.dirname, '../fixtures/config')
const rest = { type: 'rest', url: 'https://example.com' }

function issuesOf(raw: unknown): string[] {
  try {
    resolveConfig(raw, {})
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return [...(error as ConfigError).issues]
  }
  throw new Error('expected ConfigError')
}

describe('defaults', () => {
  it('fills defaults for a minimal rest config', () => {
    const c = resolveConfig({ source: rest })
    expect(c.statuses).toEqual(['publish'])
    expect(c.seo).toEqual({ plugin: 'auto', field: 'meta' })
    expect(c.redirects.enabled).toBe(true)
    expect(c.media).toMatchObject({ maxFileSizeMB: 50, reencode: true, reencodeQuality: 90 })
    expect(c.security.embedHosts).toContain('player.vimeo.com')
    expect(c.security.externalLinkRel).toBe('nofollow noopener')
    expect(c.collections.post?.to).toBe('posts')
    expect(c.transformers).toEqual([])
  })
  it('accepts wxr and defaults sql tablePrefix', () => {
    expect(resolveConfig({ source: { type: 'wxr', file: 'a.xml' } }).source.type).toBe('wxr')
    const sql = resolveConfig({ source: { type: 'sql', file: 'a.sql', uploadsDir: './u' } }).source
    expect(sql).toMatchObject({ type: 'sql', tablePrefix: 'wp_' })
  })
  it('defineConfig is the identity', () => {
    const input = { source: { type: 'wxr' as const, file: 'a.xml' } }
    expect(defineConfig(input)).toBe(input)
  })
  it('accepts transformers', () => {
    const t = { name: 'x', match: () => true, toHtml: () => '' }
    expect(resolveConfig({ source: rest, transformers: [t] }).transformers).toHaveLength(1)
  })
})

describe('invalid configs report exact paths', () => {
  it.each([
    [{ source: { type: 'rest', url: 'ftp://x.com' } }, 'source.url: expected an http(s) URL'],
    [{ source: { type: 'rest' } }, 'source.url:'],
    [{ source: { type: 'wxr' } }, 'source.file:'],
    [{ source: { type: 'sql', file: 'a.sql' } }, 'source.uploadsDir:'],
    [{ source: { type: 'nope' } }, 'source.type: expected source.type to be one of'],
    [{ source: rest, media: { reencodeQuality: 101 } }, 'media.reencodeQuality: expected an integer from 1 to 100'],
    [{ source: rest, seo: { plugin: 'x' } }, 'seo.plugin:'],
    [
      { source: rest, transformers: [{ name: 'a', match: 1, toHtml: () => '' }] },
      'transformers[0].match: expected a match(block) predicate (a function)',
    ],
  ])('%j -> %s', (raw, expected) => {
    expect(issuesOf(raw).some((i) => i.startsWith(expected))).toBe(true)
  })
  it('lists every issue in the message', () => {
    let error: ConfigError | undefined
    try {
      resolveConfig({ source: { type: 'rest', url: 'bad' }, media: { reencodeQuality: 0 } })
    } catch (e) {
      error = e as ConfigError
    }
    expect(error?.message).toContain('source.url')
    expect(error?.message).toContain('media.reencodeQuality')
    expect(error?.exitCode).toBe(2)
  })
})

describe('secrets', () => {
  const auth = (appPassword: string) => ({ source: { ...rest, auth: { user: 'u', appPassword } } })
  it('rejects a literal and never leaks it', () => {
    const secret = 'abcd EFGH 1234 ijkl'
    let error: ConfigError | undefined
    try {
      resolveConfig(auth(secret), { WP_APP_PASSWORD: 'other' })
    } catch (e) {
      error = e as ConfigError
    }
    expect(error).toBeInstanceOf(ConfigError)
    expect(error?.message).toContain('source.auth.appPassword')
    expect(error?.message).toContain('process.env.WP_APP_PASSWORD')
    expect(JSON.stringify([error?.message, error?.issues])).not.toContain(secret)
  })
  it('accepts an env-provided secret', () => {
    expect(resolveConfig(auth('s3cret'), { WP_APP_PASSWORD: 's3cret' }).source.type).toBe('rest')
  })
})

describe('loadConfig', () => {
  it('loads a real .ts config via jiti', async () => {
    const c = await loadConfig('valid.config.ts', fixtures)
    expect(c.source).toEqual({ type: 'wxr', file: './export.xml' })
    expect(c.statuses).toEqual(['publish', 'draft'])
  })
  it('missing file points to init', async () => {
    await expect(loadConfig(undefined, fixtures)).rejects.toThrow(/wp2payload init/)
  })
  it('reports validation errors from a file', async () => {
    await expect(loadConfig('broken.config.ts', fixtures)).rejects.toThrow('source.url: expected an http(s) URL')
  })
  it('accepts a secret that comes from the environment', async () => {
    process.env.WP_APP_PASSWORD = 'pw-from-env'
    try {
      const c = await loadConfig('secret.config.ts', fixtures)
      expect(c.source).toMatchObject({ auth: { appPassword: 'pw-from-env' } })
    } finally {
      delete process.env.WP_APP_PASSWORD
    }
  })
})
