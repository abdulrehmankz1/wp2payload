import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isTag, isText, type AnyNode, type Element } from 'domhandler'
import fc from 'fast-check'
import { parseDocument } from 'htmlparser2'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runReport } from '../../src/commands/report.js'
import { buildReport } from '../../src/report/build.js'
import { CSP, esc } from '../../src/report/html.js'
import { renderSecurityReportHtml, SECURITY_HTML_PATH } from '../../src/report/security-html.js'
import { MemoryReport, type ReportJson } from '../../src/report/types.js'
import { writeReport, writeSecurityReport } from '../../src/report/write.js'
import { fuzzParams, fuzzTimeout, hostileHtml, hostileUrl, noise } from './fuzz-support.js'

// The HTML security report (doc 12.11) is a client deliverable built from site data and from a
// report.json on disk. For any input it must be inert: a fixed set of elements and attributes,
// no script, no link, no external resource, and only its own stylesheet allowed by the CSP.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-html-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'h1', 'h2', 'p', 'div', 'b', 'table', 'tr', 'th', 'td', 'code', 'footer'])
const ATTRS: Record<string, Set<string>> = {
  html: new Set(['lang']),
  meta: new Set(['charset', 'name', 'content', 'http-equiv']),
}
const CLASSES = new Set(['muted', 'note', 'cards', 'card', 'scroll', 'num', 'high', 'medium', 'low', 'unknown'])

function nodes(root: string | AnyNode): AnyNode[] {
  const out: AnyNode[] = []
  const stack: AnyNode[] = [typeof root === 'string' ? parseDocument(root) : root]
  while (stack.length) {
    const n = stack.pop()!
    out.push(n)
    if ('children' in n) for (const c of n.children) stack.push(c)
  }
  return out
}

/** Everything that would make the page do more than display text. Empty means inert. */
function problems(html: string): string[] {
  const out: string[] = []
  // Every '<' from the input is escaped, so no tag can appear in the raw text; attributes are checked on the parse below.
  if (/<(script|a|img|iframe|link|base|form|object|embed|svg|math)[\s/>]/i.test(html)) out.push('active markup in raw text')
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(html)) out.push('control or bidi character')
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(html)) out.push('lone surrogate')
  const els = nodes(html).filter(isTag) as Element[]
  for (const el of els) {
    if (!TAGS.has(el.name)) out.push(`element ${el.name}`)
    for (const [k, v] of Object.entries(el.attribs)) {
      if (k === 'class') {
        if (!v.split(' ').every((c) => CLASSES.has(c))) out.push(`class ${JSON.stringify(v)}`)
      } else if (!ATTRS[el.name]?.has(k)) out.push(`attribute ${el.name} ${k}`)
    }
  }
  const metas = els.filter((e) => e.name === 'meta' && e.attribs['http-equiv'])
  if (metas.length !== 1 || metas[0]!.attribs['http-equiv'] !== 'Content-Security-Policy' || metas[0]!.attribs['content'] !== CSP) out.push('CSP meta')
  const styles = els.filter((e) => e.name === 'style')
  const css = styles.map((s) => s.children.filter(isText).map((t) => t.data).join('')).join('')
  if (styles.length !== 1 || !CSP.includes(`'sha256-${createHash('sha256').update(css, 'utf8').digest('base64')}'`)) out.push('stylesheet does not match the CSP hash')
  return out
}

/** The visible text of every cell, as a browser would show it. */
function cellText(html: string): string[] {
  return (nodes(html).filter(isTag) as Element[])
    .filter((e) => e.name === 'td')
    .map((td) => nodes(td).filter(isText).map((t) => t.data).join(''))
}

const start = new Date('2026-10-29T10:00:00.000Z')

function sample(): ReportJson {
  const m = new MemoryReport()
  for (let i = 0; i < 3; i++) m.count('documents', 'created')
  m.count('media', 'created')
  m.count('media', 'rejected')
  m.warning({ code: 'UNKNOWN_BLOCK', detail: 'core/foo', doc: 'post:1' })
  m.warning({ code: 'UNKNOWN_BLOCK', detail: 'core/bar', doc: 'post:2' })
  m.error({ code: 'MEDIA_404', detail: 'https://old.test/a.jpg', media: 7 })
  m.finding({ code: 'SEC_SPAM_KEYWORDS', severity: 'low', action: 'flagged', doc: 'post:1' })
  m.finding({ code: 'SEC_SCRIPT_TAG', severity: 'high', action: 'quarantined', doc: 'post:1', quarantine: 'content/post-1-1.html.txt' })
  m.finding({ code: 'SEC_EXECUTABLE_UPLOAD', severity: 'high', action: 'rejected', media: 9, file: 'uploads/2021/04/logo.jpg.php' })
  return buildReport(m, {
    site: 'https://a.test', dryRun: false, startedAt: start, finishedAt: new Date(start.getTime() + 64_200),
    redirects: { count: 12, conflicts: 1, file: 'redirects.json' },
  })
}

