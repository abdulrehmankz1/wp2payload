import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildConfig, getPayload, type CollectionConfig, type EmailAdapter, type Payload } from 'payload'
import { wpMetaField } from '../../src/loaders/wpmeta.js'
import { waitForDatabase } from '../../src/payload/ready.js'
import { closeTestPayload, testDatabase } from './db.js'

// Real Payload on a throwaway database, SQLite or MongoDB per WP2P_TEST_DB (see db.ts; doc 2.11:
// loaders run against a real instance).
// Collections mirror the blog preset (doc 4.7) closely enough for loader tests.
const collections: CollectionConfig[] = [
  {
    slug: 'categories',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'slug', type: 'text', index: true },
      { name: 'description', type: 'textarea' },
      { name: 'parent', type: 'relationship', relationTo: 'categories' },
      wpMetaField,
    ],
  },
  {
    slug: 'tags',
    fields: [{ name: 'name', type: 'text', required: true }, { name: 'slug', type: 'text', index: true }, wpMetaField],
  },
  {
    slug: 'authors',
    fields: [{ name: 'name', type: 'text', required: true }, { name: 'slug', type: 'text', index: true }, wpMetaField],
  },
  {
    slug: 'media',
    upload: { staticDir: 'media' }, // replaced per instance below
    fields: [{ name: 'alt', type: 'text' }, { name: 'caption', type: 'text' }, wpMetaField],
  },
]

export interface TestPayload {
  payload: Payload
  dir: string
  close(): Promise<void>
}

export interface StartOptions {
  /** Added to the preset-like collections, e.g. an auth collection. */
  collections?: CollectionConfig[]
  /** A stub adapter; tests never send real email. */
  email?: EmailAdapter
}

export async function startPayload(opts: StartOptions = {}): Promise<TestPayload> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-int-'))
  const config = buildConfig({
    secret: 'test-secret-not-real',
    telemetry: false,
    db: testDatabase(dir),
    collections: [...collections, ...(opts.collections ?? [])].map((c) =>
      c.upload ? { ...c, upload: { staticDir: path.join(dir, 'media') } } : c,
    ),
    ...(opts.email ? { email: opts.email } : {}),
    logger: { options: { level: 'error' } },
  })
  // A fresh key per instance: getPayload caches by config otherwise.
  const payload = await getPayload({ config, key: dir })
  await waitForDatabase(payload)
  return {
    payload,
    dir,
    close: () => closeTestPayload(payload, dir),
  }
}
