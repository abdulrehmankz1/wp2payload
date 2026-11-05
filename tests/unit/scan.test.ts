import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runScanCommand, sourceFor } from '../../src/commands/scan.js'
import type { OpenedSource } from '../../src/extractors/source.js'
import type { Extractor, IRDocument, IRMedia } from '../../src/ir/types.js'
import { renderScanHtml } from '../../src/scan/html.js'
import type { ScanReport } from '../../src/scan/run.js'

let cwd: string
let jpeg: Buffer
beforeAll(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'wp2p-scan-'))
  jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#888' } }).jpeg().toBuffer()
})
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

async function* each<T>(items: T[]): AsyncIterable<T> {
  for (const x of items) yield x
}

const SITE = 'https://old.example'
const doc = (wpId: number, html: string, over: Partial<IRDocument> = {}): IRDocument => ({
  wpId, type: 'post', status: 'publish', slug: `p${wpId}`, title: `Post ${wpId}`, html, link: `${SITE}/p${wpId}/`,
  publishedAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z', termWpIds: [], meta: {}, ...over,
})
const media = (wpId: number, filename: string): IRMedia => ({ wpId, sourceUrl: `${SITE}/wp-content/uploads/${filename}`, localPath: filename, filename, mimeType: 'image/jpeg' })

function fakeSource(): { open: () => Promise<OpenedSource>; documentsRead: () => number } {
  let read = 0
  const files: Record<string, Buffer> = { 'ok.jpg': Buffer.alloc(0), 'logo.jpg.php': Buffer.from('<?php echo 1;') }
  const extractor: Extractor = {
    name: 'sql',
    probe: async () => ({ siteUrl: SITE, counts: { posts: 2, media: 2 }, unmigratedTypes: [{ type: 'product', count: 3 }] }),
    media: () => each([media(1, 'ok.jpg'), media(2, 'logo.jpg.php')]),
    terms: () => each([]),
    authors: () => each([]),
    documents: async function* () {
      for (const d of [
        doc(10, '<p>Hello</p><script>alert(1)</script>', { meta: { pageBuilder: 'Elementor' }, seo: { title: 'T', noindex: true } }),
        doc(11, '<p><a href="javascript:alert(2)">x</a> [woocommerce_cart]</p>'),
      ]) {
        read++
        yield d
      }
    },
  }
  return {
    open: async () => ({
      extractor,
      readLocalMedia: async (rel) => (rel === 'ok.jpg' ? jpeg : files[rel]!),
      trustSiteHost: false,
      label: 'Backup of',
    }),
    documentsRead: () => read,
  }
}

describe('wp2payload scan', () => {
  it('scans documents and media without Payload, writing only the report', async () => {
    const lines: string[] = []
    const f = fakeSource()
    const code = await runScanCommand({ cwd, target: path.join(cwd, 'db.sql'), uploads: cwd, open: f.open, log: (l) => lines.push(l), env: { NO_COLOR: '1' }, version: '9.9.9' })
    expect(code).toBe(0)
    const out = lines.join('\n')
    expect(out).toMatch(/Scan of https:\/\/old\.example finished in .*Nothing was migrated/)
    expect(out).toMatch(/documents\s+2 scanned \(1 built with Elementor\)/)
    expect(out).toMatch(/media\s+2 checked: 1 clean, 1 rejected, 0 unreadable/)
    expect(out).toMatch(/not migrated\s+3 product/)
    expect(out).toMatch(/script element quarantined/)
    expect(out).toMatch(/executable upload rejected/)

    const json = JSON.parse(await readFile(path.join(cwd, '.wp2payload', 'scan.json'), 'utf8')) as ScanReport
    expect(json).toMatchObject({ kind: 'scan', source: 'sql', documents: { scanned: 2, pageBuilders: { Elementor: 1 }, seo: { title: 1, noindex: 1 } } })
    expect(json.security.summary.high).toBeGreaterThanOrEqual(3)
    expect(json.warnings.map((w) => w.code)).toContain('SHORTCODE_NOT_MIGRATED')
    // Nothing quarantined to disk: a scan only reports.
    await expect(readFile(path.join(cwd, '.wp2payload', 'quarantine', 'x'))).rejects.toThrow()
  })

  it('exits 4 with --fail-on-security, and skips media with --no-media', async () => {
    const lines: string[] = []
    const f = fakeSource()
    expect(await runScanCommand({ cwd, target: `${SITE}/`, open: f.open, media: false, failOnSecurity: 'high', log: (l) => lines.push(l), env: {} })).toBe(4)
    expect(lines.join('\n')).toMatch(/media\s+not checked/)
    expect(await runScanCommand({ cwd, target: `${SITE}/`, open: f.open, media: false, limit: 1, failOnSecurity: 'high', log: () => {}, env: {} })).toBe(4)
    expect(f.documentsRead()).toBe(3)
  })

  it('needs a target or a config, and refuses a target it cannot recognise', async () => {
    const lines: string[] = []
    expect(await runScanCommand({ cwd, log: (l) => lines.push(l), env: {} })).toBe(2)
    expect(lines.join('\n')).toMatch(/wp2payload scan https:\/\/example\.com/)
    expect(await runScanCommand({ cwd, target: 'site.zip', log: (l) => lines.push(l), env: {} })).toBe(2)
    expect(lines.join('\n')).toMatch(/Cannot tell what "site\.zip" is/)
  })
})

describe('sourceFor', () => {
  it('reads the kind of source from the target', () => {
    expect(sourceFor('https://x.example', cwd, undefined, { WP_USER: 'ed', WP_APP_PASSWORD: 'pw pw' }).source).toEqual({ type: 'rest', url: 'https://x.example', auth: { user: 'ed', appPassword: 'pw pw' } })
    expect(sourceFor('http://x.example', cwd, undefined, {}).source).toEqual({ type: 'rest', url: 'http://x.example' })
    expect(sourceFor('a/site.WPRESS', cwd, undefined, {}).source).toEqual({ type: 'wpress', file: 'a/site.WPRESS' })
    expect(sourceFor('export.xml', cwd, undefined, {}).source).toEqual({ type: 'wxr', file: 'export.xml' })
    expect(sourceFor('b/db.sql.gz', cwd, undefined, {})).toEqual({ source: { type: 'sql', file: 'b/db.sql.gz', uploadsDir: path.join('b', 'uploads') }, media: false })
    expect(sourceFor('db.sql', cwd, cwd, {})).toEqual({ source: { type: 'sql', file: 'db.sql', uploadsDir: cwd } })
  })
})

describe('renderScanHtml', () => {
  it('escapes everything from the site and runs nothing', () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>\u202e'
    const report: ScanReport = {
      version: 1, kind: 'scan', source: 'rest', site: `https://x.example/${hostile}`, startedAt: '2026-01-01T00:00:00.000Z', durationSec: 1,
      inventory: { counts: { posts: 1 }, unmigratedTypes: [{ type: hostile, count: 1 }] },
      documents: { scanned: 1, byType: { post: 1 }, pageBuilders: { [hostile]: 1 }, seo: { title: 0, description: 0, noindex: 0 } },
      media: { scanned: 0, clean: 0, rejected: 0, errors: 0, skipped: true },
      warnings: [{ code: 'X', doc: hostile, detail: hostile }],
      errors: [],
      security: { summary: { high: 1, medium: 0, low: 0 }, findings: [{ code: 'SEC_SCRIPT_TAG', severity: 'high', action: 'quarantined', doc: hostile, detail: hostile }] },
    }
    const html = renderScanHtml(report, { version: '1.0.0' })
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`)
    expect(html).not.toMatch(/<script|<img|\u202e/i)
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
