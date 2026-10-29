import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safeQuarantineName, writeQuarantine } from '../../src/security/quarantine.js'
import type { SecurityFinding } from '../../src/report/types.js'

const finding: SecurityFinding = { code: 'SEC_EXECUTABLE_UPLOAD', severity: 'high', action: 'rejected', media: 7 }
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp2p-q-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const qdir = () => join(root, '.wp2payload', 'quarantine')

describe('writeQuarantine (AC-B5, doc 12.10)', () => {
  it('writes an inert file copy plus a reason file under files/', async () => {
    const rel = await writeQuarantine(root, { kind: 'files', name: 'logo.jpg.php', bytes: Buffer.from('<?php echo "x"; ?>'), finding })
    expect(rel).toBe('files/logo.jpg.php.quarantined')
    expect(readFileSync(join(qdir(), rel), 'utf8')).toBe('<?php echo "x"; ?>')
    const reason = JSON.parse(readFileSync(join(qdir(), 'files/logo.jpg.php.reason.json'), 'utf8')) as Record<string, unknown>
    expect(reason.finding).toMatchObject({ ...finding, quarantine: rel })
    expect(reason.originalName).toBe('logo.jpg.php')
    expect(reason.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('writes removed content as .html.txt under content/', async () => {
    const rel = await writeQuarantine(root, { kind: 'content', name: 'post-981-1', text: '<script>alert(1)</script>', finding })
    expect(rel).toBe('content/post-981-1.html.txt')
    expect(readFileSync(join(qdir(), rel), 'utf8')).toBe('<script>alert(1)</script>')
    expect(readdirSync(join(qdir(), 'content')).sort()).toEqual(['post-981-1.html.txt', 'post-981-1.reason.json'])
  })

  it('never overwrites: collisions get a numeric suffix', async () => {
    const a = await writeQuarantine(root, { kind: 'files', name: 'a.php', bytes: Buffer.from('1'), finding })
    const b = await writeQuarantine(root, { kind: 'files', name: 'a.php', bytes: Buffer.from('2'), finding })
    expect(a).toBe('files/a.php.quarantined')
    expect(b).toBe('files/a.php-1.quarantined')
    expect(readFileSync(join(qdir(), a), 'utf8')).toBe('1')
    expect(readFileSync(join(qdir(), b), 'utf8')).toBe('2')
  })

  it('creates files without execute permission (0o600 where supported)', async () => {
    const rel = await writeQuarantine(root, { kind: 'files', name: 'shell.phtml', bytes: Buffer.from('x'), finding })
    if (process.platform !== 'win32') expect(statSync(join(qdir(), rel)).mode & 0o777).toBe(0o600)
    else expect(statSync(join(qdir(), rel)).isFile()).toBe(true)
  })

  it.each([
    ['../../.env', '_env'],
    ['..\\..\\Windows\\win.ini', 'win.ini'],
    ['/etc/passwd', 'passwd'],
    ['C:\\x\\..\\evil.php', 'evil.php'],
    ['..', 'item'],
    ['', 'item'],
    ['.htaccess', '_htaccess'],
    ['CON', '_CON'],
    ['nul.txt', '_nul.txt'],
    ['a\u0000b.php', 'a_b.php'],
    ['a..b', 'a.b'],
  ])('sanitises %j to %j', (input, want) => {
    expect(safeQuarantineName(input)).toBe(want)
  })

  it('caps very long names', () => {
    expect(safeQuarantineName('a'.repeat(1000) + '.php').length).toBeLessThanOrEqual(100)
  })

  it('property: random hostile names always land inside the quarantine kind folder', async () => {
    // Small deterministic PRNG (no new deps).
    let seed = 0x2f6b
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
    const alphabet = ['..', '.', '/', '\\', ':', 'a', 'Z', '0', ' ', '\u0000', '\u202e', '%2e', '~', '$', '*', '?', '<', '>', '|', '"', 'é', 'CON', 'php']
    const base = resolve(qdir())
    for (let i = 0; i < 300; i++) {
      const len = 1 + Math.floor(rnd() * 12)
      let name = ''
      for (let j = 0; j < len; j++) name += alphabet[Math.floor(rnd() * alphabet.length)]
      const safe = safeQuarantineName(name)
      expect(safe, name).not.toMatch(/[\\/:\u0000-\u001f]/)
      expect(safe).not.toContain('..')
      expect(safe.startsWith('.')).toBe(false)
      expect(safe.length).toBeGreaterThan(0)
      const kind = i % 2 ? 'files' : 'content'
      const rel = await writeQuarantine(root, { kind, name, bytes: Buffer.from(String(i)), finding })
      const abs = resolve(base, rel)
      expect(abs.startsWith(join(base, kind) + sep), `${JSON.stringify(name)} -> ${rel}`).toBe(true)
      expect(rel.split('/')).toHaveLength(2)
    }
    // Nothing escaped the quarantine root.
    expect(readdirSync(root)).toEqual(['.wp2payload'])
    expect(readdirSync(join(root, '.wp2payload'))).toEqual(['quarantine'])
  })
})
