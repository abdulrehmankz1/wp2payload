import { createHash } from 'node:crypto'
import type { Severity } from './types.js'

// Shared building blocks for the self-contained HTML reports (scan.html, security-report.html).
// Every value in them comes from a WordPress site or from a report file on disk, so all of it is
// escaped here, the pages carry no script, no link and no external resource, and the
// Content-Security-Policy allows nothing but the page's own stylesheet (pinned by hash).

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
// Control and bidi characters could disguise text; show them as '?'. Tab, LF and CR are harmless.
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g
// A surrogate without its partner is not valid UTF-16 and would be written as U+FFFD anyway; do it explicitly.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** Longest text shown in a table cell; report.json keeps the full value. */
export const MAX_TEXT = 500
/** Most table rows shown; report.json keeps every row. */
export const MAX_ROWS = 2000

export const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low']

/** Escapes a value for HTML text or a quoted attribute. Only strings and numbers render; anything else is empty. */
export function esc(v: unknown, max = Infinity): string {
  let s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
  if (s.length > max) s = `${s.slice(0, max)}…`
  return s.replace(LONE_SURROGATE, '�').replace(UNSAFE, '?').replace(/[&<>"']/g, (c) => ESC[c]!)
}

/** A CSS class for a severity: only the known ones, so a hostile value never reaches an attribute. */
export function sevClass(v: unknown): Severity | 'unknown' {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v) ? (v as Severity) : 'unknown'
}

const CSS = `
:root { --bg: #fff; --fg: #1a1a1a; --muted: #5c5c5c; --line: #e2e2e2; --card: #f6f6f6; --high: #b42318; --medium: #b54708; --low: #475467; --note: #fef7c3; }
@media (prefers-color-scheme: dark) { :root { --bg: #141414; --fg: #ececec; --muted: #a3a3a3; --line: #2e2e2e; --card: #1e1e1e; --high: #f97066; --medium: #fdb022; --low: #98a2b3; --note: #3a3410; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; overflow-wrap: anywhere; }
h2 { font-size: 18px; margin: 36px 0 12px; }
p, td { overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.note { background: var(--note); border-radius: 8px; padding: 10px 14px; }
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
`

/** The policy in every report: nothing loads, nothing runs, only the stylesheet above applies. */
export const CSP = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(CSS, 'utf8').digest('base64')}'; base-uri 'none'; form-action 'none'`

export interface PageParts {
  /** Plain text; escaped here. */
  title: string
  /** Plain text under the heading; escaped here. */
  subtitle: string
  /** Trusted HTML built from esc()-ed values. */
  body: string
  /** Plain text disclaimer; escaped here. */
  footer: string
}

/** One self-contained page. `body` must already be escaped; everything else is escaped here. */
export function renderPage(p: PageParts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>${esc(p.title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${esc(p.title)}</h1>
<p class="muted">${esc(p.subtitle)}</p>
${p.body}
<footer class="muted">
<p>${esc(p.footer)}</p>
</footer>
</main>
</body>
</html>
`
}

/** Severity cards plus any extra cards; counts are rendered as numbers only. */
export function cards(counts: Record<Severity, number>, extra: [number, string][] = []): string {
  return `<div class="cards">
${SEVERITIES.map((sev) => `<div class="card"><b class="${sev}">${esc(count(counts[sev]))}</b>${sev} severity</div>`).join('\n')}
${extra.map(([n, label]) => `<div class="card"><b>${esc(count(n))}</b>${esc(label)}</div>`).join('\n')}
</div>`
}

/** A table, or `empty` as a paragraph when there are no rows. Cells must already be escaped HTML. */
export function table(head: string[], rows: string[][], empty: string, note = 'All rows are in the JSON report.'): string {
  if (!rows.length) return empty ? `<p>${esc(empty)}</p>` : ''
  const shown = rows.slice(0, MAX_ROWS)
  return `<div class="scroll"><table>
<tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
${shown.map((r) => `<tr>${r.join('')}</tr>`).join('\n')}
</table></div>${rows.length > MAX_ROWS ? `\n<p class="muted">First ${MAX_ROWS} of ${rows.length} shown. ${esc(note)}</p>` : ''}`
}

/** A non-negative integer from untrusted input, 0 otherwise. */
export function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}
