// Transformer contracts (doc 2.3 steps 1-4). PM-frozen for spec 04: slices code against these.
import type { Block } from '../config/types.js'
import type { SecurityFinding } from '../report/types.js'

export type { Block }

/** One parsed Gutenberg block. `core/freeform` holds classic-editor HTML outside any block comment. */
export interface ParsedBlock extends Block {
  innerBlocks: ParsedBlock[]
  /** HTML pieces between inner blocks; `null` marks where each inner block sits. */
  innerContent: (string | null)[]
}

/** Clean, normalised HTML for one block, ready for the sanitizer. */
export interface NormalisedBlock {
  name: string
  html: string
  /** Set when no core rule or user transformer knew the block: html is its raw inner HTML. */
  unknown?: boolean
  /** Server-rendered block (query, navigation, post-title...): no stored content to migrate. */
  dynamic?: boolean
}

/** Something the target editor cannot express as rich text, carried as a Lexical block node. */
export type BlockNodeData =
  | { blockType: 'embed'; url: string; host: string }
  | { blockType: 'wpRawHtml'; html: string }

export interface SanitizeOptions {
  /** e.g. "post:981", used on every finding. */
  doc: string
  /** Source site origin (https://oldsite.com). Links elsewhere are external. */
  siteOrigin: string
  embedHosts: readonly string[]
  externalLinkRel: string
  /** Report SEC_SPAM_KEYWORDS here. The pipeline turns it off per block and checks the whole document once. */
  spam?: boolean
}

/** A removed fragment to write to quarantine (doc 12.10). The caller writes it. */
export interface QuarantineFragment {
  html: string
  finding: SecurityFinding
}

export interface SanitizeResult {
  /** Allowlist-clean HTML. Allowed iframes are replaced by `<wp2p-embed data-url="...">` placeholders. */
  html: string
  findings: SecurityFinding[]
  quarantine: QuarantineFragment[]
}

/** How the Lexical converter turns old URLs into references (doc 2.3 step 3). */
export interface UrlResolver {
  /** Payload media ID for an old media URL (size variants like -300x200 included), if migrated. */
  media(url: string): string | number | undefined
  /** Internal document for an old permalink, if migrated. */
  doc(url: string): { relationTo: string; value: string | number } | undefined
  /** True for URLs on the source site (any scheme, www or not). Without it only relative URLs count. */
  isOldSite?(url: string): boolean
}

export interface LexicalOptions {
  resolver: UrlResolver
  mediaCollection: string
  /** Block slugs available in the target editor; a missing one means "not available". */
  blocks: { embed?: string; wpRawHtml?: string }
  /** Written as `fields.rel` on external custom links when set; the target link feature needs a `rel` field. */
  externalLinkRel?: string
  doc: string
}

export interface LexicalIssue {
  code: 'LEXICAL_FALLBACK' | 'LINK_NOT_MIGRATED' | 'MEDIA_NOT_MIGRATED' | 'CONTENT_DROPPED'
  detail: string
}

export interface LexicalResult {
  /** Serialized editor state: `{ root: { type: 'root', children, ... } }`. */
  state: { root: Record<string, unknown> }
  warnings: LexicalIssue[]
}
