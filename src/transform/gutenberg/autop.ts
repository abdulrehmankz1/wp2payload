import { tokenize, type Token } from './html.js'

// Classic-editor content: `[caption]` unwrapping and wpautop-style paragraphs (behaviour modelled
// on WordPress's wpautop, written from scratch). Both work on tokens: only text outside tags,
// comments and raw-text elements is touched, so attribute values are never split or rewritten.

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'iframe', 'li', 'main', 'nav', 'ol', 'p',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

const isText = (t: Token | undefined): t is Extract<Token, { type: 'text' }> => t?.type === 'text' && !t.raw

/**
 * `[caption ...]<img ...> text[/caption]` becomes its inner content. The opener and closer must each
 * sit inside one text run. Other shortcodes stay as text.
 */
export function unwrapCaptions(html: string): string {
  const m = tokenize(html)
  const cut: [number, number][] = []
  let opened = false
  for (const t of m.tokens) {
    if (!isText(t)) continue
    const s = m.src.slice(t.start, t.end)
    let pos = 0
    for (;;) {
      if (!opened) {
        const open = s.indexOf('[caption', pos)
        if (open < 0) break
        const c = s.charAt(open + 8)
        const close = s.indexOf(']', open)
        if (close < 0) break
        if (c !== ']' && !/\s/.test(c)) {
          pos = open + 8
          continue
        }
        cut.push([t.start + open, t.start + close + 1])
        opened = true
        pos = close + 1
      } else {
        const close = s.indexOf('[/caption]', pos)
        if (close < 0) break
        cut.push([t.start + close, t.start + close + 10])
        opened = false
        pos = close + 10
      }
    }
  }
  if (opened) cut.pop()
  let out = ''
  let pos = 0
  for (const [a, b] of cut) {
    out += m.src.slice(pos, a)
    pos = b
  }
  return out + m.src.slice(pos)
}

type Part = { s: string; kind: 'text' | 'block' | 'other' }

/** Double newlines become paragraphs; block-level elements are left as they are; `<pre>` is untouched. */
export function autop(input: string): string {
  const m = tokenize(input.replace(/\r\n?/g, '\n'))
  const chunks: Part[][] = []
  let cur: Part[] = []
  const flush = () => {
    if (cur.length) chunks.push(cur)
    cur = []
  }

  for (let i = 0; i < m.tokens.length; i++) {
    const t = m.tokens[i] as Token
    const s = m.src.slice(t.start, t.end)
    if (t.type === 'open' && t.name === 'pre') {
      flush()
      let j = i + 1
      for (; j < m.tokens.length; j++) {
        const u = m.tokens[j] as Token
        if (u.type === 'close' && u.name === 'pre') break
      }
      chunks.push([{ s: m.src.slice(t.start, m.tokens[j]?.end ?? m.src.length), kind: 'block' }])
      i = j
    } else if ((t.type === 'open' || t.type === 'close') && BLOCK.has(t.name)) {
      if (t.type === 'open') flush()
      cur.push({ s, kind: 'block' })
      if (t.type === 'close') flush()
    } else if (isText(t)) {
      s.split(/\n\s*\n/).forEach((p, k) => {
        if (k > 0) flush()
        if (p) cur.push({ s: p, kind: 'text' })
      })
    } else cur.push({ s, kind: 'other' })
  }
  flush()

  const out: string[] = []
  for (const parts of chunks) {
    const lead = parts.find((p) => p.kind !== 'text' || p.s.trim())
    if (!lead) continue
    const verbatim = lead.kind === 'block'
    const last = parts.length - 1
    const body = parts
      .map((p, k) => {
        if (p.kind !== 'text') return p.s
        let s = k === 0 ? p.s.trimStart() : p.s
        if (k === last) s = s.trimEnd()
        return verbatim ? s : s.replace(/\n/g, '<br>\n')
      })
      .join('')
    out.push(verbatim ? body : `<p>${body}</p>`)
  }
  return out.join('\n')
}
