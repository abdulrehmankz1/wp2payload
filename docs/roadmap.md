# Roadmap

wp2payload is in 0.x. The planned 1.x features below have shipped in 0.x releases ahead of 1.0.
Version 1.0 follows once the tool has been used on real sites end to end. What changed in each
release is in [CHANGELOG.md](../CHANGELOG.md).

## Done

| Planned as | Theme | Shipped |
| --- | --- | --- |
| v1.0 | Core: REST source; posts, pages, media, categories, tags, authors; Gutenberg to Lexical; Yoast and Rank Math SEO; redirects; the security baseline in [security.md](security.md) | 0.0.1 to 0.0.7 |
| v1.1 | Exports: WXR source with hardened XML parsing | 0.1.0 |
| v1.2 | Offline backups: SQL dump with the uploads folder, All-in-One WP Migration `.wpress` files | 0.2.0 |
| v1.2 | Offline backups: zip and tar backups (Duplicator, UpdraftPlus) with archive safety checks | Unreleased |
| v1.3 | Scan: `wp2payload scan`, a security and content health report without migrating | 0.3.0 |
| v1.4 | Launch-day sync: `migrate --since <date>` copies only content changed during a content freeze | Unreleased |
| v1.5 | Review: `wp2payload review` to approve or reject quarantined items one by one | Unreleased |

The v1.2 plan imported SQL dumps into a throwaway MySQL container. The shipped version parses the
dump as text instead and never executes it, so no Docker is needed
([ADR-0012](adr/0012-sql-sandbox.md)).

## Planned

| Version | Theme | Highlights |
| --- | --- | --- |
| v2.0 | Real-world sites | ACF and SCF fields, custom post types with auto-detection of CPT UI types, custom taxonomies, comments with spam filtering |
| v2.1 | Multilingual | WPML and Polylang into Payload localization, including right-to-left languages such as Arabic |
| v2.2 | Admin plugin | A wizard in the Payload admin, reusing the same core ([ADR-0002](adr/0002-cli-first.md)) |
| v2.3 | Commerce | WooCommerce products into a Payload commerce setup |
| v2.4 | Visual QA | Playwright screenshots of old and new pages, with a diff report |
| v3.0 | Beyond WordPress | Ghost, Strapi, Contentful and Sanity extractors using the same IR, each passing the same security suite |

## Ideas backlog (not committed)

- Opt-in AI alt text for images that lack it, using your own API key or a local model. Off by
  default; no content leaves the machine unless you turn it on.
- An optional ClamAV scan of uploads, on top of the media checks.
- A Next.js starter that renders migrated content and applies the redirects out of the box.
- A GitHub Action for running migrations in CI pipelines.
- Contact Form 7 form definitions mapped to Payload form-builder forms. Fields only: submissions
  are personal data and stay opt-in.

## How features get added

1. An issue with a real use case.
2. A short design note, plus an ADR in [docs/adr](adr) if it changes the architecture.
3. Fixtures for normal and malicious input, before the code.
4. It must pass the hacked-site security suite. No exceptions for new sources.
