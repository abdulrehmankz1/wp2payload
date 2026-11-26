# Report codes

Every warning, error and security finding in `.wp2payload/report.json` (and in `.wp2payload/security-report.html`, the same report as HTML) carries one of these codes. Codes are stable: once released, a code keeps its meaning. New codes may be added.

## Security findings

Severity decides the exit code with `--fail-on-security <level>`. Actions: `removed` (stripped, rest kept), `quarantined` (removed and saved under `.wp2payload/quarantine/`), `rejected` (file not imported), `flagged` (kept, listed for review), `allowed` (kept by an explicit option).

### Content

| Code | Severity | Action | Meaning |
| --- | --- | --- | --- |
| `SEC_SCRIPT_TAG` | high | quarantined | A `<script>` element in content |
| `SEC_META_REFRESH` | high | quarantined | A `<meta http-equiv="refresh">` redirect |
| `SEC_JS_REDIRECT` | high | quarantined or removed | Script or event handler that changes `location` |
| `SEC_EVENT_HANDLER` | high | removed | An `on*` attribute such as `onerror` |
| `SEC_DANGEROUS_URL` | high | removed | A `javascript:`, `data:` or `vbscript:` URL, including obfuscated forms |
| `SEC_HIDDEN_LINKS` | high | quarantined | Links inside an element hidden by CSS or the `hidden` attribute (SEO spam) |
| `SEC_IFRAME_UNKNOWN_HOST` | medium | quarantined | An iframe whose host is not in `security.embedHosts`, or not https |
| `SEC_OBFUSCATED` | medium | quarantined | Long base64 runs or obfuscated script such as `eval(` or `atob(` |
| `SEC_FORGED_EMBED` | medium | quarantined | A `<wp2p-embed>` placeholder that the sanitizer did not write |
| `SEC_SCAN_UNSTABLE` | high | quarantined | Markup kept changing under the security scan; the whole block was dropped |
| `SEC_NESTING_LIMIT` | high | quarantined | Markup nested more than 4096 levels deep; dropped without parsing |
| `SEC_MARKUP_LIMIT` | high | quarantined | Markup too costly to parse safely; dropped without parsing |
| `SEC_HIDDEN_TEXT` | low | flagged | Hidden text without links, kept (often an accordion or tab) |
| `SEC_LINK_HEAVY` | low | flagged | Far more external links than the site's median post |
| `SEC_SPAM_KEYWORDS` | low | flagged | Link text matching known spam keywords |

### Media

| Code | Severity | Action | Meaning |
| --- | --- | --- | --- |
| `SEC_EXECUTABLE_UPLOAD` | high | rejected | Executable extension anywhere in the name, such as `logo.jpg.php` |
| `SEC_TYPE_MISMATCH` | high | rejected | The name claims an allowed type but the content is something else |
| `SEC_TYPE_NOT_ALLOWED` | medium | rejected | The content is a type outside the allowlist |
| `SEC_SVG_REJECTED` | medium or high | rejected | SVG without `--allow-svg` (medium), or SVG with active content (high) |
| `SEC_SVG_ALLOWED` | low | allowed | SVG imported because of `--allow-svg`, after a strict check |
| `SEC_PDF_ACTIVE_CONTENT` | medium | quarantined | PDF with JavaScript, OpenAction, Launch or an undecodable object stream |
| `SEC_IMAGE_UNDECODABLE` | medium | rejected | Looks like an image but cannot be decoded |
| `SEC_MIME_MISMATCH` | low | flagged | WordPress declared a different MIME type than the content |
| `SEC_REENCODE_DISABLED` | low | allowed | Image stored without re-encoding because `media.reencode` is off |
| `SEC_SSRF_BLOCKED` | high | rejected | Media URL resolves to a private or reserved address |
| `SEC_HOST_NOT_ALLOWED` | high | rejected | Media host is neither the source host nor in `media.allowedHosts` |
| `SEC_INSECURE_SCHEME` | high | rejected | Plain http, or a non-http scheme, for a media URL |
| `SEC_TOO_MANY_REDIRECTS` | high | rejected | More than 3 redirects |
| `SEC_FILE_TOO_LARGE` | high | rejected | Over `media.maxFileSizeMB` |
| `SEC_PATH_TRAVERSAL` | high | rejected | Backup sources: the dump names a media file outside the uploads folder (`../`, an absolute path, or a link that points out) |

