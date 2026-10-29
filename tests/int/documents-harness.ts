import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { BlocksFeature, LinkFeature, lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig, getPayload, type CollectionConfig, type Payload } from 'payload'
import { wpMetaField } from '../../src/loaders/wpmeta.js'

// Real Payload + SQLite shaped like the blog preset (doc 4.7): posts with drafts, an SEO `meta`
// group, a `heroImage` upload and a Lexical editor with the embed/wpRawHtml blocks; pages with a
// `parent` and a plain editor; `notes` with a required field the loader never fills.

const blocks = BlocksFeature({
  blocks: [
    { slug: 'embed', fields: [{ name: 'url', type: 'text', required: true }, { name: 'host', type: 'text', required: true }] },
    { slug: 'wpRawHtml', fields: [{ name: 'html', type: 'code', required: true }] },
  ],
})

const collections = (dir: string): CollectionConfig[] => [
  { slug: 'categories', fields: [{ name: 'name', type: 'text', required: true }, { name: 'slug', type: 'text' }, wpMetaField] },
  { slug: 'tags', fields: [{ name: 'name', type: 'text', required: true }, { name: 'slug', type: 'text' }, wpMetaField] },
  { slug: 'authors', fields: [{ name: 'name', type: 'text', required: true }, { name: 'slug', type: 'text' }, wpMetaField] },
  { slug: 'media', upload: { staticDir: path.join(dir, 'media') }, fields: [{ name: 'alt', type: 'text' }, wpMetaField] },
  {
    slug: 'posts',
    versions: { drafts: true },
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'slug', type: 'text', index: true },
      {
        name: 'content',
        type: 'richText',
        editor: lexicalEditor({
          features: ({ defaultFeatures }) => [
            ...defaultFeatures.filter((f) => f.key !== 'link'),
            LinkFeature({ fields: ({ defaultFields }) => [...defaultFields, { name: 'rel', type: 'text' }] }),
            blocks,
          ],
        }),
      },
      { name: 'publishedAt', type: 'date' },
      { name: 'author', type: 'relationship', relationTo: 'authors' },
      { name: 'categories', type: 'relationship', relationTo: 'categories', hasMany: true },
      { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true },
      { name: 'heroImage', type: 'upload', relationTo: 'media' },
      {
        name: 'meta',
        type: 'group',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'description', type: 'textarea' },
          { name: 'image', type: 'upload', relationTo: 'media' },
        ],
      },
      wpMetaField,
    ],
  },
  {
    slug: 'pages',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'slug', type: 'text' },
      { name: 'content', type: 'richText', editor: lexicalEditor() },
      { name: 'parent', type: 'relationship', relationTo: 'pages' },
      wpMetaField,
    ],
  },
  {
    slug: 'notes',
    fields: [{ name: 'title', type: 'text', required: true }, { name: 'summary', type: 'text', required: true }, wpMetaField],
  },
]

export interface DocumentsTestPayload {
  payload: Payload
  dir: string
  close(): Promise<void>
}

export async function startDocumentsPayload(): Promise<DocumentsTestPayload> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-docs-'))
  const config = buildConfig({
    secret: 'test-secret-not-real',
    telemetry: false,
    db: sqliteAdapter({ client: { url: `file:${path.join(dir, 'test.db').replace(/\\/g, '/')}` }, push: true }),
    editor: lexicalEditor(),
    collections: collections(dir),
    logger: { options: { level: 'error' } },
  })
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
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
      }
    },
  }
}
