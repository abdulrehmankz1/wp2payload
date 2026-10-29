import { createHash } from 'node:crypto'
import { isTag, isText, type ChildNode, type Element } from 'domhandler'
import { parseDocument } from 'htmlparser2'
import type { LexicalIssue, LexicalOptions, LexicalResult } from '../types.js'
import { DROP, serialize } from './html.js'
import * as n from './nodes.js'

type Ctx = { fmt: number; pre: boolean; depth: number }
interface Frame {
  node: n.ElementNode
  /** Opened implicitly (inline content at root or inside a list), not by an element. */
  auto: boolean
  /** A block-level child ended here; the next inline content starts after a linebreak. */
  pendingBreak: boolean
  /** Reported only if the element survives (a link left empty around an upload is not). */
  issue?: LexicalIssue
}

// Beyond this the subtree is flattened to text, so hostile nesting cannot exhaust the stack.
const MAX_DEPTH = 200
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const INLINE_FORMAT: Record<string, number> = {
  strong: n.FORMAT.bold,
  b: n.FORMAT.bold,
  em: n.FORMAT.italic,
  i: n.FORMAT.italic,
  s: n.FORMAT.strikethrough,
  del: n.FORMAT.strikethrough,
  strike: n.FORMAT.strikethrough,
  u: n.FORMAT.underline,
  code: n.FORMAT.code,
}
const SCHEME = /^([a-z][a-z0-9+.-]*):/i
const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])
const IMAGE_SCHEMES = new Set(['http', 'https'])

/**
 * Sanitized HTML (doc 12.4 tag set) to a serialized Lexical editor state for Payload's
 * `lexicalEditor()`. Never throws on odd nesting: block content inside inline context splits the
 * surrounding elements, and anything not kept is reported.
 */
export function htmlToLexical(html: string, opts: LexicalOptions): LexicalResult {
  const b = new Builder(opts)
  const document = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true })
  for (const child of document.children) b.walk(child, { fmt: 0, pre: false, depth: 0 })
  return b.finish()
}

class Builder {
  private readonly rootNode = n.root()
  private readonly stack: Frame[] = [{ node: this.rootNode, auto: false, pendingBreak: false }]
  private readonly warnings: LexicalIssue[] = []
  private readonly seen = new Set<string>()
  private ids = 0

  constructor(private readonly opts: LexicalOptions) {}

  finish(): LexicalResult {
    this.popTo(1)
    return { state: { root: this.rootNode as unknown as Record<string, unknown> }, warnings: this.warnings }
  }

  walk(node: ChildNode, ctx: Ctx): void {
    if (isText(node)) return this.appendText(node.data, ctx)
    if (!isTag(node)) return
    if (ctx.depth >= MAX_DEPTH) {
      this.warn('LEXICAL_FALLBACK', `nesting deeper than ${MAX_DEPTH} flattened to text`)
      return this.appendText(textOf(node), ctx)
    }
    const el = node
    const name = el.name
    const inner: Ctx = { ...ctx, depth: ctx.depth + 1 }
    const format = INLINE_FORMAT[name]
    if (format !== undefined) return this.children(el, { ...inner, fmt: inner.fmt | format })
    if (HEADINGS.has(name)) return this.textBlock(n.heading(name as n.HeadingNode['tag']), el, inner)
    switch (name) {
      case 'p':
      case 'figcaption':
        return this.textBlock(n.paragraph(), el, inner)
      case 'pre':
        return this.pre(el, inner)
      case 'blockquote':
        return this.textBlock(n.quote(), el, inner)
      case 'ul':
      case 'ol':
        return this.list(el, inner)
      case 'li':
        return this.listItem(el, inner)
      case 'sub':
        return this.children(el, { ...inner, fmt: (inner.fmt & ~n.FORMAT.superscript) | n.FORMAT.subscript })
      case 'sup':
        return this.children(el, { ...inner, fmt: (inner.fmt & ~n.FORMAT.subscript) | n.FORMAT.superscript })
      case 'br':
        return this.appendInline(n.linebreak())
      case 'hr':
        return this.decorator(n.horizontalRule())
      case 'img':
        return this.image(el, inner)
      case 'a':
        return this.anchor(el, inner)
      case 'table':
        return this.table(el, inner)
      case 'wp2p-embed':
        this.embed(el)
        // A self-closed placeholder can swallow following siblings as children; keep them.
        return this.children(el, inner)
    }
    if (DROP.has(name)) {
      if (textOf(el).trim()) this.warn('CONTENT_DROPPED', `<${name}> element removed`)
      return
    }
    this.children(el, inner)
  }

