# Changelog

All notable changes to wp2payload are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). While the version is 0.x, a minor release can change
behaviour.

Report codes are described in [docs/reference/codes.md](docs/reference/codes.md).

## [Unreleased]

### Added

- `migrate --since <date>` writes only documents changed since that date or time, for a
  launch-day sync after a content freeze.
- `wp2payload review` goes through quarantined items one by one (or `--list`, `--approve <id>`,
  `--reject <id>`, `--all`). Approvals are saved in `.wp2payload/review.json` and apply on the
  next run. Only unknown iframe hosts and hidden blocks with links can be approved.
- Authors can map into an auth collection. Each new account gets a random password that is never
  shown or saved. `migrate --invite-users` sends Payload's forgot-password email to each account
  the run created; the run stops before writing if Payload has no email adapter.
- `migrate --include-pii` allows author emails in the report. By default the report and the
  output hold no email addresses.
- Every `migrate`, dry runs and stopped runs included, writes `.wp2payload/security-report.html`:
  a self-contained, script-free page of the findings. `report --html [path]` writes it again from
  the last `report.json`.
- Zip and tar backups: `source.type: 'archive'` reads a Duplicator `*_archive.zip` or any `.zip`,
  `.tar.gz`, `.tgz` or `.tar` that holds the dump and `wp-content/uploads`. A `sql` source takes
  `uploads` (one or more uploads archives, such as UpdraftPlus `-uploads.zip` files) instead of
  `uploadsDir`.
- Archive safety checks run before anything is read. A hostile archive is refused with a
  `SEC_ARCHIVE_*` code: path traversal, links, device and special files, Windows device names,
  overlapping zip entries, and caps on entry count, unpacked size and compression ratio.
- `scan` accepts zip and tar backups, and `--uploads` can be repeated and can name uploads
  archives. An UpdraftPlus `-db.gz` finds its `-uploads*.zip` files next to it.
- `AUTHOR_ACCOUNT_CREATED` warning for each login account a run creates, also shown on the
  summary's `accounts` line and in the HTML report.

### Fixed

- `report --html` writes only to `.html` or `.htm` paths, and temporary files are created
  exclusively with a random name.
- Email addresses with Unicode letters are redacted in reports.
- Archive reading: Windows device names in every folder of a path, tar dump extraction, cleanup
  of the temporary folder on errors and Ctrl+C, and overlapping zip entries.

### Security

- Raised the `next` override to `>=16.4.5` for GHSA-mfr8-8qww-v76h. `next` is only a development
  dependency (through Payload) and is not installed with wp2payload.
- Dependency updates, including `sanitize-html` 2.18.2.

## [0.3.0] - 2026-11-05

### Added

- `wp2payload scan [target]`: a security and content health report of a site, export or backup,
  without migrating and without a Payload project. Writes `.wp2payload/scan.json` and
  `.wp2payload/scan.html`. Options: `--uploads`, `--no-media`, `--limit`, `--concurrency`,
  `--fail-on-security`, `--allow-svg`, `--allow-embed-host`, `--json`, `--verbose`.

## [0.2.0] - 2026-11-05

### Added

- Backup sources. `source.type: 'sql'` reads a SQL dump (`.sql` or `.sql.gz`) with the uploads
  folder. `source.type: 'wpress'` reads an All-in-One WP Migration backup in place. The dump is
  parsed as text and never executed, and media is read from the uploads, so nothing is
  downloaded.
- The hacked-site suite also runs over a SQL backup.

### Fixed

- Backup files are checked and read through one open file handle.

## [0.1.0] - 2026-11-03

### Added

- `source.type: 'wxr'` migrates from a WordPress export file (Tools → Export). The file is
  streamed and parsed without DTDs or entity expansion; a file with a `DOCTYPE` is refused.
- The hacked-site suite also runs over the export.

## [0.0.7] - 2026-11-03

### Added

- The hacked-site fixture: a WordPress seeded with the threats in the security model, migrated in
  CI on every change and before every release.
- Reports flag page builders (`PAGE_BUILDER_LAYOUT`), shortcodes (`SHORTCODE_NOT_MIGRATED`) and
  post types that are not migrated (`DOC_TYPE_UNMAPPED`).

### Fixed

- Threats on wrapper markup that the normaliser rebuilds, and inside skipped dynamic blocks, are
  reported.
- `.wp2payload/.gitignore` is created without a race.
- The fixture scripts read `.env` and the cached test data without a check-then-use race.

## [0.0.6] - 2026-11-02

### Added

- Commands find `wp2payload.config.ts` from a project subfolder.
- Reusable blocks (synced patterns) are inlined from the REST API.
- Links to attachment pages and media files become links to the migrated uploads.
- Security scanning in CI (pnpm audit, OSV-Scanner, CodeQL), OpenSSF Scorecard, Dependabot and
  `SECURITY.md`.
- Property-based fuzzing of the sanitizer, slugs, SEO head and redirect paths.

### Fixed

- Slugs are kept in Unicode NFC, lone surrogates no longer break a run, and raw-text element
  content is dropped.

## [0.0.5] - 2026-10-31

### Changed

- The real run reuses the media downloaded by the first-run preview.

### Fixed

- REST responses are streamed with a 64 MB size cap.
- SEO canonicals with credentials are dropped, and percent-encoded slugs are decoded.

## [0.0.4] - 2026-10-30

### Added

- Rank Math SEO through its headless API. `seo.plugin` (`auto`, `yoast`, `rankmath`, `none`) is
  honoured.

### Fixed

- Short fields are parsed with the sanitizer and decoded only once.

## [0.0.3] - 2026-10-30

### Added

- Gutenberg block parser and normaliser, with custom transformers.
- Allowlist content sanitizer with hidden-link and spam detection.
- HTML to Lexical conversion, with old URLs resolved to migrated media and documents.
- `docs/reference/codes.md`, the reference for report codes.
- Payload boot from the project's config, and a check of the target collections before writing.
- Documents loader with field mapping and a relationship pass.
- `report.json`, the CLI summary, exit codes and the `report` command.
- The `migrate` and `reset` commands.
- `init` with the blog preset scaffold.
- Redirects from old WordPress URLs, written to `@payloadcms/plugin-redirects` or to
  `.wp2payload/redirects.json`.

## [0.0.2] - 2026-10-29

### Added

- `wpMeta` upserts, the local ID cache (`.wp2payload/state.json`), and the term and author
  loaders.
- Media download with an SSRF guard, file type checks by content, and quarantine.
- Media loader with deduplication by SHA-256 of the original bytes and re-encoding of raster
  images.
- Releases are published from GitHub Actions through npm trusted publishing.

### Fixed

- Yoast SEO is read again per item when the collection response returns another post's head.

## [0.0.1] - 2026-10-29

### Added

- First release: `wp2payload --version`, `--help` and `doctor`, the config schema with
  `defineConfig`, and the REST extractor.

[Unreleased]: https://github.com/abdulrehmankz1/wp2payload/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/abdulrehmankz1/wp2payload/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/abdulrehmankz1/wp2payload/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/abdulrehmankz1/wp2payload/compare/v0.0.7...v0.1.0
[0.0.7]: https://github.com/abdulrehmankz1/wp2payload/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/abdulrehmankz1/wp2payload/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/abdulrehmankz1/wp2payload/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/abdulrehmankz1/wp2payload/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/abdulrehmankz1/wp2payload/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/abdulrehmankz1/wp2payload/releases/tag/v0.0.2
[0.0.1]: https://www.npmjs.com/package/wp2payload/v/0.0.1
