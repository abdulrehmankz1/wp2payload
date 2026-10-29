// @ts-nocheck -- fixture compiled by tsx at runtime with its own tsconfig, not by the repo's tsc.
// A user-style Payload config: TypeScript, a path alias, a relative .ts import, the Lexical
// editor, and every secret and path read from .env (written by the test at runtime).
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { Media } from '@/collections/Media'
import { Posts } from './collections/Posts.ts'

export default buildConfig({
  secret: process.env.PAYLOAD_SECRET || '',
  telemetry: false,
  editor: lexicalEditor(),
  db: sqliteAdapter({ client: { url: process.env.DATABASE_URI || '' }, push: true }),
  collections: [Posts, Media],
  logger: { options: { level: 'error' } },
})
