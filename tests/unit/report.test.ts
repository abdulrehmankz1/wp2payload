import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runReport } from '../../src/commands/report.js'
import { buildReport } from '../../src/report/build.js'
import { exitCode } from '../../src/report/exit.js'
import { clean, formatDuration, formatSummary } from '../../src/report/summary.js'
import { MemoryReport, type ReportJson, type Severity } from '../../src/report/types.js'
import { readReport, ReportCorruptError, writeReport } from '../../src/report/write.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-report-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const start = new Date('2026-10-29T10:00:00.000Z')
const end = new Date('2026-10-29T10:01:04.200Z')

function sample(): MemoryReport {
  const m = new MemoryReport()
  for (let i = 0; i < 3; i++) m.count('documents', 'created')
  m.count('media', 'created')
  m.count('media', 'rejected')
  m.count('terms', 'reused')
  m.count('authors', 'created')
  m.count('zeta', 'skipped')
  m.count('redirects-extra', 'created')
  m.warning({ code: 'UNKNOWN_BLOCK', detail: 'core/foo x2', doc: 'post:1' })
  m.warning({ code: 'UNKNOWN_BLOCK', detail: 'core/bar', doc: 'post:2' })
  m.warning({ code: 'LINK_NOT_MIGRATED', detail: 'https://old.test/x', doc: 'post:2' })
  m.error({ code: 'MEDIA_404', detail: 'GET returned 404', media: 7 })
  m.finding({ code: 'SEC_SPAM_KEYWORDS', severity: 'low', action: 'flagged', doc: 'post:1' })
  m.finding({ code: 'SEC_SCRIPT_TAG', severity: 'high', action: 'quarantined', doc: 'post:1' })
  m.finding({ code: 'SEC_IFRAME_UNKNOWN_HOST', severity: 'medium', action: 'quarantined', doc: 'post:3' })
  m.finding({ code: 'SEC_SCRIPT_TAG', severity: 'high', action: 'quarantined', doc: 'post:4' })
  m.finding({ code: 'SEC_EXECUTABLE_UPLOAD', severity: 'high', action: 'rejected', media: 9, file: 'uploads/2021/04/logo.jpg.php' })
  return m
}

const build = (overrides: Partial<Parameters<typeof buildReport>[1]> = {}): ReportJson =>
  buildReport(sample(), { site: 'https://a.test', dryRun: false, startedAt: start, finishedAt: end, ...overrides })

describe('buildReport (AC-B1)', () => {
  it('builds doc 4.9 shape with a full severity summary and high-to-low stable findings', () => {
    const r = build()
    expect(r).toMatchObject({ version: 1, dryRun: false, site: 'https://a.test', startedAt: start.toISOString(), durationSec: 64.2 })
    expect(r.security.summary).toEqual({ high: 3, medium: 1, low: 1 })
    expect(r.security.findings.map((f) => `${f.severity}:${f.doc ?? f.media}`)).toEqual([
      'high:post:1',
      'high:post:4',
      'high:9',
      'medium:post:3',
      'low:post:1',
    ])
    expect(r.summary['documents']).toEqual({ created: 3 })
    expect(r.warnings).toHaveLength(3)
    expect(r.errors).toHaveLength(1)
    expect('stopped' in r).toBe(false)
    expect('redirects' in r).toBe(false)
  })

  it('always has high/medium/low keys, even with no findings', () => {
    const r = buildReport(new MemoryReport(), { site: 's', dryRun: true, startedAt: start, finishedAt: start })
    expect(r.security).toEqual({ summary: { high: 0, medium: 0, low: 0 }, findings: [] })
    expect(r.durationSec).toBe(0)
  })

  it('copies stopped and redirects, and does not alias the MemoryReport', () => {
    const m = sample()
    const r = buildReport(m, {
      site: 's',
      dryRun: false,
      startedAt: start,
      finishedAt: end,
      stopped: { phase: 'media', reason: 'Too many errors' },
      redirects: { count: 4, conflicts: 1 },
    })
    expect(r.stopped).toEqual({ phase: 'media', reason: 'Too many errors' })
    expect(r.redirects).toEqual({ count: 4, conflicts: 1 })
    m.count('documents', 'created')
    expect(r.summary['documents']).toEqual({ created: 3 })
  })
})

