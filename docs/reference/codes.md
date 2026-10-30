# Report codes

Every warning, error and security finding in `.wp2payload/report.json` carries one of these codes. Codes are stable: once released, a code keeps its meaning. New codes may be added.

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

## Warnings

| Code | Meaning |
| --- | --- |
| `UNKNOWN_BLOCK` | Blocks no rule or transformer handles, listed once per document with counts; their HTML is kept after sanitizing (video and audio become links) |
| `DYNAMIC_BLOCK_SKIPPED` | Server-rendered blocks (query loops, navigation, search...) with no stored content, listed once per document |
| `REUSABLE_BLOCK_SKIPPED` | A reusable block; its content lives in a separate post that is not migrated yet |
| `QUARANTINE_LIMIT` | More than 50 fragments were removed from one document; the rest are reported but not saved |
| `SEO_CANONICAL_OFFSITE` | The SEO canonical points to another site; kept, listed for review (canonicals to the old site are dropped, since the new site is canonical now) |
| `SEO_CANONICAL_INVALID` | The SEO canonical URL was not http(s) and was dropped |
| `SEO_RANKMATH_HEADLESS_OFF` | Rank Math's headless API (`rankmath/v1/getHead`) is off, so no Rank Math SEO was migrated; listed once per run. Turn on Rank Math → General Settings → Others → Headless CMS Support |
| `SEO_FETCH_FAILED` | Rank Math SEO could not be read for some documents (request failed, invalid or oversized head, or a permalink Rank Math cannot resolve); they were migrated without SEO. Listed once per run with a count |
| `TRANSFORMER_FAILED` | A custom transformer threw; the built-in rule was used instead |
| `BLOCK_ATTRS_INVALID` | A block comment had attributes that are not valid JSON |
| `BLOCK_UNCLOSED` | A block was never closed; it was closed at the end of the content |
| `BLOCK_CLOSER_STRAY` | A closing block comment with no opener, kept as text |
| `BLOCK_CLOSER_MISMATCH` | A closer for an outer block closed inner blocks implicitly |
| `BLOCK_DEPTH_EXCEEDED` | Blocks nested deeper than 64; the rest kept as HTML |
| `LEXICAL_FALLBACK` | Content the editor cannot express was converted best-effort |
| `LINK_NOT_MIGRATED` | A link to the old site points at content that was not migrated |
| `MEDIA_NOT_MIGRATED` | An image in content points at media that was not migrated |
| `CONTENT_DROPPED` | Content that could not be converted at all |
| `DOC_TYPE_UNMAPPED` | A WordPress post type with no entry in `collections`, listed once per type |
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

## Errors

| Code | Meaning |
| --- | --- |
| `MEDIA_404` and other `MEDIA_<status>` | The media URL answered with an HTTP error |
| `MEDIA_NETWORK`, `MEDIA_DNS_FAILED`, `MEDIA_TIMEOUT`, `MEDIA_BAD_URL` | The media file could not be fetched |
| `MEDIA_LOCAL_UNSUPPORTED` | Local media files arrive with the SQL backup source (v1.1) |
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
