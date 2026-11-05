import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Transformer } from '../config/types.js'
import type { IRDocument, IRSeo } from '../ir/types.js'
import type { ReportSink, SecurityFinding } from '../report/types.js'
import { countExternalLinks, normalisePlain, sanitizeContent, scanDocument, spamFinding, toPlainText } from '../security/content/index.js'
import { safeQuarantineName, writeQuarantine } from '../security/quarantine.js'
import { normaliseBlocks, parseBlocks } from './gutenberg/index.js'
import { htmlToLexical } from './lexical/index.js'
import type { LexicalOptions, LexicalResult, QuarantineFragment } from './types.js'

/** Fragments written per document; the rest are still reported (a hostile post must not flood the disk). */
export const MAX_QUARANTINE_PER_DOC = 50

/** What the security half needs; `wp2payload scan` runs only that half. */
export interface SecureContext {
  siteOrigin: string
  embedHosts: readonly string[]
  externalLinkRel: string
  transformers: Transformer[]
  report: ReportSink
  /** Project folder; quarantine goes under <root>/.wp2payload/quarantine. */
  root: string
  dryRun: boolean
}

export interface TransformContext extends SecureContext {
  lexical: Omit<LexicalOptions, 'doc'>
}

export interface SecuredDocument {
  /** Sanitized HTML, ready for Lexical. */
  html: string
  /** For the caller's link-heavy check against the site median (doc 12.5). */
  externalLinks: number
}

export interface TransformedDocument {
  title: string
  excerpt?: string
  content: LexicalResult['state']
  seo?: IRSeo
  /** For the caller's link-heavy check against the site median (doc 12.5). */
  externalLinks: number
}

/**
 * Doc 2.3 steps 1-4 for one document. The security scan runs over the raw post first, so hidden
 * wrappers and stylesheet rules are seen before the Gutenberg normaliser drops wrapper markup; then
 * each block is normalised, allowlist-sanitized and converted to Lexical. Short fields become plain
 * text (T2). Everything removed or skipped is reported with `doc` set.
 */
export async function transformDocument(doc: IRDocument, ctx: TransformContext): Promise<TransformedDocument> {
  const ref = `${doc.type}:${doc.wpId}`
  const warn = (i: { code: string; detail: string }) => ctx.report.warning({ ...i, doc: ref })
  const { html, externalLinks } = await secureDocument(doc, ctx)
  const lexical = htmlToLexical(html, { externalLinkRel: ctx.externalLinkRel, ...ctx.lexical, doc: ref })
  for (const w of lexical.warnings) warn(w)

  const out: TransformedDocument = { title: normalisePlain(doc.title), content: lexical.state, externalLinks }
  if (doc.excerpt !== undefined) out.excerpt = normalisePlain(doc.excerpt)
  if (doc.seo) out.seo = plainSeo(doc.seo, warn)
  return out
}

/** Steps 1-3 of transformDocument: scan, normalise and sanitize, reporting every finding. */
export async function secureDocument(doc: IRDocument, ctx: SecureContext): Promise<SecuredDocument> {
  const ref = `${doc.type}:${doc.wpId}`
  const warn = (i: { code: string; detail: string }) => ctx.report.warning({ ...i, doc: ref })
  const opts = { doc: ref, siteOrigin: ctx.siteOrigin, embedHosts: ctx.embedHosts, externalLinkRel: ctx.externalLinkRel, spam: false }
  const quarantine = quarantiner(doc, ctx)

  const scanned = scanDocument(doc.html, opts)
  await quarantine(scanned.findings, scanned.quarantine)

  const skipped = new Tally()
  const unknown = new Tally()
  const seen = new Tally()
  const clean: string[] = []
  for (const block of normaliseBlocks(parseBlocks(scanned.html, warn), ctx.transformers, warn)) {
    if (block.name === 'core/block') {
      // The REST extractor inlines every reusable block with a valid ref; what still arrives here was not resolved.
      warn({ code: 'REUSABLE_BLOCK_SKIPPED', detail: 'Reusable block the source did not resolve (no valid ref); its content was not migrated' })
      continue
    }
    if (block.dynamic && !block.unknown) {
      skipped.add(block.name)
      continue
    }
    if (block.unknown) unknown.add(block.name)
    const result = sanitizeContent(block.html, opts)
    for (const f of result.findings) seen.add(findingKey(f))
    await quarantine(result.findings, result.quarantine)
    if (result.html.trim()) clean.push(result.html)
    else if (hasText(block.html)) warn({ code: 'CONTENT_DROPPED', detail: `${block.name} had content but nothing safe remained` })
  }
  // The normaliser rebuilds wrappers (<p>, <figure>, containers) without their attributes and skips
  // dynamic blocks, so a handler or script only there never reached the sanitizer above. A
  // report-only pass over the whole post adds the findings the per-block passes did not make.
  const whole = sanitizeContent(scanned.html, opts)
  const unseen = whole.findings.filter((f) => !PASS_LIMITS.has(f.code) && !seen.take(findingKey(f)))
  await quarantine(unseen, whole.quarantine.filter((q) => unseen.includes(q.finding)))
  if (skipped.size) warn({ code: 'DYNAMIC_BLOCK_SKIPPED', detail: `Server-rendered blocks have no stored content: ${skipped}` })
  if (unknown.size) warn({ code: 'UNKNOWN_BLOCK', detail: `Kept as sanitized HTML or links: ${unknown}` })

  const html = clean.join('\n')
  // ADR-0005: page-builder layouts and shortcodes are not converted, so say so instead of
  // leaving them as unexplained text.
  const builder = typeof doc.meta['pageBuilder'] === 'string' ? doc.meta['pageBuilder'] : undefined
  if (builder) {
    warn({ code: 'PAGE_BUILDER_LAYOUT', detail: `Built with ${builder}: text, images and links were migrated; its layout (sections, columns, styling) was not` })
  }
  const codes = shortcodes(html, builder)
  if (codes.size) warn({ code: 'SHORTCODE_NOT_MIGRATED', detail: `Shortcodes kept as text, their output was not migrated: ${codes}` })
  const spam = spamFinding(html, { doc: ref })
  if (spam) ctx.report.finding(spam)
  return { html, externalLinks: countExternalLinks(html, ctx.siteOrigin) }
}

