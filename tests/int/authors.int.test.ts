import type { CollectionConfig, EmailAdapter } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IRAuthor } from '../../src/ir/types.js'
import { loadAuthors } from '../../src/loaders/authors.js'
import type { IdKind, LoaderContext } from '../../src/loaders/types.js'
import { wpMetaField } from '../../src/loaders/wpmeta.js'
import { MemoryReport } from '../../src/report/types.js'
import { startPayload, type TestPayload } from './harness.js'

let t: TestPayload
beforeAll(async () => {
  t = await startPayload()
})
afterAll(async () => {
  await t?.close()
})

function mkCtx(site: string, dryRun = false) {
  const map = new Map<string, string | number>()
  const report = new MemoryReport()
  const ctx: LoaderContext = {
    payload: t.payload,
    site,
    dryRun,
    ids: { get: (k: IdKind, id) => map.get(`${k}:${id}`), set: (k, id, v) => void map.set(`${k}:${id}`, v) },
    report,
    collections: { media: 'media', category: 'categories', post_tag: 'tags', author: 'authors' },
  }
  return { ctx, report, map }
}
const users: IRAuthor[] = [
  { wpId: 1, slug: 'ann', displayName: 'Ann', email: 'ann@example.com' },
  { wpId: 2, slug: 'bob', displayName: 'Bob' },
  { wpId: 3, slug: 'eve', displayName: 'Eve' },
]
const count = async () => (await t.payload.count({ collection: 'authors' })).totalDocs

describe('loadAuthors', () => {
  it('migrates only included users, reports the rest, never writes email', async () => {
    const a = mkCtx('https://auth.test')
    await loadAuthors(a.ctx, users, { include: new Set([1, 2]) })
    expect(a.report.summary['authors']).toEqual({ created: 2, skipped: 1 })
    expect(a.report.warnings).toHaveLength(1)
    expect(a.report.warnings[0]).toMatchObject({ code: 'AUTHOR_NOT_MIGRATED', doc: 'author:3' })
    expect(JSON.stringify(a.report.warnings)).not.toMatch(/eve/i)
    const ann = await t.payload.findByID({ collection: 'authors', id: a.map.get('author:1') as number })
    expect(ann).toMatchObject({ name: 'Ann', slug: 'ann' })
    expect(JSON.stringify(ann)).not.toContain('ann@example.com')
  })

  it('re-run is idempotent with the same ids', async () => {
    const a = mkCtx('https://auth2.test')
    await loadAuthors(a.ctx, users)
    const n = await count()
    const b = mkCtx('https://auth2.test')
    await loadAuthors(b.ctx, users)
    expect(b.report.summary['authors']).toEqual({ updated: 3 })
    expect(await count()).toBe(n)
    expect(b.map.get('author:2')).toBe(a.map.get('author:2'))
  })

  it('dry run writes nothing', async () => {
    const n = await count()
    const d = mkCtx('https://auth3.test', true)
    await loadAuthors(d.ctx, users)
    expect(d.report.summary['authors']).toEqual({ created: 3 })
    expect(await count()).toBe(n)
  })
})

