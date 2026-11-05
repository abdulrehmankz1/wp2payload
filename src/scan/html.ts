import { describeFindings } from '../report/summary.js'
import type { Issue, SecurityFinding, Severity } from '../report/types.js'
import type { ScanReport } from './run.js'

// The scan as one self-contained HTML page: a deliverable an agency can hand to a client (doc
// 12.11). Every value comes from the scanned site, so all of it is escaped, the page has no script
// and its Content-Security-Policy allows nothing but its own inline styles.

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
// Control and bidi characters could disguise text; show them as '?'.
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const esc = (v: unknown) => String(v ?? '').replace(UNSAFE, '?').replace(/[&<>"']/g, (c) => ESC[c]!)

const SEVERITIES: Severity[] = ['high', 'medium', 'low']
const SOURCES: Record<ScanReport['source'], string> = { rest: 'live site (REST API)', wxr: 'WordPress export file', sql: 'SQL backup', wpress: 'All-in-One WP Migration backup' }
const MAX_ROWS = 2000

export function renderScanHtml(r: ScanReport, opts: { version: string }): string {
  const s = r.security.summary
  const findings = [...r.security.findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.code.localeCompare(b.code))
  const groups = new Map<string, SecurityFinding[]>()
  for (const f of findings) {
    const key = `${f.severity}\0${f.code}`
    groups.set(key, [...(groups.get(key) ?? []), f])
  }
  const c = r.inventory.counts
  const inventory: [string, unknown][] = [
    ['Posts', c.posts], ['Pages', c.pages], ['Media files', c.media], ['Categories', c.categories], ['Tags', c.tags], ['Users', c.users],
    ['SEO plugin', r.inventory.seoPlugin ?? 'none detected'],
  ]
  const health: [string, string][] = [
    ['Documents scanned', String(r.documents.scanned)],
    ['Media files checked', r.media.skipped ? 'skipped (--no-media)' : `${r.media.scanned} (${r.media.clean} clean, ${r.media.rejected} rejected, ${r.media.errors} unreadable)`],
    ['Built with a page builder', list(r.documents.pageBuilders) || 'none'],
    ['SEO titles / descriptions', `${r.documents.seo.title} / ${r.documents.seo.description} of ${r.documents.scanned}`],
    ['Marked noindex', String(r.documents.seo.noindex)],
    ['Not migrated by wp2payload', r.inventory.unmigratedTypes?.map((t) => `${t.count} ${t.type}`).join(', ') || 'nothing'],
  ]

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="referrer" content="no-referrer">
<title>Site scan: ${esc(r.site)}</title>
<style>
:root { --bg: #fff; --fg: #1a1a1a; --muted: #5c5c5c; --line: #e2e2e2; --card: #f6f6f6; --high: #b42318; --medium: #b54708; --low: #475467; }
@media (prefers-color-scheme: dark) { :root { --bg: #141414; --fg: #ececec; --muted: #a3a3a3; --line: #2e2e2e; --card: #1e1e1e; --high: #f97066; --medium: #fdb022; --low: #98a2b3; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; overflow-wrap: anywhere; }
h2 { font-size: 18px; margin: 36px 0 12px; }
.muted { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 20px; }
.card { background: var(--card); border-radius: 8px; padding: 14px 16px; }
.card b { display: block; font-size: 26px; font-variant-numeric: tabular-nums; }
.high { color: var(--high); } .medium { color: var(--medium); } .low { color: var(--low); }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; font-size: 13px; color: var(--muted); }
td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
code { font: 13px ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
details { margin: 6px 0; } summary { cursor: pointer; }
footer { margin-top: 48px; font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>Site scan: ${esc(r.site)}</h1>
<p class="muted">${esc(SOURCES[r.source])} · scanned ${esc(r.startedAt.slice(0, 16).replace('T', ' '))} UTC in ${esc(Math.round(r.durationSec))}s · wp2payload ${esc(opts.version)}</p>

<div class="cards">
${SEVERITIES.map((sev) => `<div class="card"><b class="${sev}">${s[sev]}</b>${sev} severity</div>`).join('\n')}
<div class="card"><b>${r.documents.scanned}</b>documents scanned</div>
</div>

<h2>Security findings</h2>
${groups.size === 0 ? '<p>No findings.</p>' : `<div class="scroll"><table>
<tr><th>Severity</th><th>Count</th><th>Finding</th></tr>
${[...groups].map(([, items]) => `<tr><td class="${items[0]!.severity}">${items[0]!.severity}</td><td class="num">${items.length}</td><td>${esc(describeFindings(items[0]!.code, items))} <code>${esc(items[0]!.code)}</code></td></tr>`).join('\n')}
</table></div>
<details><summary>All ${findings.length} findings</summary>
<div class="scroll"><table>
<tr><th>Severity</th><th>Code</th><th>Where</th><th>Detail</th></tr>
${findings.slice(0, MAX_ROWS).map((f) => `<tr><td class="${f.severity}">${f.severity}</td><td><code>${esc(f.code)}</code></td><td><code>${esc(where(f))}</code></td><td>${esc(f.detail ?? '')}</td></tr>`).join('\n')}
</table></div>${findings.length > MAX_ROWS ? `<p class="muted">First ${MAX_ROWS} shown; all are in scan.json.</p>` : ''}
</details>`}

<h2>Content</h2>
<div class="scroll"><table>
${inventory.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? 'unknown')}</td></tr>`).join('\n')}
${health.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('\n')}
</table></div>

<h2>Notes</h2>
${issueTable(r.warnings, 'No warnings.')}
${r.errors.length ? `<h2>Could not be read</h2>\n${issueTable(r.errors, '')}` : ''}

<footer class="muted">
<p>This report lists what wp2payload found in the site's content and media, and what a migration would keep out of the new site. It is not a malware scan of the server and does not certify that the site is clean. If a site is known to be compromised, treat everything from it as untrusted and rotate every credential it used.</p>
</footer>
</main>
</body>
</html>
`
}

function list(counts: Record<string, number>): string {
  return Object.entries(counts).map(([k, n]) => `${k} (${n})`).join(', ')
}

function where(f: SecurityFinding): string {
  if (f.doc) return f.doc
  if (f.media !== undefined) return `media:${f.media}`
  return f.file ?? ''
}

function issueTable(issues: Issue[], empty: string): string {
  if (!issues.length) return empty ? `<p>${empty}</p>` : ''
  return `<div class="scroll"><table>
<tr><th>Code</th><th>Where</th><th>Detail</th></tr>
${issues.slice(0, MAX_ROWS).map((i) => `<tr><td><code>${esc(i.code)}</code></td><td><code>${esc(i.doc ?? (i.media !== undefined ? `media:${i.media}` : ''))}</code></td><td>${esc(i.detail)}</td></tr>`).join('\n')}
</table></div>`
}