describe('writeReport / readReport (AC-B1)', () => {
  it('writes atomically, overwrites, returns a forward-slash relative path, and reads back', async () => {
    const r = build()
    expect(await writeReport(dir, r)).toBe('.wp2payload/report.json')
    expect(await writeReport(dir, { ...r, dryRun: true })).toBe('.wp2payload/report.json') // Windows replace path
    expect(await readdir(path.join(dir, '.wp2payload'))).toEqual(['report.json'])
    const back = await readReport(dir)
    expect(back).toEqual({ ...r, dryRun: true })
    expect(JSON.parse(await readFile(path.join(dir, '.wp2payload', 'report.json'), 'utf8'))).toEqual(back)
  })

  it('returns undefined when there is no report', async () => {
    expect(await readReport(dir)).toBeUndefined()
  })

  it.each([
    ['invalid JSON', '{ nope', /not valid JSON/],
    ['wrong version', JSON.stringify({ ...build(), version: 2 }), /unsupported version 2/],
    ['missing fields', JSON.stringify({ version: 1, site: 's' }), /missing required fields/],
    ['not an object', '42', /not a JSON object/],
  ])('corrupt report (%s) gives a clear error with a next step', async (_name, content, re) => {
    await mkdir(path.join(dir, '.wp2payload'), { recursive: true })
    await writeFile(path.join(dir, '.wp2payload', 'report.json'), content, 'utf8')
    const err = await readReport(dir).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReportCorruptError)
    expect((err as Error).message).toMatch(re)
    expect((err as Error).message).toMatch(/migrate --dry-run/)
  })
})

