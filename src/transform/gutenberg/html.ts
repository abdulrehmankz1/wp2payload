import { Tokenizer, type TokenizerCallbacks } from 'htmlparser2'

// Markup helpers over htmlparser2's tokenizer, the same one the security pre-scan sees. Tag
// boundaries respect quoted/unquoted attribute values, comments and raw-text elements, so text
// inside an attribute can never become markup here. Every helper slices the source only at token
// boundaries, and content the tokenizer drops (an unterminated tag at the end) is dropped too.

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export type Token =
  | { type: 'open'; name: string; start: number; end: number; attrs: Map<string, string> }
  | { type: 'close'; name: string; start: number; end: number }
  | { type: 'text'; start: number; end: number; raw: boolean }
  | { type: 'comment'; start: number; end: number }

export interface Markup {
  /** Source up to the end of the last token. */
  src: string
  tokens: Token[]
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext'])
const noop = () => {}

export function tokenize(html: string): Markup {
  const tokens: Token[] = []
  let open: Extract<Token, { type: 'open' }> | undefined
  let attrName = ''
  let valStart = -1
  let valEnd = -1
  let raw: string | undefined
  const endOpen = (endIndex: number) => {
    if (!open) return
    open.end = endIndex + 1
    tokens.push(open)
    if (RAW_TEXT.has(open.name)) raw = open.name
    open = undefined
  }
  const cbs: TokenizerCallbacks = {
    onopentagname(start, endIndex) {
      open = { type: 'open', name: html.slice(start, endIndex).toLowerCase(), start: start - 1, end: -1, attrs: new Map() }
    },
    onattribname(start, endIndex) {
      attrName = html.slice(start, endIndex).toLowerCase()
      valStart = valEnd = -1
    },
    onattribdata(start, endIndex) {
      if (valStart < 0) valStart = start
      valEnd = endIndex
    },
    onattribend() {
      if (open && !open.attrs.has(attrName)) open.attrs.set(attrName, valStart < 0 ? '' : html.slice(valStart, valEnd))
    },
    onopentagend: endOpen,
    onselfclosingtag: endOpen,
    onclosetag(start, endIndex) {
      const name = html.slice(start, endIndex).toLowerCase()
      const gt = html.indexOf('>', endIndex)
      tokens.push({ type: 'close', name, start: Math.max(0, html.lastIndexOf('</', start)), end: gt < 0 ? html.length : gt + 1 })
      if (raw === name) raw = undefined
    },
    ontext(start, endIndex) {
      const last = tokens[tokens.length - 1]
      if (last?.type === 'text' && last.end === start) last.end = endIndex
      else tokens.push({ type: 'text', start, end: endIndex, raw: raw !== undefined })
    },
    oncomment(start, endIndex) {
      const lt = html.lastIndexOf('<', start - 1)
      tokens.push({ type: 'comment', start: lt < 0 ? start : lt, end: html.charAt(endIndex) === '>' ? endIndex + 1 : endIndex })
    },
    oncdata(start, endIndex, endOffset) {
      cbs.oncomment(start, endIndex, endOffset)
    },
    ondeclaration(start, endIndex) {
      tokens.push({ type: 'comment', start: Math.max(0, html.lastIndexOf('<', start - 1)), end: endIndex + 1 })
    },
    onprocessinginstruction(start, endIndex) {
      cbs.ondeclaration(start, endIndex)
    },
    onattribentity: noop,
    ontextentity: noop,
    onend: noop,
  }
  try {
    const t = new Tokenizer({ decodeEntities: false }, cbs)
    t.write(html)
    t.end()
  } catch {
    return { src: '', tokens: [] }
  }
  const last = tokens[tokens.length - 1]
  return { src: html.slice(0, last ? last.end : 0), tokens }
}

/** Index of the first open tag named one of `names` at or after token `from`, else -1. */
export function findOpen(m: Markup, names: string | readonly string[], from = 0): number {
  for (let i = from; i < m.tokens.length; i++) {
    const t = m.tokens[i] as Token
    if (t.type === 'open' && (typeof names === 'string' ? t.name === names : names.includes(t.name))) return i
  }
  return -1
}

function findClose(m: Markup, name: string, from: number): number {
  for (let i = from; i < m.tokens.length; i++) {
    const t = m.tokens[i] as Token
    if (t.type === 'close' && t.name === name) return i
  }
  return -1
}

function lastClose(m: Markup, name: string, after: number): number {
  for (let i = m.tokens.length - 1; i > after; i--) {
    const t = m.tokens[i] as Token
    if (t.type === 'close' && t.name === name) return i
  }
  return -1
}

/** Raw (still entity-encoded) attribute value, safe inside double quotes. */
export function attr(m: Markup, index: number, name: string): string | undefined {
  const t = m.tokens[index]
  const v = t?.type === 'open' ? t.attrs.get(name) : undefined
  return v === undefined ? undefined : v.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Source between token `from` (inclusive) and token `to` (exclusive). */
export const between = (m: Markup, from: number, to: number): string =>
  m.src.slice(m.tokens[from]?.start ?? m.src.length, m.tokens[to]?.start ?? m.src.length)

/** Content of the first `<name>...</name>`, or undefined. */
export function innerOf(html: string | Markup, name: string, from = 0): string | undefined {
  const m = typeof html === 'string' ? tokenize(html) : html
  const i = findOpen(m, name, from)
  if (i < 0) return undefined
  const j = findClose(m, name, i + 1)
  return between(m, i + 1, j < 0 ? m.tokens.length : j)
}

/** From the first `<name` to the end of the last `</name>`, or undefined. */
export function outerOf(html: string, name: string): string | undefined {
  const m = tokenize(html)
  const i = findOpen(m, name)
  if (i < 0) return undefined
  const j = lastClose(m, name, i)
  return j < 0 ? `${between(m, i, m.tokens.length)}</${name}>` : between(m, i, j + 1)
}

const firstTag = (m: Markup): number => m.tokens.findIndex((t) => t.type !== 'text' || m.src.slice(t.start, t.end).trim() !== '')

/** Name of the element wrapping html, if it is one of `names`. */
export function wrapper(html: string, names: readonly string[]): string | undefined {
  const m = tokenize(html)
  const t = m.tokens[firstTag(m)]
  return t?.type === 'open' && names.includes(t.name) ? t.name : undefined
}

/** Strips one wrapping element (any of `names`); returns the html trimmed if none. */
export function unwrap(html: string, names: readonly string[]): string {
  const m = tokenize(html)
  const i = firstTag(m)
  const t = m.tokens[i]
  if (t?.type !== 'open' || !names.includes(t.name)) return m.src.trim()
  const j = lastClose(m, t.name, i)
  return between(m, i + 1, j < 0 ? m.tokens.length : j).trim()
}

/** Visible-ish text of the non-raw text tokens, joined by spaces. */
export const textOf = (m: Markup): string =>
  m.tokens.filter((t) => t.type === 'text' && !t.raw).map((t) => m.src.slice(t.start, t.end)).join(' ')
