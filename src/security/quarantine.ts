import { createHash } from 'node:crypto'
import { mkdir, open, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { SecurityFinding } from '../report/types.js'

// Quarantine (doc 12.3 T10, 12.10): inert copies plus a reason file, never imported automatically.

export type QuarantineKind = 'content' | 'files'

export type QuarantineItem = {
  kind: QuarantineKind
  /** Original name or id (attacker-controlled for files). Sanitised before use. */
  name: string
  finding: SecurityFinding
} & ({ bytes: Buffer; text?: never } | { text: string; bytes?: never })

const MAX_NAME = 100
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)$/i

/** Basename only, `[A-Za-z0-9._-]`, no `..`, no leading dot, no Windows device names, at most 100 chars. */
export function safeQuarantineName(name: string): string {
  let s = name.split(/[\\/]/).pop() ?? ''
  s = s.slice(s.lastIndexOf(':') + 1) // drive letters / NTFS streams
  if (s === '.' || s === '..') s = ''
  s = s
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\./, '_')
    .replace(/[. ]+$/, '')
    .slice(0, MAX_NAME)
    .replace(/[. ]+$/, '')
  if (!s) return 'item'
  if (WINDOWS_RESERVED.test(s.split('.')[0] ?? '')) s = ('_' + s).slice(0, MAX_NAME)
  return s
}

/**
 * Writes the item under `<root>/.wp2payload/quarantine/<kind>/` and returns its path relative to
 * the quarantine folder (for `SecurityFinding.quarantine`). Never overwrites: a collision gets `-N`.
 */
export async function writeQuarantine(root: string, item: QuarantineItem): Promise<string> {
  const qroot = resolve(root, '.wp2payload', 'quarantine')
  const dir = join(qroot, item.kind)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const data = item.bytes ?? Buffer.from(item.text ?? '', 'utf8')
  const suffix = item.kind === 'content' ? '.html.txt' : '.quarantined'
  const base = safeQuarantineName(item.name)

  for (let n = 0; n < 10_000; n++) {
    const stem = n === 0 ? base : `${base}-${n}`
    const dataPath = join(dir, stem + suffix)
    const reasonPath = join(dir, stem + '.reason.json')
    if (!dataPath.startsWith(dir + sep) || !reasonPath.startsWith(dir + sep)) {
      throw new Error('Quarantine path escaped its folder.') // unreachable with safeQuarantineName
    }
    const rel = `${item.kind}/${stem}${suffix}`
    // 'wx' = create exclusively: never overwrite and never follow an existing symlink.
    const dataFile = await open(dataPath, 'wx', 0o600).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'EEXIST') return undefined
      throw e
    })
    if (!dataFile) continue
    let reasonFile
    try {
      await dataFile.writeFile(data)
    } finally {
      await dataFile.close()
    }
    try {
      reasonFile = await open(reasonPath, 'wx', 0o600)
    } catch (e) {
      await unlink(dataPath)
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    try {
      const reason = {
        finding: { ...item.finding, quarantine: rel },
        originalName: item.name,
        sha256: createHash('sha256').update(data).digest('hex'),
        bytes: data.length,
        quarantinedAt: new Date().toISOString(),
      }
      await reasonFile.writeFile(JSON.stringify(reason, null, 2) + '\n')
    } finally {
      await reasonFile.close()
    }
    return rel
  }
  throw new Error(`Too many quarantined items named ${base}.`)
}
