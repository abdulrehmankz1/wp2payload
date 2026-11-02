import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrate } from '../../src/commands/migrate.js'
import type { ReportJson, SecurityFinding } from '../../src/report/types.js'
import { startDocumentsPayload, type DocumentsTestPayload } from '../int/documents-harness.js'

// Doc 12.14: migrate the hacked-site fixture (tests/fixtures/hacked-site) into a real Payload and
// assert none of the seeded threats reach it and every one of them is in the report. One test file
// per source (one Payload per process), each calling hackedSiteSuite.
// Needs the fixture: `node scripts/fixture-hacked-seed.mjs`. Skipped without it, except when
// WP2P_REQUIRE_HACKED=1 (CI and the release gate), where a missing fixture fails the suite.

try {
  process.loadEnvFile('.env')
} catch {
  // No .env: the fixture is not seeded on this machine.
}
const URL_ = process.env['HACKED_WP_URL']
const WXR = process.env['HACKED_WXR_FILE']
const required = process.env['WP2P_REQUIRE_HACKED'] === '1'

export const SOURCES = {
  rest: `{ type: 'rest', url: process.env.HACKED_WP_URL, auth: { user: process.env.HACKED_WP_USER, appPassword: process.env.HACKED_WP_APP_PASSWORD } }`,
  wxr: `{ type: 'wxr', file: ${JSON.stringify(path.resolve(WXR ?? 'missing-export.xml'))}, url: process.env.HACKED_WP_URL }`,
}

