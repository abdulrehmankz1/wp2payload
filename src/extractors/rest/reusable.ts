import { blockDelimiters } from '../../transform/gutenberg/parse.js'

// Reusable blocks (synced patterns, post type wp_block) are stored as their own post and referenced
// from content as `<!-- wp:block {"ref":123} /-->`. The extractor inlines their content into the
// document HTML, so the security scan, sanitizer and Lexical converter treat it as ordinary content.

/** Nested reusable blocks deeper than this are left out. */
export const MAX_REUSABLE_DEPTH = 8
/** Reusable blocks inlined into one document at most. */
export const MAX_REUSABLE_INLINES = 200
/** Characters reusable blocks may add to one document at most. */
export const MAX_REUSABLE_CHARS = 4 * 1024 * 1024

/** A reusable block's stored content, or why it cannot be used. */
export type ReusableContent = { html: string } | { reason: string }

/** A positive integer ref, or undefined. Gutenberg writes a number; a canonical digit string is accepted too. */
export function reusableRef(attrs: Record<string, unknown>): number | undefined {
  const v = attrs.ref
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : undefined
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/**
 * Replaces every `core/block` delimiter that has a valid ref with that block's content, nested
 * blocks included. A block that cannot be used (unreadable, a cycle, too deep, over the limits)
 * is removed and passed to `skip`. A delimiter without a valid ref stays as it is, so the
 * transform still reports it.
 */
export async function inlineReusableBlocks(
  html: string,
  load: (ref: number) => Promise<ReusableContent>,
  skip: (ref: number, reason: string) => void,
): Promise<string> {
  const budget = { inlines: 0, chars: 0 }
  const expand = async (src: string, chain: number[]): Promise<string> => {
    let out = ''
    let at = 0
    for (const d of blockDelimiters(src)) {
      if (d.kind !== 'void' || d.name !== 'core/block') continue
      const ref = reusableRef(d.attrs)
      if (ref === undefined) continue
      out += src.slice(at, d.start)
      at = d.end
      let reason: string
      if (chain.includes(ref)) reason = 'contains itself'
      else if (chain.length >= MAX_REUSABLE_DEPTH) reason = `nested more than ${MAX_REUSABLE_DEPTH} deep`
      else if (budget.inlines >= MAX_REUSABLE_INLINES) reason = `more than ${MAX_REUSABLE_INLINES} reusable blocks in one document`
      else {
        const content = await load(ref)
        if ('html' in content && budget.chars + content.html.length <= MAX_REUSABLE_CHARS) {
          budget.inlines++
          budget.chars += content.html.length
          out += await expand(content.html, [...chain, ref])
          continue
        }
        reason = 'reason' in content ? content.reason : 'too much reusable content in one document'
      }
      skip(ref, reason)
    }
    return at === 0 ? src : out + src.slice(at)
  }
  return expand(html, [])
}
