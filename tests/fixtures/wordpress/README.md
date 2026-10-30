# WordPress fixture

Local, throwaway WordPress + MySQL for the REST extractor and end-to-end tests. Bound to `127.0.0.1:8080` only. All credentials in `docker-compose.yml` are fake.

## Start / seed / reset

```
docker compose up -d
node scripts/fixture-seed.mjs     # pnpm fixture:seed once PM adds the script
docker compose down -v            # full reset (drops DB and wp volume)
```

The seed is idempotent: re-running keeps one copy of the content (import is skipped via the `wp2p_fixture_import_done` option) and rotates the `wp2p-fixture` Application Password. It writes `WP_URL`, `WP_USER=wp2p-editor`, `WP_APP_PASSWORD` to the gitignored `.env` and never prints the password. Site admin (local only): `admin` / `fixture-admin-not-a-secret`.

## Content

- WordPress Theme Unit Test data (posts, pages, media, categories, tags, comments), imported with `wordpress-importer`.
- Permalinks `/%postname%/`; `WP_ENVIRONMENT_TYPE=local` so Application Passwords work over http.
- Yoast SEO active. Custom `_yoast_wpseo_title` / `_yoast_wpseo_metadesc` set on posts with slugs `markup-html-tags-and-formatting` and `markup-image-alignment`.
- User `wp2p-editor` (role editor).

## Rank Math instead of Yoast

The seed uses Yoast. To test Rank Math (spec 07), switch the running fixture by hand:

```
docker compose run --rm -T wpcli wp plugin install seo-by-rank-math
docker compose run --rm -T wpcli wp plugin deactivate wordpress-seo
docker compose run --rm -T wpcli wp plugin activate seo-by-rank-math
docker compose run --rm -T wpcli wp option update rank_math_registration_skip 1
docker compose run --rm -T wpcli wp option update rank_math_wizard_completed 1
docker compose run --rm -T wpcli wp eval '$o = (array) get_option("rank-math-options-general", []); $o["headless_support"] = "on"; update_option("rank-math-options-general", $o);'
```

The `rankmath/v1` REST namespace appears only after the setup wizard is completed or skipped, and `getHead` only with Headless CMS Support on. Switch back with `wp plugin deactivate seo-by-rank-math && wp plugin activate wordpress-seo`. Verified with Rank Math 1.0.280.

## Pins

| Item | Pin |
|---|---|
| mysql | `mysql:8.4@sha256:a0225d1ea6631c8bc2385dc4c2faba17bbf1834ecf369e1659a9a382bd8d5dd7` |
| wordpress | `wordpress:php8.3-apache@sha256:8901759bfbb7ebc567dbc44a244c0d96d720d0a67c17bc4f42ec355ddba2e863` |
| wp-cli | `wordpress:cli-php8.3@sha256:661db880e953da051abcac6c0a769767b995a82cd52101c003ca7438dd427d7d` |
| Yoast SEO | 28.8 |
| wordpress-importer | 0.9.7 |
| Test data | `WordPress/theme-test-data` commit `b47acf980696897936265182cb684dca648476c7`, `themeunittestdata.wordpress.xml`, sha256 `457aace6ec93cf77369bbcc6158996e52da8798bd5e39c83d58dfab9b50d64fa` |

The downloaded XML is cached in `tests/fixtures/wordpress/.cache/` (ignored) and checked against the sha256 before import.
