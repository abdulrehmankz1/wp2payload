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

export interface TransformContext {
  siteOrigin: string
  embedHosts: readonly string[]
  externalLinkRel: string
  transformers: Transformer[]
  lexical: Omit<LexicalOptions, 'doc'>
  report: ReportSink
  /** Project folder; quarantine goes under <root>/.wp2payload/quarantine. */
  root: string
  dryRun: boolean
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
  const opts = { doc: ref, siteOrigin: ctx.siteOrigin, embedHosts: ctx.embedHosts, externalLinkRel: ctx.externalLinkRel, spam: false }
  const quarantine = quarantiner(doc, ctx)

  const scanned = scanDocument(doc.html, opts)
  await quarantine(scanned.findings, scanned.quarantine)

  const skipped = new Tally()
  const unknown = new Tally()
  const clean: string[] = []
  for (const block of normaliseBlocks(parseBlocks(scanned.html, warn), ctx.transformers, warn)) {
    if (block.name === 'core/block') {
      warn({ code: 'REUSABLE_BLOCK_SKIPPED', detail: 'Reusable block content is stored separately and is not migrated yet' })
      continue
    }
    if (block.dynamic && !block.unknown) {
      skipped.add(block.name)
      continue
    }
    if (block.unknown) unknown.add(block.name)
    const result = sanitizeContent(block.html, opts)
    await quarantine(result.findings, result.quarantine)
    if (result.html.trim()) clean.push(result.html)
    else if (hasText(block.html)) warn({ code: 'CONTENT_DROPPED', detail: `${block.name} had content but nothing safe remained` })
  }
  if (skipped.size) warn({ code: 'DYNAMIC_BLOCK_SKIPPED', detail: `Server-rendered blocks have no stored content: ${skipped}` })
  if (unknown.size) warn({ code: 'UNKNOWN_BLOCK', detail: `Kept as sanitized HTML or links: ${unknown}` })

  const html = clean.join('\n')
  const spam = spamFinding(html, { doc: ref })
  if (spam) ctx.report.finding(spam)
  const lexical = htmlToLexical(html, { externalLinkRel: ctx.externalLinkRel, ...ctx.lexical, doc: ref })
  for (const w of lexical.warnings) warn(w)

  const out: TransformedDocument = {
    title: normalisePlain(doc.title),
    content: lexical.state,
    externalLinks: countExternalLinks(html, ctx.siteOrigin),
  }
  if (doc.excerpt !== undefined) out.excerpt = normalisePlain(doc.excerpt)
  if (doc.seo) out.seo = plainSeo(doc.seo, warn)
  return out
}

/**
 * Reports findings and writes their fragments. Names carry a content hash, so a re-run reuses the
 * same file instead of piling up copies (doc 12.10 stays readable across runs).
 */
function quarantiner(doc: IRDocument, ctx: TransformContext) {
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

class Tally {
  readonly #counts = new Map<string, number>()
  add(name: string) {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + 1)
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
