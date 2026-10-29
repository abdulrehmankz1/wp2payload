import { isComment, isTag, isText, type AnyNode, type Element } from 'domhandler'
import { parseDocument } from 'htmlparser2'
import sanitizeHtml, { type IOptions } from 'sanitize-html'
import type { SecurityFinding } from '../../report/types.js'
import type { QuarantineFragment, SanitizeOptions, SanitizeResult } from '../../transform/types.js'
import {
  CONTENT_POLICY,
  EMBED_ATTR,
  EMBED_TAG,
  LINK_HEAVY_FACTOR,
  LINK_HEAVY_MIN,
} from './policy.js'
import {
  URL_ATTRIBUTES,
  dangerousScheme,
  embedUrl,
  hiddenSelectors,
  hiddenStyleReason,
  isExternalUrl,
  isJsRedirect,
  obfuscationReason,
  siteHostKey,
  spamKeywords,
  type HiddenSelectors,
} from './signals.js'
import { markupLimit } from './depth.js'

// Content sanitizer (doc 2.3 step 2, 12.4, 12.5; threats T1, T3, T4, T5).
//
// 1. Pre-scan: htmlparser2 DOM walk records findings and computes source edits (remove a hidden
//    link farm, a script, a meta refresh, a rogue iframe, an obfuscated text run; swap an allowed
//    iframe for the embed placeholder). Edits are spliced into the source by offset, never by
//    re-serialising the DOM, so deep nesting cannot overflow a recursive serialiser.
//    A cut never lets its neighbours join into new markup (`a<` + `b>` must not become `<b>`):
//    unless the cut follows a `>` or whitespace, a space is left in its place.
//    The scan repeats on the edited source until it is stable. If it is still changing after
//    MAX_PASSES, the whole input is dropped and quarantined (fail closed).
// 2. Allowlist: sanitize-html with doc 12.4 CONTENT_POLICY. This is the security boundary:
//    whatever the pre-scan misses, only allowlisted tags, attributes and schemes come out.
//
// `scanDocument` runs step 1 alone over a whole raw post (block comments included), so hiding
// wrappers and stylesheets that span Gutenberg blocks are seen before the post is split.

type Finding = SecurityFinding
type Mode = 'block' | 'document'

interface Edit {
  start: number
  end: number // inclusive
  replacement: string
}

interface Scan {
  edits: Edit[]
  /** Fragments the edits remove, each with its finding. */
  removed: QuarantineFragment[]
  /** Findings about content that stays in the source (attributes the allowlist drops, kept hidden text). */
  kept: Finding[]
  keptQuarantine: QuarantineFragment[]
}

/** Internal limits; exposed for tests only. */
export interface ScanLimits {
  maxPasses?: number
}

const MAX_PASSES = 4
/** Text inside these is shown as code, not executed; obfuscation heuristics would misfire there. */
const CODE_TAGS = new Set(['code', 'pre', 'kbd', 'samp'])
/** Raw-text content the allowlist drops anyway; not scanned for obfuscation. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'xmp', 'noembed', 'noframes', 'title', 'iframe'])
/** Content a browser with scripting never renders: links inside are as hidden as display:none. */
const NEVER_RENDERED = new Set(['noscript', 'template'])
const FRAME_TAGS = new Set(['iframe', 'frame'])
const BLOCK_COMMENT = /^\s*(\/)?wp:([a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?)(?:\s[\s\S]*)?$/

const PARSE = { withStartIndices: true, withEndIndices: true } as const

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function embedPlaceholder(url: string): string {
  return `<${EMBED_TAG} ${EMBED_ATTR}="${escapeAttr(url)}"></${EMBED_TAG}>`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function pushChildren(stack: AnyNode[], node: AnyNode): void {
  if (!('children' in node)) return
  for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]!)
}

/**
 * Source range of a node. An element closed implicitly (`<p>a<div>`) can report an end offset
 * past its next sibling's start, so the end is clamped to the next sibling and the parent.
 */
function range(node: AnyNode, srcLength: number): [number, number] {
  const start = node.startIndex ?? 0
  let end = node.endIndex ?? srcLength - 1
  if (node.next?.startIndex != null) end = Math.min(end, node.next.startIndex - 1)
  if (node.parent?.endIndex != null) end = Math.min(end, node.parent.endIndex)
  return [start, Math.max(start, end)]
}

