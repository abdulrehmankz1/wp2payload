// @ts-nocheck -- fixture compiled by tsx at runtime with its own tsconfig, not by the repo's tsc.
import type { CollectionConfig } from 'payload'
import { wpMeta } from '../fields/wpMeta.ts'

export const Posts: CollectionConfig = {
  slug: 'posts',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'content', type: 'richText' },
    wpMeta,
  ],
}
