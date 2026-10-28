// Small built-in HTML entity decoder for short text fields (title, excerpt, alt, caption).
// Long HTML content is never touched here: sanitizing is a later transformer.

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×',
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        return whole
      }
      return String.fromCodePoint(code)
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

/** Strip tags, decode entities, collapse whitespace: HTML snippet to plain text. */
export function toPlainText(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}
