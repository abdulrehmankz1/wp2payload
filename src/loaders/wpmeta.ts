import type { CollectionSlug, Field, Payload } from 'payload'

// Idempotency key on every migrated document (doc 2.4, ADR-0004). The database is the
// source of truth: every write is an upsert by (site, wpId), so re-runs never duplicate.
// The WordPress ID lives in `wpId`, not `id`: a group sub-field named `id` breaks
// queries on the SQLite adapter (see docs/adr/0004-db-source-of-truth.md).
export interface WpMeta {
  site: string
  wpId: number
  link?: string
  sha256?: string // media only: hash of the original bytes
  importedAt: string
}

export type PayloadId = string | number

/** Field users add to each target collection (the blog preset adds it for them). */
export const wpMetaField: Field = {
  name: 'wpMeta',
  type: 'group',
  admin: { readOnly: true, position: 'sidebar', description: 'Set by wp2payload. Do not edit.' },
  fields: [
    { name: 'site', type: 'text', index: true },
    { name: 'wpId', type: 'number', index: true },
    { name: 'link', type: 'text' },
    { name: 'sha256', type: 'text', index: true },
    { name: 'importedAt', type: 'date' },
  ],
}

/** Normalised source site key: lowercase origin plus path, no trailing slash. */
export function siteKey(url: string): string {
  const u = new URL(url)
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, '').toLowerCase()
}

export async function findByWpMeta(
  payload: Payload,
  collection: CollectionSlug,
  site: string,
  wpId: number,
): Promise<PayloadId | undefined> {
  const found = await payload.find({
    collection,
    where: { and: [{ 'wpMeta.site': { equals: site } }, { 'wpMeta.wpId': { equals: wpId } }] },
    limit: 1,
    depth: 0,
    pagination: false,
    overrideAccess: true,
  })
  return (found.docs[0] as { id?: PayloadId } | undefined)?.id
}

export interface UpsertArgs {
  collection: CollectionSlug
  meta: Omit<WpMeta, 'importedAt'>
  data: Record<string, unknown>
  // Upload collections take the file alongside data.
  file?: { data: Buffer; mimetype: string; name: string; size: number }
  // Known Payload ID from the state cache; verified, never trusted blindly.
  knownId?: PayloadId
}

export interface UpsertResult {
  id: PayloadId
  action: 'created' | 'updated'
}

export async function upsertByWpMeta(payload: Payload, args: UpsertArgs): Promise<UpsertResult> {
  const { collection, meta } = args
  const wpMeta: WpMeta = { ...meta, importedAt: new Date().toISOString() }
  const data = { ...args.data, wpMeta }
  const existing = await findByWpMeta(payload, collection, meta.site, meta.wpId)
  if (existing !== undefined) {
    const updated = await payload.update({
      collection,
      id: existing,
      data: data as never,
      depth: 0,
      overrideAccess: true,
      ...(args.file ? { file: args.file } : {}),
    })
    return { id: (updated as { id: PayloadId }).id, action: 'updated' }
  }
  const created = await payload.create({
    collection,
    data: data as never,
    depth: 0,
    overrideAccess: true,
    ...(args.file ? { file: args.file } : {}),
  })
  return { id: (created as { id: PayloadId }).id, action: 'created' }
}
