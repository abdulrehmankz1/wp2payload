// @ts-nocheck -- fixture compiled by tsx at runtime with its own tsconfig, not by the repo's tsc.
import type { Field } from 'payload'

// Same shape as wp2payload's exported wpMetaField; inlined so the fixture stands alone.
export const wpMeta: Field = {
  name: 'wpMeta',
  type: 'group',
  fields: [
    { name: 'site', type: 'text', index: true },
    { name: 'wpId', type: 'number', index: true },
    { name: 'link', type: 'text' },
    { name: 'sha256', type: 'text', index: true },
    { name: 'importedAt', type: 'date' },
  ],
}