describe('formatSummary (AC-B2)', () => {
  const opts = { color: false, reportPath: '.wp2payload/report.json' }

  it('prints header, phases in stable order, issue totals, the security block and Details', () => {
    const lines = formatSummary(build(), opts)
    expect(lines[0]).toBe('Migration of https://a.test finished in 1m 4s with 1 error')
    const phaseLines = lines.filter((l) => /^ \S/.test(l)).map((l) => l.trim().split(/\s+/)[0])
    expect(phaseLines).toEqual(['media', 'terms', 'authors', 'documents', 'redirects-extra', 'zeta'])
    expect(lines.find((l) => l.startsWith(' media'))).toMatch(/^ media +1 created, 1 rejected$/)
    expect(lines).toContain('Warnings: 3')
    expect(lines).toContain('  ! 2  UNKNOWN_BLOCK')
    expect(lines).toContain('  ! 1  LINK_NOT_MIGRATED')
    expect(lines).toContain('Errors: 1')
    expect(lines).toContain('  ✖ 1  MEDIA_404')
    const sec = lines.slice(lines.indexOf('Security'))
    expect(sec).toEqual([
      'Security',
      '✖ 2 high    script elements quarantined',
      '✖ 1 high    executable upload rejected: uploads/2021/04/logo.jpg.php',
      '! 1 medium  iframe from an unknown host quarantined',
      '  1 low     link with spam keywords flagged for review',
      'Details: .wp2payload/report.json',
    ])
    expect(lines.join('\n')).not.toMatch(/\u001b\[/)
  })

  it('dry run header, no findings, no issues', () => {
    const r = buildReport(new MemoryReport(), { site: 's.test', dryRun: true, startedAt: start, finishedAt: new Date(start.getTime() + 4200) })
    const lines = formatSummary(r, opts)
    expect(lines[0]).toBe('Dry run of s.test finished in 4.2s. Nothing was written.')
    expect(lines).toContain(' No items processed.')
    expect(lines).toContain('Warnings: none')
    expect(lines).toContain('Errors: none')
    expect(lines.slice(-3)).toEqual(['Security', '  No findings.', 'Details: .wp2payload/report.json'])
  })

  it('verbose lists every issue with its location', () => {
    const lines = formatSummary(build(), { ...opts, verbose: true })
    expect(lines).toContain('  ! UNKNOWN_BLOCK (post:1): core/foo x2')
    expect(lines).toContain('  ! LINK_NOT_MIGRATED (post:2): https://old.test/x')
    expect(lines).toContain('  ✖ MEDIA_404 (media 7): GET returned 404')
  })

  it('groups beyond the top 5 codes into a pointer to the report', () => {
    const m = new MemoryReport()
    for (const c of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) m.warning({ code: c, detail: '' })
    const lines = formatSummary(buildReport(m, { site: 's', dryRun: false, startedAt: start, finishedAt: start }), opts)
    expect(lines).toContain('  and 2 more codes; see the report or use --verbose')
  })

  it('shows the stopped reason', () => {
    const lines = formatSummary(build({ stopped: { phase: 'media', reason: 'more than 10% of items failed' } }), opts)
    expect(lines[0]).toBe('Migration of https://a.test stopped after 1m 4s')
    expect(lines).toContain('✖ Stopped during media: more than 10% of items failed')
  })

  it('falls back to the code for unknown findings and joins mixed actions', () => {
    const m = new MemoryReport()
    m.finding({ code: 'SEC_NEW_THING', severity: 'medium', action: 'flagged' })
    m.finding({ code: 'SEC_JS_REDIRECT', severity: 'high', action: 'quarantined' })
    m.finding({ code: 'SEC_JS_REDIRECT', severity: 'high', action: 'removed' })
    const lines = formatSummary(buildReport(m, { site: 's', dryRun: false, startedAt: start, finishedAt: start }), opts)
    expect(lines).toContain('✖ 2 high    script redirects quarantined or removed')
    expect(lines).toContain('! 1 medium  SEC_NEW_THING flagged for review')
  })

  it('uses standard ANSI colours only when color is on', () => {
    const text = formatSummary(build(), { ...opts, color: true }).join('\n')
    expect(text).toContain('\u001b[31m✖\u001b[0m')
    expect(text).toContain('\u001b[33m!\u001b[0m')
    const codes = [...text.matchAll(/\u001b\[(\d+)m/g)].map((m) => Number(m[1]))
    expect(codes.every((c) => [0, 1, 2, 31, 33].includes(c))).toBe(true)
  })

  it('neutralises terminal escapes in report text from WordPress', () => {
    const m = new MemoryReport()
    m.warning({ code: 'X', detail: 'evil \u001b[2J‮ text' })
    m.finding({ code: 'SEC_EXECUTABLE_UPLOAD', severity: 'high', action: 'rejected', file: 'a\u001b]0;pwn\u0007.php' })
    const r = buildReport(m, { site: 's\u001b[31m', dryRun: false, startedAt: start, finishedAt: start })
    const text = formatSummary(r, { ...opts, verbose: true }).join('\n')
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f‮]/)
    expect(clean('a\nb')).toBe('a?b')
  })

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(4.25)).toBe('4.3s')
    expect(formatDuration(3725)).toBe('1h 2m')
    expect(formatDuration(Number.NaN)).toBe('0s')
  })
})