function textOf(node: AnyNode): string {
  let out = ''
  const stack: AnyNode[] = [node]
  while (stack.length) {
    const n = stack.pop()!
    if (isText(n)) out += n.data
    else pushChildren(stack, n)
  }
  return out
}

function countLinks(node: AnyNode): number {
  let n = 0
  const stack: AnyNode[] = [node]
  while (stack.length) {
    const c = stack.pop()!
    if (isTag(c) && c.name === 'a' && c.attribs.href !== undefined) n++
    pushChildren(stack, c)
  }
  return n
}

/**
 * Gutenberg block delimiters inside a removed node that have no partner inside it. They are put
 * back so the delimiters outside the cut still pair up (`<!-- wp:html --><div hidden><!-- /wp:html -->`).
 */
function unpairedDelimiters(node: AnyNode, src: string): string {
  const tokens: { text: string; name: string; close: boolean; keep: boolean }[] = []
  const open: number[] = []
  const stack: AnyNode[] = [node]
  while (stack.length) {
    const n = stack.pop()!
    if (isComment(n)) {
      const m = BLOCK_COMMENT.exec(n.data)
      if (!m || /\/\s*$/.test(n.data)) continue // not a delimiter, or self-closing
      const [s, e] = range(n, src.length)
      const t = { text: src.slice(s, e + 1), name: m[2] ?? '', close: m[1] === '/', keep: true }
      if (!t.close) open.push(tokens.length)
      else if (open.length && tokens[open[open.length - 1]!]!.name === t.name) {
        tokens[open.pop()!]!.keep = false
        t.keep = false
      }
      tokens.push(t)
      continue
    }
    pushChildren(stack, n)
  }
  return tokens.filter((t) => t.keep).map((t) => t.text).join('')
}

function hiddenReason(el: Element, sheets: HiddenSelectors): string | undefined {
  if (NEVER_RENDERED.has(el.name)) return `<${el.name}>`
  if (el.attribs.hidden !== undefined) return 'hidden attribute'
  const style = el.attribs.style
  const inline = style ? hiddenStyleReason(style) : undefined
  if (inline) return inline
  for (const c of (el.attribs.class ?? '').toLowerCase().split(/\s+/)) {
    const r = c ? sheets.classes.get(c) : undefined
    if (r) return r
  }
  const id = el.attribs.id?.toLowerCase()
  return id ? sheets.ids.get(id) : undefined
}

