import type { IRSeo } from '../ir/types.js'
import { toPlainText } from './rest/decode.js'

// Post meta and post rows shared by the sources that read WordPress data directly (WXR, SQL).

export const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', m4v: 'video/mp4', mp3: 'audio/mpeg',
}
// Editor and site internals that exports include but nobody would call content.
export const INTERNAL_TYPES = new Set(['revision', 'custom_css', 'customize_changeset', 'oembed_cache', 'user_request'])
export const SEO_KEYS = {
  yoast: { title: '_yoast_wpseo_title', description: '_yoast_wpseo_metadesc', canonical: '_yoast_wpseo_canonical', image: '_yoast_wpseo_opengraph-image-id' },
  rankmath: { title: 'rank_math_title', description: 'rank_math_description', canonical: 'rank_math_canonical_url', image: 'rank_math_facebook_image_id' },
} as const
export type SeoKeys = (typeof SEO_KEYS)[keyof typeof SEO_KEYS]

/** A positive integer ID written as text, or undefined. */
export const positiveId = (v: string | undefined): number | undefined => {
  const n = v !== undefined && /^\s*\d{1,15}\s*$/.test(v) ? Number(v) : undefined
  return n !== undefined && n > 0 ? n : undefined
}

/** `2026-10-01 10:00:00` (GMT) to ISO; drafts carry zeros there, so the local date is used then. */
export function isoDate(gmt: string | undefined, local: string | undefined): string {
  for (const v of [gmt, local]) {
    const m = v?.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/)
    if (m && !m[1]!.startsWith('0000')) {
      const d = new Date(`${m[1]}T${m[2]}Z`)
      if (!Number.isNaN(d.getTime())) return d.toISOString()
    }
  }
  return new Date(0).toISOString()
}

/**
 * SEO from post meta. Exports hold what the editor typed, so Yoast (`%%title%%`) and Rank Math
 * (`%title%`) variables are filled for the common ones; a field with any other variable is left out.
 */
export function mapSeoMeta(
  meta: Map<string, string>,
  keys: SeoKeys,
  vars: { title: string; sitename: string; excerpt: string },
): { value?: IRSeo; unresolved: boolean } {
  const known: Record<string, string> = { title: vars.title, sitename: vars.sitename, sep: '-', page: '', excerpt: vars.excerpt }
  let unresolved = false
  const fill = (v: string | undefined): string | undefined => {
    if (!v?.trim()) return undefined
    let out = toPlainText(v)
    out = out.replace(/%%([a-z_]+)%%|%([a-z_]+)%/gi, (whole, a?: string, b?: string) => {
      const name = (a ?? b ?? '').toLowerCase()
      return Object.hasOwn(known, name) ? known[name]! : whole
    })
    if (/%%[a-z_]+%%|%[a-z_]+%/i.test(out)) {
      unresolved = true
      return undefined
    }
    return out.replace(/\s+/g, ' ').trim() || undefined
  }
  const seo: IRSeo = {}
  const title = fill(meta.get(keys.title))
  if (title) seo.title = title
  const description = fill(meta.get(keys.description))
  if (description) seo.description = description
  const canonical = meta.get(keys.canonical)?.trim()
  if (canonical) seo.canonical = canonical
  const noindex = keys.title.startsWith('_yoast') ? meta.get('_yoast_wpseo_meta-robots-noindex') === '1' : /"noindex"/.test(meta.get('rank_math_robots') ?? '')
  if (noindex) seo.noindex = true
  const image = positiveId(meta.get(keys.image))
  if (image !== undefined) seo.ogImageWpId = image
  return Object.keys(seo).length ? { value: seo, unresolved } : { unresolved }
}