// Doc 2.6: authors mapped into an auth collection (opt-in). A stub adapter records every email; nothing is sent.
describe('loadAuthors into an auth collection', () => {
  let u: TestPayload
  const sent: { to: string; subject: string }[] = []
  const failFor = new Set<string>()
  const passwords: string[] = []
  const stubEmail: EmailAdapter = () => ({
    name: 'test-stub',
    defaultFromAddress: 'noreply@test.invalid',
    defaultFromName: 'Test',
    sendEmail: async (message) => {
      const to = String(message.to)
      if (failFor.has(to)) throw new Error(`SMTP 550 mailbox unavailable: ${to}`)
      sent.push({ to, subject: String(message.subject) })
    },
  })
  const members: CollectionConfig = {
    slug: 'members',
    auth: true,
    // Captures what the loader hands Payload, so the test can check the generated password.
    hooks: {
      beforeValidate: [
        ({ data, operation }) => {
          if (operation === 'create' && typeof data?.['password'] === 'string') passwords.push(data['password'])
          return data
        },
      ],
    },
    fields: [{ name: 'name', type: 'text' }, { name: 'slug', type: 'text' }, wpMetaField],
  }
  // `verify` on, and no name or slug fields.
  const verified: CollectionConfig = { slug: 'verified', auth: { verify: true }, fields: [wpMetaField] }

  beforeAll(async () => {
    u = await startPayload({ collections: [members, verified], email: stubEmail })
  })
  afterAll(async () => {
    await u?.close()
  })
  const reset = () => {
    sent.length = 0
    failFor.clear()
    passwords.length = 0
  }

  function ctxFor(site: string, collection: string, dryRun = false) {
    const map = new Map<string, string | number>()
    const report = new MemoryReport()
    const ctx: LoaderContext = {
      payload: u.payload,
      site,
      dryRun,
      ids: { get: (k: IdKind, id) => map.get(`${k}:${id}`), set: (k, id, v) => void map.set(`${k}:${id}`, v) },
      report,
      collections: { media: 'media', author: collection as never },
    }
    return { ctx, report, map }
  }
  const people = (prefix: string): IRAuthor[] => [
    { wpId: 1, slug: 'ann', displayName: 'Ann', email: ` ${prefix}Ann@Example.com ` },
    { wpId: 2, slug: 'bob', displayName: 'Bob', email: `${prefix}bob@example.com` },
  ]
  const find = async (collection: string, email: string) =>
    (await u.payload.find({ collection: collection as never, where: { email: { equals: email } }, overrideAccess: true, showHiddenFields: true }))
      .docs[0] as Record<string, unknown> | undefined
  const total = async (collection: string) => (await u.payload.count({ collection: collection as never, overrideAccess: true })).totalDocs

  it('creates accounts with the email and a random 32-byte password, and sends nothing without invite', async () => {
    reset()
    const a = ctxFor('https://users1.test', 'members')
    expect(await loadAuthors(a.ctx, people('1-'))).toEqual({ auth: true })
    expect(a.report.summary['authors']).toEqual({ created: 2 })
    expect(sent).toEqual([])
    expect(await find('members', '1-ann@example.com')).toMatchObject({ name: 'Ann', slug: 'ann', wpMeta: { site: 'https://users1.test', wpId: 1 } })
    expect(passwords).toHaveLength(2)
    for (const p of passwords) expect(Buffer.from(p, 'base64url')).toHaveLength(32)
    expect(passwords[0]).not.toBe(passwords[1])
    // Never in the report or the ID cache.
    const out = JSON.stringify({ report: a.report, map: [...a.map] })
    for (const p of passwords) expect(out).not.toContain(p)
    expect(out).not.toMatch(/@example\.com/i)
  })

  it('--invite-users emails each new user once, and a re-run sends nothing', async () => {
    reset()
    const a = ctxFor('https://users2.test', 'members')
    expect(await loadAuthors(a.ctx, people('2-'), { invite: true })).toEqual({ auth: true, invitations: { sent: 2, failed: 0 } })
    expect(sent.map((m) => m.to).sort()).toEqual(['2-ann@example.com', '2-bob@example.com'])
    expect((await find('members', '2-ann@example.com'))?.['resetPasswordToken']).toBeTruthy()

    const b = ctxFor('https://users2.test', 'members')
    expect(await loadAuthors(b.ctx, people('2-'), { invite: true })).toEqual({ auth: true, invitations: { sent: 0, failed: 0 } })
    expect(b.report.summary['authors']).toEqual({ updated: 2 })
    expect(sent).toHaveLength(2)
    // An update never sets a password.
    expect(passwords).toHaveLength(2)
    expect(b.map.get('author:1')).toBe(a.map.get('author:1'))
  })

  it('a dry run with --invite-users writes and sends nothing but counts the invitations', async () => {
    reset()
    const n = await total('members')
    const d = ctxFor('https://users3.test', 'members', true)
    expect(await loadAuthors(d.ctx, people('3-'), { invite: true })).toEqual({ auth: true, invitations: { sent: 2, failed: 0 } })
    expect(d.report.summary['authors']).toEqual({ created: 2 })
    expect(sent).toEqual([])
    expect(await total('members')).toBe(n)
  })

  it('skips users without an email and never takes over an existing account', async () => {
    reset()
    const owner = (await u.payload.create({
      collection: 'members' as never,
      data: { email: 'owner@example.com', password: 'owner-pass-1234', name: 'Owner' } as never,
      overrideAccess: true,
    })) as { id: number }
    const a = ctxFor('https://users4.test', 'members')
    const res = await loadAuthors(
      a.ctx,
      [
        { wpId: 7, slug: 'nomail', displayName: 'No Mail' },
        { wpId: 8, slug: 'mallory', displayName: 'Mallory', email: 'OWNER@example.com' },
      ],
      { invite: true },
    )
    expect(res.invitations).toEqual({ sent: 0, failed: 0 })
    expect(a.report.summary['authors']).toEqual({ skipped: 2 })
    expect(a.report.warnings.map((w) => w.code)).toEqual(['AUTHOR_NO_EMAIL', 'AUTHOR_EMAIL_IN_USE'])
    expect(JSON.stringify(a.report.warnings)).not.toMatch(/owner@/i)
    const after = (await u.payload.findByID({ collection: 'members' as never, id: owner.id, overrideAccess: true })) as Record<string, unknown>
    expect(after['name']).toBe('Owner')
    expect((after['wpMeta'] as { site?: unknown } | undefined)?.site ?? null).toBeNull()
    expect(sent).toEqual([])
  })

  it('a failed send is a warning without the address, unless includePii', async () => {
    reset()
    failFor.add('5-ann@example.com')
    const a = ctxFor('https://users5.test', 'members')
    const res = await loadAuthors(a.ctx, [{ wpId: 1, slug: 'ann', displayName: 'Ann', email: '5-ann@example.com' }], { invite: true })
    expect(res.invitations).toEqual({ sent: 0, failed: 1 })
    expect(a.report.summary['authors']).toEqual({ created: 1 })
    expect(a.report.warnings.map((w) => w.code)).toEqual(['AUTHOR_ACCOUNT_CREATED', 'AUTHOR_INVITE_FAILED'])
    const failed = a.report.warnings[1]!
    expect(failed).toMatchObject({ code: 'AUTHOR_INVITE_FAILED', doc: 'author:1' })
    expect(failed.detail).toContain('SMTP 550')
    expect(failed.detail).not.toContain('@')

    failFor.add('6-ann@example.com')
    const b = ctxFor('https://users6.test', 'members')
    await loadAuthors(b.ctx, [{ wpId: 1, slug: 'ann', displayName: 'Ann', email: '6-ann@example.com' }], { invite: true, includePii: true })
    expect(b.report.warnings.find((w) => w.code === 'AUTHOR_INVITE_FAILED')!.detail).toContain('6-ann@example.com')
  })

  // SEC-01: on a hacked site the attacker's user wrote the spam and gets an account; each one is listed for review.
  it('reports every account it creates by wpId and slug, never the email unless includePii', async () => {
    reset()
    const a = ctxFor('https://users8.test', 'members')
    await loadAuthors(a.ctx, [...people('8-'), { wpId: 3, slug: 'seo-admin', displayName: 'admin', email: 'x@spam.example' }])
    const created = a.report.warnings.filter((w) => w.code === 'AUTHOR_ACCOUNT_CREATED')
    expect(created.map((w) => w.doc)).toEqual(['author:1', 'author:2', 'author:3'])
    expect(created[2]!.detail).toBe('User 3 (slug "seo-admin") got a login account in members. Check it is a real person before go-live')
    expect(JSON.stringify(a.report.warnings)).not.toContain('@')

    // A re-run updates and reports nothing new.
    const b = ctxFor('https://users8.test', 'members')
    await loadAuthors(b.ctx, people('8-'))
    expect(b.report.warnings).toEqual([])

    // A dry run lists what it would create; --include-pii adds the address.
    const d = ctxFor('https://users9.test', 'members', true)
    await loadAuthors(d.ctx, people('9-'), { includePii: true })
    expect(d.report.warnings.map((w) => w.code)).toEqual(['AUTHOR_ACCOUNT_CREATED', 'AUTHOR_ACCOUNT_CREATED'])
    expect(d.report.warnings[1]!.detail).toBe('User 2 (slug "bob") (9-bob@example.com) would get a login account in members. Check it is a real person before go-live')
  })

  it('a non-auth collection creates no accounts and reports none', async () => {
    const a = ctxFor('https://users10.test', 'authors' as never)
    await loadAuthors(a.ctx, people('10-'))
    expect(a.report.summary['authors']).toEqual({ created: 2 })
    expect(a.report.warnings).toEqual([])
  })

  it('a collection with verify gets no verification email, and fields it lacks are dropped', async () => {
    reset()
    const a = ctxFor('https://users7.test', 'verified')
    await loadAuthors(a.ctx, [{ wpId: 1, slug: 'ann', displayName: 'Ann', email: '7-ann@example.com' }])
    expect(a.report.errors).toEqual([])
    expect(a.report.summary['authors']).toEqual({ created: 1 })
    expect(sent).toEqual([])
  })
})
