# Hacked-site fixture

A throwaway WordPress seeded with the threats in the security model (doc 12.3), for the
end-to-end test in `tests/e2e/hacked-site.e2e.test.ts` (doc 12.14). Bound to `127.0.0.1:8091`
only. All credentials in `docker-compose.yml` are fake, and every attack sample is inert: `alert()`
calls, `*.example` hosts, and a PHP file that only echoes a word.

## Start / seed / reset

```
pnpm fixture:hacked                                                  # start, install, seed
WP2P_REQUIRE_HACKED=1 pnpm test:security                             # the suite CI runs
docker compose -f tests/fixtures/hacked-site/docker-compose.yml down -v   # full reset
```

The seed also writes the site as a WordPress export to the gitignored
`tests/fixtures/hacked-site/.cache/export.xml` (`HACKED_WXR_FILE` in `.env`), and the suite runs
once over the REST source and once over that export (`tests/e2e/hacked-site-*.e2e.test.ts`).

The seed is idempotent: everything it created before is deleted and created again, and the
`wp2p-hacked` Application Password of `wp2p-editor` is rotated. It writes `HACKED_WP_URL`,
`HACKED_WP_USER` and `HACKED_WP_APP_PASSWORD` to the gitignored `.env` and never prints the
password. Without those, the e2e test is skipped; with `WP2P_REQUIRE_HACKED=1` (CI and the release
gate) a missing fixture fails it.

## What is seeded (`seed.php`)

| Threat (doc 12.3) | Where |
| --- | --- |
| T1 script injection | `hacked-scripts`: `<script>`, `onerror`, `javascript:` (plain, entity- and whitespace-obfuscated), `data:` and `vbscript:` links, mutation-XSS classics |
| T2 markup in short fields | `hacked-short-fields` title and excerpt; the clean image's title, alt and caption; the author's display name |
| T3 SEO spam | `hacked-spam`: `display:none` link farm, off-screen and `font-size:0` links; a hidden block in `hacked-page` |
| T4 malicious redirects | `hacked-redirects`: meta refresh, `<script>` redirect, redirect in an `onmouseover` on a paragraph |
| T5 rogue iframes | `hacked-iframes`: unknown host and a look-alike host, next to an allowed YouTube embed |
| T6 backdoor uploads | `logo.jpg.php`, `shell.phtml`, a PHP-in-JPEG polyglot (featured image of `hacked-media-links`), HTML disguised as PNG, PDF with `/JavaScript` |
| T7 malicious SVG | `scripted.svg`, the featured image of `hacked-short-fields` |
| T8 rogue user | `wp-sys-maint`, an administrator with no posts |
| T9 SSRF media URLs | attachments pointing at `169.254.169.254`, at `127.0.0.2` (allowlisted in the test config, still private) and at the source host on another port |

The media files come from `tests/fixtures/hacked-media`. The must-use plugin in `mu-plugins/`
lets an attachment report a forced source URL, as an attacker with database access could.

XXE and entity expansion in export files (T12) are covered by `tests/unit/wxr.test.ts`. Zip slip
(T11) and SQL dump threats (T13) belong to the backup source and are added with it.
