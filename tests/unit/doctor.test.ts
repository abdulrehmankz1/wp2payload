import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDoctor } from '../../src/commands/doctor.js'
import { RestError } from '../../src/extractors/rest/index.js'

describe('runDoctor', () => {
  let root: string
  let lines: string[]
  const log = (line: string) => lines.push(line)
  const output = () => lines.join('\n')

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-doctor-cmd-'))
    lines = []
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { payload: '^3.92.0' } }))
    await mkdir(path.join(root, 'node_modules', 'payload'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'payload', 'package.json'), JSON.stringify({ version: '3.92.1' }))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const writeConfig = (body: string, name = 'wp2payload.config.ts') => writeFile(path.join(root, name), body)

  it('passes and warns when there is no config file', async () => {
    expect(await runDoctor({ cwd: root, log })).toBe(0)
    expect(output()).toMatch(/! No wp2payload\.config\.ts found, source checks skipped/)
  })

  it('exits 2 when --config points at a missing file', async () => {
    expect(await runDoctor({ cwd: root, configPath: 'nope.config.ts', log })).toBe(2)
    expect(output()).toMatch(/Config file not found/)
  })

  it('exits 2 for an invalid config, even when other checks also fail', async () => {
    await writeConfig(`export default { source: { type: 'rest', url: 'not a url' } }`)
    await rm(path.join(root, 'node_modules'), { recursive: true })
    expect(await runDoctor({ cwd: root, log })).toBe(2)
    expect(output()).toMatch(/source\.url/)
  })

  it('probes the REST source and reminds to revoke the app password', async () => {
    await writeConfig(
      `export default { source: { type: 'rest', url: 'http://localhost:8080', auth: { user: 'ed', appPassword: process.env.TEST_APP_PW } } }`,
    )
    const env = { TEST_APP_PW: 'abcd efgh ijkl mnop' }
    process.env.TEST_APP_PW = env.TEST_APP_PW
    try {
      const code = await runDoctor({
        cwd: root,
        env,
        log,
        createExtractor: () => ({
          probe: async () => ({ siteUrl: 'http://localhost:8080', counts: { posts: 12, pages: 3 }, seoPlugin: 'yoast' as const }),
        }),
      })
      expect(code).toBe(0)
      expect(output()).toMatch(/✔ WordPress at http:\/\/localhost:8080/)
      expect(output()).toMatch(/12 posts, 3 pages/)
      expect(output()).toMatch(/Revoke the Application Password/)
      expect(output()).not.toContain(env.TEST_APP_PW)
    } finally {
      delete process.env.TEST_APP_PW
    }
  })

  it('reports a source failure with its next step and exits 1', async () => {
    await writeConfig(`export default { source: { type: 'rest', url: 'https://example.com' } }`)
    const code = await runDoctor({
      cwd: root,
      log,
      createExtractor: () => ({
        probe: async () => {
          throw new RestError('REST_AUTH', 'Could not reach https://example.com/wp-json (401 Unauthorized)\nCheck WP_USER and WP_APP_PASSWORD.', 401)
        },
      }),
    })
    expect(code).toBe(1)
    expect(output()).toMatch(/✖ Could not reach https:\/\/example\.com\/wp-json \(401 Unauthorized\)\n {2}.*Check WP_USER/)
  })
})
