import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runScanCommand } from '../../src/commands/scan.js'
import type { ScanReport } from '../../src/scan/run.js'

// `wp2payload scan` over the hacked site's backup (doc F18, 12.14): no Payload, no config, and every
// threat the migration keeps out is in the report.

try {
  process.loadEnvFile('.env')
} catch {
  // No .env: the fixture is not seeded on this machine.
}
const SQL = process.env['HACKED_SQL_FILE']
const UPLOADS = process.env['HACKED_UPLOADS_DIR']
const required = process.env['WP2P_REQUIRE_HACKED'] === '1'

describe.runIf(SQL !== undefined || required)('scan of the hacked-site backup', () => {
  let cwd: string
  let exit: number
  let report: ScanReport
  let html: string

  beforeAll(async () => {
    if (!SQL || !UPLOADS) throw new Error('WP2P_REQUIRE_HACKED=1 but HACKED_SQL_FILE is not set: run node scripts/fixture-hacked-seed.mjs first')
    cwd = await mkdtemp(path.join(os.tmpdir(), 'wp2p-scan-e2e-'))
    exit = await runScanCommand({ cwd, target: path.resolve(SQL), uploads: path.resolve(UPLOADS), failOnSecurity: 'high', log: () => {}, env: { NO_COLOR: '1' } })
    report = JSON.parse(await readFile(path.join(cwd, '.wp2payload', 'scan.json'), 'utf8')) as ScanReport
    html = await readFile(path.join(cwd, '.wp2payload', 'scan.html'), 'utf8')
  }, 300_000)

  afterAll(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true })
  })

  it('fails the high-severity gate and counts what it scanned', () => {
    expect(exit).toBe(4)
    expect(report.documents.scanned).toBe(9)
    expect(report.media).toMatchObject({ scanned: 10, rejected: 5, errors: 0 })
  })

  it('finds every content and upload threat the migration keeps out', () => {
    const codes = new Set(report.security.findings.map((f) => f.code))
    for (const code of [
      'SEC_SCRIPT_TAG', 'SEC_EVENT_HANDLER', 'SEC_DANGEROUS_URL', 'SEC_HIDDEN_LINKS', 'SEC_META_REFRESH', 'SEC_JS_REDIRECT',
      'SEC_IFRAME_UNKNOWN_HOST', 'SEC_EXECUTABLE_UPLOAD', 'SEC_SVG_REJECTED', 'SEC_PDF_ACTIVE_CONTENT',
    ]) expect([...codes], code).toContain(code)
  })

  it('writes an inert HTML report and nothing else', async () => {
    expect(html).not.toMatch(/<script|<iframe|<img|<meta http-equiv="refresh"/i)
    expect(html).toContain('Site scan:')
    await expect(readFile(path.join(cwd, '.wp2payload', 'quarantine'))).rejects.toThrow()
  })
})
