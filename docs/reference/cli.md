# CLI reference

wp2payload is a command-line tool. Its interface is the commands below, the config file
([config.md](config.md)) and the files it writes under `.wp2payload/`. Report codes are in
[codes.md](codes.md).

```bash
npx wp2payload <command> [options]
npx wp2payload --help             # list commands
npx wp2payload <command> --help   # options of one command
npx wp2payload -v                 # or --version
```

## Project folder and .env

Commands work on the nearest folder at or above the current one that holds
`wp2payload.config.ts`, without going past the folder with your project's `package.json`. When
that is not the current folder, the CLI prints `Using the project in <folder>`.

The CLI loads `.env` from that folder. Variables already set in your shell win. Paths you pass
on the command line (`--config`, a `scan` target, `--uploads`, `report --html <path>`) are
relative to where you typed the command.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Write `wp2payload.config.ts` and update `.gitignore`; optionally scaffold the blog preset collections |
| `doctor` | Check Node.js, the Payload project and the WordPress source, without writing anything |
| `migrate` | Run the migration. Resumes from existing state and never creates duplicates |
| `scan [target]` | Security and content health report of a source, without migrating and without Payload |
| `review` | Go through quarantined items and approve or reject them; approvals apply on the next run |
| `report` | Print the last migration report again, or export it as HTML |
| `reset` | Delete local state and the download cache. Never touches the database |

### init

Writes `wp2payload.config.ts` and appends `.wp2payload/`, `.env` and backup file patterns to
`.gitignore`. It asks questions when run in a terminal. Your TypeScript files are never edited.

| Flag | Meaning |
| --- | --- |
| `--url <url>` | WordPress site URL, written to `.env` as `WP_URL` |
| `--scaffold` | Write the blog preset collections to `src/collections/wp2payload/` as new files. Existing files are never overwritten |
| `--force` | Replace an existing `wp2payload.config.ts`. Collection files are still never overwritten |
| `--yes` | Ask no questions; use the flags |

After `--scaffold`, `init` prints the two lines to add to `payload.config.ts`. It warns when
your project already has a collection with the same slug as a scaffolded one.

### doctor

Checks the Node.js version, that Payload 3 is installed in the project, the config file, and
the source: it connects to the REST API, or reads the export or backup, and prints what it
found (counts, detected SEO plugin, table prefix, post types it will skip). Writes nothing.
Exits non-zero when a check fails.

| Flag | Meaning |
| --- | --- |
| `--config <path>` | Config file (default `wp2payload.config.ts`) |

### migrate

Runs the migration: media, then terms, then authors, then documents and a relationship pass,
then redirects. Every write is an upsert by `wpMeta.site` and `wpMeta.wpId`
([ADR-0004](../adr/0004-db-source-of-truth.md)), so a re-run updates instead of duplicating.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--config <path>` | `wp2payload.config.ts` | Config file |
| `--dry-run` | off | Extract and transform everything, write nothing to the database |
| `--only <list>` | all | Limit phases (`media`, `terms`, `authors`, `documents`, `redirects`) or document types (`posts`, `pages`), comma-separated or repeated. `--only redirects` rebuilds redirects from what is already migrated |
| `--limit <n>` | none | Write only the first n documents. All are still read, so links resolve |
| `--concurrency <n>` | 4 | Parallel media downloads |
| `--fresh` | off | Ignore the local ID cache. Still upserts, so no duplicates |
| `--since <date>` | none | Write only documents changed since this date (`2026-11-05`, midnight UTC) or time (`2026-11-05T09:00:00Z`) |
| `--strict` | off | Exit with code 3 when there are warnings or errors |
| `--fail-on-security <level>` | off | Exit with code 4 when findings at or above `low`, `medium` or `high` exist |
| `--allow-svg` | off | Accept SVG uploads that pass a strict check ([ADR-0010](../adr/0010-svg-rejected.md)) |
| `--allow-embed-host <host>` | YouTube, Vimeo | Trust another iframe host. Repeatable, or comma-separated |
| `--invite-users` | off | When authors map into an auth collection, send Payload's forgot-password email to each account the run created. Needs `authors.createAccounts: true` in the config and an email adapter in your Payload config |
| `--include-pii` | off | Allow author emails in the report. By default the report and the output hold none |
| `--yes` | off | Skip the first-run confirmation (for CI) |
| `--verbose` | off | List every warning and skipped phase |

**First run.** When the database has no documents from this source yet, `migrate` shows the
dry-run summary and asks `Write this to the database? [y/N]`. The check uses the database, not
the state file, so deleting `.wp2payload/` does not change it. Without a terminal, the first run
stops and asks for `--yes`.

**Errors.** A single item that fails (a bad image, a rejected write) is recorded and the run
continues. Payload writes are retried up to 3 times with backoff. A phase stops when more than
10% of at least 20 attempted writes fail, so a wrong config does not produce thousands of bad
writes. Progress is kept, and the next run resumes.

**Reminders.** At the end of a real run with an Application Password, `migrate` reminds you to
revoke it. `doctor` prints the same reminder.
When authors map into an auth collection, it warns before starting that every new account can
log in.

### scan

Reads a source the way a migration would and reports what it found: security findings, page
builders, shortcodes, SEO coverage and post types a migration would leave behind. Needs no
Payload project and writes only `.wp2payload/scan.json` and `.wp2payload/scan.html`.

`target` is a site URL, an export file (`.xml`), a SQL dump (`.sql`, `.sql.gz`, UpdraftPlus
`-db.gz`), a `.wpress` backup, or a `.zip`, `.tar.gz` or `.tgz` backup. Without a target, it
scans the source in `wp2payload.config.ts`. For a URL, `WP_USER` and `WP_APP_PASSWORD` are used
when set.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--config <path>` | `wp2payload.config.ts` | Config file, when no target is given |
| `--uploads <path>` | `uploads` next to the dump | For a SQL dump: the uploads folder, or an uploads archive. Repeatable. An UpdraftPlus `-db.gz` finds its `-uploads*.zip` files next to it |
| `--table-prefix <prefix>` | detected | For a SQL dump or backup archive: the table prefix, when the dump holds several sites |
| `--no-media` | media checked | Do not download or check media files |
| `--limit <n>` | none | Scan only the first n documents |
| `--concurrency <n>` | 4 | Parallel media checks |
| `--fail-on-security <level>` | off | Exit with code 4 when findings at or above `low`, `medium` or `high` exist |
| `--allow-svg` | off | Accept SVG uploads that pass a strict check |
| `--allow-embed-host <host>` | YouTube, Vimeo | Trust another iframe host. Repeatable |
| `--json` | off | Print `scan.json` instead of the summary |
| `--verbose` | off | List every warning and error |