### Backup archives

Zip and tar backups (`source.type: 'archive'`, and `source.uploads` archives of a `sql` source) are checked before anything is read from them. A hostile archive is refused as a whole: `migrate`, `scan` and `doctor` stop with the code in the message, nothing is migrated, and no report is written. Caps and the rules they enforce are in the README under [From a backup](../../README.md#from-a-backup).

| Code | Severity | Action | Meaning |
| --- | --- | --- | --- |
| `SEC_ARCHIVE_PATH_TRAVERSAL` | high | refused | An entry name that leaves the archive folder: `..`, an absolute path, a drive letter or a colon, a NUL character, the same tricks with backslashes, or (tar, where files are unpacked) a name Windows reserves or trims in any folder of the path: `CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`, `LPT0`-`LPT9` (superscript ¹²³ too), `CONIN$`, `CONOUT$`, with any extension and spaces before the dot (`con .sql`), or a name ending in a dot or space |
| `SEC_ARCHIVE_LINK` | high | refused | A symbolic or hard link entry |
| `SEC_ARCHIVE_SPECIAL_FILE` | high | refused | A device, FIFO, socket, sparse or other entry that is not a regular file or folder |
| `SEC_ARCHIVE_TOO_LARGE` | high | refused | The dump and uploads of a zip, or a whole tar, unpack to more than 64 GB; or (tar) the `.sql`/`.sql.gz` files that could be the dump, kept on disk together while it is unpacked, pass the 8 GB dump cap. Only candidates that can still be picked are kept, so a backup with one dump never hits this |
| `SEC_ARCHIVE_TOO_MANY_FILES` | high | refused | More than 1,000,000 entries |
| `SEC_ARCHIVE_RATIO` | high | refused | A zip entry over 1 MB that unpacks to more than 100 times its packed size, or a tar.gz stream that does (zip bomb) |
| `SEC_ARCHIVE_OVERLAP` | high | refused | Two zip entries whose data overlap, so the same packed bytes would be unpacked several times (overlap zip bomb). Zip tools never write this |

## Warnings

| Code | Meaning |
| --- | --- |
| `UNKNOWN_BLOCK` | Blocks no rule or transformer handles, listed once per document with counts; their HTML is kept after sanitizing (video and audio become links) |
| `DYNAMIC_BLOCK_SKIPPED` | Server-rendered blocks (query loops, navigation, search...) with no stored content, listed once per document |
| `PAGE_BUILDER_LAYOUT` | The document was built with Elementor, Divi, WPBakery or Beaver Builder: its text, images and links were migrated, its layout (sections, columns, styling) was not |
| `SHORTCODE_NOT_MIGRATED` | Shortcodes left in the content as text (for example `[woocommerce_cart]` or `[contact-form-7 id="5"]`), listed once per document with counts; what they rendered on WordPress was not migrated |
| `REUSABLE_BLOCK_SKIPPED` | A reusable block that reached the transform unresolved (no valid `ref`); its content was not migrated. The REST source inlines every reusable block with a valid ref, so this is rare |
| `REUSABLE_BLOCK_MISSING` | Reusable blocks (synced patterns) that could not be inlined: not found, not readable with the credentials, not published or password protected (WordPress shows nothing for those either), nested in themselves, nested more than 8 deep, or over the per-document limit (200 blocks, 4 MB). Their place is left empty. Listed once per run, by block, with a count and sample of documents |
| `QUARANTINE_LIMIT` | More than 50 fragments were removed from one document; the rest are reported but not saved |
| `SEO_CANONICAL_OFFSITE` | The SEO canonical points to another site; kept, listed for review (canonicals to the old site are dropped, since the new site is canonical now) |
| `SEO_CANONICAL_INVALID` | The SEO canonical URL was not http(s), or contained credentials (`user:pass@`), and was dropped |
| `SEO_RANKMATH_HEADLESS_OFF` | Rank Math's headless API (`rankmath/v1/getHead`) is off, so no Rank Math SEO was migrated; listed once per run. Turn on Rank Math → General Settings → Others → Headless CMS Support |
| `SEO_FETCH_FAILED` | Rank Math SEO could not be read for some documents (request failed, invalid or oversized head, or a permalink Rank Math cannot resolve); they were migrated without SEO. Listed once per run with a count |
| `SEO_TEMPLATE_UNRESOLVED` | WXR source: an SEO title or description uses a Yoast or Rank Math template variable other than title, site name, separator, page or excerpt, so it was left out. Listed once per run with a sample of documents |
| `TRANSFORMER_FAILED` | A custom transformer threw; the built-in rule was used instead |
| `BLOCK_ATTRS_INVALID` | A block comment had attributes that are not valid JSON |
| `BLOCK_UNCLOSED` | A block was never closed; it was closed at the end of the content |
| `BLOCK_CLOSER_STRAY` | A closing block comment with no opener, kept as text |
| `BLOCK_CLOSER_MISMATCH` | A closer for an outer block closed inner blocks implicitly |
| `BLOCK_DEPTH_EXCEEDED` | Blocks nested deeper than 64; the rest kept as HTML |
| `LEXICAL_FALLBACK` | Content the editor cannot express was converted best-effort |
| `LINK_NOT_MIGRATED` | A link to the old site points at content that was not migrated. A link to a migrated media file or attachment page is reported too when the target link feature cannot link to the media collection (`enabledCollections`); otherwise it becomes an internal link to the upload |
| `MEDIA_NOT_MIGRATED` | An image in content points at media that was not migrated |
| `CONTENT_DROPPED` | Content that could not be converted at all |
| `DOC_TYPE_UNMAPPED` | A WordPress post type that was not migrated, listed once per type: one with no entry in `collections`, or one the source does not read yet (WooCommerce products, portfolio items...), with its item count |
| `FIELD_NOT_IN_TARGET` | WordPress has data for a mapped field the target collection lacks, or has with the wrong type; listed once per collection and field |
| `STATUS_NOT_KEPT` | Draft, private or scheduled content went into a collection without drafts, so it is live; listed once per collection |
| `TITLE_EMPTY` | The WordPress title was empty; the document was written as "(no title)" |
| `REFERENCE_NOT_MIGRATED` | A document's author, terms or featured image were not migrated; written without them |
| `MEDIA_SOURCE_HOST_EXCEPTION` | Media was fetched from the source host over a local or private address |
| `REDIRECT_SKIPPED` | A document got no redirect: its old link is off-site or empty, it is the front page, its old or new path is reserved (admin, API, `/_next`, listing routes), its slug is empty or has a dot segment, or there is no `redirects.paths` pattern for its type |
| `REDIRECT_COLLECTION_UNSUPPORTED` | The `redirects.collection` exists but lacks the plugin's `from` and `to` fields; redirects.json was written instead |
| `TERM_PARENT_MISSING` | A category's parent was not found; imported without a parent |
| `TERM_PARENT_CYCLE` | Categories whose parents form a loop; imported without parents |
| `TERM_TAXONOMY_UNSUPPORTED` | A taxonomy other than categories and tags |
| `AUTHOR_NOT_MIGRATED` | A user with no migrated content, left out on purpose (doc 12.9) |
| `AUTHOR_NO_EMAIL` | Authors mapped into an auth collection: the user has no email in the source, so no account was created. Only the REST source with an Application Password that can list users reads emails |
| `AUTHOR_EMAIL_IN_USE` | Authors mapped into an auth collection: an account that wp2payload did not create already has the user's email. It is never linked or changed; the user's content is written without an author |
| `AUTHOR_ACCOUNT_CREATED` | Authors mapped into an auth collection: this run created (a dry run: would create) a login account for the user. One per account, with the WordPress ID and slug; no address unless `--include-pii`. On a hacked site the attacker's own user wrote the spam and gets an account too, so check each is a real person before go-live. Also shown on the summary's `accounts` line and under "Accounts created" in the HTML report; counts for `--strict` |
| `AUTHOR_INVITE_FAILED` | `--invite-users`: the account was created but the password-set email could not be sent; the user can use "Forgot password" on the Payload login page. No address unless `--include-pii` |

## Errors

| Code | Meaning |
| --- | --- |
| `MEDIA_404` and other `MEDIA_<status>` | The media URL answered with an HTTP error, or (backup sources) the file is not in the uploads folder or archive |
| `MEDIA_NETWORK`, `MEDIA_DNS_FAILED`, `MEDIA_TIMEOUT`, `MEDIA_BAD_URL` | The media file could not be fetched |
| `MEDIA_LOCAL_UNSUPPORTED` | A media item names a local file but the source has no uploads to read it from |
| `MEDIA_UPLOADS_MISSING` | SQL source: `source.uploadsDir` does not exist |
| `MEDIA_READ_FAILED` | .wpress or zip backup: a media file could not be read from the archive (it is damaged) |
| `MEDIA_WRITE_FAILED` | Payload rejected the media upload |
| `TERM_WRITE_FAILED`, `AUTHOR_WRITE_FAILED` | Payload rejected the write after retries |
| `REDIRECT_CONFLICT` | Two documents claim the same old URL or the same new path, an old URL equals another document's new path (it would hide that document), or an existing redirect points to another document. The first is kept, nothing is changed, and the phase counts it as `rejected`. A redirect whose document was deleted is repointed instead |
| `REDIRECT_WRITE_FAILED` | A redirect, or redirects.json, could not be written |
| `RUN_FAILED` | The run stopped on an error outside a single item (source or database unreachable); progress is kept |
| `DOC_WRITE_FAILED` | A document could not be transformed or written, or its relationship pass failed; the detail names the stage |
| `REST_AUTH`, `REST_AUTH_REQUIRED` | WordPress rejected or required the Application Password |
| `REST_NOT_FOUND`, `REST_NOT_JSON`, `REST_HTTP` | The REST API is missing or answered unexpectedly |
| `REST_TOO_LARGE` | A REST response was over 64 MB and was not read |
| `REST_NETWORK`, `REST_DNS_FAILED`, `REST_TIMEOUT` | The site could not be reached |
| `REST_BAD_URL`, `REST_HTTP_NOT_ALLOWED` | The source URL is invalid, or plain http to a public host |
| `REST_BAD_REDIRECT`, `REST_CROSS_ORIGIN`, `REST_TOO_MANY_REDIRECTS` | Redirects that leave the site or loop |
| `DUMP_NO_WORDPRESS` | SQL and backup sources: the dump has no WordPress tables, none with the configured `source.tablePrefix` (the message names the prefix it found), or no complete install (a prefix needs `posts`, `postmeta` and `options` tables) |
| `DUMP_MULTIPLE_SITES` | SQL and backup sources without `source.tablePrefix`: the dump holds more than one WordPress site (a multisite, or several installs in one database), and the backup's `wp-config.php` did not name one of them. The message lists the prefixes; set `source.tablePrefix` (`scan`: `--table-prefix`) to the one to migrate. Like the archive codes, it stops `migrate`, `scan` and `doctor` before anything is read into Payload |