  private children(el: Element, ctx: Ctx): void {
    for (const child of el.children) this.walk(child, ctx)
  }

  // --- stack ---

  private get top(): Frame {
    return this.stack[this.stack.length - 1]!
  }

  private push(node: n.ElementNode, auto = false, issue?: LexicalIssue): void {
    const parent = this.top
    // Lexical derives a list item's indent from its nesting depth and rewrites it on load.
    if (node.type === 'listitem') node.indent = this.stack.filter((f) => f.node.type === 'list').length - 1
    if (parent.pendingBreak && node.type === 'link') {
      parent.node.children.push(n.linebreak())
      parent.pendingBreak = false
    }
    parent.node.children.push(node)
    this.stack.push({ node, auto, pendingBreak: false, ...(issue ? { issue } : {}) })
  }

  private pop(): Frame {
    const frame = this.stack.pop()!
    const node = frame.node
    if (node.type !== 'link') trimEnd(node)
    if (node.type === 'list') numberItems(node)
    if (node.type === 'paragraph') {
      const first = node.children.find((c): c is n.TextNode => c.type === 'text')
      node.textFormat = first?.format ?? 0
    }
    if (node.children.length === 0) {
      const siblings = this.top.node.children
      if (siblings[siblings.length - 1] === node) siblings.pop()
    } else if (frame.issue) this.warn(frame.issue.code, frame.issue.detail)
    return frame
  }

  private popTo(depth: number): void {
    while (this.stack.length > depth) this.pop()
  }

  /** Closes frames until `accepts(top)`; returns them outermost first so they can be reopened. */
  private closeUntil(accepts: (f: Frame) => boolean): Frame[] {
    const closed: Frame[] = []
    while (this.stack.length > 1 && !accepts(this.top)) closed.unshift(this.pop())
    return closed
  }

  /** Continues the split elements after the hoisted content (empty continuations are pruned on pop). */
  private reopen(closed: Frame[]): void {
    while (closed.length > 0 && closed[closed.length - 1]!.auto) closed.pop()
    for (const f of closed) this.push(continuation(f.node), f.auto, f.issue)
  }

  private ensureInline(): void {
    const type = this.top.node.type
    if (type === 'root') this.push(n.paragraph(), true)
    else if (type === 'list') this.push(n.listItem(), true)
  }

  private inLink(): Frame | undefined {
    return this.stack.find((f) => f.node.type === 'link')
  }

  // --- content ---

  private appendInline(node: n.TextNode | n.LineBreakNode): void {
    this.ensureInline()
    const f = this.top
    const children = f.node.children
    if (f.pendingBreak) {
      children.push(n.linebreak())
      f.pendingBreak = false
    }
    const last = children[children.length - 1]
    if (node.type === 'text' && last?.type === 'text' && last.format === node.format) last.text += node.text
    else children.push(node)
  }

