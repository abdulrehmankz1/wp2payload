import { cards, esc, renderPage, SEVERITIES, sevClass, table } from '../report/html.js'
import { describeFindings } from '../report/summary.js'
import type { Issue, SecurityFinding } from '../report/types.js'
import type { ScanReport } from './run.js'

// The scan as one self-contained HTML page: a deliverable an agency can hand to a client (doc
// 12.11). Escaping, layout and the Content-Security-Policy live in report/html.ts.

const SOURCES: Record<ScanReport['source'], string> = { rest: 'live site (REST API)', wxr: 'WordPress export file', sql: 'SQL backup', wpress: 'All-in-One WP Migration backup', archive: 'zip or tar backup' }

export function renderScanHtml(r: ScanReport, opts: { version: string }): string {
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
  const sev = (s: string) => `<td class="${sevClass(s)}">${esc(s)}</td>`

  const body = `${cards(r.security.summary, [[r.documents.scanned, 'documents scanned']])}

<h2>Security findings</h2>
${groups.size === 0 ? '<p>No findings.</p>' : `${table(['Severity', 'Count', 'Finding'], [...groups.values()].map((items) => [
    sev(items[0]!.severity), `<td class="num">${items.length}</td>`, `<td>${esc(describeFindings(items[0]!.code, items))} <code>${esc(items[0]!.code)}</code></td>`,
  ]), '')}
<details><summary>All ${findings.length} findings</summary>
${table(['Severity', 'Code', 'Where', 'Detail'], findings.map((f) => [
    sev(f.severity), `<td><code>${esc(f.code)}</code></td>`, `<td><code>${esc(where(f))}</code></td>`, `<td>${esc(f.detail ?? '')}</td>`,
  ]), '', 'All are in scan.json.')}
</details>`}

<h2>Content</h2>
<div class="scroll"><table>
${inventory.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? 'unknown')}</td></tr>`).join('\n')}
${health.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('\n')}
</table></div>

<h2>Notes</h2>
${issueTable(r.warnings, 'No warnings.')}
${r.errors.length ? `<h2>Could not be read</h2>\n${issueTable(r.errors, '')}` : ''}`

  return renderPage({
    title: `Site scan: ${r.site}`,
    subtitle: `${SOURCES[r.source]} · scanned ${r.startedAt.slice(0, 16).replace('T', ' ')} UTC in ${Math.round(r.durationSec)}s · wp2payload ${opts.version}`,
    body,
    footer:
      "This report lists what wp2payload found in the site's content and media, and what a migration would keep out of the new site. " +
      'It is not a malware scan of the server and does not certify that the site is clean. If a site is known to be compromised, ' +
      'treat everything from it as untrusted and rotate every credential it used.',
  })
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
  return table(['Code', 'Where', 'Detail'], issues.map((i) => [
    `<td><code>${esc(i.code)}</code></td>`, `<td><code>${esc(i.doc ?? (i.media !== undefined ? `media:${i.media}` : ''))}</code></td>`, `<td>${esc(i.detail)}</td>`,
  ]), empty, 'All are in scan.json.')
}
