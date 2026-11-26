import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runReview } from '../../src/commands/review.js'
import { approvable, loadApprovals, readReview } from '../../src/review/store.js'
import { sanitizeContent, scanDocument } from '../../src/security/content/index.js'
import { writeQuarantine } from '../../src/security/quarantine.js'
import type { SecurityFinding } from '../../src/report/types.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-review-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const HIDDEN = '<div style="display:none"><a href="https://ok.example/">Read more</a></div>'
const opts = { doc: 'post:1', siteOrigin: 'https://site.example', embedHosts: [], externalLinkRel: 'nofollow' }

async function seed() {
  const items: [string, SecurityFinding, string][] = [
    ['map', { code: 'SEC_IFRAME_UNKNOWN_HOST', severity: 'medium', action: 'quarantined', doc: 'page:70', detail: '<iframe> to www.google.com' }, '<iframe src="https://www.google.com/maps/embed"></iframe>'],
    ['hidden', { code: 'SEC_HIDDEN_LINKS', severity: 'high', action: 'quarantined', doc: 'post:1', detail: '1 link in hidden <div> (display:none)' }, HIDDEN],
    ['script', { code: 'SEC_SCRIPT_TAG', severity: 'high', action: 'quarantined', doc: 'post:1', detail: '<script>' }, '<script>alert(1)</script>\u001b[2J'],
  ]
  const ids: string[] = []
  for (const [name, finding, text] of items) ids.push(await writeQuarantine(root, { kind: 'content', name, text, finding }))
  return ids
}

describe('approvable', () => {
  it('allows only findings that are safe once sanitized', () => {
    expect(approvable({ code: 'SEC_IFRAME_UNKNOWN_HOST', severity: 'medium', action: 'quarantined', detail: '<iframe> to maps.example.com' })).toMatchObject({ ok: true, host: 'maps.example.com' })
    expect(approvable({ code: 'SEC_IFRAME_UNKNOWN_HOST', severity: 'medium', action: 'quarantined', detail: '<iframe> to http://x.example' }).ok).toBe(false)
    expect(approvable({ code: 'SEC_HIDDEN_LINKS', severity: 'high', action: 'quarantined' }).ok).toBe(true)
    for (const code of ['SEC_SCRIPT_TAG', 'SEC_EVENT_HANDLER', 'SEC_DANGEROUS_URL', 'SEC_EXECUTABLE_UPLOAD', 'SEC_SVG_REJECTED'] as const) {
      expect(approvable({ code, severity: 'high', action: 'rejected' }).ok, code).toBe(false)
    }
  })
})

describe('wp2payload review', () => {
  it('lists items with their status when not in a terminal', async () => {
    const ids = await seed()
    const lines: string[] = []
    expect(await runReview({ cwd: root, isTTY: false, log: (l) => lines.push(l) })).toBe(0)
    expect(lines.join('\n')).toMatch(/pending\s+medium SEC_IFRAME_UNKNOWN_HOST\s+page:70/)
    expect(lines.join('\n')).toContain(ids[0]!)
    expect(lines.join('\n')).toMatch(/3 quarantined, 3 pending/)
  })

  it('approves and rejects by id, and refuses to approve what can never be let through', async () => {
    const [map, hidden, script] = await seed()
    const log = () => {}
    expect(await runReview({ cwd: root, approve: [map!, hidden!], reject: [script!], log })).toBe(0)
    const review = await readReview(root)
    expect(review.decisions[map!]).toMatchObject({ decision: 'approved', host: 'www.google.com' })
    expect(review.decisions[script!]).toMatchObject({ decision: 'rejected' })
    expect(await runReview({ cwd: root, approve: [script!], log })).toBe(2)
    expect(await runReview({ cwd: root, approve: ['content/nope.html.txt'], log })).toBe(2)

    const approvals = await loadApprovals(root)
    expect(approvals.hosts).toEqual(['www.google.com'])
    expect([...approvals.fragments]).toEqual([createHash('sha256').update(HIDDEN).digest('hex')])
  })

  it('walks through pending items in a terminal, saving each answer and showing previews inertly', async () => {
    await seed()
    const lines: string[] = []
    const answers = ['a', 'x', 's', 'r']
    const asked: string[] = []
    await runReview({ cwd: root, isTTY: true, log: (l) => lines.push(l), prompt: async (q) => (asked.push(q), answers.shift() ?? 'q') })
    const review = await readReview(root)
    expect(Object.values(review.decisions).map((d) => `${d.code}:${d.decision}`).sort()).toEqual(['SEC_IFRAME_UNKNOWN_HOST:approved', 'SEC_SCRIPT_TAG:rejected'])
    expect(asked.at(-1)).toBe('Mark as rejected, skip or quit? [r/s/q] ')
    expect(lines.join('\n')).not.toContain('\u001b')
    expect(lines.join('\n')).toMatch(/1 approved, 1 rejected\. Run wp2payload migrate again/)
  })

  it('ignores approvals a hand-edited review.json gives to findings that cannot be approved', async () => {
    await mkdir(path.join(root, '.wp2payload'), { recursive: true })
    await writeFile(path.join(root, '.wp2payload', 'review.json'), JSON.stringify({
      version: 1,
      decisions: {
        a: { decision: 'approved', code: 'SEC_SCRIPT_TAG', sha256: 'a'.repeat(64), decidedAt: '' },
        b: { decision: 'approved', code: 'SEC_IFRAME_UNKNOWN_HOST', sha256: 'b'.repeat(64), host: 'evil.example/"><script>', decidedAt: '' },
      },
    }))
    expect(await loadApprovals(root)).toEqual({ fragments: new Set(), hosts: [] })
    expect(JSON.parse(await readFile(path.join(root, '.wp2payload', 'review.json'), 'utf8')).version).toBe(1)
  })
})

describe('approved fragments in the sanitizer', () => {
  it('keeps an approved hidden block, still sanitized, and reports it as allowed', () => {
    const hash = createHash('sha256').update(HIDDEN).digest('hex')
    const blocked = scanDocument(HIDDEN, opts)
    expect(blocked.findings.map((f) => f.code)).toEqual(['SEC_HIDDEN_LINKS'])
    expect(blocked.html).not.toContain('Read more')

    const kept = scanDocument(HIDDEN, { ...opts, approvedFragments: new Set([hash]) })
    expect(kept.findings.filter((f) => f.code === 'SEC_HIDDEN_LINKS')).toEqual([expect.objectContaining({ severity: 'low', action: 'allowed' })])
    expect(kept.html).toContain('Read more')

    const withScript = '<div style="display:none"><a href="https://ok.example/">Read more</a><script>alert(1)</script></div>'
    const h2 = createHash('sha256').update(withScript).digest('hex')
    const out = sanitizeContent(withScript, { ...opts, approvedFragments: new Set([h2]) })
    expect(out.html).toContain('Read more')
    expect(out.html).not.toContain('<script')
    expect(out.findings.map((f) => f.code)).toContain('SEC_SCRIPT_TAG')
  })
})
