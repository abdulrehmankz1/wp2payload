import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SecurityFinding } from '../report/types.js'
import { renameWithFallback, STATE_DIR } from '../state/store.js'

// `wp2payload review` (doc 12.10): a person's decisions about quarantined items, kept in
// `.wp2payload/review.json`. Approval is limited to findings that are often false positives and
// safe once sanitized; scripts, handlers, dangerous URLs and rejected files can only be rejected.

export const REVIEW_FILE = 'review.json'
export type Decision = 'approved' | 'rejected'

export interface QuarantineEntry {
  /** Path inside the quarantine folder, e.g. `content/1a2b...-post-981.html.txt`. */
  id: string
  kind: 'content' | 'files'
  finding: SecurityFinding
  sha256: string
  bytes: number
  quarantinedAt?: string
}

export interface ReviewDecision {
  decision: Decision
  code: string
  sha256: string
  doc?: string
  /** SEC_IFRAME_UNKNOWN_HOST: the host an approval trusts. */
  host?: string
  decidedAt: string
}

export interface ReviewFile {
  version: 1
  decisions: Record<string, ReviewDecision>
}

export interface Approvals {
  /** sha256 of approved fragments, kept by the sanitizer. */
  fragments: Set<string>
  /** Hosts trusted for iframes because an iframe to them was approved. */
  hosts: string[]
}

const IFRAME = /^<(?:iframe|frame|embed|object)> to ([a-z0-9.-]+(?::\d{1,5})?)$/i

/** What approving does, or why the item can only be rejected. */
export function approvable(f: SecurityFinding): { ok: true; effect: string; host?: string } | { ok: false; why: string } {
  if (f.code === 'SEC_IFRAME_UNKNOWN_HOST') {
    const host = IFRAME.exec(f.detail ?? '')?.[1]?.toLowerCase()
    return host ? { ok: true, host, effect: `trust ${host} for embeds; its iframes become embed blocks on the next run` } : { ok: false, why: 'only an https iframe can be approved' }
  }
  if (f.code === 'SEC_HIDDEN_LINKS') return { ok: true, effect: 'keep this hidden block on the next run (sanitized, and visible in Payload)' }
  if (f.code === 'SEC_SVG_REJECTED') return { ok: false, why: 'SVG files are never approved one by one; run with --allow-svg to accept them after a strict check' }
  return { ok: false, why: 'this kind of finding is never let through; rebuild the content by hand if it was legitimate' }
}

const quarantineDir = (root: string) => path.join(root, STATE_DIR, 'quarantine')

/** Every quarantined item with its reason, oldest first. Unreadable reason files are skipped. */
export async function listQuarantine(root: string): Promise<QuarantineEntry[]> {
  const out: QuarantineEntry[] = []
  for (const kind of ['content', 'files'] as const) {
    let names: string[]
    try {
      names = await readdir(path.join(quarantineDir(root), kind))
    } catch {
      continue
    }
    for (const name of names.filter((n) => n.endsWith('.reason.json'))) {
      let reason: { finding?: SecurityFinding; sha256?: string; bytes?: number; quarantinedAt?: string }
      try {
        reason = JSON.parse(await readFile(path.join(quarantineDir(root), kind, name), 'utf8')) as typeof reason
      } catch {
        continue
      }
      const f = reason.finding
      if (!f || typeof f.code !== 'string' || typeof reason.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(reason.sha256)) continue
      const stem = name.slice(0, -'.reason.json'.length)
      const id = `${kind}/${stem}${kind === 'content' ? '.html.txt' : '.quarantined'}`
      out.push({ id, kind, finding: f, sha256: reason.sha256, bytes: Number(reason.bytes) || 0, ...(reason.quarantinedAt ? { quarantinedAt: String(reason.quarantinedAt) } : {}) })
    }
  }
  return out.sort((a, b) => (a.quarantinedAt ?? '').localeCompare(b.quarantinedAt ?? '') || a.id.localeCompare(b.id))
}

/** The quarantined text or bytes of an item. */
export async function readQuarantined(root: string, entry: QuarantineEntry): Promise<Buffer> {
  const file = path.join(quarantineDir(root), ...entry.id.split('/'))
  if (!file.startsWith(quarantineDir(root) + path.sep)) throw new Error('Quarantine id escaped its folder.')
  return readFile(file)
}

export async function readReview(root: string): Promise<ReviewFile> {
  try {
    const raw = JSON.parse(await readFile(path.join(root, STATE_DIR, REVIEW_FILE), 'utf8')) as Partial<ReviewFile>
    if (raw.version === 1 && raw.decisions && typeof raw.decisions === 'object') return { version: 1, decisions: raw.decisions }
  } catch {
    // Missing or unreadable: no decisions yet.
  }
  return { version: 1, decisions: {} }
}

export async function writeReview(root: string, review: ReviewFile): Promise<void> {
  const file = path.join(root, STATE_DIR, REVIEW_FILE)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(review, null, 2) + '\n', 'utf8')
  try {
    await renameWithFallback(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

export function decide(entry: QuarantineEntry, decision: Decision): ReviewDecision {
  const can = approvable(entry.finding)
  if (decision === 'approved' && !can.ok) throw new Error(`${entry.id} cannot be approved: ${can.why}`)
  return {
    decision,
    code: entry.finding.code,
    sha256: entry.sha256,
    ...(entry.finding.doc ? { doc: entry.finding.doc } : {}),
    ...(decision === 'approved' && can.ok && can.host ? { host: can.host } : {}),
    decidedAt: new Date().toISOString(),
  }
}

/** What the next run lets through. Only approvals of approvable codes count, whatever the file says. */
export async function loadApprovals(root: string): Promise<Approvals> {
  const review = await readReview(root)
  const fragments = new Set<string>()
  const hosts = new Set<string>()
  for (const d of Object.values(review.decisions)) {
    if (d?.decision !== 'approved') continue
    if (d.code === 'SEC_HIDDEN_LINKS' && /^[0-9a-f]{64}$/.test(d.sha256)) fragments.add(d.sha256)
    if (d.code === 'SEC_IFRAME_UNKNOWN_HOST' && typeof d.host === 'string' && /^[a-z0-9.-]+(?::\d{1,5})?$/.test(d.host)) hosts.add(d.host)
  }
  return { fragments, hosts: [...hosts] }
}
