# Config reference

The config lives in `wp2payload.config.ts` at the root of your Payload project. `init` writes
one. It is loaded with `jiti` and validated with zod before anything connects or writes
([ADR-0006](../adr/0006-explicit-config.md)). Every object is strict: an unknown key is an error.
An invalid config exits with code 2 and names the exact field and what was expected:

```text
Invalid configuration:
  - media.reencodeQuality: expected an integer from 1 to 100
```

The config is code and runs as you. Secrets must still come from environment variables:
`source.auth.appPassword` is rejected unless an environment variable holds the same value.

## Example

```ts
import { defineConfig } from 'wp2payload'

export default defineConfig({
  source: {
    type: 'rest',
    url: process.env.WP_URL!,
    auth: process.env.WP_APP_PASSWORD
      ? { user: process.env.WP_USER!, appPassword: process.env.WP_APP_PASSWORD }
      : undefined,
  },
  collections: {
    post: { to: 'posts', fields: { featuredImage: 'heroImage' } },
    page: { to: 'pages' },
    category: { to: 'categories' },
    post_tag: { to: 'tags' },
    author: { to: 'authors' },
    media: { to: 'media' },
  },
  statuses: ['publish'],
  seo: { plugin: 'auto', field: 'meta' },
  redirects: { enabled: true },
  media: {
    allowedHosts: ['cdn.oldsite.com'],
    maxFileSizeMB: 50,
    reencode: true,
    reencodeQuality: 90,
  },
  security: {
    embedHosts: ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com'],
    externalLinkRel: 'nofollow noopener',
  },
  transformers: [
    {
      name: 'acme-callout',
      match: (block) => block.name === 'acme/callout',
      toHtml: (block) => `<blockquote>${block.innerHTML}</blockquote>`,
    },
  ],
})
```

`defineConfig` only gives your editor types and completion. The package also exports the types
`Wp2PayloadConfigInput`, `Block` and `Transformer`, and `wpMetaField`.

## source

Required. `type` picks the source.

### rest

A live site through the WordPress REST API.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `type` | `'rest'` | | |
| `url` | string | required | Site URL, http or https. Plain http is accepted only when the host resolves to a loopback or private address |
| `auth` | `{ user, appPassword }` | none | Application Password auth. Without it only published content is read, and Gutenberg block markup is not available |

### wxr

A WordPress export file (Tools → Export → All content).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `type` | `'wxr'` | | |
| `file` | string | required | Path to the export file |
| `url` | string | none | The site's address. Its host then counts as the source host for media downloads, which allows a local copy (`localhost`, LocalWP). Without it, the host named in the file gets the full download guard |

### sql

