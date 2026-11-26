import { STATE_DIR } from '../state/store.js'
import { cards, count, esc, MAX_TEXT, renderPage, SEVERITIES, sevClass, table } from './html.js'
import { ACCOUNT_CREATED, describeFindings, formatDuration } from './summary.js'
import type { CountAction, ReportJson, SecurityFinding, Severity } from './types.js'

// The migration's security report as one self-contained HTML page (doc 12.11): a client
// deliverable saying what was found on the old site and what was kept out of the new one.
// Input is report.json, which `wp2payload report --html` reads back from disk, so it is treated as
// untrusted: every field is type-checked and clipped before use, and all text is escaped.

export const SECURITY_HTML = 'security-report.html'
/** Path shown to users, relative to the project root. */
export const SECURITY_HTML_PATH = `${STATE_DIR}/${SECURITY_HTML}`

const ACTIONS: CountAction[] = ['created', 'updated', 'reused', 'skipped', 'rejected', 'errors']
const PHASE_ORDER = ['media', 'terms', 'authors', 'documents', 'redirects']
// report.json is PII-free by contract; the HTML stays so even when a detail quotes site content.
// Any word holding `@domain.tld` (an address, mailto:, user:password@host) is hidden whole. Words
// are found with a linear scan: an email regex run over a long string backtracks quadratically.
const WORD = /[^\s<>"'(),;]+/g
const AT_DOMAIN = /@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/u
const hideEmails = (s: string) => (s.includes('@') ? s.replace(WORD, (w) => (w.includes('@') && AT_DOMAIN.test(w) ? '[email hidden]' : w)) : s)

interface Finding {
  code: string
  severity: string
  action: string
  where: string
  file: string
  quarantine: string
  detail: string
}

export function renderSecurityReportHtml(input: ReportJson, opts: { version?: string } = {}): string {
  const r = obj(input) ?? {}
  const site = text(r['site'], 200) || 'unknown site'
  const dryRun = r['dryRun'] === true
  const stopped = obj(r['stopped'])
  const sec = obj(r['security']) ?? {}
  const findings = arr(sec['findings']).map(finding).filter((f): f is Finding => f !== undefined)
  findings.sort((a, b) => rank(a.severity) - rank(b.severity) || a.code.localeCompare(b.code))
  const totals: Record<Severity, number> = { high: 0, medium: 0, low: 0 }
  for (const f of findings) {
    const s = sevClass(f.severity)
    if (s !== 'unknown') totals[s]++
  }
  const warnings = arr(r['warnings'])
  const errors = arr(r['errors'])
  const accounts = warnings.map(obj).filter((w): w is Record<string, unknown> => w?.['code'] === ACCOUNT_CREATED)
  const optIns = arr(r['optIns']).map(obj).filter((o): o is Record<string, unknown> => o !== undefined)

  const kind = stopped ? 'Migration stopped early' : dryRun ? 'Dry run, nothing was written' : 'Migration'
  const started = text(r['startedAt'], 40)
  const when = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(started) ? ` · started ${started.slice(0, 16).replace('T', ' ')} UTC` : ''
  const durationSec = r['durationSec']
  const took = typeof durationSec === 'number' ? ` · took ${formatDuration(durationSec)}` : ''

  const sev = (s: string) => `<td class="${sevClass(s)}">${esc(s)}</td>`
  const groups = new Map<string, Finding[]>()
  for (const f of findings) {
    const key = `${f.severity}\0${f.code}`
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const intro = dryRun
    ? 'This was a dry run: nothing was written to the new site. The findings below show what a migration would keep out of it.'
    : 'What wp2payload found in the content and media of the old site, and what it kept out of the new one.'

  const body = `<p>${esc(intro)}</p>
${stopped ? `<p class="note">The run stopped during ${esc(text(stopped['phase'], 100))}: ${esc(text(stopped['reason'], MAX_TEXT))}. Progress is saved; running the same command again resumes it.</p>` : ''}
${cards(totals, [[warnings.length, 'warnings'], [errors.length, 'errors']])}

<h2>Summary by severity</h2>
${table(['Severity', 'Count', 'Finding'], [...groups.values()].map((items) => [
    sev(items[0]!.severity),
    `<td class="num">${items.length}</td>`,
    `<td>${esc(text(describeFindings(items[0]!.code, items.map(asFinding)), MAX_TEXT))} <code>${esc(items[0]!.code)}</code></td>`,
  ]), 'No security findings.')}

<h2>Findings</h2>
${table(['Severity', 'Code', 'Where', 'Action', 'Quarantine', 'Detail'], findings.map((f) => [
    sev(f.severity),
    `<td><code>${esc(f.code)}</code></td>`,
    `<td><code>${esc(f.where)}</code></td>`,
    `<td>${esc(f.action)}</td>`,
    `<td><code>${esc(f.quarantine)}</code></td>`,
    `<td>${esc(f.detail)}</td>`,
  ]), 'No security findings.', 'All are in report.json.')}
${findings.some((f) => f.quarantine) ? `<p class="muted">Quarantine paths are relative to ${esc(STATE_DIR)}/quarantine/. Quarantined items are saved as inert text and never imported automatically; run wp2payload review to approve them one by one.</p>` : ''}

<h2>Run summary</h2>
${table(['Phase', ...ACTIONS], phases(obj(r['summary']) ?? {}).map(([phase, counts]) => [
    `<th>${esc(text(phase, 100))}</th>`,
    ...ACTIONS.map((a) => `<td class="num">${count(counts[a])}</td>`),
  ]), 'No items processed.')}
${redirects(obj(r['redirects']))}
${optIns.length ? `
<h2>Safety defaults loosened</h2>
<p>These options were turned on for this run; without them wp2payload would have refused.</p>
${table(['Option', 'Effect'], optIns.map((o) => [`<td><code>${esc(text(o['option'], 100))}</code></td>`, `<td>${esc(text(o['detail'], MAX_TEXT))}</td>`]), '')}` : ''}
${accounts.length ? `
<h2>Accounts created</h2>
<p>${dryRun ? 'These WordPress users would get' : 'These WordPress users got'} an account that can log in to the new site. On a hacked site the attacker's own user usually wrote the spam, so it gets one too. Check each is a real person before go-live and delete any that is not.</p>
${table(['User', 'Detail'], accounts.map((a) => [`<td><code>${esc(text(a['doc'], 100))}</code></td>`, `<td>${esc(text(a['detail'], MAX_TEXT))}</td>`]), '', 'All are in report.json.')}` : ''}

<h2>Warnings</h2>
${table(['Code', 'Count'], byCode(warnings), 'No warnings.', 'All are in report.json.')}

<h2>Errors</h2>
${table(['Code', 'Count'], byCode(errors), 'No errors.', 'All are in report.json.')}`

  return renderPage({
    title: `Security report: ${site}`,
    subtitle: `${kind}${when}${took} · wp2payload ${text(opts.version, 40)}`.trimEnd(),
    body,
    footer:
      "This report lists what wp2payload found in the old site's content and media while migrating it, and what it kept out of the new site. " +
      'Every warning, error and finding with its full detail is in .wp2payload/report.json; codes are described in docs/reference/codes.md. ' +
      'It is not a malware scan of the server and does not certify that the site is clean. If a site is known to be compromised, ' +
      'treat everything from it as untrusted and rotate every credential it used.',
  })
}

function finding(v: unknown): Finding | undefined {
  const f = obj(v)
  if (!f) return undefined
  const media = num(f['media'])
  const user = num(f['user'])
  const file = text(f['file'], 200)
  const where = [text(f['doc'], 200), media !== undefined ? `media:${media}` : '', file, user !== undefined ? `user:${user}` : '']
    .filter(Boolean)
    .join(' · ')
  return {
    code: text(f['code'], 100),
    severity: text(f['severity'], 20),
    action: text(f['action'], 40),
    where,
    file,
    quarantine: text(f['quarantine'], 200),
    detail: text(f['detail'], MAX_TEXT),
  }
}

/** The fields describeFindings reads, from a checked finding. */
function asFinding(f: Finding): SecurityFinding {
  return {
    code: f.code as SecurityFinding['code'],
    severity: sevClass(f.severity) as Severity,
    action: f.action as SecurityFinding['action'],
    ...(f.file ? { file: f.file } : {}),
  }
}

function phases(summary: Record<string, unknown>): [string, Record<string, unknown>][] {
  const order = (p: string) => (PHASE_ORDER.includes(p) ? PHASE_ORDER.indexOf(p) : PHASE_ORDER.length)
  return Object.keys(summary)
    .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((p) => [p, obj(summary[p]) ?? {}])
}

function redirects(r: Record<string, unknown> | undefined): string {
  if (!r) return ''
  const file = text(r['file'], 200)
  const conflicts = count(r['conflicts'])
  return `<p>Redirects: ${count(r['count'])}${conflicts ? `, ${conflicts} conflict${conflicts === 1 ? '' : 's'}` : ''}${file ? `, written to <code>${esc(file)}</code> for review` : ''}.</p>`
}

/** Warnings or errors grouped by code, most frequent first. Details stay in report.json. */
function byCode(issues: unknown[]): string[][] {
  const counts = new Map<string, number>()
  for (const i of issues) {
    const code = text(obj(i)?.['code'], 100) || 'UNKNOWN'
    counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, n]) => [`<td><code>${esc(code)}</code></td>`, `<td class="num">${n}</td>`])
}

const rank = (s: string) => {
  const i = (SEVERITIES as readonly string[]).indexOf(s)
  return i === -1 ? SEVERITIES.length : i
}
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** A string field with email addresses hidden, then clipped: clipping first could cut an address so it no longer matches. */
const text = (v: unknown, max: number): string => {
  const s = hideEmails(str(v))
  return s.length > max ? `${s.slice(0, max)}…` : s
}
