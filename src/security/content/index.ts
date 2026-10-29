// Content security (doc 12.4, 12.5; threats T1-T5).
export {
  sanitizeContent,
  scanDocument,
  spamFinding,
  countExternalLinks,
  linkHeavyFinding,
  embedPlaceholder,
  type LinkHeavyOptions,
  type ScanLimits,
} from './sanitize.js'
export { toPlainText } from './text.js'
export {
  CONTENT_POLICY,
  ALLOWED_TAGS,
  ALLOWED_ATTRIBUTES,
  ALLOWED_SCHEMES,
  EMBED_TAG,
  EMBED_ATTR,
  SPAM_KEYWORDS,
  LINK_HEAVY_FACTOR,
  LINK_HEAVY_MIN,
} from './policy.js'
export {
  dangerousScheme,
  embedUrl,
  hiddenStyleReason,
  isExternalUrl,
  isJsRedirect,
  obfuscationReason,
  spamKeywords,
} from './signals.js'
export { markupCost, MAX_NESTING, MAX_PARSE_WORK, type MarkupCost } from './depth.js'
