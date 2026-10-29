import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { buildConfig, getPayload, type CollectionConfig, type Payload } from 'payload'
import { wpMetaField } from '../../src/loaders/wpmeta.js'

// Real Payload on a throwaway SQLite file (doc 2.11: loaders run against a real instance).
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

export async function startPayload(): Promise<TestPayload> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-int-'))
  const config = buildConfig({
    secret: 'test-secret-not-real',
    telemetry: false,
    db: sqliteAdapter({ client: { url: `file:${path.join(dir, 'test.db').replace(/\\/g, '/')}` }, push: true }),
    collections: collections.map((c) =>
      c.upload ? { ...c, upload: { staticDir: path.join(dir, 'media') } } : c,
    ),
    logger: { options: { level: 'error' } },
  })
  // A fresh key per instance: getPayload caches by config otherwise.
  const payload = await getPayload({ config, key: dir })
  return {
    payload,
    dir,
    async close() {
      await payload.db.destroy?.()
      ;(payload.db as { client?: { close?: () => void } }).client?.close?.()
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (error) {
        // Windows can hold the SQLite file briefly after close; the OS temp cleaner removes it.
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
      }
    },
  }
}