/**
 * Reports findings and writes their fragments. Names carry a content hash, so a re-run reuses the
 * same file instead of piling up copies (doc 12.10 stays readable across runs).
 */
function quarantiner(doc: IRDocument, ctx: SecureContext) {
  let written = 0
  let capped = false
  return async (findings: SecurityFinding[], fragments: QuarantineFragment[]) => {
    const withFragment = new Set(fragments.map((q) => q.finding))
    for (const q of fragments) {
      if (!ctx.dryRun && written < MAX_QUARANTINE_PER_DOC) {
        // Hash first: the post type comes from the source and must never push it past the name cap.
        const name = `${createHash('sha256').update(q.html).digest('hex').slice(0, 16)}-${doc.type.slice(0, 32)}-${doc.wpId}`
        const rel = `content/${safeQuarantineName(name)}.html.txt`
        q.finding.quarantine = holds(join(ctx.root, '.wp2payload', 'quarantine', rel), q.html)
          ? rel
          : await writeQuarantine(ctx.root, { kind: 'content', name, text: q.html, finding: q.finding })
        written++
      } else if (!ctx.dryRun && !capped) {
        capped = true
        ctx.report.warning({
          code: 'QUARANTINE_LIMIT',
          doc: `${doc.type}:${doc.wpId}`,
          detail: `More than ${MAX_QUARANTINE_PER_DOC} fragments removed; the rest are reported but not saved`,
        })
      }
      ctx.report.finding(q.finding)
    }
    for (const f of findings) if (!withFragment.has(f)) ctx.report.finding(f)
  }
}

function holds(file: string, text: string): boolean {
  try {
    return readFileSync(file, 'utf8') === text
  } catch {
    return false
  }
}

// `[name]`, `[name attr=...]` or `[/name]` in text. Plain bracketed words ("[sic]") are not
// shortcodes, so a name without a separator counts only with attributes, a closing tag or when
// WordPress itself defines it.
const SHORTCODE = /\[(\/?)([a-z][a-z0-9_-]{0,48})((?:\s+[a-z_][\w-]*\s*=)?)[^\][]*\]/gi
const CORE_SHORTCODES = new Set(['gallery', 'audio', 'video', 'playlist', 'embed'])

function shortcodes(html: string, builder: string | undefined): Tally {
  const text = html.replace(/<[^>]*>/g, ' ')
  const tags = [...text.matchAll(SHORTCODE)].map(([, close, name, attrs]) => ({ close: close === '/', name: name!.toLowerCase(), attrs: attrs !== '' }))
  const closed = new Set(tags.filter((t) => t.close).map((t) => t.name))
  const found = new Tally()
  for (const t of tags) {
    if (t.close || !(t.attrs || closed.has(t.name) || CORE_SHORTCODES.has(t.name) || /[_-]/.test(t.name))) continue
    // The builder's own layout shortcodes are covered by PAGE_BUILDER_LAYOUT.
    if (builder && /^(?:et_pb_|vc_)/.test(t.name)) continue
    found.add(t.name)
  }
  return found
}

// About the pass itself, not the content: the whole post can hit a limit no single block reached.
const PASS_LIMITS = new Set(['SEC_MARKUP_LIMIT', 'SEC_NESTING_LIMIT', 'SEC_SCAN_UNSTABLE'])
const findingKey = (f: SecurityFinding) => `${f.code}\0${f.detail ?? ''}`

class Tally {
  readonly #counts = new Map<string, number>()
  add(name: string) {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + 1)
  }
  /** Removes one occurrence; false when there was none. */
  take(name: string): boolean {
    const n = this.#counts.get(name) ?? 0
    if (n === 0) return false
    this.#counts.set(name, n - 1)
    return true
  }
  get size() {
    return this.#counts.size
  }
  toString() {
    return [...this.#counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', ')
  }
}

const hasText = (html: string) => /<(img|iframe|video|audio)\b/i.test(html) || toPlainText(html) !== ''

function plainSeo(seo: IRSeo, warn: (i: { code: string; detail: string }) => void): IRSeo {
  const out: IRSeo = { ...seo }
  if (seo.title !== undefined) out.title = normalisePlain(seo.title)
  if (seo.description !== undefined) out.description = normalisePlain(seo.description)
  if (seo.canonical !== undefined && !/^https?:\/\//i.test(seo.canonical.trim())) {
    delete out.canonical
    warn({ code: 'SEO_CANONICAL_INVALID', detail: 'Canonical URL is not http(s) and was dropped' })
  }
  return out
}
