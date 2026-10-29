import type { IOptions } from 'sanitize-html'

// Content allowlist (doc 12.4, threat T1). Author-owned security policy (doc 9.4):
// change it only with the owner's sign-off. The arrays are the doc's CONTENT_POLICY verbatim.

export const ALLOWED_TAGS: readonly string[] = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a',
  'strong', 'em', 'b', 'i', 'u', 's', 'sub', 'sup', 'blockquote',
  'code', 'pre', 'br', 'hr', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
]

export const ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  th: ['colspan', 'rowspan'],
  td: ['colspan', 'rowspan'],
}

export const ALLOWED_SCHEMES: readonly string[] = ['http', 'https', 'mailto', 'tel']

export const CONTENT_POLICY: IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: Object.fromEntries(Object.entries(ALLOWED_ATTRIBUTES).map(([k, v]) => [k, [...v]])),
  allowedSchemes: [...ALLOWED_SCHEMES],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
}

/**
 * Placeholder for an allowlisted iframe (doc 12.4: "become a Payload embed block"). Only the
 * sanitizer emits it; the Lexical converter turns it into an embed block node.
 */
export const EMBED_TAG = 'wp2p-embed'
export const EMBED_ATTR = 'data-url'

/**
 * Spam phrases checked in visible link text (doc 12.5, low, flag only). Kept short and
 * unambiguous on purpose: a match never removes content, but noise erodes trust in the report.
 */
export const SPAM_KEYWORDS: readonly string[] = [
  'casino', 'viagra', 'cialis', 'levitra', 'payday loan', 'replica watch', 'porn', 'betting',
  'crypto doubler', 'bitcoin doubler', 'online pharmacy', 'cheap pills',
]

/** A post is link-heavy at `max(min, median * factor)` external links (doc 12.5, low, flag only). */
export const LINK_HEAVY_FACTOR = 3
export const LINK_HEAVY_MIN = 10

/** Runs of base64 alphabet at least this long are treated as an obfuscated payload. */
export const BASE64_RUN = 200
