import { z } from 'zod'
import type { Block, Transformer } from './types.js'

const httpUrl = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value)
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  },
  { error: 'expected an http(s) URL' },
)

const nonEmpty = (what: string) =>
  z.string({ error: `expected ${what} (a string)` }).min(1, `expected ${what} (a non-empty string)`)

const restSource = z.strictObject({
  type: z.literal('rest'),
  url: httpUrl,
  auth: z
    .strictObject({ user: nonEmpty('a WordPress username'), appPassword: nonEmpty('an application password') })
    .optional(),
})

const wxrSource = z.strictObject({
  type: z.literal('wxr'),
  file: nonEmpty('a path to the WXR export file'),
})

const sqlSource = z.strictObject({
  type: z.literal('sql'),
  file: nonEmpty('a path to the SQL dump'),
  uploadsDir: nonEmpty('a path to the uploads directory'),
  tablePrefix: z.string().min(1, 'expected a non-empty table prefix').default('wp_'),
})

const source = z.discriminatedUnion('type', [restSource, wxrSource, sqlSource], {
  error: "expected source.type to be one of 'rest', 'wxr', 'sql'",
})

const collection = z.strictObject({
  to: nonEmpty('a Payload collection slug'),
  fields: z.record(z.string(), z.string()).optional(),
})

// Blog preset from the product doc (Section 4.5).
const BLOG_PRESET = {
  post: { to: 'posts', fields: { content: 'content', excerpt: 'excerpt', featuredImage: 'heroImage' } },
  page: { to: 'pages', fields: { content: 'content', parent: 'parent' } },
  category: { to: 'categories' },
  post_tag: { to: 'tags' },
  media: { to: 'media' },
  author: { to: 'authors' },
}

const EMBED_HOSTS = ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com']
const QUALITY_MSG = 'expected an integer from 1 to 100'

const fn = <T>(what: string) =>
  z.custom<T>((value) => typeof value === 'function', { error: `expected ${what} (a function)` })

const transformer = z.strictObject({
  name: nonEmpty('a transformer name'),
  match: fn<(block: Block) => boolean>('a match(block) predicate'),
  toHtml: fn<(block: Block) => string>('a toHtml(block) function'),
})

export const configSchema = z.strictObject({
  source,
  collections: z.record(z.string(), collection).default(BLOG_PRESET),
  statuses: z.array(nonEmpty('a WordPress post status')).default(['publish']),
  seo: z
    .strictObject({
      plugin: z
        .enum(['auto', 'yoast', 'rankmath', 'none'], { error: "expected one of 'auto', 'yoast', 'rankmath', 'none'" })
        .default('auto'),
      field: nonEmpty('a Payload field name').default('meta'),
    })
    .default({ plugin: 'auto', field: 'meta' }),
  redirects: z.strictObject({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  media: z
    .strictObject({
      allowedHosts: z.array(z.string()).default([]),
      maxFileSizeMB: z.number({ error: 'expected a positive number' }).positive('expected a positive number').default(50),
      reencode: z.boolean().default(true),
      reencodeQuality: z
        .number({ error: QUALITY_MSG })
        .int(QUALITY_MSG)
        .min(1, QUALITY_MSG)
        .max(100, QUALITY_MSG)
        .default(90),
    })
    .default({ allowedHosts: [], maxFileSizeMB: 50, reencode: true, reencodeQuality: 90 }),
  security: z
    .strictObject({
      embedHosts: z.array(z.string()).default(EMBED_HOSTS),
      externalLinkRel: z.string().default('nofollow noopener'),
    })
    .default({ embedHosts: EMBED_HOSTS, externalLinkRel: 'nofollow noopener' }),
  transformers: z.array(transformer).default([]),
})

export type Wp2PayloadConfigInput = z.input<typeof configSchema>
export type ResolvedConfig = Omit<z.output<typeof configSchema>, 'transformers'> & { transformers: Transformer[] }