function startTag(el: Element): string {
  const attrs = Object.entries(el.attribs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')
  return `<${el.name}${attrs}>`
}

function frameTarget(src: string | undefined): string {
  if (!src) return 'without src'
  try {
    const u = new URL(src.trim())
    if (u.protocol === 'https:') return `to ${u.host}`
    return u.protocol === 'http:' ? `to http://${u.host}` : `with a ${u.protocol} src`
  } catch {
    return 'with an invalid src'
  }
}

function scan(src: string, opts: SanitizeOptions, mode: Mode): Scan {
  const dom = parseDocument(src, PARSE)
  const out: Scan = { edits: [], removed: [], kept: [], keptQuarantine: [] }
  const finding = (code: Finding['code'], severity: Finding['severity'], action: Finding['action'], detail: string): Finding =>
    ({ code, severity, action, doc: opts.doc, detail })
  const flagHiddenText = mode === 'document' || opts.spam !== false

  // Stylesheets first: a class rule can hide a link farm declared before or after it.
  const sheets: HiddenSelectors = { classes: new Map(), ids: new Map() }
  const all: AnyNode[] = [dom]
  while (all.length) {
    const n = all.pop()!
    if (isTag(n) && n.name === 'style') hiddenSelectors(textOf(n), sheets)
    pushChildren(all, n)
  }

  const swap = (node: AnyNode, replacement: string) => {
    const [start, end] = range(node, src.length)
    out.edits.push({ start, end, replacement })
  }
  const cut = (node: AnyNode, f: Finding) => {
    const [start, end] = range(node, src.length)
    const before = start > 0 ? src[start - 1]! : '>'
    const sep = before === '>' || /\s/.test(before) ? '' : ' '
    const keep = mode === 'document' ? unpairedDelimiters(node, src) : ''
    out.edits.push({ start, end, replacement: sep + keep })
    out.removed.push({ html: src.slice(start, end + 1), finding: f })
  }

  // Iterative DFS. `code`: inside a code element; `raw`: inside raw text; `hidden`: inside a
  // hidden container already judged (it had no links), so nested containers are not re-counted.
  type Entry = { node: AnyNode; code: boolean; raw: boolean; hidden: boolean }
  const stack: Entry[] = []
  for (let i = dom.children.length - 1; i >= 0; i--) stack.push({ node: dom.children[i]!, code: false, raw: false, hidden: false })
  while (stack.length) {
    const { node, code, raw, hidden } = stack.pop()!

    if (isText(node)) {
      const why = !code && !raw ? obfuscationReason(node.data, 'text') : undefined
      if (why) cut(node, finding('SEC_OBFUSCATED', 'medium', 'quarantined', `${why} in text`))
      continue
    }
    if (!isTag(node)) continue
    const el = node
    const name = el.name

    if (name === 'script') {
      const js = textOf(el) + ' ' + (el.attribs.src ?? '')
      cut(el, isJsRedirect(js)
        ? finding('SEC_JS_REDIRECT', 'high', 'quarantined', 'JavaScript redirect in <script>')
        : finding('SEC_SCRIPT_TAG', 'high', 'quarantined', el.attribs.src !== undefined ? '<script src>' : '<script>'))
      continue
    }
    if (name === 'meta' && el.attribs['http-equiv']?.trim().toLowerCase() === 'refresh') {
      cut(el, finding('SEC_META_REFRESH', 'high', 'quarantined', '<meta http-equiv="refresh">'))
      continue
    }
    if (mode === 'block' && FRAME_TAGS.has(name)) {
      const url = embedUrl(el.attribs.src, opts.embedHosts)
      if (url) swap(el, embedPlaceholder(url))
      else cut(el, finding('SEC_IFRAME_UNKNOWN_HOST', 'medium', 'quarantined', `<${name}> ${frameTarget(el.attribs.src)}`))
      continue
    }
    if (mode === 'block' && name === EMBED_TAG) {
      // Only the sanitizer writes placeholders. One already in the input is accepted only in the
      // exact shape the sanitizer emits (allowed https URL, no content), which keeps sanitizing
      // idempotent; it is then no more powerful than the allowed iframe it stands for.
      if (!embedUrl(el.attribs[EMBED_ATTR], opts.embedHosts) || el.children.length > 0) {
        cut(el, finding('SEC_FORGED_EMBED', 'medium', 'quarantined', `<${EMBED_TAG}> not written by the sanitizer`))
        continue
      }
    }

    let inHidden = hidden
    if (!hidden) {
      const why = hiddenReason(el, sheets)
      if (why) {
        // Outermost hidden containers are disjoint subtrees, so counting here stays linear.
        const links = countLinks(el)
        if (links > 0) {
          cut(el, finding('SEC_HIDDEN_LINKS', 'high', 'quarantined', `${plural(links, 'link')} in hidden <${name}> (${why})`))
          continue
        }
        inHidden = true
        const text = textOf(el).replace(/\s+/g, ' ').trim()
        if (text && flagHiddenText) {
          out.kept.push(finding('SEC_HIDDEN_TEXT', 'low', 'flagged', `${plural(text.length, 'char')} of text in hidden <${name}> (${why}), kept`))
        }
      }
    }

    if (mode === 'block') {
      for (const [attr, value] of Object.entries(el.attribs)) {
        const a = attr.toLowerCase()
        if (a.startsWith('on')) {
          out.kept.push(isJsRedirect(value)
            ? finding('SEC_JS_REDIRECT', 'high', 'removed', `JavaScript redirect in ${a} on <${name}>`)
            : finding('SEC_EVENT_HANDLER', 'high', 'removed', `${a} on <${name}>`))
          continue
        }
        if (a === 'style') continue
        const scheme = URL_ATTRIBUTES.has(a) ? dangerousScheme(value) : undefined
        if (scheme) {
          out.kept.push(finding('SEC_DANGEROUS_URL', 'high', 'removed', `${scheme}: URL in ${a} on <${name}>`))
          continue
        }
        const why = obfuscationReason(value, 'attribute')
        if (why) {
          const f = finding('SEC_OBFUSCATED', 'medium', 'quarantined', `${why} in ${a} on <${name}>, attribute removed`)
          out.kept.push(f)
          out.keptQuarantine.push({ html: startTag(el), finding: f })
        }
      }
    }

    const inCode = code || CODE_TAGS.has(name)
    const inRaw = raw || RAW_TEXT_TAGS.has(name)
    for (let i = el.children.length - 1; i >= 0; i--) stack.push({ node: el.children[i]!, code: inCode, raw: inRaw, hidden: inHidden })
  }
  return out
}

/** Applies non-overlapping edits (the scan never descends into an edited node). */
function applyEdits(src: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start)
  let out = ''
  let pos = 0
  for (const e of sorted) {
    if (e.start < pos) continue // defensive: overlapping ranges from implied end tags
    out += src.slice(pos, e.start) + e.replacement
    pos = e.end + 1
  }
  return out + src.slice(pos)
}

