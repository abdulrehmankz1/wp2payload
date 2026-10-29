import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { BlocksFeature, LinkFeature, lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig, getPayload, type Payload } from 'payload'

// Real Payload with a lexicalEditor() rich text field (default features + embed and wpRawHtml
// blocks), so converter output is validated by Payload itself. Pattern from harness.ts.
export const BLOCKS = { embed: 'embed', wpRawHtml: 'wpRawHtml' } as const

const blocksFeature = () =>
  BlocksFeature({
    blocks: [
      {
        slug: BLOCKS.embed,
        fields: [
          { name: 'url', type: 'text', required: true },
          { name: 'host', type: 'text', required: true },
        ],
      },
      { slug: BLOCKS.wpRawHtml, fields: [{ name: 'html', type: 'code', required: true }] },
    ],
  })

export interface LexicalTestPayload {
  payload: Payload
  dir: string
  close(): Promise<void>
}

export async function startLexicalPayload(): Promise<LexicalTestPayload> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-lexical-'))
  const config = buildConfig({
    secret: 'test-secret-not-real',
    telemetry: false,
    db: sqliteAdapter({ client: { url: `file:${path.join(dir, 'test.db').replace(/\\/g, '/')}` }, push: true }),
    editor: lexicalEditor(),
    collections: [
      { slug: 'media', upload: { staticDir: path.join(dir, 'media') }, fields: [{ name: 'alt', type: 'text' }] },
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text', required: true },
          {
            name: 'content',
            type: 'richText',
            editor: lexicalEditor({ features: ({ defaultFeatures }) => [...defaultFeatures, blocksFeature()] }),
          },
        ],
      },
      {
        // Same editor plus a `rel` link field: how a preset can keep externalLinkRel.
        slug: 'relposts',
        fields: [
          { name: 'title', type: 'text', required: true },
          {
            name: 'content',
            type: 'richText',
            editor: lexicalEditor({
              features: ({ defaultFeatures }) => [
                ...defaultFeatures.filter((f) => f.key !== 'link'),
                LinkFeature({ fields: ({ defaultFields }) => [...defaultFields, { name: 'rel', type: 'text' }] }),
                blocksFeature(),
              ],
            }),
          },
        ],
      },
    ],
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