describe('renderSecurityReportHtml', () => {
  it('shows the summary by severity, every finding, and a short run summary', () => {
    const html = renderSecurityReportHtml(sample(), { version: '1.2.3' })
    expect(problems(html)).toEqual([])
    expect(html).toContain('<title>Security report: https://a.test</title>')
    expect(html).toContain('Migration · started 2026-10-29 10:00 UTC · took 1m 4s · wp2payload 1.2.3')
    expect(html).toContain('<b class="high">2</b>high severity')
    expect(html).toContain('<b class="low">1</b>low severity')
    expect(html).toContain('<b>2</b>warnings')
    expect(html).toContain('executable upload rejected: uploads/2021/04/logo.jpg.php')
    const cells = cellText(html)
    // Findings: code, severity, where, action and quarantine path.
    expect(cells).toEqual(expect.arrayContaining(['SEC_SCRIPT_TAG', 'post:1', 'quarantined', 'content/post-1-1.html.txt']))
    expect(cells).toEqual(expect.arrayContaining(['media:9 · uploads/2021/04/logo.jpg.php', 'rejected']))
    // Run summary: phase counts, redirects, and warnings/errors grouped by code (no details).
    expect(html).toMatch(/<th>media<\/th><td class="num">1<\/td><td class="num">0<\/td>/)
    expect(html).toContain('Redirects: 12, 1 conflict, written to <code>redirects.json</code> for review.')
    expect(html).toMatch(/<code>UNKNOWN_BLOCK<\/code><\/td><td class="num">2<\/td>/)
    expect(html).toMatch(/<code>MEDIA_404<\/code><\/td><td class="num">1<\/td>/)
    expect(html).not.toContain('https://old.test/a.jpg')
    // Most severe first.
    expect(html.indexOf('SEC_EXECUTABLE_UPLOAD')).toBeLessThan(html.indexOf('SEC_SPAM_KEYWORDS'))
  })

  it('the inertness check itself catches active markup (negative control)', () => {
    const html = renderSecurityReportHtml(sample())
    expect(problems(html)).toEqual([])
    expect(problems(html.replace('</main>', '<img src=x onerror=alert(1)></main>'))).not.toEqual([])
    expect(problems(html.replace('<td class="num">', '<td class="num" onclick="x()">'))).not.toEqual([])
    expect(problems(html.replace('<td class="num">', '<td class="evil">'))).not.toEqual([])
    expect(problems(html.replace('.muted {', '.muted { color: red; } .x {'))).toContain('stylesheet does not match the CSP hash')
    expect(problems(html.replace('<p>', '<p>‮'))).toContain('control or bidi character')
  })

  it('says so for a dry run and for a run that stopped (RUN_FAILED)', () => {
    const m = new MemoryReport()
    m.error({ code: 'RUN_FAILED', detail: 'documents: database gone' })
    const r = buildReport(m, { site: 's.test', dryRun: true, startedAt: start, stopped: { phase: 'documents', reason: 'database gone' } })
    const html = renderSecurityReportHtml(r)
    expect(problems(html)).toEqual([])
    expect(html).toContain('Migration stopped early')
    expect(html).toContain('This was a dry run: nothing was written to the new site.')
    expect(html).toContain('The run stopped during documents: database gone.')
    expect(html).toContain('<code>RUN_FAILED</code>')
    expect(html).toContain('No security findings.')
  })

  it('renders hostile values from the site as inert text', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '"><img src=x onerror=alert(1)>',
      "'><svg/onload=alert(1)>",
      'javascript:alert(1)',
      '</td></tr></table><a href="https://evil.example/">click</a>',
      '</style><script>alert(1)</script>',
      '‮evil⁦ \u0000\u001b[31m\u0085',
      'lone \ud800 and \udfff surrogates',
    ]
    const r = sample()
    r.site = `https://a.test/${hostile[1]}`
    r.security.findings = hostile.map((h, i) => ({
      code: `SEC_${h}` as `SEC_${string}`, severity: 'high', action: 'removed', doc: h, file: h, quarantine: h, detail: h, media: i,
    }))
    r.warnings.push({ code: hostile[0]!, detail: hostile[0]! })
    r.summary[hostile[4]!] = { created: 1 }
    r.stopped = { phase: hostile[5]!, reason: hostile[1]! }
    r.redirects = { count: 1, conflicts: 0, file: hostile[4]! }
    const html = renderSecurityReportHtml(r, { version: hostile[0]! })
    expect(problems(html)).toEqual([])
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;')
    // A source URL stays text: it is shown, never a link.
    expect(cellText(html)).toContain('javascript:alert(1)')
    expect(html).toContain('lone � and � surrogates')
    expect(html).toContain('?evil? ??[31m?')
  })

  it('clips very long strings and caps the number of rows', () => {
    const r = sample()
    const long = 'A'.repeat(1_000_000)
    r.security.findings = Array.from({ length: 2500 }, (_, i) => ({ code: 'SEC_HIDDEN_TEXT', severity: 'low', action: 'removed', doc: `post:${i}`, detail: long }))
    const t0 = performance.now()
    const html = renderSecurityReportHtml(r)
    expect(performance.now() - t0).toBeLessThan(5000)
    expect(problems(html)).toEqual([])
    expect(html).toContain(`<td>${'A'.repeat(500)}…</td>`)
    expect(html).not.toContain('A'.repeat(501))
    expect(html).toContain('First 2000 of 2500 shown. All are in report.json.')
  })

  it('never shows an email address', () => {
    const r = sample()
    r.site = 'https://a.test'
    r.security.findings = [
      { code: 'SEC_HIDDEN_LINKS', severity: 'high', action: 'removed', doc: 'post:1', detail: 'contact spam.bot+x@evil.example or jösé@exämple.de, ok' },
      { code: 'SEC_DANGEROUS_URL', severity: 'high', action: 'removed', doc: 'post:2', detail: '<a href="mailto:a@b.example">' },
      { code: 'SEC_SSRF_BLOCKED', severity: 'medium', action: 'rejected', file: 'https://user:pw@intranet.example/x.jpg', detail: 'twitter @handle stays' },
    ]
    const html = renderSecurityReportHtml(r)
    // Visible text only: the stylesheet has an @media rule.
    const shown = nodes(html).filter(isText).map((t) => t.data).join('\n')
    expect(shown).not.toMatch(/@[\w-]+\./)
    expect(shown).toContain('contact [email hidden] or [email hidden], ok')
    expect(shown).toContain('<a href="[email hidden]">')
    expect(shown).toContain('twitter @handle stays')
    expect(shown).not.toContain('pw')
  })

  it('hides an address before clipping, so one cut at the limit does not leak partly', () => {
    const r = sample()
    // Clipping at 500 first would leave "john.doe@example.c…", which no longer looks like an address.
    for (const pad of [480, 485, 490, 495, 499]) {
      const detail = `${'x'.repeat(pad)} john.doe@example.com`
      r.security.findings = [{ code: 'SEC_HIDDEN_LINKS', severity: 'high', action: 'removed', doc: 'post:1', detail }]
      r.site = `${'s'.repeat(190)} jörg@bücher.de`
      const html = renderSecurityReportHtml(r)
      expect(html, String(pad)).not.toContain('john')
      expect(html, String(pad)).not.toContain('jörg')
      expect(html).not.toMatch(/@example/)
    }
  })

  it('long text is still fast to clean and clip', () => {
    const r = sample()
    const words = ['a@'.repeat(500_000), `x@${'ü.'.repeat(500_000)}`, `${'a'.repeat(500_000)}@${'b-'.repeat(250_000)}`]
    r.security.findings = words.map((detail, i) => ({ code: 'SEC_HIDDEN_TEXT', severity: 'low', action: 'removed', doc: `post:${i}`, detail }))
    const t0 = performance.now()
    const html = renderSecurityReportHtml(r)
    expect(performance.now() - t0).toBeLessThan(5000)
    expect(problems(html)).toEqual([])
  })

  it('lists the login accounts the run created, without email addresses', () => {
    const m = new MemoryReport()
    m.count('authors', 'created')
    m.count('authors', 'created')
    m.warning({ code: 'AUTHOR_ACCOUNT_CREATED', detail: 'User 7 (slug "seo-admin") got a login account in users. Check it is a real person before go-live', doc: 'author:7' })
    m.warning({ code: 'AUTHOR_ACCOUNT_CREATED', detail: 'User 8 (slug "<b>x</b>") (eve@evil.example) got a login account in users', doc: 'author:8' })
    const html = renderSecurityReportHtml(buildReport(m, { site: 'https://a.test', dryRun: false, startedAt: start }))
    expect(problems(html)).toEqual([])
    expect(html).toContain('<h2>Accounts created</h2>')
    expect(html).toContain('These WordPress users got an account that can log in')
    const cells = cellText(html)
    expect(cells).toEqual(expect.arrayContaining(['author:7', 'author:8']))
    expect(cells.some((c) => c.includes('slug "seo-admin"'))).toBe(true)
    expect(html).toContain('slug &quot;&lt;b&gt;x&lt;/b&gt;&quot;')
    expect(html).not.toContain('eve@')
    // Still counted with the other warnings.
    expect(html).toMatch(/<code>AUTHOR_ACCOUNT_CREATED<\/code><\/td><td class="num">2<\/td>/)

    const dry = renderSecurityReportHtml(buildReport(m, { site: 'https://a.test', dryRun: true, startedAt: start }))
    expect(dry).toContain('These WordPress users would get an account')
    expect(renderSecurityReportHtml(sample())).not.toContain('Accounts created')
  })

  it('survives a hand-edited report.json with the wrong types', () => {
    const broken = {
      version: 1, dryRun: 'yes', site: { toString: 1, valueOf: 1 }, startedAt: 5, durationSec: 'x',
      summary: { media: null, documents: { created: '<b>9</b>', updated: -4, skipped: Infinity }, __proto__x: [] },
      warnings: [null, 1, { code: { a: 1 } }], errors: 'none',
      security: { summary: null, findings: [null, 'x', 7, { severity: 'evil" onload="x', code: '<x>', action: { toString: 1 } }, { severity: '__proto__', code: 'constructor', action: 'constructor' }] },
      redirects: { count: '<script>', conflicts: NaN },
      stopped: { phase: ['<script>'], reason: 1 },
    } as unknown as ReportJson
    const html = renderSecurityReportHtml(broken)
    expect(problems(html)).toEqual([])
    expect(html).toContain('<title>Security report: unknown site</title>')
    expect(html).toContain('<td class="unknown">evil&quot; onload=&quot;x</td>')
  })

  it('property: any report renders as inert HTML', { timeout: fuzzTimeout(0.5) }, () => {
    const value = fc.oneof(noise(40), hostileHtml, hostileUrl)
    const loose = fc.oneof({ weight: 6, arbitrary: value }, fc.integer(), fc.constant(null), fc.anything({ maxDepth: 2 }))
    const finding = fc.record({
      code: fc.oneof(value.map((v) => `SEC_${v}`), loose), severity: fc.oneof(fc.constantFrom('high', 'medium', 'low'), loose),
      action: fc.oneof(fc.constantFrom('removed', 'quarantined', 'rejected'), loose), doc: loose, file: loose, media: loose,
      user: loose, detail: loose, quarantine: loose,
    }, { requiredKeys: [] })
    const issue = fc.record({ code: loose, detail: loose, doc: loose }, { requiredKeys: [] })
    const report = fc.record({
      version: fc.constant(1), dryRun: fc.boolean(), site: loose, startedAt: loose, durationSec: fc.oneof(fc.double(), loose),
      summary: fc.dictionary(value, fc.dictionary(fc.constantFrom('created', 'updated', 'skipped', 'x'), fc.oneof(fc.integer(), loose)), { maxKeys: 3 }),
      warnings: fc.array(fc.oneof(issue, loose), { maxLength: 4 }), errors: fc.array(fc.oneof(issue, loose), { maxLength: 4 }),
      redirects: fc.option(fc.record({ count: loose, conflicts: loose, file: loose })),
      security: fc.record({ summary: loose, findings: fc.array(fc.oneof({ weight: 4, arbitrary: finding }, loose), { maxLength: 6 }) }),
      stopped: fc.option(fc.record({ phase: loose, reason: loose })),
    })
    fc.assert(
      fc.property(report, value, (r, version) => {
        const html = renderSecurityReportHtml(r as unknown as ReportJson, { version })
        expect(problems(html)).toEqual([])
      }),
      fuzzParams(0.5),
    )
  })

  it('esc keeps text recoverable: what a browser shows is the input, minus controls', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 40 }), (s) => {
        const doc = parseDocument(`<p>${esc(s)}</p>`)
        expect(doc.children.length).toBe(1)
        expect(nodes(doc).filter(isText).map((t) => t.data).join('')).toBe(
          s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '?'),
        )
      }),
      fuzzParams(),
    )
  })
})