interface Stable {
  src: string
  findings: Finding[]
  quarantine: QuarantineFragment[]
}

/** Runs the pre-scan to a fixpoint. Fails closed: input that never settles is dropped whole. */
function prescan(html: string, opts: SanitizeOptions, mode: Mode, limits: ScanLimits): Stable {
  const maxPasses = limits.maxPasses ?? MAX_PASSES
  const findings: Finding[] = []
  const quarantine: QuarantineFragment[] = []
  const limit = markupLimit(html)
  if (limit) {
    const f: Finding = {
      code: limit.code, severity: 'high', action: 'quarantined', doc: opts.doc,
      detail: `${limit.detail}; the whole ${mode} was dropped unparsed`,
    }
    return { src: '', findings: [f], quarantine: [{ html, finding: f }] }
  }
  let src = html
  for (let pass = 0; pass < maxPasses; pass++) {
    const s = scan(src, opts, mode)
    for (const q of s.removed) {
      findings.push(q.finding)
      quarantine.push(q)
    }
    if (s.edits.length === 0) {
      // Findings about content still present come from this final pass only: earlier passes may
      // have seen elements that were removed since.
      findings.push(...s.kept)
      quarantine.push(...s.keptQuarantine)
      return { src, findings, quarantine }
    }
    src = applyEdits(src, s.edits)
  }
  const f: Finding = {
    code: 'SEC_SCAN_UNSTABLE', severity: 'high', action: 'quarantined', doc: opts.doc,
    detail: `content still changing after ${plural(maxPasses, 'pre-scan pass')}; the whole ${mode} was dropped`,
  }
  findings.push(f)
  quarantine.push({ html, finding: f })
  return { src: '', findings, quarantine }
}

function allowlistOptions(opts: SanitizeOptions): IOptions {
  const site = siteHostKey(opts.siteOrigin)
  const base = CONTENT_POLICY.allowedAttributes as Record<string, string[]>
  return {
    ...CONTENT_POLICY,
    allowedTags: [...(CONTENT_POLICY.allowedTags as string[]), EMBED_TAG],
    // `rel` is set by the transform below, never taken from the input.
    allowedAttributes: { ...base, a: [...(base.a ?? []), 'rel'], [EMBED_TAG]: [EMBED_ATTR] },
    transformTags: {
      '*': (tagName, attribs) => {
        const kept: Record<string, string> = {}
        for (const [k, v] of Object.entries(attribs)) {
          if (URL_ATTRIBUTES.has(k) && dangerousScheme(v)) continue
          if (k !== EMBED_ATTR && obfuscationReason(v, 'attribute')) continue
          kept[k] = v
        }
        if (tagName === 'a') {
          delete kept.rel
          if (kept.href !== undefined && isExternalUrl(kept.href, site)) kept.rel = opts.externalLinkRel
        }
        return { tagName, attribs: kept }
      },
    },
    // Output check for the placeholder: an allowed https URL and nothing inside it.
    exclusiveFilter: (frame) =>
      frame.tag === EMBED_TAG && (!embedUrl(frame.attribs[EMBED_ATTR], opts.embedHosts) || frame.text.trim() !== ''),
  }
}

