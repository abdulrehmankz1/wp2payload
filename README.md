# wp2payload

[![npm version](https://img.shields.io/npm/v/wp2payload.svg)](https://www.npmjs.com/package/wp2payload)
[![CI](https://github.com/abdulrehmankz1/wp2payload/actions/workflows/ci.yml/badge.svg)](https://github.com/abdulrehmankz1/wp2payload/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/abdulrehmankz1/wp2payload/badge)](https://scorecard.dev/viewer/?uri=github.com/abdulrehmankz1/wp2payload)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Migrate a WordPress site into [Payload CMS 3](https://payloadcms.com): posts, pages,
media, categories, tags, authors, SEO metadata and redirects, from the live site, a
WordPress export file or a backup. Safe to re-run, and it keeps a hacked site's junk out of your new one.

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
- A WordPress site reachable over its REST API, an export file from **Tools → Export**
  (see [From an export file](#from-an-export-file-wxr)), or a backup: a SQL dump with the uploads
  folder, or an All-in-One WP Migration `.wpress` file (see [From a backup](#from-a-backup)).
  For the REST API, an
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
| `doctor` | Checks Node.js, your Payload installation and the WordPress site or export file. Writes nothing. |
| `migrate` | Runs the migration. Safe to re-run: existing items are updated, not duplicated. |
| `scan [target]` | Security and content health report of a site, without migrating. Needs no Payload project (see [Scanning a site](#scanning-a-site)). |
| `report` | Prints the last migration report again (`--json` for the raw file). |
| `reset` | Deletes local state and the cache. Never touches your database. |

Run commands from your project folder or any folder inside it: wp2payload uses the nearest
folder above that has `wp2payload.config.ts`, without going past your project's `package.json`.

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

### From an export file (WXR)

When the REST API is blocked or you only have an export, use the file from
**Tools → Export → All content** instead:

```ts
source: { type: 'wxr', file: './export.xml' },
```

The export holds posts, pages, terms, authors and SEO fields, but not the files: media is
still downloaded from the site named in the export, so it must be online (`doctor` says
which). That address comes from the file, so it is held to the full download guard (https,
no private addresses). To download from a local copy of the site (`localhost`, LocalWP),
name it yourself with `url: process.env.WP_URL`; it then counts as the source host, as with
the REST source. Yoast and Rank Math titles are stored as templates; the common variables
(`%%title%%`, `%%sitename%%`, `%%sep%%`) are filled in, and a title with any other variable
is left out and reported. The file is read as a stream and parsed without DTDs or entity
expansion; a file with a `DOCTYPE` is refused.

### From a backup

When the site is gone and only a backup is left, read it directly. Nothing is downloaded and
no database server is needed:

```ts
// A SQL dump (.sql or .sql.gz: mysqldump, phpMyAdmin, hosting backups) and wp-content/uploads
source: { type: 'sql', file: './backup.sql.gz', uploadsDir: './uploads' },
// tablePrefix: 'wp_' is the default; doctor names the prefix the dump uses if it differs.

// Or an All-in-One WP Migration backup, read in place without unpacking
source: { type: 'wpress', file: './site.wpress' },
```

The dump is read as text and never run against a database, so triggers, procedures and the
rest of a hacked dump have no effect, and only the columns wp2payload needs are kept: password
hashes and emails are never read. Old URLs are rebuilt from the permalink settings in the dump.
Media paths from the dump must stay inside the uploads folder or archive. Encrypted `.wpress`
backups cannot be read.

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
| Posts and pages | Your mapped collections, with Lexical content, excerpt, dates, author, categories, tags, featured image and draft status. Links to other migrated posts and pages become internal links; links to media files (any size) and attachment pages become internal links to the upload when your link feature allows the media collection |
| Reusable blocks (synced patterns) | Inlined into each document that uses them, nested ones included. With credentials they are read from `/wp/v2/blocks`; without, WordPress serves rendered content that already contains them |
| Media | Your upload collection, deduplicated by content hash, with alt text and caption |
| Categories (with hierarchy) and tags | Your mapped collections |
| Authors | Name and slug only, and only users who wrote migrated content |
| Yoast SEO and Rank Math | The SEO group (`meta` by default): title, description, image, and noindex and off-site canonicals when your group has them. Rank Math needs **Headless CMS Support** turned on (General Settings → Others); `doctor` tells you when it is off |
| Old URLs | Redirects |

An internal link to an upload points at the media document, so your frontend's link component
should use that document's `url` (a component that always builds `/<slug>` would give a broken link).

Passwords, roles and capabilities are never migrated. Blocks with no stored content
(query loops, navigation) are reported, and unknown blocks are kept as sanitized HTML.
Pages built with Elementor, Divi, WPBakery or Beaver Builder keep their text, images and
links but not their layout; shortcodes stay as text; other post types (such as WooCommerce
products) are not migrated yet. Each of these is listed in the report, and `doctor` names the
post types it will skip.

## Scanning a site

`scan` reads a site the way a migration would and reports what it found, without Payload and
without writing anything but the report. Point it at a site, an export or a backup:

```bash
npx wp2payload scan https://oldsite.com          # WP_USER and WP_APP_PASSWORD from the environment, if set
npx wp2payload scan ./export.xml
npx wp2payload scan ./backup.sql.gz --uploads ./uploads
npx wp2payload scan ./site.wpress
npx wp2payload scan                              # the source in wp2payload.config.ts
```

Every document goes through the same security scan and sanitizer as a migration, and every
media file through the same download guard and verification (`--no-media` skips them). The
report covers security findings, page builders, shortcodes, SEO coverage and the post types a
migration would leave behind. It is written to `.wp2payload/scan.json` and
`.wp2payload/scan.html`, a self-contained page you can hand to a client: no scripts, and every
value from the site escaped. `--fail-on-security <level>` exits with code 4 when findings at that
level exist, for CI. The report is not a malware scan of the server and does not certify that
the site is clean.

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

A second fixture is a deliberately hacked WordPress site
([`tests/fixtures/hacked-site`](tests/fixtures/hacked-site/README.md)). CI migrates it on every
change and before every release, and checks that none of its threats reach Payload:

```bash
corepack pnpm fixture:hacked   # needs Docker
corepack pnpm test:security    # hacked-site run and sanitizer fuzzing
```

## Security

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/abdulrehmankz1/wp2payload/security/advisories/new)
rather than in public issues. See [SECURITY.md](SECURITY.md) for response times and scope.

## License

[MIT](LICENSE) © Abdul Rehman
