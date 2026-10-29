import type { CollectionSlug, FlattenedField, Payload } from 'payload'
import type { LexicalOptions } from '../transform/types.js'

// What a target collection can hold, read from the sanitized Payload config at runtime, so the
// documents loader writes only fields that exist (spec 05 Decisions) and only the Lexical blocks
// the editor knows (AC-A4).

export type FieldKind = 'text' | 'richText' | 'relationship' | 'group' | 'date' | 'checkbox' | 'other'

export interface TargetField {
  name: string
  kind: FieldKind
  /** Payload field type as configured (text, textarea, upload, relationship...). */
  type: string
  hasMany: boolean
  /** relationship/upload only. An array means a polymorphic relationship. */
  relationTo?: string | string[]
  /** group only. */
  fields?: Map<string, TargetField>
  /** richText only: what the field's Lexical editor supports. */
  editor?: EditorSupport
}

export interface EditorSupport {
  blocks: LexicalOptions['blocks']
  /** The link feature has a `rel` field, so `fields.rel` on links is part of the schema. */
  linkRel: boolean
}

export interface CollectionShape {
  slug: CollectionSlug
  drafts: boolean
  fields: Map<string, TargetField>
}

const TEXT = new Set(['text', 'textarea', 'email', 'code'])

function kindOf(type: string): FieldKind {
  if (TEXT.has(type)) return 'text'
  if (type === 'richText') return 'richText'
  if (type === 'relationship' || type === 'upload') return 'relationship'
  // A named tab stores its fields under the tab name, exactly like a group (website template `meta`).
  if (type === 'group' || type === 'tab') return 'group'
  if (type === 'date') return 'date'
  if (type === 'checkbox') return 'checkbox'
  return 'other'
}

function describeFields(payload: Payload, fields: readonly FlattenedField[]): Map<string, TargetField> {
  const out = new Map<string, TargetField>()
  for (const f of fields) {
    const kind = kindOf(f.type)
    const tf: TargetField = { name: f.name, kind, type: f.type, hasMany: 'hasMany' in f && f.hasMany === true }
    if (kind === 'relationship' && 'relationTo' in f) tf.relationTo = f.relationTo as string | string[]
    if (kind === 'group' && 'flattenedFields' in f) tf.fields = describeFields(payload, f.flattenedFields)
    if (kind === 'richText') tf.editor = editorSupport(payload, (f as { editor?: unknown }).editor)
    out.set(f.name, tf)
  }
  return out
}

/** Throws if the collection is not in the Payload config (preflight, slice C, reports that nicely). */
export function describeCollection(payload: Payload, slug: CollectionSlug): CollectionShape {
  const col = payload.collections[slug]
  if (!col) throw new Error(`Collection "${slug}" is not in the Payload config`)
  const versions = col.config.versions as { drafts?: unknown } | false | undefined
  return { slug, drafts: Boolean(versions && versions.drafts), fields: describeFields(payload, col.config.flattenedFields) }
}

interface BlockLike {
  slug?: string
  fields?: readonly { name?: string }[]
}

/**
 * Verified against @payloadcms/richtext-lexical 3.92.1 at runtime: a sanitized richText field's
 * `editor.editorConfig.resolvedFeatureMap` is a Map keyed by feature key. `blocks` carries
 * `sanitizedServerFeatureProps.blocks` (Block objects, or slugs referencing `config.blocks`);
 * `link` carries `sanitizedServerFeatureProps.fields` (the link drawer fields, `rel` included when
 * the user added it). A block only counts when it also has the fields the converter writes.
 */
export function editorSupport(payload: Payload, editor: unknown): EditorSupport {
  const map = (editor as { editorConfig?: { resolvedFeatureMap?: unknown } } | undefined)?.editorConfig?.resolvedFeatureMap
  const support: EditorSupport = { blocks: {}, linkRel: false }
  if (!(map instanceof Map)) return support
  const feature = (key: string) => (map.get(key) as { sanitizedServerFeatureProps?: Record<string, unknown> } | undefined)?.sanitizedServerFeatureProps

  const global = (payload.config.blocks ?? []) as readonly BlockLike[]
  const raw = feature('blocks')?.['blocks']
  const blocks = (Array.isArray(raw) ? raw : []).map((b: unknown) => (typeof b === 'string' ? global.find((g) => g.slug === b) : (b as BlockLike)))
  const has = (slug: string, names: string[]) => {
    const b = blocks.find((x) => x?.slug === slug)
    const fieldNames = new Set((b?.fields ?? []).map((f) => f.name))
    return b !== undefined && names.every((n) => fieldNames.has(n))
  }
  if (has('embed', ['url', 'host'])) support.blocks.embed = 'embed'
  if (has('wpRawHtml', ['html'])) support.blocks.wpRawHtml = 'wpRawHtml'

  const linkFields = feature('link')?.['fields']
  support.linkRel = Array.isArray(linkFields) && linkFields.some((f: unknown) => (f as { name?: string }).name === 'rel')
  return support
}
