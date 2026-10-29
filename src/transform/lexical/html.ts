import { isTag, isText, type ChildNode, type Element } from 'domhandler'

// Re-serializes a sanitized subtree for the wpRawHtml block. Only the sanitizer's tag and attribute
// allowlist is written back, so this never widens what the sanitizer let through.
const TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'b', 'i', 'u', 's', 'sub', 'sup',
  'blockquote', 'code', 'pre', 'br', 'hr', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'th', 'td', 'caption',
])
const VOID = new Set(['br', 'hr'])
const ATTRS: Record<string, readonly string[]> = {
  a: ['href', 'title', 'rel'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
}

// Never content: skipped with their text (the converter reports them).
export const DROP = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'head', 'title', 'textarea', 'select'])

export interface SerializeHooks {
  /** Images are never written (no hotlinks to the old site); alt text is kept. */
  img(src: string): void
  /** `<wp2p-embed>` is written as a plain link to its URL. */
  embed(url: string): void
  /** Return false to drop the href (the link text stays). */
  link(href: string): boolean
  dropped(name: string): void
}

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;')

/** Iterative, so hostile nesting depth cannot overflow the stack. */
export function serialize(root: Element, hooks: SerializeHooks): string {
  let out = ''
  // A string is a closing tag to emit; a node is still to visit.
  const todo: (ChildNode | string)[] = [root]
  const visit = (el: Element, close: string | undefined) => {
    if (close !== undefined) todo.push(close)
    for (let i = el.children.length - 1; i >= 0; i--) todo.push(el.children[i]!)
  }
  while (todo.length > 0) {
    const node = todo.pop()!
    if (typeof node === 'string') {
      out += node
      continue
    }
    if (isText(node)) {
      out += escapeText(node.data)
      continue
    }
    if (!isTag(node)) continue
    const name = node.name
    if (name === 'img') {
      hooks.img(node.attribs.src?.trim() ?? '')
      const alt = node.attribs.alt?.trim()
      if (alt) out += escapeText(alt)
      continue
    }
    if (name === 'wp2p-embed') {
      const url = node.attribs['data-url']?.trim()
      if (url && /^https:\/\//i.test(url)) {
        hooks.embed(url)
        out += `<a href="${escapeAttr(url)}">${escapeText(url)}</a>`
      }
      visit(node, undefined)
      continue
    }
    if (DROP.has(name)) {
      hooks.dropped(name)
      continue
    }
    if (!TAGS.has(name)) {
      visit(node, undefined)
      continue
    }
    let attrs = ''
    for (const key of ATTRS[name] ?? []) {
      const value = node.attribs[key]
      if (value === undefined) continue
      if (key === 'href' && !hooks.link(value.trim())) continue
      attrs += ` ${key}="${escapeAttr(value)}"`
    }
    out += `<${name}${attrs}>`
    if (!VOID.has(name)) visit(node, `</${name}>`)
  }
  return out
}
