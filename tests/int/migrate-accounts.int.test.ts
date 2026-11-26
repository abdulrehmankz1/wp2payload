import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CollectionConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrate, type MigrateOptions } from '../../src/commands/migrate.js'
import type { Extractor, IRAuthor, IRDocument } from '../../src/ir/types.js'
import { wpMetaField } from '../../src/loaders/wpmeta.js'
import type { ReportJson } from '../../src/report/types.js'
import { startPayload, type TestPayload } from './harness.js'

// SEC-01 (doc 2.6, 12.2 principle 6): `migrate` creates Payload login accounts only with
// authors.createAccounts. Without it, mapping authors into an auth collection stops in preflight
// with exit code 2 before anything is written; --invite-users without it is a usage error. With it,
// the report records the opt-in. Boot and the source are injected; preflight and the pipeline are real.

let t: TestPayload
const dirs: string[] = []
const members: CollectionConfig = {
  slug: 'members',
  auth: true,
  fields: [{ name: 'name', type: 'text' }, { name: 'slug', type: 'text' }, wpMetaField],
}

beforeAll(async () => {
  t = await startPayload({ collections: [members] })
})
afterAll(async () => {
  await t?.close()
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function* each<T>(items: T[]): AsyncIterable<T> {
  for (const x of items) yield x
}

const site = (n: number) => `https://accounts${n}.test`
// The attacker's user on a hacked site: it wrote the spam post, so it has content.
const spammer: IRAuthor = { wpId: 1, slug: 'seo-admin', displayName: 'admin', email: 'spam@evil.example' }
const spam = (n: number): IRDocument => ({
  wpId: 10, type: 'post', status: 'publish', slug: 'buy-now', title: 'Buy now', html: '<p>spam</p>', authorWpId: 1,
  link: `${site(n)}/buy-now/`, publishedAt: '2021-01-01T00:00:00.000Z', modifiedAt: '2021-01-01T00:00:00.000Z', termWpIds: [], meta: {},
})

async function project(n: number, authors = ''): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wp2p-accounts-'))
  dirs.push(cwd)
  await writeFile(path.join(cwd, 'wp2payload.config.ts'), `export default { source: { type: 'rest', url: '${site(n)}' }, collections: { author: { to: 'members' } }${authors} }\n`)
  return cwd
}

function harness(n: number, cwd: string, over: Partial<MigrateOptions> = {}) {
  const lines: string[] = []
  let probed = 0
  const extractor: Extractor = {
    name: 'rest',
    probe: async () => (probed++, { siteUrl: site(n), counts: {} }),
    media: () => each([]),
    terms: () => each([]),
    authors: () => each([spammer]),
    documents: () => each([spam(n)]),
  }
  const opts: MigrateOptions = {
    cwd,
    yes: true,
    env: { NO_COLOR: '1' },
    log: (l) => lines.push(l),
    isTTY: false,
    createExtractor: () => extractor,
    boot: async () => ({ payload: t.payload, close: async () => {} }),
    ...over,
  }
  return { opts, lines, out: () => lines.join('\n'), probed: () => probed }
}

const accounts = async (n: number) =>
  (await t.payload.count({ collection: 'members' as never, where: { 'wpMeta.site': { equals: site(n) } }, overrideAccess: true })).totalDocs
const report = async (cwd: string) => JSON.parse(await readFile(path.join(cwd, '.wp2payload', 'report.json'), 'utf8')) as ReportJson

describe('migrate: login accounts need authors.createAccounts (SEC-01)', () => {
  it('stops in preflight with exit 2 and writes nothing when authors map into an auth collection', async () => {
    const cwd = await project(1)
    for (const dryRun of [false, true]) {
      const h = harness(1, cwd, { dryRun })
      expect(await runMigrate(h.opts)).toBe(2)
      expect(h.out()).toMatch(/✖ Authors map into members, an auth collection, so each would get a login account/)
      expect(h.out()).toMatch(/attacker's own user[\s\S]*Nothing was written[\s\S]*authors: \{ createAccounts: true \}/)
    }
    expect(await accounts(1)).toBe(0)
    expect(existsSync(path.join(cwd, '.wp2payload'))).toBe(false)
  })

  it('makes --invite-users without the opt-in a usage error, before the source is read', async () => {
    const cwd = await project(2)
    const h = harness(2, cwd, { inviteUsers: true })
    expect(await runMigrate(h.opts)).toBe(2)
    expect(h.out()).toMatch(/--invite-users needs authors\.createAccounts/)
    expect(h.probed()).toBe(0)
    expect(await accounts(2)).toBe(0)
  })

  it('with the opt-in, creates and lists the accounts as before and records the opt-in in the report', async () => {
    const cwd = await project(3, ', authors: { createAccounts: true }')
    const dry = harness(3, cwd, { dryRun: true })
    expect(await runMigrate(dry.opts)).toBe(0)
    expect((await report(cwd)).optIns).toEqual([{ option: 'authors.createAccounts', detail: 'WordPress users with migrated content become login accounts in members' }])
    expect(await accounts(3)).toBe(0)

    // --strict is unchanged: the new account is a warning (exit 3); the opt-in itself is not.
    const h = harness(3, cwd, { strict: true })
    expect(await runMigrate(h.opts)).toBe(3)
    expect(h.out()).toMatch(/! Authors become login accounts in members \(authors\.createAccounts\)/)
    expect(h.out()).toMatch(/ opt-in\s+authors\.createAccounts: WordPress users with migrated content become login accounts in members/)
    expect(await accounts(3)).toBe(1)
    const json = await report(cwd)
    expect(json.warnings.map((w) => w.code)).toEqual(['AUTHOR_ACCOUNT_CREATED'])
    expect(json.optIns?.map((o) => o.option)).toEqual(['authors.createAccounts'])
    expect(await readFile(path.join(cwd, '.wp2payload', 'security-report.html'), 'utf8')).toMatch(/Safety defaults loosened[\s\S]*<code>authors\.createAccounts<\/code>/)

    // A re-run only updates: no warnings, so --strict passes although the opt-in is still recorded.
    const again = harness(3, cwd, { strict: true })
    expect(await runMigrate(again.opts)).toBe(0)
    expect((await report(cwd)).optIns).toHaveLength(1)
    expect(await accounts(3)).toBe(1)
  })
})
