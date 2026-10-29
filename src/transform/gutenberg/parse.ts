import { Tokenizer, type TokenizerCallbacks } from 'htmlparser2'
import type { ParsedBlock } from '../types.js'

// In-house Gutenberg block-comment parser (the official one is GPL-2.0; wp2payload is MIT).
// One left-to-right pass, an explicit stack, no recursion. Never throws on bad input.

export const MAX_BLOCK_DEPTH = 64

export interface ParseIssue {
  code: 'BLOCK_ATTRS_INVALID' | 'BLOCK_UNCLOSED' | 'BLOCK_CLOSER_STRAY' | 'BLOCK_CLOSER_MISMATCH' | 'BLOCK_DEPTH_EXCEEDED'
  detail: string
}

interface Delimiter {
  kind: 'open' | 'void' | 'close'
  name: string
  attrs: Record<string, unknown>
  badAttrs: boolean
}

interface Frame {
  block: ParsedBlock
  openStart: number
  textStart: number
}

const NAME = /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?$/

/** Reads the text between `<!--` and `-->`. Returns null when it is not a block delimiter. */
function readDelimiter(body: string): Delimiter | null {
  if (!/^\s/.test(body)) return null
  let s = body.trim()
  let kind: Delimiter['kind'] = 'open'
  if (s.startsWith('/wp:')) {
    kind = 'close'
    s = s.slice(4)
  } else if (s.startsWith('wp:')) s = s.slice(3)
  else return null

  const ws = s.search(/\s/)
  let name = ws < 0 ? s : s.slice(0, ws)
  let rest = ws < 0 ? '' : s.slice(ws).trim()
  if (ws < 0 && name.endsWith('/')) {
    name = name.slice(0, -1)
    rest = '/'
  }
  if (rest.endsWith('/')) {
    if (kind === 'close') return null
    kind = 'void'
    rest = rest.slice(0, -1).trimEnd()
  }
  if (!NAME.test(name)) return null
  if (!name.includes('/')) name = `core/${name}`
  if (kind === 'close') return rest === '' ? { kind, name, attrs: {}, badAttrs: false } : null
  if (rest === '') return { kind, name, attrs: {}, badAttrs: false }
  if (!rest.startsWith('{') || !rest.endsWith('}')) return null
  try {
    const v: unknown = JSON.parse(rest)
    if (v && typeof v === 'object' && !Array.isArray(v)) return { kind, name, attrs: v as Record<string, unknown>, badAttrs: false }
  } catch {
    // fall through
  }
  return { kind, name, attrs: {}, badAttrs: true }
}

const noop = () => {}

/**
 * `[open, bodyStart, bodyEnd]` of every real `<!-- ... -->` comment, as htmlparser2's tokenizer
 * (linear; the security pre-scan uses the same one) sees it. Delimiter-shaped text inside
 * attribute values or raw-text elements (script, style, textarea, title, xmp...) is not a comment,
 * so it cannot split blocks behind the scanner's back. No foreign-content (svg/math) tracking:
 * that only makes us see fewer comments than the Parser, never more.
 */
export function realComments(html: string): number[] {
  const out: number[] = []
  const cbs: TokenizerCallbacks = {
    oncomment(start, endIndex) {
      const open = start - 4
      if (html.startsWith('<!--', open) && endIndex - 2 >= start && html.startsWith('-->', endIndex - 2)) out.push(open, start, endIndex - 2)
    },
    onattribdata: noop, onattribentity: noop, onattribend: noop, onattribname: noop, oncdata: noop, onclosetag: noop,
    ondeclaration: noop, onend: noop, onopentagend: noop, onopentagname: noop, onprocessinginstruction: noop,
    onselfclosingtag: noop, ontext: noop, ontextentity: noop,
  }
  try {
    const t = new Tokenizer({}, cbs)
    t.write(html)
    t.end()
  } catch {
    return [] // treat everything as freeform rather than guess
  }
  return out
}

