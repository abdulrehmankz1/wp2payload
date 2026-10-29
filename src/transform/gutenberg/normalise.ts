import type { Transformer } from '../../config/types.js'
import type { NormalisedBlock, ParsedBlock } from '../types.js'
import { autop, unwrapCaptions } from './autop.js'
import { embedHtml } from './embed.js'
import { attr, between, esc, findOpen, innerOf, outerOf, tokenize, unwrap, wrapper, type Token } from './html.js'
import { isDynamic, looksEmpty } from './dynamic.js'

// Block tree to clean, unsanitized HTML per block (doc 2.3 step 1). The sanitizer runs next.
// All markup is read through html.ts tokens, so attribute text never becomes markup.

export interface NormaliseIssue {
  code: 'TRANSFORMER_FAILED'
  detail: string
}

type Render = (b: ParsedBlock) => string
type Result = string | { html: string; unknown?: true; dynamic?: true }
type Rule = (b: ParsedBlock, render: Render) => Result

const FLATTEN = new Set(['core/group', 'core/columns', 'core/column', 'core/cover', 'core/media-text', 'core/buttons'])
/** Layout tags of a flattened wrapper; whatever else sits in its own innerContent is kept. */
const WRAPPER_TAGS = new Set(['div', 'span', 'section', 'article', 'aside', 'header', 'footer', 'main', 'figure'])
const MEDIA_TAGS = new Set(['img', 'video', 'audio', 'source'])

/** innerContent with each inner block replaced by its normalised HTML. */
function withInner(b: ParsedBlock, render: Render): string {
  let html = ''
  let i = 0
  for (const c of b.innerContent) {
    if (c !== null) html += c
    else {
      const child = b.innerBlocks[i++]
      if (child) html += render(child)
    }
  }
  return html
}

