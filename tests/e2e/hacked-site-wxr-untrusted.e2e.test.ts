import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrate } from '../../src/commands/migrate.js'
import type { ReportJson } from '../../src/report/types.js'
import { startDocumentsPayload, type DocumentsTestPayload } from '../int/documents-harness.js'
import { SOURCES } from './hacked-suite.js'

// The site address inside an export file is not the user's word: without `url` in the config, the
// local fixture host must get the full download guard, not the source-host exception (doc 12.6).

const WXR = process.env['HACKED_WXR_FILE']
const required = process.env['WP2P_REQUIRE_HACKED'] === '1'

describe.runIf(WXR !== undefined || required)('WXR export without a configured url', () => {
  let t: DocumentsTestPayload
  let cwd: string
  let report: ReportJson

  beforeAll(async () => {
    if (!WXR) throw new Error('WP2P_REQUIRE_HACKED=1 but HACKED_WXR_FILE is not set: run node scripts/fixture-hacked-seed.mjs first')
    t = await startDocumentsPayload()
    cwd = await mkdtemp(path.join(os.tmpdir(), 'wp2p-wxr-untrusted-'))
    const source = SOURCES.wxr.replace(/, url: [^}]*\}$/, ' }')
    await writeFile(path.join(cwd, 'wp2payload.config.ts'), `export default { source: ${source}, collections: { media: { to: 'media' } } }\n`)
    await runMigrate({ cwd, yes: true, isTTY: false, env: { ...process.env, NO_COLOR: '1' }, log: () => {}, boot: async () => ({ payload: t.payload, close: async () => {} }) })
    report = JSON.parse(await readFile(path.join(cwd, '.wp2payload', 'report.json'), 'utf8')) as ReportJson
  }, 300_000)

  afterAll(async () => {
    await t?.close()
    if (cwd) await rm(cwd, { recursive: true, force: true })
  })

  it('downloads nothing over plain http to the local host named in the file', async () => {
    expect(SOURCES.wxr).toContain(', url: ')
    expect(report.summary['media']?.created ?? 0).toBe(0)
    expect(report.warnings.map((w) => w.code)).not.toContain('MEDIA_SOURCE_HOST_EXCEPTION')
    const local = report.security.findings.filter((f) => f.file?.startsWith('http://localhost:8091/'))
    expect(local.length).toBeGreaterThan(0)
    expect(new Set(local.map((f) => f.code))).toEqual(new Set(['SEC_INSECURE_SCHEME']))
    expect((await t.payload.count({ collection: 'media', overrideAccess: true })).totalDocs).toBe(0)
  })
})
