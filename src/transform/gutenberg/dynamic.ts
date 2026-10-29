import { tokenize } from './html.js'

// Server-rendered core blocks: WordPress stores only attrs and renders them in PHP, so there is no
// content to migrate (their inner blocks are templates, e.g. core/query > core/post-template).

const NAMES = new Set([
  'core/latest-posts', 'core/latest-comments', 'core/archives', 'core/calendar', 'core/categories', 'core/tag-cloud',
  'core/rss', 'core/search', 'core/avatar', 'core/loginout', 'core/page-list', 'core/page-list-item', 'core/read-more',
  'core/term-description', 'core/home-link', 'core/template-part', 'core/pattern', 'core/legacy-widget',
  // Reusable block reference: points at a wp_block post that is not migrated yet.
  'core/block',
])
const PREFIXES = ['core/navigation', 'core/query', 'core/post-', 'core/site-', 'core/comment']

export const isDynamic = (name: string): boolean => NAMES.has(name) || PREFIXES.some((p) => name.startsWith(p))

const MEDIA = new Set(['img', 'iframe', 'a', 'video', 'audio', 'source', 'embed', 'object'])

/** No visible text and nothing that points anywhere: what a dynamic block's stored markup looks like. */
export function looksEmpty(html: string): boolean {
  const m = tokenize(html)
  return !m.tokens.some((t) =>
    t.type === 'open' ? MEDIA.has(t.name) : t.type === 'text' && m.src.slice(t.start, t.end).replace(/&nbsp;|&#160;|\s/gi, '') !== '')
}
