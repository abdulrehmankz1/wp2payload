import type { CountAction, Issue, ReportJson, SecurityFinding, Severity } from './types.js'

// CLI summary after a run and for `wp2payload report` (doc 12.11). Standard ANSI colours only;
// the caller decides whether colour is on (colorEnabled: NO_COLOR, TTY).

export interface SummaryOptions {
  color: boolean
  /** Shown on the Details line, e.g. `.wp2payload/report.json`. */
  reportPath: string
  /** List every warning and error instead of the top codes. */
  verbose?: boolean
}

const PHASE_ORDER = ['media', 'terms', 'authors', 'documents']
const ACTION_ORDER: CountAction[] = ['created', 'updated', 'reused', 'skipped', 'rejected', 'errors']
const TOP_CODES = 5

// Singular and plural noun phrase per code; the action ("removed", "quarantined"...) follows.
const DESCRIPTIONS: Record<string, [string, string]> = {
  SEC_SCRIPT_TAG: ['script element', 'script elements'],
  SEC_META_REFRESH: ['meta refresh redirect', 'meta refresh redirects'],
  SEC_JS_REDIRECT: ['script redirect', 'script redirects'],
  SEC_EVENT_HANDLER: ['event handler attribute', 'event handler attributes'],
  SEC_DANGEROUS_URL: ['dangerous URL', 'dangerous URLs'],
  SEC_HIDDEN_LINKS: ['hidden spam link block', 'hidden spam link blocks'],
  SEC_IFRAME_UNKNOWN_HOST: ['iframe from an unknown host', 'iframes from unknown hosts'],
  SEC_OBFUSCATED: ['obfuscated code fragment', 'obfuscated code fragments'],
  SEC_FORGED_EMBED: ['forged embed placeholder', 'forged embed placeholders'],
  SEC_SCAN_UNSTABLE: ['block that kept changing under the scan', 'blocks that kept changing under the scan'],
  SEC_NESTING_LIMIT: ['block nested too deeply', 'blocks nested too deeply'],
  SEC_MARKUP_LIMIT: ['block too costly to parse', 'blocks too costly to parse'],
  SEC_HIDDEN_TEXT: ['hidden text block', 'hidden text blocks'],
  SEC_LINK_HEAVY: ['post with unusual external links', 'posts with unusual external links'],
  SEC_SPAM_KEYWORDS: ['link with spam keywords', 'links with spam keywords'],
  SEC_EXECUTABLE_UPLOAD: ['executable upload', 'executable uploads'],
  SEC_TYPE_MISMATCH: ['file whose content does not match its name', 'files whose content does not match their names'],
  SEC_TYPE_NOT_ALLOWED: ['file of a type outside the allowlist', 'files of types outside the allowlist'],
  SEC_SVG_REJECTED: ['SVG file', 'SVG files'],
  SEC_SVG_ALLOWED: ['SVG file', 'SVG files'],
  SEC_PDF_ACTIVE_CONTENT: ['PDF with active content', 'PDFs with active content'],
  SEC_IMAGE_UNDECODABLE: ['undecodable image', 'undecodable images'],
  SEC_MIME_MISMATCH: ['file with a mismatched MIME type', 'files with mismatched MIME types'],
  SEC_REENCODE_DISABLED: ['image without re-encoding', 'images without re-encoding'],
  SEC_SSRF_BLOCKED: ['media URL to a private address', 'media URLs to private addresses'],
  SEC_HOST_NOT_ALLOWED: ['media URL from a host not allowed', 'media URLs from hosts not allowed'],
  SEC_INSECURE_SCHEME: ['insecure media URL', 'insecure media URLs'],
  SEC_TOO_MANY_REDIRECTS: ['media URL with too many redirects', 'media URLs with too many redirects'],
  SEC_FILE_TOO_LARGE: ['file over the size limit', 'files over the size limit'],
}

const ACTION_WORDS: Record<SecurityFinding['action'], string> = {
  removed: 'removed',
  rejected: 'rejected',
  quarantined: 'quarantined',
  flagged: 'flagged for review',
  'not migrated': 'not migrated',
  allowed: 'allowed',
}

const SEV_STYLE: Record<Severity, { mark: string; code: number; rank: number }> = {
  high: { mark: '✖', code: 31, rank: 0 },
  medium: { mark: '!', code: 33, rank: 1 },
  low: { mark: ' ', code: 2, rank: 2 },
}