The scan is not a malware scan of the server and does not certify that a site is clean.

### review

Goes through quarantined items one by one and saves each decision in `.wp2payload/review.json`.
Only two kinds of item can be approved: an iframe from a host not in `security.embedHosts`, and
a hidden block with links. Scripts, event handlers, dangerous URLs and rejected uploads can only
be rejected. Run `migrate` again after approving.

| Flag | Meaning |
| --- | --- |
| `--list` | List every quarantined item with its id and status. Also the default without a terminal |
| `--approve <id>` | Approve an item by its id from `--list`. Repeatable |
| `--reject <id>` | Reject an item by its id. Repeatable |
| `--all` | Also go through items that already have a decision |

### report

Prints the summary of the last migration from `.wp2payload/report.json`.

| Flag | Meaning |
| --- | --- |
| `--json` | Print `report.json` instead of the summary |
| `--html [path]` | Write the HTML security report. Default `.wp2payload/security-report.html`. A path must end in `.html` or `.htm` |
| `--verbose` | List every warning and error |

### reset

Deletes `.wp2payload/state.json` and the download cache in `.wp2payload/cache/`. Keeps the
quarantine, `report.json` and `review.json`. Never touches Payload: the next run rebuilds the ID
map from `wpMeta` in the database.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Completed |
| 1 | Fatal error, or the run stopped (source or database unreachable, error-rate threshold hit, first run without confirmation) |
| 2 | Invalid config or usage |
| 3 | Warnings or errors, only with `--strict` |
| 4 | Security findings at or above the `--fail-on-security` level |

When several apply, the most serious wins, in this order: 2, 1, 4, 3.

## Environment variables

| Variable | Needed for | Purpose |
| --- | --- | --- |
| `PAYLOAD_SECRET` | `migrate` | Payload needs it to boot. Already in your Payload project |
| `DATABASE_URI` | `migrate` | The target database, as your Payload config reads it. Already in your project |
| `PAYLOAD_CONFIG_PATH` | optional | Path to your Payload config, when it is not found automatically |
| `WP_URL` | REST source | Source site URL, read by the config that `init` writes |
| `WP_USER` | optional | WordPress username for Application Password auth |
| `WP_APP_PASSWORD` | optional | WordPress Application Password. Must come from the environment; a literal in the config is rejected |
| `NO_COLOR` | optional | Turn off coloured output. Colour is also off when the output is not a terminal |
| `TMPDIR` | optional | Where a `.tar.gz` backup's dump and uploads are unpacked; removed when the command ends |

## Files

Everything wp2payload writes locally lives in `.wp2payload/`, which ignores itself in git.

| Path | Written by | Contents |
| --- | --- | --- |
| `report.json` | `migrate` | Counts, warnings, errors, redirects and security findings |
| `security-report.html` | `migrate`, `report --html` | The findings as a self-contained page with no scripts |
| `scan.json`, `scan.html` | `scan` | The last scan |
| `state.json` | `migrate` | Cache of WordPress to Payload IDs and progress. Safe to delete |
| `cache/` | `migrate` | Media downloaded by the first-run preview, reused by the real run |
| `quarantine/content/`, `quarantine/files/` | `migrate` (not a dry run) | Removed fragments and rejected files, saved as inert text, each with a reason |
| `review.json` | `review` | Approve and reject decisions |
| `redirects.json` | `migrate` | Redirects in Next.js `redirects()` format, when `@payloadcms/plugin-redirects` is not installed |
