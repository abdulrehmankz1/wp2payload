import type { Payload } from 'payload'
import { describe, expect, it } from 'vitest'
import { inviteCheck } from '../../src/commands/migrate.js'
import { resolveConfig } from '../../src/config/index.js'
import { redactEmails, withoutEmails } from '../../src/report/pii.js'
import { formatSummary } from '../../src/report/summary.js'
import type { ReportJson } from '../../src/report/types.js'

describe('redactEmails', () => {
  it('replaces addresses, keeps retina file names', () => {
    expect(redactEmails('to Ann.Lee+wp@mail.Example.co.uk, cc bob@example.com.')).toBe('to [email], cc [email].')
    expect(redactEmails('uploads/2024/logo@2x.png and hero@3x.JPEG')).toBe('uploads/2024/logo@2x.png and hero@3x.JPEG')
    expect(redactEmails('Key (email)=(ann@example.com) already exists')).toBe('Key (email)=([email]) already exists')
    expect(redactEmails('no address @ here, user@localhost')).toBe('no address @ here, user@localhost')
  })

  it('stays fast on long text without an address', () => {
    const long = 'a'.repeat(200_000) + '@' + 'b'.repeat(200_000)
    const t = performance.now()
    redactEmails(long)
    expect(performance.now() - t).toBeLessThan(1000)
  })

  it('replaces addresses with non-ASCII letters whole, in the local part and the domain', () => {
    expect(redactEmails('user@bücher.de')).toBe('[email]')
    expect(redactEmails('jörg@x.de')).toBe('[email]')
    expect(redactEmails('mail jörg@x.de, then user@bücher.de.')).toBe('mail [email], then [email].')
    expect(redactEmails('иван@пример.рф wrote')).toBe('[email] wrote')
    // NFD: "ö" as "o" plus a combining diaeresis.
    expect(redactEmails('jörg@bücher.de')).toBe('[email]')
    expect(redactEmails('uploads/bücher@2x.png')).toBe('uploads/bücher@2x.png')
    expect(withoutEmails({ d: 'from user@bücher.de' })).toEqual({ d: 'from [email]' })
  })

  it('stays fast on about 1 MB of adversarial text, ASCII or not', () => {
    const inputs = [
      'ä'.repeat(500_000) + '@' + 'ü'.repeat(500_000),
      'ä@'.repeat(500_000),
      'a@' + 'ü.'.repeat(500_000),
      'a@' + 'ü-'.repeat(500_000),
      ('x@' + 'é'.repeat(70) + '.').repeat(13_000),
      ('ab@c' + 'd.'.repeat(9) + '1 ').repeat(40_000),
    ]
    for (const input of inputs) {
      const t = performance.now()
      redactEmails(input)
      expect(performance.now() - t).toBeLessThan(1000)
    }
  })

  it('withoutEmails copies a report with every string cleaned', () => {
    const input = { warnings: [{ code: 'X', detail: 'ann@example.com' }], n: 3, ok: true, none: null }
    const out = withoutEmails(input)
    expect(out).toEqual({ warnings: [{ code: 'X', detail: '[email]' }], n: 3, ok: true, none: null })
    expect(input.warnings[0]!.detail).toBe('ann@example.com')
  })
})

const report = (over: Partial<ReportJson>): ReportJson => ({
  version: 1,
  dryRun: false,
  site: 'https://old.test',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationSec: 1,
  summary: { authors: { created: 2 } },
  warnings: [],
  errors: [],
  security: { summary: { high: 0, medium: 0, low: 0 }, findings: [] },
  ...over,
})

describe('invitations in the summary', () => {
  it('shows sent and failed, or what a dry run would send', () => {
    const real = formatSummary(report({ invitations: { sent: 2, failed: 1 } }), { color: false, reportPath: 'r.json' })
    expect(real).toContain(' invitations  2 sent, 1 failed')
    const dry = formatSummary(report({ dryRun: true, invitations: { sent: 2, failed: 0 } }), { color: false, reportPath: 'r.json' })
    expect(dry).toContain(' invitations  2 would be sent')
    expect(formatSummary(report({}), { color: false, reportPath: 'r.json' }).join('\n')).not.toContain('invitations')
  })
})

describe('inviteCheck', () => {
  const config = (to: string) => resolveConfig({ source: { type: 'rest', url: 'https://old.test' }, collections: { author: { to } } })
  const payload = (auth: boolean, email: boolean) =>
    ({
      collections: { authors: { config: { fields: [] } }, users: { config: { fields: [], auth: auth ? {} : undefined } } },
      config: email ? { email: () => ({}) } : {},
    }) as unknown as Payload

  it('is silent for a non-auth collection, and warns that --invite-users does nothing there', () => {
    expect(inviteCheck(payload(true, true), config('authors'), false)).toBeUndefined()
    expect(inviteCheck(payload(true, true), config('authors'), true)).toMatchObject({ status: 'warn' })
  })

  it('fails --invite-users without an email adapter, since Payload would log the addresses', () => {
    expect(inviteCheck(payload(true, false), config('users'), true)).toMatchObject({ status: 'fail' })
  })

  it('warns that authors in an auth collection become login accounts to review before go-live', () => {
    for (const invite of [false, true]) {
      const check = inviteCheck(payload(true, true), config('users'), invite)
      expect(check).toMatchObject({ status: 'warn' })
      expect(check?.title).toContain('login accounts in users')
      expect(check?.detail).toMatch(/can log in/)
      expect(check?.detail).toContain('AUTHOR_ACCOUNT_CREATED')
      expect(check?.detail).toMatch(/before go-live/)
    }
  })
})

describe('accounts in the summary', () => {
  const created = (wpId: number) => ({ code: 'AUTHOR_ACCOUNT_CREATED', detail: `User ${wpId} (slug "u${wpId}") got a login account in users`, doc: `author:${wpId}` })

  it('counts the accounts created, or that a dry run would create', () => {
    const real = formatSummary(report({ warnings: [created(1), created(2)] }), { color: false, reportPath: 'r.json' })
    expect(real.join('\n')).toMatch(/ accounts +2 login accounts created; check each is a real person before go-live/)
    const dry = formatSummary(report({ dryRun: true, warnings: [created(1)] }), { color: false, reportPath: 'r.json' })
    expect(dry.join('\n')).toMatch(/ accounts +1 login account would be created/)
    expect(formatSummary(report({}), { color: false, reportPath: 'r.json' }).join('\n')).not.toContain('accounts')
  })

  it('lists each account with --verbose', () => {
    const lines = formatSummary(report({ warnings: [created(1), created(2)] }), { color: false, reportPath: 'r.json', verbose: true }).join('\n')
    expect(lines).toContain('AUTHOR_ACCOUNT_CREATED (author:1): User 1 (slug "u1")')
    expect(lines).toContain('AUTHOR_ACCOUNT_CREATED (author:2)')
  })
})
