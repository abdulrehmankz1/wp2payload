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

/**
 * HTML snippet to plain text with the sanitizer's own parser: a regex strip would let an unclosed
 * `<img onerror=...` through, and the IR promises plain text for short fields.
 */
export { toPlainText } from '../../security/content/text.js'

// Bidi controls and zero-width characters: invisible, and used to disguise text.
const BIDI = /[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/**
 * Normalise text that is already decoded (e.g. by htmlparser2): control characters become
 * spaces, whitespace collapses. Entities are left alone, so nothing is decoded twice.
 */
export function normaliseText(input: string): string {
  // Cc: C0, DEL and C1 controls. Zl/Zp: line and paragraph separators.
  return input.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim()
}
