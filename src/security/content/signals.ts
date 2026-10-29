import { BASE64_RUN, SPAM_KEYWORDS } from './policy.js'

// Pure detectors for the doc 12.5 signals. Inputs are attribute values and text as the HTML
// parser delivers them, i.e. with character references already decoded once.

/** Attributes a browser may load or navigate to. Checked for dangerous schemes. */
export const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster', 'cite', 'data',
  'srcset', 'lowsrc', 'dynsrc', 'longdesc', 'ping', 'codebase', 'archive', 'manifest', 'icon',
  'profile', 'usemap', 'classid', 'to', 'from', 'values', 'by',
])

// Whitespace, C0/C1 controls and invisible separators a browser ignores inside a scheme.
const SCHEME_NOISE = /[\u0000-\u0020\u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g
const DANGEROUS_SCHEME = /^(javascript|vbscript|livescript|mocha|data):/

/** The dangerous scheme (`javascript`, `vbscript`, `data`...) a URL value starts with, if any. */
export function dangerousScheme(value: string): string | undefined {
  // srcset / SMIL values carry several URLs; check each candidate.
  for (const part of value.split(/[,;]/)) {
    const m = DANGEROUS_SCHEME.exec(part.replace(SCHEME_NOISE, '').toLowerCase())
    if (m) return m[1]
  }
  return undefined
}

const REDIRECT =
  /\blocation\s*(?:\.\s*href\s*)?=(?!=)|\blocation\s*\[\s*['"]href['"]\s*\]\s*=(?!=)|\blocation\s*\.\s*(?:replace|assign)\s*\(|\b(?:window|document|top|self|parent)\s*\.\s*navigate\s*\(/i

/** Script text or an event handler that navigates the page (T4). */
export function isJsRedirect(code: string): boolean {
  return REDIRECT.test(code)
}


// Strong signals only: these never occur in ordinary prose, so they are safe to act on in text.
const STRONG: readonly [RegExp, string][] = [
  [new RegExp(`[A-Za-z0-9+/]{${BASE64_RUN},}`), `base64 run of ${BASE64_RUN}+ chars`],
  [/(?:\\x[0-9a-f]{2}){8,}/i, 'hex escapes'],
  [/(?:\\u[0-9a-f]{4}){8,}/i, 'unicode escapes'],
  [/\beval\s*\(\s*(?:atob|unescape|decodeURIComponent|String\s*\.\s*fromCharCode)\b/i, 'eval of a decoded string'],
  [/\bdocument\s*\.\s*write\s*\(\s*(?:atob|unescape|decodeURIComponent|String\s*\.\s*fromCharCode)\b/i, 'document.write of a decoded string'],
]
// Function-name heuristics: fine in attribute values, too noisy for prose ("never call eval()").
const WEAK: readonly [RegExp, string][] = [
  [/\beval\s*\(/i, 'eval('],
  [/\batob\s*\(/i, 'atob('],
  [/\bString\s*\.\s*fromCharCode\b/i, 'String.fromCharCode'],
  [/\bunescape\s*\(/i, 'unescape('],
  [/\bdocument\s*\.\s*write\s*\(/i, 'document.write('],
]

/**
 * Why a value looks like an obfuscated payload, if it does. Text nodes are judged on strong
 * signals only; attribute values also on function names.
 */
export function obfuscationReason(value: string, context: 'text' | 'attribute' = 'attribute'): string | undefined {
  if (value.length < 8) return undefined
  for (const [re, why] of STRONG) if (re.test(value)) return why
  if (context === 'attribute') for (const [re, why] of WEAK) if (re.test(value)) return why
  return undefined
}

/** Drops CSS comments and decodes escapes, so `d\69splay:/**\/none` reads as `display:none`. Linear. */
function normaliseCss(css: string): string {
  let noComments = ''
  let pos = 0
  for (;;) {
    const open = css.indexOf('/*', pos)
    if (open < 0) {
      noComments += css.slice(pos)
      break
    }
    noComments += css.slice(pos, open)
    const close = css.indexOf('*/', open + 2)
    if (close < 0) break // unterminated comment runs to the end
    pos = close + 2
  }
  return noComments
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex: string) => {
      const cp = Number.parseInt(hex, 16)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
    .replace(/\\(.)/g, '$1')
    .toLowerCase()
}

function declarations(css: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim()
    const value = decl.slice(i + 1).replace(/!\s*important/g, '').replace(/\s+/g, ' ').trim()
    if (prop) out.set(prop, value)
  }
  return out
}

/** A length in px (em/rem as 16px, pt as 4/3px), or `%` kept as its own unit. Else undefined. */
function length(value: string | undefined): { n: number; pct: boolean } | undefined {
  if (value === undefined || value.length > 32) return undefined
  const m = /^(-?(?:\d+\.?\d*|\.\d+))(px|em|rem|pt|%)?$/.exec(value)
  if (!m) return undefined
  const n = Number(m[1])
  const unit = m[2]
  if (unit === '%') return { n, pct: true }
  return { n: unit === 'em' || unit === 'rem' ? n * 16 : unit === 'pt' ? n * (4 / 3) : n, pct: false }
}
const px = (value: string | undefined) => {
  const l = length(value)
  return l && !l.pct ? l.n : undefined
}

/** Positional offsets at or past this push content out of view. Margins get more room (layout tricks). */
const OFF_SCREEN_PX = -100
const OFF_SCREEN_MARGIN_PX = -500
const POSITION_PROPS = ['left', 'top', 'right', 'bottom', 'text-indent']
const MARGIN_PROPS = ['margin-left', 'margin-top']

function hiddenDeclReason(d: Map<string, string>): string | undefined {
  if (d.get('display') === 'none') return 'display:none'
  const vis = d.get('visibility')
  if (vis === 'hidden' || vis === 'collapse') return `visibility:${vis}`
  const fs = px(d.get('font-size'))
  if (fs !== undefined && fs <= 1) return 'font-size:0'
  const opacity = d.get('opacity')
  if (opacity !== undefined && opacity.length < 16 && Number(opacity) === 0) return 'opacity:0'
  for (const p of POSITION_PROPS) {
    const l = length(d.get(p))
    if (l && (l.pct ? l.n <= -100 : l.n <= OFF_SCREEN_PX)) return `off-screen ${p}`
  }
  for (const p of MARGIN_PROPS) {
    const v = px(d.get(p))
    if (v !== undefined && v <= OFF_SCREEN_MARGIN_PX) return `off-screen ${p}`
  }
  const transform = d.get('transform') ?? ''
  if (/translate[xy3d]?\(\s*-\d{3,}/.test(transform)) return 'off-screen transform'
  if (/\bscale[xy]?\(\s*(?:0+(?:\.0*)?|\.0+)\s*[,)]/.test(transform)) return 'transform:scale(0)'
  const position = d.get('position')
  const clip = (d.get('clip') ?? '').replace(/px/g, '')
  if ((position === 'absolute' || position === 'fixed') && /^rect\((?:\s*(?:0|1|auto)\s*,?){4}\)$/.test(clip)) return 'clip:rect(0)'
  const clipPath = (d.get('clip-path') ?? '').replace(/\s+/g, '')
  const inset = /^inset\((\d+(?:\.\d+)?)%\)$/.exec(clipPath)
  if ((inset && Number(inset[1]) >= 50) || /^circle\(0(?:px|%)?\)$/.test(clipPath)) return 'clip-path'
  const overflowHidden = (d.get('overflow') ?? d.get('overflow-y') ?? d.get('overflow-x')) === 'hidden'
  if (overflowHidden) {
    for (const p of ['height', 'max-height', 'width', 'max-width']) {
      const v = px(d.get(p))
      if (v !== undefined && v <= 1) return `${p}:${v} overflow:hidden`
    }
  }
  const color = d.get('color')
  const bg = d.get('background-color') ?? d.get('background')
  if (color && bg && color === bg) return 'text colour equals background'
  return undefined
}

/** Why an inline style hides its element (T3), if it does. */
export function hiddenStyleReason(style: string): string | undefined {
  return hiddenDeclReason(declarations(normaliseCss(style)))
}

export interface HiddenSelectors {
  classes: Map<string, string>
  ids: Map<string, string>
}

/**
 * Class and id selectors that a `<style>` element in the content hides. Only simple selectors
 * (`.x`, `#x`, `div.x`) are understood; anything fancier is left to the allowlist. Rules nested
 * in at-rules (`@media { .x {} }`) count too. A single linear brace scan, no regex backtracking.
 */
export function hiddenSelectors(css: string, into: HiddenSelectors): void {
  const text = normaliseCss(css)
  let selStart = 0
  let pos = 0
  for (;;) {
    const open = text.indexOf('{', pos)
    if (open < 0) return
    const nextOpen = text.indexOf('{', open + 1)
    const close = text.indexOf('}', open + 1)
    if (close < 0) return
    if (nextOpen >= 0 && nextOpen < close) {
      // An at-rule block: its body starts a new selector.
      selStart = open + 1
      pos = open + 1
      continue
    }
    const selector = text.slice(selStart, open).replace(/^[\s}]+/, '')
    const reason = hiddenDeclReason(declarations(text.slice(open + 1, close)))
    if (reason) {
      for (const sel of selector.split(',')) {
        const s = /^[a-z0-9-]*([.#])([a-z0-9_-]+)$/.exec(sel.trim())
        if (!s) continue
        ;(s[1] === '.' ? into.classes : into.ids).set(s[2] ?? '', `stylesheet ${s[1]}${s[2]} ${reason}`)
      }
    }
    selStart = close + 1
    pos = close + 1
  }
}

const SPAM = SPAM_KEYWORDS.map((k) => ({
  keyword: k,
  re: new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}(?:e?s)?\\b`, 'i'),
}))

/** Spam keywords present in a link's visible text. */
export function spamKeywords(text: string): string[] {
  return SPAM.filter((s) => s.re.test(text)).map((s) => s.keyword)
}

function hostKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

/** The site's host for internal/external decisions. www and non-www count as the same site. */
export function siteHostKey(siteOrigin: string): string | undefined {
  try {
    return hostKey(new URL(siteOrigin).host)
  } catch {
    return undefined
  }
}

/** True for an absolute http(s) link to another host than the site's. Relative links are internal. */
export function isExternalUrl(href: string, siteKey: string | undefined): boolean {
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  return hostKey(u.host) !== siteKey
}

/**
 * The canonical embed URL for an iframe src: https, no credentials, host exactly in `hosts`
 * (case-insensitive, port included). Anything else is not embeddable.
 */
export function embedUrl(src: string | undefined, hosts: readonly string[]): string | undefined {
  if (!src) return undefined
  let u: URL
  try {
    u = new URL(src.trim())
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' || u.username || u.password) return undefined
  const host = u.host.toLowerCase()
  return hosts.some((h) => h.toLowerCase() === host) ? u.href : undefined
}
