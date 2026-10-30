import { isTag, isText, type AnyNode } from 'domhandler'
import { parseDocument } from 'htmlparser2'
import { markupLimit } from './depth.js'

// Short fields to plain text (doc 12.4, threat T2): titles, excerpts, alt text, captions, SEO.

/** Contents never shown as text. */
const SKIP = new Set(['script', 'style', 'template', 'head'])

/** Elements the HTML tokenizer reads as raw text up to their end tag (or the end of input). */
const RAW_TEXT = /<(\/?)(textarea|title|xmp|iframe|noembed|noframes|plaintext)(?=[\s/>]|$)/gi
const SCRIPT_STYLE = /<(script|style)(?=[\s/>]|$)/gi

/**
 * A tag-like word in a short field must not swallow the rest of it: `Using <textarea> in forms`.
 * Raw-text elements are renamed to an ordinary unknown element, so their tags are stripped and
 * their text kept. A script or style is dropped with its content only when it has an end tag;
 * an unclosed one is renamed the same way.
 */
function neutraliseRawText(s: string): string {
  const lower = s.toLowerCase()
  const lastClose = { script: lower.lastIndexOf('</script'), style: lower.lastIndexOf('</style') }
  return s
    .replace(SCRIPT_STYLE, (m, name: string, at: number) =>
      at > lastClose[name.toLowerCase() as 'script' | 'style'] ? `<x-wp2p-${name}` : m)
    .replace(RAW_TEXT, (_, slash: string, name: string) => `<${slash}x-wp2p-${name}`)
}
/** Elements that separate words when rendered. */
const BREAK = new Set([
  'br', 'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr',
  'tr', 'td', 'th', 'table', 'figure', 'figcaption', 'section', 'article', 'header', 'footer', 'dt', 'dd',
])
// C0/C1 controls except tab, LF, CR (those collapse to a space below).
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/**
 * For text that is already plain (IR titles and SEO fields: extractors decode them): removes
 * control characters and collapses whitespace, and decodes nothing. Decoding again would turn a
 * literal `&lt;b&gt;` in a title into a tag and strip it.
 */
export function normalisePlain(s: string): string {
  return s.replace(CONTROLS, '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
}

// Bidi controls and zero-width characters: invisible, and used to disguise text.
const INVISIBLE = /[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/**
 * Removes all markup, decodes character references exactly once (`&amp;lt;` becomes `&lt;`),
 * collapses whitespace and trims. The result is text, not HTML: render it escaped.
 */
export function toPlainText(s: string): string {
  // Hostile nesting: strip tag-shaped runs first so the parser sees flat text (linear).
  const input = markupLimit(s) ? s.replace(/<[^<>]*>/g, ' ') : s
  const dom = parseDocument(neutraliseRawText(input))
  let out = ''
  const stack: (AnyNode | ' ')[] = [dom]
  while (stack.length) {
    const n = stack.pop()!
    if (n === ' ') {
      out += ' '
      continue
    }
    if (isText(n)) {
      out += n.data
      continue
    }
    if (isTag(n)) {
      if (SKIP.has(n.name)) continue
      if (BREAK.has(n.name)) {
        out += ' '
        stack.push(' ')
      }
    }
    if ('children' in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!)
  }
  return out.replace(CONTROLS, '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
}