describe('writeSecurityReport', () => {
  it('writes .wp2payload/security-report.html and returns its path', async () => {
    expect(await writeSecurityReport(dir, sample(), { version: '1.0.0' })).toBe(SECURITY_HTML_PATH)
    const html = await readFile(path.join(dir, '.wp2payload', 'security-report.html'), 'utf8')
    expect(problems(html)).toEqual([])
    expect(html).toContain('wp2payload 1.0.0')
  })
})

describe('runReport --html', () => {
  const run = async (opts: Partial<Parameters<typeof runReport>[0]> = {}) => {
    const lines: string[] = []
    const code = await runReport({ cwd: dir, log: (l) => lines.push(l), env: { NO_COLOR: '1' }, ...opts })
    return { code, lines }
  }

  it('exports the last report to .wp2payload/security-report.html by default', async () => {
    await writeReport(dir, sample())
    const { code, lines } = await run({ html: true, version: '9.9.9' })
    expect(code).toBe(0)
    expect(lines).toEqual(['✔ Wrote .wp2payload/security-report.html'])
    const html = await readFile(path.join(dir, '.wp2payload', 'security-report.html'), 'utf8')
    expect(html).toBe(renderSecurityReportHtml(sample(), { version: '9.9.9' }))
    expect(problems(html)).toEqual([])
  })

  it('writes to a given path, creating its folder', async () => {
    await writeReport(dir, sample())
    const { code, lines } = await run({ html: path.join('out', 'client', 'report.html') })
    expect(code).toBe(0)
    expect(lines).toEqual(['✔ Wrote out/client/report.html'])
    expect(problems(await readFile(path.join(dir, 'out', 'client', 'report.html'), 'utf8'))).toEqual([])
  })

  it('never overwrites report.json or another .json file', async () => {
    await writeReport(dir, sample())
    const before = await readFile(path.join(dir, '.wp2payload', 'report.json'), 'utf8')
    for (const target of ['.wp2payload/report.json', 'x.JSON']) {
      const { code, lines } = await run({ html: target })
      expect(code).toBe(2)
      expect(lines[0]).toMatch(/Will not write HTML/)
    }
    expect(await readFile(path.join(dir, '.wp2payload', 'report.json'), 'utf8')).toBe(before)
    expect(existsSync(path.join(dir, 'x.JSON'))).toBe(false)
  })

  it('writes only to .html or .htm, so a typo cannot overwrite source code', async () => {
    await writeReport(dir, sample())
    await writeFile(path.join(dir, 'payload.config.ts'), 'export default {}\n', 'utf8')
    for (const target of ['payload.config.ts', 'notes.txt', 'report', 'report.html.ts', '.wp2payload/security-report.html.bak']) {
      const { code, lines } = await run({ html: target })
      expect(code, target).toBe(2)
      expect(lines[0]).toMatch(/Will not write HTML/)
      expect(lines.join('\n')).toContain('.html or .htm')
    }
    expect(await readFile(path.join(dir, 'payload.config.ts'), 'utf8')).toBe('export default {}\n')
    for (const f of ['notes.txt', 'report', 'report.html.ts']) expect(existsSync(path.join(dir, f))).toBe(false)
    for (const target of ['a.htm', 'b.HTML']) {
      expect((await run({ html: target })).code).toBe(0)
      expect(problems(await readFile(path.join(dir, target), 'utf8'))).toEqual([])
    }
  })

  it('refuses --json together with --html, and needs a report', async () => {
    expect((await run({ html: true, json: true })).code).toBe(2)
    const none = await run({ html: true })
    expect(none.code).toBe(1)
    expect(none.lines).toEqual(['No report yet. Run `wp2payload migrate --dry-run` first.'])
    expect(existsSync(path.join(dir, '.wp2payload', 'security-report.html'))).toBe(false)
  })

  it('a corrupt report.json writes nothing', async () => {
    await mkdir(path.join(dir, '.wp2payload'), { recursive: true })
    await writeFile(path.join(dir, '.wp2payload', 'report.json'), '{', 'utf8')
    expect((await run({ html: true })).code).toBe(1)
    expect(existsSync(path.join(dir, '.wp2payload', 'security-report.html'))).toBe(false)
  })
})
