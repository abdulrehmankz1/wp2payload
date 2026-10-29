// @ts-nocheck -- fixture compiled by tsx at runtime with its own tsconfig, not by the repo's tsc.
import type { CollectionConfig } from 'payload'
import { wpMeta } from '@/fields/wpMeta'

export const Media: CollectionConfig = {
  slug: 'media',
  upload: { staticDir: process.env.FIXTURE_MEDIA_DIR },
  fields: [{ name: 'alt', type: 'text' }, wpMeta],
}
