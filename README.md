# wp2payload

[![npm version](https://img.shields.io/npm/v/wp2payload.svg)](https://www.npmjs.com/package/wp2payload)
[![CI](https://github.com/abdulrehmankz1/wp2payload/actions/workflows/ci.yml/badge.svg)](https://github.com/abdulrehmankz1/wp2payload/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Migrate a WordPress site into [Payload CMS 3](https://payloadcms.com): posts, pages,
media, categories, tags, authors, SEO metadata and redirects.

> **Status: early development.** The `doctor` command is available today. The
> `migrate` command is in progress and not yet published. Do not use this on a
> production site yet.

## Why wp2payload

- **Safe to re-run.** Every imported document records where it came from, so running
  the migration again updates existing content instead of creating duplicates.
- **Keeps a hacked site's junk out.** Media is downloaded through an SSRF guard,
  checked by its real content rather than its file name, re-encoded to strip hidden
  payloads and metadata, and anything suspicious is quarantined and reported.
- **Works with your schema.** Content is written through Payload's Local API, so
  your collections, hooks and validation apply as usual.

## Requirements

- Node.js 22.12 or newer
- A Payload CMS 3 project

## Usage

Run from the root of your Payload project:

```bash
npx wp2payload doctor
```

`doctor` checks your Node.js version, your Payload installation and, when a
`wp2payload.config.ts` is present, the connection to your WordPress site. It
does not write anything.

```bash
npx wp2payload --version
npx wp2payload --help
```

## Roadmap

| Area | Status |
| --- | --- |
| `doctor` command | Available |
| WordPress REST API extraction | Done, unreleased |
| Categories, tags and authors | Done, unreleased |
| Media import with security checks | Done, unreleased |
| Posts, pages, blocks and SEO | In progress |
| `migrate` command and report | Planned |
| Redirects | Planned |

## Development

```bash
corepack pnpm install
corepack pnpm test        # unit and integration tests
corepack pnpm build
```

Integration tests run against a real Payload instance on SQLite. An optional
WordPress fixture for end-to-end checks is described in
[`tests/fixtures/wordpress`](tests/fixtures/wordpress/README.md).

## Security

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/abdulrehmankz1/wp2payload/security/advisories/new)
rather than in public issues.

## License

[MIT](LICENSE) © Abdul Rehman
