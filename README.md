# wp2payload

[![npm version](https://img.shields.io/npm/v/wp2payload.svg)](https://www.npmjs.com/package/wp2payload)
[![CI](https://github.com/abdulrehmankz1/wp2payload/actions/workflows/ci.yml/badge.svg)](https://github.com/abdulrehmankz1/wp2payload/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Migrate a WordPress site into [Payload CMS 3](https://payloadcms.com): posts, pages,
media, categories, tags, authors, SEO metadata and redirects. Safe to re-run, and it
keeps a hacked site's junk out of your new one.

> **Status: early (0.x).** The full pipeline works and is tested against WordPress
> Theme Unit Test data, but it has not yet been used on many real sites. Run it
> against a copy of your database first, and please report anything that breaks.

## Why wp2payload

- **Safe to re-run.** Every migrated document records where it came from, so running
  the migration again updates existing content instead of creating duplicates.
- **Keeps a hacked site's junk out.** Content is sanitized against an allowlist, and
  hidden link farms, injected scripts and unknown iframes are removed and saved to a
  quarantine folder for review. Media is downloaded through an SSRF guard, checked by
  its real content rather than its file name, and re-encoded to strip hidden payloads.
- **Gutenberg to Lexical.** Core blocks become Lexical rich text; images become upload
  nodes; links to migrated posts become internal links; YouTube and Vimeo embeds become
  blocks.
- **Works with your schema.** Content is written through Payload's Local API, so your
  collections, hooks and validation apply as usual. Only fields your collections have
  are written.
- **Tells you what it could not move.** Every skipped block, missing reference and
  security finding is listed in a report.

## Requirements

- Node.js 22.12 or newer
- A Payload CMS 3 project (any database adapter)
- A WordPress site reachable over its REST API. An
  [Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/)
  is optional but recommended: without it only published content is read, and
  Gutenberg block markup is not available.

## Quick start

Run these from the root of your Payload project:

```bash
pnpm add -D wp2payload
npx wp2payload init --scaffold     # writes wp2payload.config.ts and blog collections
```

`init --scaffold` writes the blog collections to `src/collections/wp2payload/` and
prints the two lines to add to your `payload.config.ts`:

```ts
import { wp2payloadCollections } from './collections/wp2payload'

export default buildConfig({
  collections: [...wp2payloadCollections /* , your other collections */],
})
```

Then regenerate types and run the migration:

```bash
npx payload generate:types
npx wp2payload doctor              # checks everything without writing
npx wp2payload migrate --dry-run   # preview: what would be created, warnings, findings
npx wp2payload migrate             # asks for confirmation on the first run
```

If your project already has `posts`, `pages`, `categories` or `media` (the Payload
website template does), two collections with the same slug will not boot. `init`
warns about this: keep yours and map them in `wp2payload.config.ts` (see
[Using your existing collections](#using-your-existing-collections)), or remove yours.

Set the source in your `.env`:

```bash
WP_URL=https://oldsite.com
WP_USER=migration-editor          # optional: a dedicated user with the Editor role
WP_APP_PASSWORD=xxxx xxxx xxxx    # optional: revoke it after the migration
```

## Commands

| Command | What it does |
| --- | --- |
| `init` | Writes `wp2payload.config.ts` and appends `.wp2payload/`, `.env` and backup patterns to `.gitignore`. With `--url`, adds `WP_URL` to `.env`. With `--scaffold`, writes the blog preset collections as new files you own; existing files are never overwritten. Other flags: `--force` (replace `wp2payload.config.ts` only), `--yes` (no questions). Your TypeScript files are never edited. |
| `doctor` | Checks Node.js, your Payload installation and the WordPress connection. Writes nothing. |
| `migrate` | Runs the migration. Safe to re-run: existing items are updated, not duplicated. |
| `report` | Prints the last migration report again (`--json` for the raw file). |
| `reset` | Deletes local state and the cache. Never touches your database. |

### migrate options

| Flag | Meaning |
| --- | --- |
| `--config <path>` | Config file (default `wp2payload.config.ts`) |
| `--dry-run` | Extract and transform everything, write nothing |
| `--only <list>` | Limit phases (`media`, `terms`, `authors`, `documents`, `redirects`) or types (`posts`, `pages`), e.g. `--only media,posts`. `--only redirects` regenerates redirects from what is already migrated |
| `--limit <n>` | Write only the first n documents (all are still read, so links resolve) |
| `--concurrency <n>` | Parallel media downloads (default 4) |
| `--fresh` | Ignore the local ID cache; still upserts, so no duplicates |
| `--strict` | Exit with code 3 when there are warnings or errors |
| `--fail-on-security <level>` | Exit with code 4 when findings at `low`, `medium` or `high` exist |
| `--allow-svg` | Accept SVG uploads after a strict check |
| `--allow-embed-host <host>` | Trust another iframe host (YouTube and Vimeo are trusted by default) |
| `--yes` | Skip the first-run confirmation (for CI) |
| `--verbose` | List every warning and skipped phase |

Exit codes: `0` completed, `1` fatal error or stopped, `2` invalid config or usage,
`3` warnings or errors with `--strict`, `4` security findings at the `--fail-on-security`
level.

## Configuration

`init` writes a `wp2payload.config.ts` like this:

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
  // WordPress type → your Payload collection. `fields` renames target fields.
  collections: {
    post: { to: 'posts', fields: { featuredImage: 'heroImage' } },
    page: { to: 'pages' },
    category: { to: 'categories' },
    post_tag: { to: 'tags' },
    author: { to: 'authors' },
    media: { to: 'media' },
  },
  statuses: ['publish'],              // add 'draft', 'private' with an Application Password
  seo: { plugin: 'auto', field: 'meta' },   // 'auto', 'yoast', 'rankmath' or 'none'
  redirects: { enabled: true },
})
```

Secrets must come from environment variables: a literal password in the config is
rejected.

### Using your existing collections

Instead of `--scaffold`, point `collections` at the collections you already have and
add a `wpMeta` field to each of them. It is how re-runs find what was already
migrated. Copy it into your project (`init --scaffold` writes the same file to
`src/collections/wp2payload/wpMeta.ts`), so your build never depends on wp2payload:

```ts
import type { Field } from 'payload'

export const wpMeta: Field = {
  name: 'wpMeta',
  type: 'group',
  admin: { readOnly: true, position: 'sidebar', description: 'Set by wp2payload. Do not edit.' },
  fields: [
    { name: 'site', type: 'text', index: true },
    { name: 'wpId', type: 'number', index: true },
    { name: 'link', type: 'text' },
    { name: 'sha256', type: 'text', index: true },
    { name: 'importedAt', type: 'date' },
  ],
}
```

Then add `wpMeta` to the `fields` of each mapped collection. `migrate` checks every
mapped collection before writing anything and tells you exactly what is missing.

Fields that WordPress has but your collection does not are reported once
(`FIELD_NOT_IN_TARGET`) and skipped.

## Redirects

Every migrated post and page gets a redirect from its old WordPress URL:

- **Without the redirects plugin**, wp2payload writes `.wp2payload/redirects.json` in
  the format of Next.js
  [`redirects()`](https://nextjs.org/docs/app/api-reference/config/next-config-js/redirects).
  The file is built from source data, so review it, then copy it into your project
  and load it in `next.config.ts`:

  ```ts
  import type { NextConfig } from 'next'
  import wpRedirects from './redirects.json' with { type: 'json' }

  type Redirects = Awaited<ReturnType<NonNullable<NextConfig['redirects']>>>

  const nextConfig: NextConfig = {
    async redirects() {
      return wpRedirects as Redirects
    },
  }
  ```

  Set the new URL per type with `redirects.paths`, for example
  `{ post: '/blog/:slug', page: '/:slug' }` (the default is the Payload website
  template's `/posts/:slug` and `/:slug`).
- **With [`@payloadcms/plugin-redirects`](https://payloadcms.com/docs/plugins/redirects)**
  in your Payload config, redirects are written into its collection as references to
  the migrated documents. The plugin only stores them: your front end decides when to
  look them up. The website template checks them on its `/[slug]` and `/posts/[slug]`
  routes, so old URLs with more than one segment (such as `/2024/01/hello/` or
  child pages) also need a lookup in middleware or a catch-all route.

Redirects are never created for the site root, for Payload's admin and API routes,
`/_next`, or listing routes such as `/posts` and `/search`. A conflict (one old URL
claimed by two documents, two documents with the same new URL, an old URL equal to
another document's new URL, or an existing redirect that points to another document)
is reported as an error and left as it is. An existing redirect whose document was
deleted is pointed at the migrated document.
`migrate --only redirects` rebuilds them from what is already migrated.

## What gets migrated

| WordPress | Payload |
| --- | --- |
| Posts and pages | Your mapped collections, with Lexical content, excerpt, dates, author, categories, tags, featured image and draft status |
| Media | Your upload collection, deduplicated by content hash, with alt text and caption |
| Categories (with hierarchy) and tags | Your mapped collections |
| Authors | Name and slug only, and only users who wrote migrated content |
| Yoast SEO and Rank Math | The SEO group (`meta` by default): title, description, image, and noindex and off-site canonicals when your group has them. Rank Math needs **Headless CMS Support** turned on (General Settings → Others); `doctor` tells you when it is off |
| Old URLs | Redirects |

Passwords, roles and capabilities are never migrated. Blocks with no stored content
(query loops, navigation) are reported, and unknown blocks are kept as sanitized HTML.

## Reports and local files

Everything wp2payload writes locally lives in `.wp2payload/`, which ignores itself in
git:

- `report.json`: counts, warnings, errors, redirects and security findings. Every code
  is described in [`docs/reference/codes.md`](docs/reference/codes.md).
- `quarantine/`: removed fragments and rejected files, saved as inert text for review.
- `state.json`: a cache of WordPress to Payload IDs. Deleting it loses nothing,
  because the database is the source of truth.

## Development

```bash
corepack pnpm install
corepack pnpm test        # unit and integration tests
corepack pnpm build
```

Integration tests run against a real Payload instance on SQLite. A WordPress fixture
for end-to-end runs is described in
[`tests/fixtures/wordpress`](tests/fixtures/wordpress/README.md).

## Security

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/abdulrehmankz1/wp2payload/security/advisories/new)
rather than in public issues.

## License

[MIT](LICENSE) © Abdul Rehman
