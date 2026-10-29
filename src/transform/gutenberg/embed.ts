import { esc, innerOf, textOf, tokenize } from './html.js'
import type { ParsedBlock } from '../types.js'

const VIDEO_ID = /^[A-Za-z0-9_-]{6,32}$/

/** Player URL for YouTube/Vimeo page or player URLs, else undefined. */
export function playerUrl(url: string): string | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '')
  const parts = u.pathname.split('/').filter(Boolean)
  let id: string | undefined
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parts[0] === 'watch') id = u.searchParams.get('v') ?? undefined
    else if (parts[0] === 'embed' || parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'v') id = parts[1]
    return id && VIDEO_ID.test(id) ? `https://www.youtube.com/embed/${id}` : undefined
  }
  if (host === 'youtu.be') {
    id = parts[0]
    return id && VIDEO_ID.test(id) ? `https://www.youtube.com/embed/${id}` : undefined
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    id = host === 'player.vimeo.com' && parts[0] === 'video' ? parts[1] : parts.find((p) => /^\d+$/.test(p))
    return id && /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : undefined
  }
  return undefined
}

function embedSource(b: ParsedBlock): string | undefined {
  if (typeof b.attrs.url === 'string' && b.attrs.url.trim()) return b.attrs.url.trim()
  const text = textOf(tokenize(innerOf(b.innerHTML, 'div') ?? b.innerHTML))
  const m = /https?:\/\/[^\s<>"']+/i.exec(text)
  return m?.[0].replace(/&amp;|&#0?38;/g, '&')
}

/** core/embed and legacy core-embed/*: iframe for known video players, else a plain link. */
export function embedHtml(b: ParsedBlock): string {
  const url = embedSource(b)
  if (!url) return ''
  const player = playerUrl(url)
  const caption = innerOf(b.innerHTML, 'figcaption')?.trim()
  const main = player ? `<iframe src="${esc(player)}"></iframe>` : `<p><a href="${esc(url)}">${esc(url)}</a></p>`
  return caption ? `${main}<p>${caption}</p>` : main
}
