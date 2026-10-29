import type { CollectionSlug, Payload } from 'payload'
import type { ReportSink } from '../report/types.js'
import type { PayloadId } from './wpmeta.js'

/** wpId → Payload ID map per kind. Backed by the state file, which is only a cache (ADR-0004). */
export interface IdMap {
  get(kind: IdKind, wpId: number): PayloadId | undefined
  set(kind: IdKind, wpId: number, id: PayloadId): void
}

export type IdKind = 'media' | 'category' | 'post_tag' | 'author' | 'post' | 'page' | (string & {})

export interface LoaderContext {
  payload: Payload
  site: string // siteKey() of the source
  dryRun: boolean
  ids: IdMap
  report: ReportSink
  collections: {
    media: CollectionSlug
    category: CollectionSlug
    post_tag: CollectionSlug
    author: CollectionSlug
  }
}