// C0, DEL, C1, and the bidi controls (ALM, LRM, RLM, embeddings and isolates).
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** Report text comes from WordPress: replace control and bidi characters so it cannot inject terminal escapes. */
export function clean(text: string): string {
  return text.replace(UNSAFE, '?')
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0s'
  if (sec < 60) return `${Math.round(sec * 10) / 10}s`
  const total = Math.round(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export function formatSummary(json: ReportJson, opts: SummaryOptions): string[] {
  const paint = (code: number, text: string): string => (opts.color ? `\u001b[${code}m${text}\u001b[0m` : text)
  const lines: string[] = []
  const took = formatDuration(json.durationSec)
  const site = clean(json.site)
  const kind = json.dryRun ? 'Dry run' : 'Migration'

  if (json.stopped) lines.push(paint(1, `${kind} of ${site} stopped after ${took}`))
  else if (json.dryRun) {
    const n = json.errors.length
    lines.push(paint(1, `Dry run of ${site} finished in ${took}${n ? ` with ${n} error${n === 1 ? '' : 's'}` : ''}. Nothing was written.`))
  }
  else if (json.errors.length > 0) {
    // Below the error-rate threshold a run completes, but "Migrated" alone would read as success.
    const n = json.errors.length
    lines.push(paint(1, `Migration of ${site} finished in ${took} with ${n} error${n === 1 ? '' : 's'}`))
  } else lines.push(paint(1, `Migrated ${site} in ${took}`))
  lines.push('')

  // Per-phase counts: known phases in pipeline order, then any others alphabetically.
  const order = (p: string): number => {
    const i = PHASE_ORDER.indexOf(p)
    return i === -1 ? PHASE_ORDER.length : i
  }
  const phases = Object.keys(json.summary).sort((a, b) => order(a) - order(b) || a.localeCompare(b))
  const width = Math.max(11, ...phases.map((p) => clean(p).length + 2))
  for (const phase of phases) {
    const counts = json.summary[phase] ?? {}
    const parts = ACTION_ORDER.filter((a) => (counts[a] ?? 0) > 0).map((a) => `${counts[a]} ${a}`)
    lines.push(` ${clean(phase).padEnd(width)}${parts.length ? parts.join(', ') : 'nothing to do'}`)
  }
  if (phases.length === 0) lines.push(' No items processed.')
  // The redirects phase row already shows its counts; this row is for reports built without one.
  if (json.redirects && !json.summary['redirects']) {
    const conflicts = json.redirects.conflicts ? `, ${plural(json.redirects.conflicts, 'conflict')}` : ''
    lines.push(` ${'redirects'.padEnd(width)}${json.redirects.count}${conflicts}`)
  }
  if (json.redirects?.file && !json.dryRun) {
    // Generated from source data and kept in the ignored folder on purpose: a person reviews it first.
    lines.push('', `Redirects for next.config: ${clean(json.redirects.file)}. Review it, then copy it into your project (see the README).`)
  }
  lines.push('')

  const verbose = opts.verbose === true
  lines.push(...issueLines('Warnings', json.warnings, 33, '!', verbose, paint))
  lines.push(...issueLines('Errors', json.errors, 31, '✖', verbose, paint))

  if (json.stopped) {
    lines.push('')
    lines.push(`${paint(31, '✖')} Stopped during ${clean(json.stopped.phase)}: ${clean(json.stopped.reason)}`)
    lines.push('  Progress is saved. Fix the cause, then run the same command again to resume.')
  }

  lines.push('', paint(1, 'Security'))
  const groups = groupFindings(json.security.findings)
  if (groups.length === 0) lines.push('  No findings.')
  const countWidth = Math.max(1, ...groups.map((g) => String(g.count).length))
  for (const g of groups) {
    const style = SEV_STYLE[g.severity]
    const head = `${String(g.count).padStart(countWidth)} ${g.severity.padEnd(6)}`
    lines.push(`${paint(style.code, style.mark)} ${paint(style.code, head)}  ${g.text}`)
  }
  lines.push(`Details: ${opts.reportPath}`)
  return lines
}

function issueLines(
  label: string,
  issues: Issue[],
  colour: number,
  mark: string,
  verbose: boolean,
  paint: (code: number, text: string) => string,
): string[] {
  if (issues.length === 0) return [`${label}: none`]
  const out = [`${label}: ${issues.length}`]
  if (verbose) {
    for (const i of issues) {
      const where = i.doc ? ` (${clean(i.doc)})` : i.media !== undefined ? ` (media ${i.media})` : ''
      out.push(`  ${paint(colour, mark)} ${clean(i.code)}${where}: ${clean(i.detail)}`)
    }
    return out
  }
  const byCode = new Map<string, number>()
  for (const i of issues) byCode.set(i.code, (byCode.get(i.code) ?? 0) + 1)
  const sorted = [...byCode].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const w = String(sorted[0]?.[1] ?? 0).length
  for (const [code, n] of sorted.slice(0, TOP_CODES)) out.push(`  ${paint(colour, mark)} ${String(n).padStart(w)}  ${clean(code)}`)
  const rest = sorted.length - TOP_CODES
  if (rest > 0) out.push(`  and ${plural(rest, 'more code')}; see the report or use --verbose`)
  return out
}

interface FindingGroup {
  severity: Severity
  code: string
  count: number
  text: string
}

function groupFindings(findings: SecurityFinding[]): FindingGroup[] {
  const map = new Map<string, { severity: Severity; code: string; items: SecurityFinding[] }>()
  for (const f of findings) {
    const key = `${f.severity} ${f.code}`
    let g = map.get(key)
    if (!g) map.set(key, (g = { severity: f.severity, code: f.code, items: [] }))
    g.items.push(f)
  }
  return [...map.values()]
    .sort(
      (a, b) =>
        SEV_STYLE[a.severity].rank - SEV_STYLE[b.severity].rank || b.items.length - a.items.length || a.code.localeCompare(b.code),
    )
    .map((g) => ({ severity: g.severity, code: g.code, count: g.items.length, text: describe(g.code, g.items) }))
}

function describe(code: string, items: SecurityFinding[]): string {
  const n = items.length
  const action = [...new Set(items.map((i) => ACTION_WORDS[i.action] ?? clean(String(i.action))))].join(' or ')
  const known = DESCRIPTIONS[code]
  let text = known ? `${known[n === 1 ? 0 : 1]} ${action}` : `${clean(code)} ${action}`
  const only = items[0]
  if (n === 1 && only?.file) text += `: ${clean(only.file)}`
  return text
}
