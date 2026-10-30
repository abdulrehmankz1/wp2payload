import { Parser } from 'htmlparser2'
import type { IRSeo } from '../../ir/types.js'
import { normaliseText } from './decode.js'

/** Heads larger than this are not parsed (a real Rank Math head is a few KiB). */
export const MAX_HEAD_CHARS = 256 * 1024

// Content of these elements is never metadata for the page: JSON-LD, inline CSS, fallbacks.
const IGNORED = new Set(['script', 'style', 'noscript', 'template'])

/**
 * Reads SEO fields from the `head` HTML that Rank Math's `getHead` returns. The HTML is untrusted:
 * it is only tokenised (nothing runs), the first occurrence of each field wins, entities are
 * decoded once by the parser, and values are normalised to plain text.
 *
 * Returns `undefined` when the head cannot be used: too large, or it does not identify a page
 * (no canonical and no og:url). Rank Math answers an unresolvable URL, such as a `?p=` link,
 * with its 404 head (`noindex`, "Page Not Found" title), which must not land on a real document.
 */
export function parseRankMathHead(head: string): IRSeo | undefined {
  if (head.length > MAX_HEAD_CHARS) return undefined
  const found: Partial<Record<'description' | 'robots' | 'canonical' | 'ogTitle' | 'ogUrl' | 'twitterTitle' | 'title', string>> = {}
  let ignoredDepth = 0
  let inTitle = false
  let titleText = ''
  const first = (k: keyof typeof found, v: string | undefined) => {
    if (v !== undefined && found[k] === undefined) found[k] = v
  }

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (IGNORED.has(name)) {
          ignoredDepth++
          return
        }
        if (ignoredDepth > 0) return
        if (name === 'title') {
          if (found.title === undefined) {
            inTitle = true
            titleText = ''
          }
          return
        }
        if (name === 'meta') {
          const key = (attribs.name ?? '').trim().toLowerCase()
          const prop = (attribs.property ?? '').trim().toLowerCase()
          const content = attribs.content
          if (key === 'description') first('description', content)
          else if (key === 'robots') first('robots', content)
          else if (key === 'twitter:title') first('twitterTitle', content)
          if (prop === 'og:title') first('ogTitle', content)
          else if (prop === 'og:url') first('ogUrl', content)
          return
        }
        if (name === 'link') {
          const rel = (attribs.rel ?? '').toLowerCase().split(/\s+/)
          if (rel.includes('canonical')) first('canonical', attribs.href)
        }
      },
      ontext(text) {
        if (inTitle && ignoredDepth === 0) titleText += text
      },
      onclosetag(name) {
        if (IGNORED.has(name)) {
          if (ignoredDepth > 0) ignoredDepth--
          return
        }
        if (name === 'title' && inTitle) {
          inTitle = false
          found.title = titleText
        }
      },
    },
    // decodeEntities: attribute values and text arrive decoded exactly once.
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  )
  parser.write(head)
  parser.end()

  const canonical = httpUrl(found.canonical)
  if (canonical === undefined && httpUrl(found.ogUrl) === undefined) return undefined

  const seo: IRSeo = {}
  const title = [found.ogTitle, found.twitterTitle, found.title].map((t) => (t === undefined ? '' : normaliseText(t))).find((t) => t !== '')
  if (title) seo.title = title
  const description = found.description === undefined ? '' : normaliseText(found.description)
  if (description) seo.description = description
  if (canonical) seo.canonical = canonical
  const robots = (found.robots ?? '').toLowerCase().split(/[\s,]+/)
  if (robots.includes('noindex')) seo.noindex = true
  return seo
}

/** Absolute http(s) URL only; anything else (relative, javascript:, data:) is dropped. */
function httpUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim()
  // eslint-disable-next-line no-control-regex
  if (v === '' || /[\u0000-\u001f\u007f\s]/.test(v)) return undefined
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : undefined
  } catch {
    return undefined
  }
}