/** `https://x/a-1024x768.jpg?v=1` and `https://x/a-scaled.jpg` both become `https://x/a.jpg`. */
const fileKey = (url: string) =>
  url.split(/[?#]/)[0]?.replace(/-(?:\d+x\d+|scaled)(?=\.[a-z0-9]+$)/i, '').toLowerCase() ?? ''

const isTag = (t: Token | undefined, type: 'open' | 'close', name: string) => t?.type === type && t.name === name

/** One `<figure><img>` from the first img in html (or attrs.url), keeping a custom link around it. */
function image(html: string, attrs: Record<string, unknown> = {}): string {
  const m = tokenize(html)
  const i = findOpen(m, 'img')
  const src = (i >= 0 && attr(m, i, 'src')) || (typeof attrs.url === 'string' ? esc(attrs.url) : '')
  if (!src) return ''
  const alt = i >= 0 ? (attr(m, i, 'alt') ?? '') : typeof attrs.alt === 'string' ? esc(attrs.alt) : ''
  let img = `<img src="${src}" alt="${alt}">`

  if (i >= 0) {
    // The <a> still open at the img, and closed after it.
    let a = -1
    for (let k = 0; k < i; k++) {
      if (isTag(m.tokens[k], 'open', 'a')) a = k
      else if (isTag(m.tokens[k], 'close', 'a')) a = -1
    }
    const closed = a >= 0 && m.tokens.some((t, k) => k > i && isTag(t, 'close', 'a'))
    const href = closed ? attr(m, a, 'href') : undefined
    if (href && attrs.linkDestination !== 'media' && fileKey(href) !== fileKey(src)) img = `<a href="${href}">${img}</a>`
  }
  const caption = innerOf(m, 'figcaption', i + 1)?.trim()
  return `<figure>${img}${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`
}

/** Pre-5.8 gallery markup: `<ul><li><figure><img><figcaption>` per image, no inner blocks. */
function legacyGallery(html: string): string {
  const m = tokenize(html)
  const out: string[] = []
  let cursor = 0
  let li = 0 // cached index of the next `</li>` token; -1 once there is none left
  for (let i = findOpen(m, 'img'); i >= 0; ) {
    const next = findOpen(m, 'img', i + 1)
    if (li >= 0 && li <= i) {
      li = -1
      for (let k = i + 1; k < m.tokens.length; k++) {
        if (isTag(m.tokens[k], 'close', 'li')) {
          li = k
          break
        }
      }
    }
    const end = Math.min(next >= 0 ? next : m.tokens.length, li < 0 ? m.tokens.length : li)
    out.push(image(between(m, cursor, end)))
    cursor = end
    i = next
  }
  return out.join('')
}

/** Modern galleries hold only their own caption in innerHTML; legacy ones put it after the `</ul>`. */
function galleryCaption(b: ParsedBlock): string {
  const m = tokenize(b.innerHTML)
  let from = 0
  if (!b.innerBlocks.length) {
    from = -1
    m.tokens.forEach((t, k) => {
      if (isTag(t, 'close', 'ul')) from = k
    })
    if (from < 0) return ''
  }
  const cap = innerOf(m, 'figcaption', from)?.trim()
  return cap ? `<p>${cap}</p>` : ''
}

/** core/video and core/audio: no editor node for them, so a link to the file, flagged unknown. */
function mediaLink(b: ParsedBlock, tags: readonly string[]): Result {
  const m = tokenize(b.innerHTML)
  let src: string | undefined
  for (const t of [...tags, 'source']) {
    const i = findOpen(m, t)
    src = i >= 0 ? attr(m, i, 'src') : undefined
    if (src) break
  }
  src ||= typeof b.attrs.src === 'string' ? esc(b.attrs.src) : ''
  if (!src) return { html: '', unknown: true }
  const caption = innerOf(m, 'figcaption')?.trim()
  const label = caption || src.split(/[?#]/)[0]?.split('/').pop() || src
  return { html: `<p><a href="${src}">${label}</a></p>`, unknown: true }
}


const paragraph: Rule = (b) => {
  const inner = unwrap(b.innerHTML, ['p'])
  return inner ? `<p>${inner}</p>` : ''
}

const heading: Rule = (b) => {
  const tag = wrapper(b.innerHTML, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
  const lvl = typeof b.attrs.level === 'number' && Number.isInteger(b.attrs.level) && b.attrs.level >= 1 && b.attrs.level <= 6
    ? b.attrs.level
    : tag ? Number(tag[1]) : 2
  const inner = tag ? unwrap(b.innerHTML, [tag]) : tokenize(b.innerHTML).src.trim()
  return inner ? `<h${lvl}>${inner}</h${lvl}>` : ''
}

const list: Rule = (b, render) => {
  const tag = b.attrs.ordered === true || (b.attrs.ordered === undefined && wrapper(b.innerHTML, ['ol'])) ? 'ol' : 'ul'
  const items = b.innerBlocks.length ? b.innerBlocks.map(render).join('') : unwrap(b.innerHTML, ['ul', 'ol'])
  return items ? `<${tag}>${items}</${tag}>` : ''
}

const listItem: Rule = (b, render) => `<li>${unwrap(withInner(b, render), ['li'])}</li>`

const quote: Rule = (b, render) => {
  const inner = unwrap(withInner(b, render), ['blockquote'])
  return inner ? `<blockquote>${inner}</blockquote>` : ''
}

const pullquote: Rule = (b, render) => {
  const html = withInner(b, render)
  const inner = (innerOf(html, 'blockquote') ?? unwrap(html, ['figure'])).trim()
  return inner ? `<blockquote>${inner}</blockquote>` : ''
}

const pre: Rule = (b) => {
  const inner = innerOf(b.innerHTML, 'code') ?? innerOf(b.innerHTML, 'pre') ?? tokenize(b.innerHTML).src
  return inner ? `<pre><code>${inner}</code></pre>` : ''
}

const gallery: Rule = (b, render) => {
  const images = b.innerBlocks.length ? b.innerBlocks.map(render).join('') : legacyGallery(b.innerHTML)
  return images ? images + galleryCaption(b) : ''
}

const table: Rule = (b) => {
  const t = outerOf(b.innerHTML, 'table')
  if (!t) return ''
  const cap = innerOf(b.innerHTML, 'figcaption')?.trim()
  return cap ? `${t}<p>${cap}</p>` : t
}

const file: Rule = (b) => {
  const m = tokenize(b.innerHTML)
  const a = findOpen(m, 'a')
  const href = (a >= 0 && attr(m, a, 'href')) || (typeof b.attrs.href === 'string' ? esc(b.attrs.href) : '')
  if (!href) return ''
  const text = (a >= 0 && innerOf(m, 'a', a)?.trim()) || href.split('/').pop() || href
  return `<p><a href="${href}">${text}</a></p>`
}

const socialLinks: Rule = (b) => {
  const items = b.innerBlocks
    .map((l) => (typeof l.attrs.url === 'string' && l.attrs.url ? `<li><a href="${esc(l.attrs.url)}">${esc(String(l.attrs.label || l.attrs.service || l.attrs.url))}</a></li>` : ''))
    .join('')
  return items ? `<ul>${items}</ul>` : { html: '', dynamic: true }
}

const classic: Rule = (b) => autop(unwrapCaptions(b.innerHTML))

const button: Rule = (b) => {
  const a = outerOf(b.innerHTML, 'a')
  return a ? `<p>${a}</p>` : ''
}

const nothing: Rule = () => ''

const RULES: Record<string, Rule> = {
  'core/paragraph': paragraph,
  'core/heading': heading,
  'core/list': list,
  'core/list-item': listItem,
  'core/image': (b) => image(b.innerHTML, b.attrs),
  'core/quote': quote,
  'core/pullquote': pullquote,
  'core/code': pre,
  'core/preformatted': pre,
  'core/verse': pre,
  'core/gallery': gallery,
  'core/embed': (b) => embedHtml(b),
  'core/separator': () => '<hr>',
  'core/table': table,
  'core/html': (b) => b.innerHTML.trim(),
  'core/freeform': classic,
  'core/shortcode': classic,
  'core/button': button,
  'core/file': file,
  'core/video': (b) => mediaLink(b, ['video']),
  'core/audio': (b) => mediaLink(b, ['audio']),
  'core/social-links': socialLinks,
  'core/more': nothing,
  'core/nextpage': nothing,
  'core/spacer': nothing,
}

/** The wrapper's own image: cover background or media-text media. */
function wrapperMedia(b: ParsedBlock): Result {
  if (b.name === 'core/cover') {
    if (b.attrs.backgroundType === 'video') return mediaLink(b, ['video'])
    return image(b.innerHTML, typeof b.attrs.url === 'string' ? { url: b.attrs.url, alt: b.attrs.alt } : {})
  }
  if (b.name === 'core/media-text') {
    if (b.attrs.mediaType === 'video') return mediaLink(b, ['video'])
    return image(b.innerHTML, typeof b.attrs.mediaUrl === 'string' ? { url: b.attrs.mediaUrl, alt: b.attrs.mediaAlt } : {})
  }
  return ''
}

/** A flattened wrapper's own innerContent piece, minus its layout tags (and its media, already emitted). */
function wrapperText(b: ParsedBlock, piece: string): string {
  const m = tokenize(piece)
  const media = b.name === 'core/cover' || b.name === 'core/media-text'
  let s = ''
  for (const t of m.tokens) {
    if (t.type === 'comment') continue
    if ((t.type === 'open' || t.type === 'close') && (WRAPPER_TAGS.has(t.name) || (media && MEDIA_TAGS.has(t.name)))) continue
    s += m.src.slice(t.start, t.end)
  }
  return s.trim() ? autop(s) : ''
}

/**
 * User transformers first (first `match` wins; a throwing one is reported as TRANSFORMER_FAILED and
 * skipped), then core rules. Server-rendered blocks become `dynamic` with no HTML (their inner
 * blocks go with them). Layout wrappers are flattened, keeping their media and own text. Unknown
 * blocks keep their HTML (inner blocks normalised in place) with `unknown: true`; an unknown block
 * with no text, image, frame or link is also `dynamic`.
 */
export function normaliseBlocks(
  blocks: readonly ParsedBlock[],
  transformers: readonly Transformer[],
  report?: (issue: NormaliseIssue) => void,
): NormalisedBlock[] {
  const out: NormalisedBlock[] = []

  const viaTransformer = (b: ParsedBlock): string | undefined => {
    for (const t of transformers) {
      try {
        if (t.match(b)) return t.toHtml(b)
      } catch (e) {
        report?.({ code: 'TRANSFORMER_FAILED', detail: `${t.name} on ${b.name}: ${e instanceof Error ? e.message : String(e)}` })
      }
    }
    return undefined
  }

  const render: Render = (b) => {
    const acc: NormalisedBlock[] = []
    visit(b, acc)
    return acc.map((n) => n.html).join('')
  }

  const push = (acc: NormalisedBlock[], name: string, r: Result) => {
    if (typeof r === 'string') {
      if (r) acc.push({ name, html: r })
    } else if (r.html || r.unknown || r.dynamic) acc.push({ name, ...r })
  }

  const visit = (b: ParsedBlock, acc: NormalisedBlock[]): void => {
    const custom = viaTransformer(b)
    if (custom !== undefined) return void acc.push({ name: b.name, html: custom })
    if (isDynamic(b.name)) return void acc.push({ name: b.name, html: '', dynamic: true })
    if (FLATTEN.has(b.name)) {
      push(acc, b.name, wrapperMedia(b))
      let i = 0
      for (const c of b.innerContent) {
        if (c !== null) push(acc, b.name, wrapperText(b, c))
        else {
          const child = b.innerBlocks[i++]
          if (child) visit(child, acc)
        }
      }
      return
    }
    const rule = RULES[b.name] ?? (b.name.startsWith('core-embed/') ? RULES['core/embed'] : undefined)
    if (rule) return push(acc, b.name, rule(b, render))
    const html = withInner(b, render).trim()
    acc.push(looksEmpty(html) ? { name: b.name, html: '', unknown: true, dynamic: true } : { name: b.name, html, unknown: true })
  }

  for (const b of blocks) visit(b, out)
  return out
}