export const hackedSiteSuite = (name: string, source: string) => describe.runIf(URL_ !== undefined || required)(`hacked-site fixture over ${name} (doc 12.14)`, () => {
  let t: DocumentsTestPayload
  let cwd: string
  let exit: number
  let report: ReportJson
  const lines: string[] = []

  beforeAll(async () => {
    if (!URL_ || !WXR) throw new Error('WP2P_REQUIRE_HACKED=1 but HACKED_WP_URL or HACKED_WXR_FILE is not set: run node scripts/fixture-hacked-seed.mjs first')
    t = await startDocumentsPayload({ excerpt: true })
    cwd = await mkdtemp(path.join(os.tmpdir(), 'wp2p-hacked-'))
    await writeFile(
      path.join(cwd, 'wp2payload.config.ts'),
      `export default {
  source: ${source},
  collections: {
    post: { to: 'posts', fields: { content: 'content', excerpt: 'excerpt', featuredImage: 'heroImage' } },
    page: { to: 'pages', fields: { content: 'content', parent: 'parent' } },
    category: { to: 'categories' },
    post_tag: { to: 'tags' },
    media: { to: 'media' },
    author: { to: 'authors' },
  },
  // Even an allowlisted host must not reach a private address (T9).
  media: { allowedHosts: ['127.0.0.2'] },
}
`,
    )
    exit = await runMigrate({
      cwd,
      yes: true,
      isTTY: false,
      env: { ...process.env, NO_COLOR: '1' },
      log: (l) => lines.push(l),
      boot: async () => ({ payload: t.payload, close: async () => {} }),
    })
    report = JSON.parse(await readFile(path.join(cwd, '.wp2payload', 'report.json'), 'utf8')) as ReportJson
  }, 300_000)

  afterAll(async () => {
    await t?.close()
    if (cwd) await rm(cwd, { recursive: true, force: true })
  })

  const all = async (collection: string) =>
    (await t.payload.find({ collection: collection as 'posts', limit: 1000, depth: 0, overrideAccess: true, draft: true })).docs as unknown as Record<string, unknown>[]
  const bySlug = async (slug: string) => (await all('posts')).find((d) => d['slug'] === slug)
  const wpIdOf = async (slug: string) => ((await bySlug(slug))?.['wpMeta'] as { wpId: number } | undefined)?.wpId
  const findings = (where: Partial<SecurityFinding>) =>
    report.security.findings.filter((f) => Object.entries(where).every(([k, v]) => f[k as keyof SecurityFinding] === v))

  it('completes the run and writes the report', () => {
    expect(report.stopped, lines.join('\n')).toBeUndefined()
    expect(report.errors, lines.join('\n')).toEqual([])
    expect(exit).toBe(0)
    // 6 hacked posts and the hacked page, plus WordPress's own Hello World post and Sample Page.
    expect(report.summary['documents']?.created).toBe(9)
  })

  it('stores no executable markup, dangerous URL or spam in any collection', async () => {
    const stored = JSON.stringify(
      await Promise.all(['posts', 'pages', 'media', 'authors', 'categories', 'tags'].map((c) => all(c))),
    )
    for (const bad of [/<script/i, /<iframe/i, /<meta/i, /<svg/i, /\bon[a-z]+\s*=/i, /javascript:/i, /vbscript:/i, /data:text\/html/i, /evil\.example/i, /casino/i, /viagra/i, /pills\.example/i, /loans\.example/i, /169\.254\.169\.254/, /127\.0\.0\.2/]) {
      expect(stored).not.toMatch(bad)
    }
  })

  it('keeps the clean content around the threats', async () => {
    const text = JSON.stringify(await all('posts'))
    for (const kept of ['Before the scripts.', 'After the scripts.', 'A normal paragraph about gardening.', 'Hover text.']) {
      expect(text).toContain(kept)
    }
    expect(JSON.stringify(await all('pages'))).toContain('About us.')
  })

  it('reports every content threat against its document (T1, T3, T4, T5)', async () => {
    const expected: Record<string, string[]> = {
      'hacked-scripts': ['SEC_SCRIPT_TAG', 'SEC_EVENT_HANDLER', 'SEC_DANGEROUS_URL'],
      'hacked-spam': ['SEC_HIDDEN_LINKS'],
      'hacked-redirects': ['SEC_META_REFRESH', 'SEC_JS_REDIRECT'],
      'hacked-iframes': ['SEC_IFRAME_UNKNOWN_HOST'],
    }
    for (const [slug, codes] of Object.entries(expected)) {
      const doc = `post:${await wpIdOf(slug)}`
      const got = new Set(findings({ doc }).map((f) => f.code))
      for (const code of codes) expect([...got], `${slug} ${code}`).toContain(code)
    }
    // The <script> redirect and the one in an onmouseover handler.
    expect(findings({ doc: `post:${await wpIdOf('hacked-redirects')}`, code: 'SEC_JS_REDIRECT' })).toHaveLength(2)
    const page = (await all('pages')).find((p) => p['slug'] === 'hacked-page')!
    const pageCodes = findings({ doc: `page:${(page['wpMeta'] as { wpId: number }).wpId}` }).map((f) => f.code)
    expect(pageCodes).toContain('SEC_SCRIPT_TAG')
    expect(pageCodes).toContain('SEC_HIDDEN_LINKS')
  })

  it('quarantines the removed content for review', async () => {
    const dir = path.join(cwd, '.wp2payload', 'quarantine')
    expect(existsSync(dir)).toBe(true)
    const quarantined = report.security.findings.filter((f) => f.quarantine)
    expect(quarantined.length).toBeGreaterThan(0)
    for (const f of quarantined) expect(existsSync(path.join(dir, f.quarantine!)), f.quarantine).toBe(true)
  })

  it('turns markup in short fields into plain text (T2)', async () => {
    const post = (await bySlug('hacked-short-fields'))!
    expect(post['title']).toMatch(/^Breaking\s+news\b/)
    expect(post['excerpt']).toBe('Excerpt')
    const clean = (await all('media')).find((m) => m['filename'] === 'ok.jpg' || String(m['filename']).startsWith('ok'))!
    expect(clean['alt']).toBe('Alt')
  })

  it('rejects backdoors, scripted SVG, active PDF and disguised files (T6, T7)', () => {
    const rejected = new Set(report.security.findings.filter((f) => f.media !== undefined && (f.action === 'rejected' || f.action === 'quarantined')).map((f) => f.media))
    const reasons = report.security.findings.filter((f) => f.media !== undefined).map((f) => f.code)
    for (const code of ['SEC_EXECUTABLE_UPLOAD', 'SEC_SVG_REJECTED', 'SEC_PDF_ACTIVE_CONTENT']) expect(reasons).toContain(code)
    // logo.jpg.php, shell.phtml, fake.png, js.pdf, scripted.svg and the three SSRF attachments.
    expect(rejected.size).toBe(8)
  })

  it('stores only the clean image and the re-encoded polyglot, with no PHP inside', async () => {
    const media = await all('media')
    expect(media).toHaveLength(2)
    const files = await readdir(path.join(t.dir, 'media'))
    for (const f of files) {
      expect(f).not.toMatch(/\.(php|phtml|svg|pdf|png)$/i)
      const bytes = await readFile(path.join(t.dir, 'media', f))
      expect(bytes.includes('<?php')).toBe(false)
      expect(bytes.includes('<script')).toBe(false)
    }
    const polyglotPost = (await bySlug('hacked-media-links'))!
    expect(polyglotPost['heroImage']).toBeDefined()
    // The scripted SVG was rejected, so the featured image is left empty, not linked.
    expect((await bySlug('hacked-short-fields'))!['heroImage'] ?? null).toBeNull()
  })

  it('blocks media URLs to metadata, internal addresses and other ports of the source host (T9)', async () => {
    const ssrf = report.security.findings.filter((f) => f.media !== undefined && /^SEC_(HOST_NOT_ALLOWED|SSRF_BLOCKED|INSECURE_SCHEME)$/.test(f.code))
    expect(ssrf.map((f) => f.code).sort()).toEqual(['SEC_HOST_NOT_ALLOWED', 'SEC_HOST_NOT_ALLOWED', 'SEC_SSRF_BLOCKED'])
  })

  it('migrates only authors with content, as name and slug, never the rogue admin (T8)', async () => {
    const authors = await all('authors')
    expect(authors.map((a) => a['slug'])).not.toContain('wp-sys-maint')
    const author = authors.find((a) => a['slug'] === 'hacked-author')!
    expect(author['name']).toBe('Jane Doe')
    expect(Object.keys(author).some((k) => /email|role|password|capabilit/i.test(k))).toBe(false)
  })
})
