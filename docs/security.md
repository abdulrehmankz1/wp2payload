# Security model

WordPress is the most targeted CMS on the web, mostly through outdated plugins and themes. Many
sites that get migrated are migrated because they were compromised. A careless migration copies
the attack into the new site: injected scripts, hidden spam links, rogue admin accounts and
backdoor files disguised as images.

wp2payload treats the old site as untrusted input. Content is moved; attacks are not.

To report a vulnerability in wp2payload itself, see [SECURITY.md](../SECURITY.md).

## Principles

1. **All source data is hostile.** Titles, alt text, excerpts, meta, filenames, archive entry
   names and file contents are all attacker-controlled.
2. **Allowlist, never blocklist.** Only known-safe tags, attributes, URL schemes and file types
   get through.
3. **Quarantine, don't import, and don't silently drop.** Dangerous content is removed from the
   CMS but kept locally with a reason, for a person to review.
4. **Never execute anything from the source.** No PHP, no JavaScript, and no SQL from a dump.
5. **Least privilege.** A WordPress user with the Editor role, and credentials revoked after the
   migration.
6. **Secure by default.** Loosening a rule needs an explicit flag or config key, and the report
   shows it.

## Threat model

| # | Threat | Example on a hacked site | Mitigation |
| --- | --- | --- | --- |
| T1 | Script injection in content | `<script>`, `onerror=` on images, `javascript:` links | Allowlist sanitizer, URL scheme allowlist |
| T2 | Script injection in short fields | Markup in a title, alt text or excerpt | Short fields become plain text |
| T3 | SEO spam ("pharma hack") | Hundreds of casino links in `display:none` blocks | Hidden-content detection, removal and quarantine |
| T4 | Malicious redirects | `<meta http-equiv="refresh">`, script that sets `location` | Removed, flagged high |
| T5 | Rogue iframes | Iframes to unknown domains loading malware | Only allowlisted embed hosts; the rest quarantined |
| T6 | Backdoor files in uploads | `logo.jpg.php`, `shell.phtml`, PHP inside a JPEG | Executable-extension check, type by content, re-encoding |
| T7 | Malicious SVG | SVG with an embedded `<script>` | Rejected; with `--allow-svg`, a strict check that rejects any active content |
| T8 | Rogue user accounts | An attacker-created admin with no posts | Roles never migrated; only users with migrated content become authors |
| T9 | SSRF through media URLs | Media at `http://169.254.169.254/` or an internal IP | Host allowlist, private addresses blocked after DNS resolution |
| T10 | Path traversal | A file name `../../.env` in an export, dump or archive | File names regenerated; paths must stay inside the uploads |
| T11 | Archive attacks | Zip slip, zip bombs, links in backups | Entry checks, size, count and ratio caps, links and devices refused |
| T12 | XML attacks in exports | XXE, "billion laughs" entity expansion | No DTDs or entities; a `DOCTYPE` is refused; size limits |
| T13 | Malicious SQL dump | A dump that creates users or triggers, or touches other databases | Dumps are parsed as text and never executed |
| T14 | Credential leakage | Application Password in the config or in Git | Secrets only from the environment; `.gitignore` entries |
| T15 | Supply-chain attack on wp2payload | A compromised dependency or npm account | See [Supply chain](#supply-chain) |

All mitigations are on by default.

## Content sanitization

Each post goes through three steps before anything reaches Lexical:

1. **Scan.** The raw HTML is scanned for threats first, so hidden wrappers and stylesheet rules
   are seen before the Gutenberg normaliser rebuilds the markup.
2. **Sanitize.** Each block, including the output of [custom transformers](guides/custom-transformers.md),
   goes through `sanitize-html` with the allowlist in `src/security/content/policy.ts`:

   ```ts
   allowedTags: [
     'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a',
     'strong', 'em', 'b', 'i', 'u', 's', 'sub', 'sup', 'blockquote',
     'code', 'pre', 'br', 'hr', 'img', 'figure', 'figcaption',
     'table', 'thead', 'tbody', 'tr', 'th', 'td',
   ],
   allowedAttributes: {
     a: ['href', 'title'],
     img: ['src', 'alt', 'title', 'width', 'height'],
     th: ['colspan', 'rowspan'],
     td: ['colspan', 'rowspan'],
   },
   allowedSchemes: ['http', 'https', 'mailto', 'tel'],
   allowProtocolRelative: false,
   ```

3. **Check the whole post again.** A report-only pass over the whole post adds findings that
   only existed on wrapper markup or in skipped dynamic blocks.

Other rules:

- `style` and all `on*` attributes are always removed. `javascript:`, `data:` and `vbscript:`
  URLs are removed, including obfuscated forms.
- External links get `rel="nofollow noopener"` (`security.externalLinkRel`) when the target link
  feature has a `rel` field, so leftover spam links pass no SEO value.
- Iframes from `security.embedHosts` (YouTube and Vimeo by default) over https become embed
  blocks. Other iframes are quarantined.
- Titles, excerpts, alt text, captions and SEO fields become plain text, with entities decoded
  once and all markup removed.
- Markup nested more than 4096 levels deep, or too costly to parse, is dropped without parsing.

## Spam and injection detection

| Signal | Severity | Action | Code |
| --- | --- | --- | --- |
| Links inside an element hidden by CSS or the `hidden` attribute | High | Quarantined | `SEC_HIDDEN_LINKS` |
| `<script>` | High | Quarantined | `SEC_SCRIPT_TAG` |
| `<meta http-equiv="refresh">` | High | Quarantined | `SEC_META_REFRESH` |
| Script or event handler that changes `location` | High | Quarantined or removed | `SEC_JS_REDIRECT` |
| `on*` attribute | High | Removed | `SEC_EVENT_HANDLER` |
| Long base64 runs (200 characters or more) or obfuscated script (`eval(`, `atob(`) | Medium | Quarantined | `SEC_OBFUSCATED` |
| Iframe from an unknown host, or not https | Medium | Quarantined | `SEC_IFRAME_UNKNOWN_HOST` |
| Hidden text without links (often an accordion or tab) | Low | Kept, flagged | `SEC_HIDDEN_TEXT` |
| A post with far more external links than the site median (3 times the median, at least 10) | Low | Kept, flagged | `SEC_LINK_HEAVY` |
| Link text matching known spam keywords | Low | Kept, flagged | `SEC_SPAM_KEYWORDS` |

Low-severity items are only flagged, never removed, so legitimate content is not deleted on a
weak signal. The full list of codes is in [reference/codes.md](reference/codes.md).

## Media safety

1. **Download guard** (REST and export sources). https only, only the source host and
   `media.allowedHosts`, at most 3 redirects, a 30-second timeout and a size cap
   (`media.maxFileSizeMB`, default 50).
2. **SSRF guard.** DNS is resolved first, private, loopback, link-local and reserved addresses
   are blocked, and the connection goes to the vetted address. The Host header and TLS name still
   use the URL's host name, and there is no second lookup, so the host cannot switch address
   between check and use.
3. **The configured source host.** The host in `source.url` is trusted because you configured
   it. Its addresses are allowed even when they are loopback or private, which covers local
   restores (`localhost`, LocalWP `.local` domains) and Docker service names. Plain http is
   accepted for that host only when it resolves to a loopback or private address. Every other host,
   including those in `media.allowedHosts`, gets the full guard. Each use of this exception is
   reported (`MEDIA_SOURCE_HOST_EXCEPTION`).
4. **Type by content, not by name.** The real type is detected from the file's bytes
   (`file-type`). It must be on the allowlist (JPEG, PNG, GIF, WebP, AVIF, PDF, MP4, QuickTime
   MOV, MP3) and match the file's extension.
5. **Executables rejected.** Any executable or active extension anywhere in the name (`.php`,
   `.phtml`, `.phar`, `.js`, `.html`, `.htaccess`, `.xml` and more) is rejected as high severity,
   so `logo.jpg.php` and `x.php .jpg` are caught.
6. **Raster images re-encoded** with `sharp` (default on, quality 90). This destroys polyglot
   payloads and strips EXIF metadata, including GPS location
   ([ADR-0011](adr/0011-reencode-images.md)).
7. **SVG rejected by default.** With `--allow-svg`, an SVG is imported unchanged only when every
   element, attribute and value is on a strict allowlist ([ADR-0010](adr/0010-svg-rejected.md)).
8. **File names regenerated** from a slug of the original name plus a hash.
9. **PDFs are not re-encoded.** A PDF with `/JavaScript`, `/OpenAction`, `/Launch` or an object
   stream that cannot be decoded is quarantined as medium severity.

Backup sources read media from the uploads, so nothing is downloaded. A media path from the dump
must stay inside the uploads folder or archive.

## File and archive inputs

**Export files (WXR).** Streamed and parsed with DTDs and entity processing off. A file with a
`DOCTYPE` is refused. Size is capped at 2 GB, with limits on nesting depth and item size.

**SQL dumps.** Read as text by a streaming parser and never executed, against any database
([ADR-0012](adr/0012-sql-sandbox.md)). Only `CREATE TABLE` column lists and `INSERT` rows of the
seven tables wp2payload needs are kept, and only listed columns: `user_pass` and `user_email` are
never read. Triggers, procedures, users, grants and every other statement are skipped unread. The
dump is capped at 8 GB unpacked.

**.wpress backups.** Read in place without unpacking. Entry names are only lookup keys.

**Zip and tar backups.** Every entry is checked before anything is read, and a hostile archive is
refused as a whole:

- names that leave the archive: `..`, absolute paths, drive letters, NUL characters, backslash
  tricks, and (tar, where files are unpacked) Windows device names such as `CON` or `nul .jpg`;
- symbolic and hard links, devices, FIFOs, sockets and sparse entries;
- zip entries whose data overlap;
- more than 1,000,000 entries, more than 64 GB unpacked, or a compression ratio over 100:1 for an
  entry over 1 MB.

## Credentials and access

- Use a dedicated WordPress user with the Editor role, not Administrator. Editor can read drafts
  and private content.
- Revoke the Application Password after the migration. `doctor` and the end of every real
  `migrate` print this reminder.
- https is required for remote sources. Plain http is accepted only when the source host
  resolves to a loopback or private address, such as a local restore or a Docker fixture.
- Secrets come only from environment variables. A literal `appPassword` in the config is
  rejected.
- `init` adds `.wp2payload/`, `.env` and backup file patterns to `.gitignore`.
- There is no telemetry ([ADR-0007](adr/0007-no-telemetry.md)).

## Users and accounts

- WordPress roles, capabilities and password hashes are never migrated.
- Only users who wrote at least one migrated document become authors. Attacker-created accounts
  usually have no content, so they are left out and listed as `AUTHOR_NOT_MIGRATED`.
- When authors map into an auth collection, each account gets a random password that is never
  shown or saved. Every account a run creates is listed as `AUTHOR_ACCOUNT_CREATED`, because on a
  hacked site the attacker's own user often wrote the spam posts and qualifies too. Check each one
  before go-live.
- Reports hold no email addresses unless you pass `--include-pii`.

## Quarantine

```text
.wp2payload/quarantine/
  content/<hash>-post-981.html.txt       removed fragment, saved as inert text
  content/<hash>-post-981.reason.json    finding, original name, sha256, size, time
  files/logo.jpg.php.quarantined         rejected upload, renamed, not executable
  files/logo.jpg.php.reason.json
```

Files are created with owner-only permissions and never overwritten.

Quarantined items are never imported on their own. `wp2payload review` goes through them one by
one. Only an iframe from an unknown host and a hidden block with links can be approved; scripts,
event handlers, dangerous URLs and rejected uploads can only be rejected. Approvals apply on the
next `migrate` and are listed as allowed findings in the report. At most 50 fragments are saved
per document (`QUARANTINE_LIMIT`); the rest are still reported.

## Security report

Every run ends with a security block in the CLI output, the same findings in the `security`
section of `.wp2payload/report.json`, and `.wp2payload/security-report.html`. The HTML page is a
client deliverable: what was found on the old site, and what was kept out of the new one. It is
self-contained and inert, with no scripts, no links and nothing loaded from elsewhere, and every
value from the site is escaped.

`migrate --fail-on-security <level>` and `scan --fail-on-security <level>` exit with code 4 when
findings at or above that level exist.

## What wp2payload does not do

- It is not a malware scanner or a clean-up service. It keeps common attack payloads out of the
  new site, but it does not certify that the old site is clean.
- If a site is known to be compromised, treat the whole source as untrusted, rotate every
  credential the site ever used, and consider a professional clean-up of the old server.
- It does not secure the new Payload site. Check access control on every collection, login rate
  limiting, security headers including a Content Security Policy, safe rich-text rendering (no
  `dangerouslySetInnerHTML` on unsanitized data), and regular dependency updates.

## Supply chain

A migration tool runs with database credentials, so it has to be trustworthy itself.

| Control | How |
| --- | --- |
| Publish integrity | npm trusted publishing (OIDC) from GitHub Actions, with provenance. No npm token is stored anywhere |
| Release gate | The release workflow publishes only after the hacked-site suite passes, and checks the tag matches `package.json` |
| No install-time code | No `postinstall` or other lifecycle scripts. CI installs the packed tarball with `--ignore-scripts` and runs it |
| Small dependency tree | Every new dependency needs a reason in the pull request |
| Dependency updates | Dependabot, grouped weekly, with a 7-day cooldown on new releases |
| Vulnerability scanning | `pnpm audit --prod` and OSV-Scanner on every pull request and weekly |
| Code scanning | GitHub CodeQL (`security-extended`) on every pull request and weekly |
| CI hardening | Third-party Actions pinned by commit SHA; `permissions` set per workflow and job |
| Project health | OpenSSF Scorecard |

## Security testing

- **Hacked-site fixture.** `tests/fixtures/hacked-site/` is a WordPress seeded with the threats
  above: script tags, event handlers, hidden spam blocks, malicious redirects, rogue iframes, a
  `.jpg.php` upload, a PHP-in-JPEG polyglot, a scripted SVG, a PDF with JavaScript, SSRF media
  URLs and a rogue admin. The end-to-end tests migrate it through the REST API, the export, a SQL
  backup and a zip backup, and scan it. They assert that none of it reaches Payload and that every
  item appears in the security report. Because the fixture runs on a local Docker host, the tests
  also prove the source-host exception stays narrow: a media URL pointing at another internal
  address is still blocked.
- **Unit tests** cover XXE and entity expansion in exports, hostile dumps, and path traversal and
  bombs in `.wpress`, zip and tar archives.
- **Property-based fuzzing** (`fast-check`) of the sanitizer: for any generated input, the output
  never contains `<script`, `on*=` attributes, `javascript:` or `data:` URLs. Slugs, the SEO head
  and redirect paths are fuzzed too.
- **Regression rule.** Every security bug gets a fixture or test before its fix is merged.
- **Inert samples.** Every attack sample is an inert test string, such as an `alert()` call or a
  PHP file that only echoes a word. Never real malware.