describe('exitCode (AC-B3)', () => {
  const clean0 = buildReport(new MemoryReport(), { site: 's', dryRun: false, startedAt: start, finishedAt: start })
  const withWarn = (() => {
    const m = new MemoryReport()
    m.warning({ code: 'W', detail: '' })
    return buildReport(m, { site: 's', dryRun: false, startedAt: start, finishedAt: start })
  })()
  const withErrOnly = (() => {
    const m = new MemoryReport()
    m.error({ code: 'MEDIA_404', detail: '' })
    return buildReport(m, { site: 's', dryRun: false, startedAt: start, finishedAt: start })
  })()
  const withFinding = (sev: Severity, warn = false): ReportJson => {
    const m = new MemoryReport()
    m.finding({ code: 'SEC_X', severity: sev, action: 'flagged' })
    if (warn) m.warning({ code: 'W', detail: '' })
    return buildReport(m, { site: 's', dryRun: false, startedAt: start, finishedAt: start })
  }
  const stopped: ReportJson = { ...withFinding('high', true), stopped: { phase: 'media', reason: 'r' } }

  it.each<[string, Parameters<typeof exitCode>[0], number]>([
    ['clean run', { report: clean0 }, 0],
    ['no report, nothing wrong', {}, 0],
    ['warnings without --strict', { report: withWarn }, 0],
    ['warnings with --strict', { report: withWarn, strict: true }, 3],
    ['errors with --strict', { report: withErrOnly, strict: true }, 3],
    ['clean with --strict', { report: clean0, strict: true }, 0],
    ['findings without --fail-on-security', { report: withFinding('high') }, 0],
    ['high finding, fail-on high', { report: withFinding('high'), failOnSecurity: 'high' }, 4],
    ['medium finding, fail-on high', { report: withFinding('medium'), failOnSecurity: 'high' }, 0],
    ['medium finding, fail-on medium', { report: withFinding('medium'), failOnSecurity: 'medium' }, 4],
    ['low finding, fail-on medium', { report: withFinding('low'), failOnSecurity: 'medium' }, 0],
    ['low finding, fail-on low', { report: withFinding('low'), failOnSecurity: 'low' }, 4],
    ['high finding, fail-on low', { report: withFinding('high'), failOnSecurity: 'low' }, 4],
    ['security (4) beats strict (3)', { report: withFinding('high', true), strict: true, failOnSecurity: 'low' }, 4],
    ['strict applies when security is below level', { report: withFinding('low', true), strict: true, failOnSecurity: 'high' }, 3],
    ['fatal (1) beats security and strict', { fatal: true, report: withFinding('high', true), strict: true, failOnSecurity: 'low' }, 1],
    ['stopped report counts as fatal', { report: stopped, strict: true, failOnSecurity: 'low' }, 1],
    ['fatal with no report', { fatal: true }, 1],
    ['invalid config (2) beats everything', { configInvalid: true, fatal: true, report: stopped, strict: true, failOnSecurity: 'low' }, 2],
  ])('%s → %i', (_name, input, expected) => {
    expect(exitCode(input)).toBe(expected)
  })
})

describe('runReport (AC-B4)', () => {
  const run = async (opts: Partial<Parameters<typeof runReport>[0]> = {}) => {
    const lines: string[] = []
    const code = await runReport({ cwd: dir, log: (l) => lines.push(l), env: { NO_COLOR: '1' }, ...opts })
    return { code, lines }
  }

  it('missing report explains how to create one, exit 1', async () => {
    const { code, lines } = await run()
    expect(code).toBe(1)
    expect(lines).toEqual(['No report yet. Run `wp2payload migrate --dry-run` first.'])
  })

  it('reprints the summary of the last report without colour under NO_COLOR', async () => {
    await writeReport(dir, build())
    const { code, lines } = await run()
    expect(code).toBe(0)
    expect(lines[0]).toBe('Migration of https://a.test finished in 1m 4s with 1 error')
    expect(lines.at(-1)).toBe('Details: .wp2payload/report.json')
    expect(lines.join('\n')).not.toMatch(/\u001b\[/)
  })

  it('--json prints the raw report', async () => {
    const r = build()
    await writeReport(dir, r)
    const { code, lines } = await run({ json: true })
    expect(code).toBe(0)
    expect(JSON.parse(lines.join('\n'))).toEqual(r)
  })

  it('corrupt report prints a clear error, exit 1', async () => {
    await mkdir(path.join(dir, '.wp2payload'), { recursive: true })
    await writeFile(path.join(dir, '.wp2payload', 'report.json'), '{', 'utf8')
    const { code, lines } = await run()
    expect(code).toBe(1)
    expect(lines.join('\n')).toMatch(/cannot be read[\s\S]*migrate --dry-run/)
  })
})