  private appendText(raw: string, ctx: Ctx): void {
    if (ctx.pre) {
      raw.replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
        if (i > 0) this.appendInline(n.linebreak())
        if (line) this.appendInline(n.text(line, ctx.fmt))
      })
      return
    }
    let s = raw.replace(/[ \t\n\r\f]+/g, ' ')
    if (s === '') return
    if (s === ' ') {
      const type = this.top.node.type
      if (type === 'root' || type === 'list' || this.top.pendingBreak || this.atBreak()) return
      return this.appendInline(n.text(' ', ctx.fmt))
    }
    this.ensureInline()
    if (this.top.pendingBreak || this.atBreak()) s = s.trimStart()
    this.appendInline(n.text(s, ctx.fmt))
  }

  /** True when the inline position is at a block start, after a linebreak or after a space. */
  private atBreak(): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i]!
      const last = lastLeaf(f.node)
      if (last) return last.type === 'linebreak' || last.text.endsWith(' ')
      if (f.node.type !== 'link') return true
    }
    return true
  }

  /** A block-level element inside an inline container: its content becomes a linebreak-separated run. */
  private group(el: Element, ctx: Ctx): void {
    if (this.top.node.children.length > 0) this.top.pendingBreak = true
    this.children(el, ctx)
    trimEnd(this.top.node)
    if (this.top.node.children.length > 0) this.top.pendingBreak = true
  }

  private textBlock(node: n.ElementNode, el: Element, ctx: Ctx, after?: () => void): void {
    if (this.top.auto && this.top.node.type === 'paragraph') this.pop()
    if (this.top.node.type === 'root') {
      const depth = this.stack.length
      this.push(node)
      this.children(el, ctx)
      after?.()
      this.popTo(depth)
      return
    }
    this.ensureInline()
    this.group(el, ctx)
    after?.()
  }

  private pre(el: Element, ctx: Ctx): void {
    const first = el.children[0]
    if (first && isText(first)) first.data = first.data.replace(/^\r?\n/, '')
    this.textBlock(n.paragraph(), el, { ...ctx, pre: true, fmt: ctx.fmt | n.FORMAT.code }, () => trimBreaks(this.top.node))
  }

  private list(el: Element, ctx: Ctx): void {
    const type = el.name === 'ol' ? 'number' : 'bullet'
    const start = Number.parseInt(el.attribs.start ?? '', 10)
    const closed = this.closeUntil((f) => f.node.type === 'root' || f.node.type === 'list')
    const depth = this.stack.length
    // Lexical nests a list inside its own list item, after the item it belongs to.
    if (this.top.node.type === 'list') this.push(n.listItem(), true)
    this.push(n.list(type, type === 'number' && Number.isSafeInteger(start) && start > 0 ? start : 1))
    this.children(el, ctx)
    this.popTo(depth)
    this.reopen(closed)
  }

  private listItem(el: Element, ctx: Ctx): void {
    if (!this.stack.some((f) => f.node.type === 'list')) return this.textBlock(n.paragraph(), el, ctx)
    const closed = this.closeUntil((f) => f.node.type === 'list')
    const depth = this.stack.length
    this.push(n.listItem())
    this.children(el, ctx)
    this.popTo(depth)
    this.reopen(closed)
  }

  /** Upload, block and horizontal rule nodes live at the root: split whatever is open around them. */
  private decorator(node: n.DecoratorNode): void {
    const closed = this.closeUntil((f) => f.node.type === 'root')
    this.rootNode.children.push(node)
    this.reopen(closed)
  }

  private anchor(el: Element, ctx: Ctx): void {
    const href = el.attribs.href?.trim()
    const target = href && !this.inLink() ? this.linkFields(href) : undefined
    if (!target) return this.children(el, ctx)
    this.ensureInline()
    const depth = this.stack.length
    this.push(n.link(target.fields), false, target.issue)
    this.children(el, ctx)
    this.popTo(depth)
  }

  private linkFields(href: string): { fields: n.LinkFields; issue?: LexicalIssue } | undefined {
    const url = href.replace(/ /g, '%20')
    if (!allowedScheme(url, LINK_SCHEMES)) {
      this.warn('LEXICAL_FALLBACK', `link with a disallowed scheme kept as text: ${clip(url)}`)
      return undefined
    }
    const fields: n.LinkFields = { linkType: 'custom', newTab: false, url }
    if (url.startsWith('#')) return { fields }
    const doc = this.opts.resolver.doc(url)
    if (doc) return { fields: { linkType: 'internal', newTab: false, doc: { relationTo: doc.relationTo, value: doc.value } } }
    if (!this.isOldSite(url)) {
      const rel = this.opts.externalLinkRel
      return { fields: rel && /^https?:\/\//i.test(url) ? { ...fields, rel } : fields }
    }
    const media = this.opts.resolver.media(url) !== undefined
    return { fields, issue: { code: 'LINK_NOT_MIGRATED', detail: media ? `${url} (file was migrated as media)` : url } }
  }

  private isOldSite(url: string): boolean {
    if (this.opts.resolver.isOldSite) return this.opts.resolver.isOldSite(url)
    return !SCHEME.test(url) && !url.startsWith('//')
  }

  private image(el: Element, ctx: Ctx): void {
    const src = el.attribs.src?.trim()
    const label = el.attribs.alt?.trim() || el.attribs.title?.trim() || ''
    if (!src || !allowedScheme(src, IMAGE_SCHEMES)) {
      this.warn('CONTENT_DROPPED', `image without a usable src removed${src ? `: ${clip(src)}` : ''}`)
      if (label) this.appendText(label, ctx)
      return
    }
    const link = this.inLink()
    const id = this.opts.resolver.media(src)
    if (id !== undefined) {
      const fields = link?.node.type === 'link' ? link.node.fields : undefined
      if (fields && !(fields.linkType === 'custom' && this.opts.resolver.media(fields.url) !== undefined)) {
        const target = fields.linkType === 'custom' ? fields.url : `${fields.doc.relationTo}:${fields.doc.value}`
        this.warn('LEXICAL_FALLBACK', `link around image not kept on the upload: ${clip(target)}`)
      }
      return this.decorator(n.upload(this.nextId(), this.opts.mediaCollection, id))
    }
    this.warn('MEDIA_NOT_MIGRATED', src)
    const text = label || fileName(src)
    if (link) return this.appendText(text, ctx)
    this.ensureInline()
    const depth = this.stack.length
    this.push(n.link({ linkType: 'custom', newTab: false, url: src.replace(/ /g, '%20') }))
    this.appendText(text, ctx)
    this.popTo(depth)
  }

  private embed(el: Element): void {
    const url = el.attribs['data-url']?.trim()
    if (!url) return
    const host = hostOf(url)
    if (this.opts.blocks.embed && host) {
      return this.decorator(n.block(this.nextId(), { blockType: this.opts.blocks.embed, url, host }))
    }
    this.warn('LEXICAL_FALLBACK', `embed kept as a link: ${clip(url)}`)
    const closed = this.closeUntil((f) => f.node.type === 'root')
    this.push(n.paragraph())
    if (allowedScheme(url, LINK_SCHEMES)) this.push(n.link({ linkType: 'custom', newTab: false, url: url.replace(/ /g, '%20') }))
    this.appendText(url, { fmt: 0, pre: false, depth: 0 })
    this.popTo(1)
    this.reopen(closed)
  }

  private table(el: Element, ctx: Ctx): void {
    if (this.opts.blocks.wpRawHtml) {
      const html = serialize(el, {
        img: (src) => {
          if (src && this.opts.resolver.media(src) !== undefined) this.warn('LEXICAL_FALLBACK', `image inside a table removed: ${clip(src)}`)
          else this.warn('MEDIA_NOT_MIGRATED', src || 'image without src inside a table')
        },
        dropped: (name) => this.warn('CONTENT_DROPPED', `<${name}> element removed`),
        embed: (url) => this.warn('LEXICAL_FALLBACK', `embed inside a table kept as a link: ${clip(url)}`),
        link: (href) => {
          if (!allowedScheme(href, LINK_SCHEMES)) {
            this.warn('LEXICAL_FALLBACK', `link with a disallowed scheme kept as text: ${clip(href)}`)
            return false
          }
          if (!href.startsWith('#') && this.isOldSite(href)) this.warn('LINK_NOT_MIGRATED', href)
          return true
        },
      })
      return this.decorator(n.block(this.nextId(), { blockType: this.opts.blocks.wpRawHtml, html }))
    }
    this.warn('LEXICAL_FALLBACK', 'table flattened to one paragraph per row')
    this.tableRows(el, ctx)
  }

  private tableRows(el: Element, ctx: Ctx): void {
    for (const child of el.children) {
      if (!isTag(child)) continue
      if (child.name === 'tr' || child.name === 'caption') this.row(child, ctx)
      else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot') this.tableRows(child, ctx)
      else this.walk(child, ctx)
    }
  }

  private row(tr: Element, ctx: Ctx): void {
    const closed = this.closeUntil((f) => f.node.type === 'root')
    this.push(n.paragraph())
    let cells = 0
    for (const cell of tr.children) {
      if (isTag(cell) && (cell.name === 'td' || cell.name === 'th')) {
        if (cells++ > 0) this.appendInline(n.text(' | ', 0))
        this.children(cell, cell.name === 'th' ? { ...ctx, fmt: ctx.fmt | n.FORMAT.bold } : ctx)
      } else this.walk(cell, ctx)
    }
    this.popTo(1)
    this.reopen(closed)
  }

  private nextId(): string {
    // Deterministic per document, so a re-run writes identical JSON.
    return createHash('sha1').update(`${this.opts.doc}\0${this.ids++}`).digest('hex').slice(0, 24)
  }

  private warn(code: LexicalIssue['code'], detail: string): void {
    const key = `${code}\0${detail}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.warnings.push({ code, detail })
  }
}

function continuation(node: n.ElementNode): n.ElementNode {
  switch (node.type) {
    case 'heading':
      return n.heading(node.tag)
    case 'quote':
      return n.quote()
    case 'list':
      numberItems(node)
      return n.list(node.listType, node.listType === 'number' ? nextValue(node) : 1)
    case 'listitem':
      return n.listItem()
    case 'link':
      return n.link(node.fields)
    default:
      return n.paragraph()
  }
}

const isHolder = (item: n.LexicalNode) => item.type === 'listitem' && item.children[0]?.type === 'list'

function numberItems(list: n.ListNode): void {
  let value = list.start
  for (const item of list.children) {
    if (item.type !== 'listitem') continue
    item.value = value
    if (!isHolder(item)) value++
  }
}

function nextValue(list: n.ListNode): number {
  const last = [...list.children].reverse().find((c) => c.type === 'listitem' && !isHolder(c))
  return last?.type === 'listitem' ? last.value + 1 : list.start
}

function lastLeaf(node: n.ElementNode): n.TextNode | n.LineBreakNode | undefined {
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i]!
    if (child.type === 'text' || child.type === 'linebreak') return child
    if (child.type !== 'link') return undefined
    const leaf = lastLeaf(child)
    if (leaf) return leaf
  }
  return undefined
}

function trimEnd(node: n.ElementNode): void {
  const children = node.children
  for (;;) {
    const last = children[children.length - 1]
    if (last?.type === 'text') {
      let end = last.text.length
      while (end > 0 && last.text.charCodeAt(end - 1) === 32) end--
      last.text = last.text.slice(0, end)
      if (last.text) return
      children.pop()
    } else if (last?.type === 'link') {
      trimEnd(last)
      if (last.children.length > 0) return
      children.pop()
    } else return
  }
}

function trimBreaks(node: n.ElementNode): void {
  while (node.children[node.children.length - 1]?.type === 'linebreak') node.children.pop()
}

function allowedScheme(url: string, schemes: ReadonlySet<string>): boolean {
  // Control characters and spaces are ignored by browsers inside a scheme ("java\tscript:").
  const scheme = SCHEME.exec(url.replace(/[\u0000- ]/g, ''))?.[1]
  return scheme === undefined || schemes.has(scheme.toLowerCase())
}

function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname : undefined
  } catch {
    return undefined
  }
}

function fileName(src: string): string {
  const path = src.split(/[?#]/)[0] ?? ''
  const base = path.slice(path.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(base) || src
  } catch {
    return base || src
  }
}

/** Iterative text content, safe on arbitrarily deep trees. */
function textOf(root: Element): string {
  let out = ''
  const todo: ChildNode[] = [...root.children].reverse()
  while (todo.length > 0) {
    const node = todo.pop()!
    if (isText(node)) out += node.data
    else if (isTag(node)) for (let i = node.children.length - 1; i >= 0; i--) todo.push(node.children[i]!)
  }
  return out
}

const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}...` : s)