const newBlock = (name: string, attrs: Record<string, unknown>): ParsedBlock => ({
  name,
  attrs,
  innerHTML: '',
  innerBlocks: [],
  innerContent: [],
})

/**
 * Parses post_content into a block tree. HTML outside any block becomes `core/freeform`
 * (whitespace-only runs are skipped). Malformed attrs become `{}`; unclosed blocks close at the
 * end of input; stray closers stay as text; past MAX_BLOCK_DEPTH the rest is raw HTML of the
 * deepest block. Each kind of problem is reported once with a count.
 */
export function parseBlocks(html: string, report?: (issue: ParseIssue) => void): ParsedBlock[] {
  const out: ParsedBlock[] = []
  const stack: Frame[] = []
  const issues = new Map<ParseIssue['code'], { count: number; first: string }>()
  const note = (code: ParseIssue['code'], first: string) => {
    const i = issues.get(code)
    if (i) i.count++
    else issues.set(code, { count: 1, first })
  }

  let topText = 0
  let overflow = 0

  const flushFreeform = (from: number, to: number) => {
    const t = html.slice(from, to)
    if (t.trim()) out.push({ ...newBlock('core/freeform', {}), innerHTML: t, innerContent: [t] })
  }
  const pushText = (f: Frame, to: number) => {
    if (to > f.textStart) f.block.innerContent.push(html.slice(f.textStart, to))
  }
  const addBlock = (block: ParsedBlock, start: number, end: number) => {
    const parent = stack[stack.length - 1]
    if (!parent) {
      flushFreeform(topText, start)
      out.push(block)
      topText = end
      return
    }
    pushText(parent, start)
    parent.block.innerBlocks.push(block)
    parent.block.innerContent.push(null)
    parent.textStart = end
  }
  const closeTop = (at: number, end: number) => {
    const f = stack.pop()
    if (!f) return
    pushText(f, at)
    f.block.innerHTML = f.block.innerContent.filter((c): c is string => c !== null).join('')
    addBlock(f.block, f.openStart, end)
  }

  const comments = realComments(html)
  for (let c = 0; c + 2 < comments.length; c += 3) {
    const open = comments[c] as number
    const bodyEnd = comments[c + 2] as number
    const end = bodyEnd + 3
    const d = readDelimiter(html.slice(comments[c + 1] as number, bodyEnd))
    if (!d) continue

    if (d.badAttrs) note('BLOCK_ATTRS_INVALID', `${d.name} at offset ${open}`)
    if (d.kind === 'close') {
      if (overflow > 0) {
        overflow--
        continue
      }
      let i = stack.length - 1
      while (i >= 0 && stack[i]?.block.name !== d.name) i--
      if (i < 0) {
        note('BLOCK_CLOSER_STRAY', `${d.name} at offset ${open}`)
        continue
      }
      if (i < stack.length - 1) note('BLOCK_CLOSER_MISMATCH', `${d.name} at offset ${open} closed inner blocks implicitly`)
      while (stack.length - 1 > i) closeTop(open, open)
      closeTop(open, end)
      continue
    }
    if (overflow > 0 || stack.length >= MAX_BLOCK_DEPTH) {
      if (d.kind === 'open') overflow++
      note('BLOCK_DEPTH_EXCEEDED', `${d.name} at offset ${open}; kept as raw HTML`)
      continue
    }
    if (d.kind === 'void') addBlock(newBlock(d.name, d.attrs), open, end)
    else stack.push({ block: newBlock(d.name, d.attrs), openStart: open, textStart: end })
  }

  if (stack.length) note('BLOCK_UNCLOSED', `${stack.map((f) => f.block.name).join(' > ')}; closed at end of content`)
  while (stack.length) closeTop(html.length, html.length)
  flushFreeform(topText, html.length)

  if (report) {
    for (const [code, { count, first }] of issues) report({ code, detail: count > 1 ? `${count} times; first: ${first}` : first })
  }
  return out
}