A SQL dump with the uploads. See [Migrating from a backup](../guides/migrating-from-a-backup.md).

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `type` | `'sql'` | | |
| `file` | string | required | `.sql`, `.sql.gz` or an UpdraftPlus `-db.gz` |
| `uploadsDir` | string | | The `wp-content/uploads` folder |
| `uploads` | string or string[] | | Uploads archive(s) instead of a folder, such as UpdraftPlus `-uploads.zip` files, split ones included |
| `tablePrefix` | string | detected | Table prefix used in the dump (`[A-Za-z0-9_]`, up to 64). When unset, it is detected from the dump; see [Table prefix](../guides/migrating-from-a-backup.md#table-prefix) |

Set exactly one of `uploadsDir` and `uploads`.

### wpress

An All-in-One WP Migration backup, read in place.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `type` | `'wpress'` | | |
| `file` | string | required | Path to the `.wpress` file |

### archive

One zip or tar backup with the dump and `wp-content/uploads` inside, such as a Duplicator
`*_archive.zip`.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `type` | `'archive'` | | |
| `file` | string | required | `.zip`, `.tar.gz`, `.tgz` or `.tar` |
| `tablePrefix` | string | detected | Table prefix used in the dump. When unset, it is detected from `wp-config.php` in the archive or from the dump |

## collections

Maps each WordPress type to a Payload collection. Default: the blog preset.

| Key | WordPress | Blog preset target |
| --- | --- | --- |
| `post` | Posts | `posts`, with `fields: { content: 'content', excerpt: 'excerpt', featuredImage: 'heroImage' }` |
| `page` | Pages | `pages`, with `fields: { content: 'content', parent: 'parent' }` |
| `category` | Categories, with hierarchy | `categories` |
| `post_tag` | Tags | `tags` |
| `media` | Media library | `media` |
| `author` | Users who wrote migrated content | `authors` |

Each entry is `{ to, fields? }`:

| Key | Type | Meaning |
| --- | --- | --- |
| `to` | string | Payload collection slug |
| `fields` | `Record<string, string>` | Renames target fields of a document collection: `{ <wp2payload name>: <your field> }` |

The field names wp2payload writes on posts and pages are `title`, `slug`, `content`, `excerpt`,
`publishedAt`, `author`, `featuredImage`, `categories`, `tags`, `parent` and `seo` (the SEO
group; see `seo.field`). A field your collection does not have, or has with a different type,
is skipped and reported once (`FIELD_NOT_IN_TARGET`). Leaving a type out of `collections` skips
it, and the report says so.

Every mapped collection needs a `wpMeta` group field with indexed `site` and `wpId`
sub-fields ([ADR-0004](../adr/0004-db-source-of-truth.md)). `init --scaffold` adds it; for your
own collections, copy the field from the README or import `wpMetaField` from `wp2payload`.
`migrate` checks every mapped collection before writing and says exactly what is missing.

When `author` maps to an auth collection (one with `auth`), each user becomes a login account
with a random password. This needs an explicit opt-in, because on a hacked site the attacker's
user may have written the spam posts:

```ts
authors: { createAccounts: true }
```

Without it, `migrate` and `doctor` stop with exit code 2 before anything is written. The opt-in
is recorded in the report, and every account created is listed as `AUTHOR_ACCOUNT_CREATED`. See
`--invite-users` in the [CLI reference](cli.md#migrate).

## statuses

`string[]`, default `['publish']`. WordPress statuses to migrate. Add `'draft'`, `'private'` or
`'future'` with an Application Password. Content that is not published, written into a
collection without drafts, is live; the report warns (`STATUS_NOT_KEPT`).

## seo

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `plugin` | `'auto' \| 'yoast' \| 'rankmath' \| 'none'` | `'auto'` | Where SEO data comes from. `auto` uses the plugin the source has |
| `field` | string | `'meta'` | Name of the SEO group field in the target collections |

The SEO group receives `title`, `description` and `image`, plus `noindex` and off-site
`canonical` when the group has those fields. Rank Math over REST needs Headless CMS Support
turned on in Rank Math (General Settings → Others).

## redirects

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Generate redirects from old WordPress URLs |
| `collection` | string | `'redirects'` | The `@payloadcms/plugin-redirects` collection, used when your Payload config has it |
| `paths` | `Record<string, string>` | `{ post: '/posts/:slug', page: '/:slug' }` | New URL per type for `redirects.json`. Each must start with `/` and contain `:slug` |

Without the redirects plugin, redirects go to `.wp2payload/redirects.json` in Next.js
`redirects()` format. With it, they are written to its collection as references to the migrated
documents.

## media

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `allowedHosts` | string[] | `[]` | Extra hosts media may be downloaded from, such as a CDN. They get the full download guard: https only, no private addresses |
| `maxFileSizeMB` | number | `50` | Per-file size cap |
| `reencode` | boolean | `true` | Re-encode raster images and strip metadata ([ADR-0011](../adr/0011-reencode-images.md)). Off is reported per image as `SEC_REENCODE_DISABLED` |
| `reencodeQuality` | integer 1 to 100 | `90` | Re-encoding quality |

The source host (from `source.url`, or the site named in an export) is always allowed.

## security

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `embedHosts` | string[] | `['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com']` | Iframe hosts that become embed blocks. Other iframes are quarantined. `--allow-embed-host` adds hosts for one run |
| `externalLinkRel` | string | `'nofollow noopener'` | `rel` written on external links, when your link feature has a `rel` field |

## transformers

`Transformer[]`, default `[]`. Custom handlers for Gutenberg blocks:

| Key | Type | Meaning |
| --- | --- | --- |
| `name` | string | Used in the report when it fails |
| `match` | `(block: Block) => boolean` | Return true for the blocks this transformer handles |
| `toHtml` | `(block: Block) => string` | Return HTML for the block. It still goes through the sanitizer |

See [Writing a custom transformer](../guides/custom-transformers.md).

## WordPress to Payload mapping

| WordPress | REST endpoint | Dump tables | Blog preset target |
| --- | --- | --- | --- |
| Posts | `/wp/v2/posts` | `wp_posts` (`post_type = 'post'`) | `posts` |
| Pages | `/wp/v2/pages` | `wp_posts` (`post_type = 'page'`) | `pages` |
| Media | `/wp/v2/media` | `wp_posts` (`post_type = 'attachment'`) and `_wp_attached_file` meta | `media` |
| Categories | `/wp/v2/categories` | `wp_terms` and `wp_term_taxonomy` | `categories` |
| Tags | `/wp/v2/tags` | `wp_terms` and `wp_term_taxonomy` | `tags` |
| Post to term links | in each post | `wp_term_relationships` | `categories` and `tags` relationship fields |
| Authors | `/wp/v2/users` | `wp_users` (`user_pass` and `user_email` never read) | `authors` |
| Featured image | `featured_media` | `_thumbnail_id` meta | `heroImage` |
| Yoast SEO | `yoast_head_json` | `_yoast_wpseo_*` meta | `meta` group |
| Rank Math SEO | `rankmath/v1/getHead` | `rank_math_*` meta | `meta` group |
| Reusable blocks | `/wp/v2/blocks` | `wp_posts` (`post_type = 'wp_block'`) | Inlined into each document |

`wp_` stands for the configured table prefix.