/**
 * Sanitizes one block's HTML (doc 12.4) and reports doc 12.5 signals. Removed fragments come back
 * as quarantine fragments for the caller to write (doc 12.10). Link-heavy posts are judged by the
 * caller with `countExternalLinks` and `linkHeavyFinding`, since that needs the site median.
 * With `opts.spam === false` the document-level low flags (SEC_SPAM_KEYWORDS, SEC_HIDDEN_TEXT)
 * are left to `spamFinding` and `scanDocument`.
 */
export function sanitizeContent(html: string, opts: SanitizeOptions, limits: ScanLimits = {}): SanitizeResult {
  const pre = prescan(html, opts, 'block', limits)
  const out = pre.src ? sanitizeHtml(pre.src, allowlistOptions(opts)) : ''
  if (opts.spam !== false) {
    const spam = spamFinding(out, opts)
    if (spam) pre.findings.push(spam)
  }
  return { html: out, findings: pre.findings, quarantine: pre.quarantine }
}

/**
 * Document-level pre-scan of a raw WordPress post (block comments included), before it is split
 * into blocks. Cuts hidden link containers, scripts, meta refreshes and obfuscated text runs,
 * using hiding rules from every `<style>` in the post. Everything else is left byte for byte,
 * comments included; Gutenberg delimiters inside a cut that lose their partner are put back.
 * No allowlist is applied: the result goes to the Gutenberg parser, then `sanitizeContent`.
 */
export function scanDocument(rawHtml: string, opts: SanitizeOptions, limits: ScanLimits = {}): SanitizeResult {
  const pre = prescan(rawHtml, opts, 'document', limits)
  return { html: pre.src, findings: pre.findings, quarantine: pre.quarantine }
}

/**
 * Low, flag-only finding for spam keywords in link text (doc 12.5). Run on sanitized HTML: the
 * pipeline calls it once on the joined document, `sanitizeContent` per call unless `spam: false`.
 */
export function spamFinding(html: string, opts: Pick<SanitizeOptions, 'doc'>): Finding | undefined {
  const dom = parseDocument(html)
  const words = new Set<string>()
  let links = 0
  const stack: AnyNode[] = [dom]
  while (stack.length) {
    const n = stack.pop()!
    if (isTag(n) && n.name === 'a') {
      const hits = spamKeywords(textOf(n))
      if (hits.length) {
        links++
        for (const w of hits) words.add(w)
      }
      continue
    }
    pushChildren(stack, n)
  }
  if (!links) return undefined
  return {
    code: 'SEC_SPAM_KEYWORDS', severity: 'low', action: 'flagged', doc: opts.doc,
    detail: `${plural(links, 'link')} with spam keywords in link text: ${[...words].sort().join(', ')}`,
  }
}

/** Absolute http(s) links to another host than `siteOrigin` (www and non-www are the same site). */
export function countExternalLinks(html: string, siteOrigin: string): number {
  const site = siteHostKey(siteOrigin)
  const dom = parseDocument(html)
  let n = 0
  const stack: AnyNode[] = [dom]
  while (stack.length) {
    const c = stack.pop()!
    if (isTag(c) && c.name === 'a' && c.attribs.href !== undefined && isExternalUrl(c.attribs.href, site)) n++
    pushChildren(stack, c)
  }
  return n
}

export interface LinkHeavyOptions {
  /** Flag at `median * factor` external links. Default 3. */
  factor?: number
  /** Never flag below this many external links. Default 10. */
  min?: number
}

/**
 * Doc 12.5 "far more external links than the site median": low, flagged, content kept.
 * `median` is the caller's site-wide median of `countExternalLinks` per document.
 */
export function linkHeavyFinding(count: number, median: number, doc: string, options: LinkHeavyOptions = {}): Finding | undefined {
  const threshold = Math.max(options.min ?? LINK_HEAVY_MIN, median * (options.factor ?? LINK_HEAVY_FACTOR))
  if (!(count >= threshold)) return undefined
  return {
    code: 'SEC_LINK_HEAVY', severity: 'low', action: 'flagged', doc,
    detail: `${count} external links, site median ${median}`,
  }
}
