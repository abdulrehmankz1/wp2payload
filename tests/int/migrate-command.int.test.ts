import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrate, type MigrateOptions } from '../../src/commands/migrate.js'
import type { Extractor, IRDocument } from '../../src/ir/types.js'
import { startDocumentsPayload, type DocumentsTestPayload } from './documents-harness.js'

// `wp2payload migrate` wiring (AC-D1, AC-D2): first-run confirmation, exit codes, report.json on
// every path, and Payload always closed. Boot and the source are injected; the pipeline is real.

let t: DocumentsTestPayload
let cwd: string
beforeAll(async () => {
  t = await startDocumentsPayload()
  cwd = await mkdtemp(path.join(os.tmpdir(), 'wp2p-cmd-'))
  await writeFile(
    path.join(cwd, 'wp2payload.config.ts'),
    `export default { source: { type: 'rest', url: 'https://cmd.test' }, collections: { post: { to: 'posts' }, media: { to: 'media' } } }\n`,
  )
})
afterAll(async () => {
  await t?.close()
  await rm(cwd, { recursive: true, force: true })
})

async function* each<T>(items: T[]): AsyncIterable<T> {
  for (const x of items) yield x
}

const post = (wpId: number, html = '<p>Hello</p>'): IRDocument => ({
  wpId, type: 'post', status: 'publish', slug: `p${wpId}`, title: `Post ${wpId}`, html,
  link: `https://cmd.test/p${wpId}/`, publishedAt: '2021-01-01T00:00:00.000Z', modifiedAt: '2021-01-01T00:00:00.000Z', termWpIds: [], meta: {},
})

function harness(docs: IRDocument[], over: Partial<MigrateOptions> = {}) {
  const lines: string[] = []
  let closed = 0
  let probed = 0
  const extractor: Extractor = {
    name: 'rest',
    probe: async () => {
      probed++
      return { siteUrl: 'https://cmd.test\u001b]52;c;evil\u0007', counts: {} }
    },
    media: () => each([]),
    terms: () => each([]),
    authors: () => each([]),
    documents: () => each(docs),
  }
  const opts: MigrateOptions = {
    cwd,
    env: { NO_COLOR: '1' },
    log: (l) => lines.push(l),
    isTTY: false,
    createExtractor: () => extractor,
    boot: async () => ({ payload: t.payload, close: async () => void closed++ }),
    ...over,
  }
  return { opts, lines, closed: () => closed, probed: () => probed }
}

const posts = async () => (await t.payload.count({ collection: 'posts', where: { 'wpMeta.site': { equals: 'https://cmd.test' } }, overrideAccess: true })).totalDocs

describe('runMigrate', () => {
  it('refuses a first run without a TTY or --yes, and closes Payload', async () => {
    const h = harness([post(1)])
    expect(await runMigrate(h.opts)).toBe(1)
    expect(h.lines.join('\n')).toMatch(/First run needs confirmation/)
    expect(await posts()).toBe(0)
    expect(h.closed()).toBe(1)
    // The site URL comes from the site: escape sequences never reach the terminal.
    expect(h.lines.join('\n')).not.toContain('\u001b]52')
  })

  it('previews, then writes nothing when the user declines', async () => {
    const h = harness([post(1)], { confirm: async () => false })
    expect(await runMigrate(h.opts)).toBe(0)
    expect(h.lines.join('\n')).toMatch(/Dry run of .* Nothing was written/)
    expect(h.lines).toContain('Nothing was written.')
    expect(await posts()).toBe(0)
    expect(existsSync(path.join(cwd, '.wp2payload', 'report.json'))).toBe(true)
  })

  it('writes after confirmation; later runs need no prompt', async () => {
    let asked = 0
    const h = harness([post(1)], { confirm: async () => (++asked, true) })
    expect(await runMigrate(h.opts)).toBe(0)
    expect(asked).toBe(1)
    expect(await posts()).toBe(1)
    const again = harness([post(1)])
    expect(await runMigrate(again.opts)).toBe(0)
    expect(await posts()).toBe(1)
  })

  it('exit codes: 4 for findings at --fail-on-security, 3 for warnings with --strict', async () => {
    const hostile = post(2, '<p>Hi</p><script>alert(1)</script>')
    expect(await runMigrate(harness([post(1), hostile], { yes: true, failOnSecurity: 'high' }).opts)).toBe(4)
    expect(await runMigrate(harness([post(1)], { yes: true, failOnSecurity: 'high' }).opts)).toBe(0)
    const unknown = post(3, '<!-- wp:acme/widget --><div>x</div><!-- /wp:acme/widget -->')
    expect(await runMigrate(harness([unknown], { yes: true, strict: true }).opts)).toBe(3)
  })

  it('reminds to revoke the Application Password after a real run with auth', async () => {
    const authed = await mkdtemp(path.join(os.tmpdir(), 'wp2p-cmd-auth-'))
    try {
      await writeFile(
        path.join(authed, 'wp2payload.config.ts'),
        `export default { source: { type: 'rest', url: 'https://auth.test', auth: { user: process.env.T_USER, appPassword: process.env.T_PASS } }, collections: { post: { to: 'posts' }, media: { to: 'media' } } }\n`,
      )
      process.env['T_USER'] = 'editor'
      process.env['T_PASS'] = 'not-a-real-password'
      const h = harness([post(1)], { cwd: authed, yes: true, env: { NO_COLOR: '1', T_USER: 'editor', T_PASS: 'not-a-real-password' } })
      expect(await runMigrate(h.opts)).toBe(0)
      expect(h.lines.join('\n')).toMatch(/Revoke the Application Password/)
    } finally {
      delete process.env['T_USER']
      delete process.env['T_PASS']
      await rm(authed, { recursive: true, force: true })
    }
  })

  it('rejects an unknown --only value with exit 2 before connecting', async () => {
    const h = harness([post(1)], { only: ['comments'] })
    expect(await runMigrate(h.opts)).toBe(2)
    expect(h.probed()).toBe(0)
    expect(h.closed()).toBe(0)
  })
})
