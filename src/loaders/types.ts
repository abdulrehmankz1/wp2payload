import type { CollectionSlug, Payload } from 'payload'
import type { ReportSink } from '../report/types.js'
import type { PayloadId } from './wpmeta.js'

/** wpId → Payload ID map per kind. Backed by the state file, which is only a cache (ADR-0004). */
export interface IdMap {
  get(kind: IdKind, wpId: number): PayloadId | undefined
  set(kind: IdKind, wpId: number, id: PayloadId): void
}

export type IdKind = 'media' | 'category' | 'post_tag' | 'author' | 'post' | 'page' | (string & {})

/** Where one IR document type is written (config `collections.<type>`). */
export interface DocumentTarget {
  collection: CollectionSlug
  /** IR field → target field name overrides, e.g. `{ featuredImage: 'heroImage' }`. */
  fields: Record<string, string>
}

export interface DocumentWritten {
  type: string
  wpId: number
  action: 'created' | 'updated' | 'skipped' | 'errors'
  /** External links in the final content, for the site-median link-heavy check (doc 12.5). */
  externalLinks: number
}

export interface LoaderContext {
  payload: Payload
  site: string // siteKey() of the source
  dryRun: boolean
  ids: IdMap
  report: ReportSink
  /** Target collections; a kind left out of the config is not migrated. */
  collections: {
    media: CollectionSlug
    category?: CollectionSlug
    post_tag?: CollectionSlug
    author?: CollectionSlug
  }
}
