# Migrating from a backup

Use this guide when the old site is offline, expired or hacked, and a backup is all you have.

## What a backup holds

A full WordPress backup has two parts:

- **The database**, as a SQL dump (`.sql` or `.sql.gz`). All content lives here: posts, pages,
  categories, tags, users, SEO metadata and settings.
- **The files.** The part that matters is `wp-content/uploads`, which holds the media. Themes and
  plugins are PHP code and are not migrated.

Backup plugins package these differently:

| Plugin | What you get |
| --- | --- |
| UpdraftPlus | Separate archives: `backup_..._<site>_<id>-db.gz` for the database, and one or more `-uploads.zip` files |
| Duplicator | One `*_archive.zip` with the dump under `dup-installer/` and the site files, plus an installer |
| All-in-One WP Migration | One `.wpress` file in its own format |
| Hosting panels, mysqldump, phpMyAdmin | A `.sql` or `.sql.gz` file, and the uploads folder or an archive of it |

All of them hold the same two things: the SQL and the uploads.

## Two ways to migrate

| Method | Use it when | Needs |
| --- | --- | --- |
| Restore locally, then use the REST API | The backup restores cleanly and you want WordPress itself to produce the data | Docker or LocalWP, a working restore |
| Read the backup directly | Restores fail, or you want nothing to run | Only the backup files |

Reading the backup directly is the simpler path in most cases. Restoring is useful when you need
something only the REST API gives: author emails (for login accounts), or content that plugins
build at runtime.

## Method 1: restore locally, then use the REST API

1. Restore the backup into a local WordPress: LocalWP, or a Docker WordPress. For a `.wpress`
   file, create a site in LocalWP and import it with the All-in-One WP Migration plugin.
2. Create a user with the Editor role and an Application Password for it.
3. Point wp2payload at the local site:

   ```bash
   WP_URL=http://mysite.local
   WP_USER=migration-editor
   WP_APP_PASSWORD=xxxx xxxx xxxx xxxx
   ```

4. Run `npx wp2payload doctor`, then `npx wp2payload migrate --dry-run`, then `migrate`.

Plain `http` and local addresses are accepted because the host comes from your own config: the
configured source host may resolve to a loopback or private address (`localhost`, `.local`
domains, a Docker service name). Every other host still gets the full download guard, and the
report records each media file fetched this way (`MEDIA_SOURCE_HOST_EXCEPTION`).

Restores sometimes fail because of PHP versions or plugins. If yours does, use method 2.

## Method 2: read the backup directly

wp2payload reads the dump as text and never runs it against a database
([ADR-0012](../adr/0012-sql-sandbox.md)). No Docker and no MySQL are needed. Media is read from
the uploads in the backup, so nothing is downloaded and the old site does not need to exist.

Run `npx wp2payload scan <backup>` first to see what is in it, then set the source in
`wp2payload.config.ts`.

### A SQL dump and the uploads folder

```ts
source: { type: 'sql', file: './backup/database.sql.gz', uploadsDir: './backup/uploads' },
```

`uploadsDir` is the folder that holds the year folders (`2024/`, `2025/`), that is
`wp-content/uploads` from the backup.

### UpdraftPlus

```ts
source: {
  type: 'sql',
  file: './backup_2026-01-01-1200_Site_abc123-db.gz',
  uploads: [
    './backup_2026-01-01-1200_Site_abc123-uploads.zip',
    './backup_2026-01-01-1200_Site_abc123-uploads2.zip',
  ],
},
```

List every uploads archive when UpdraftPlus split them. `uploads` and `uploadsDir` cannot both be
set. `scan` finds the `-uploads*.zip` files next to a `-db.gz` on its own.

### All-in-One WP Migration (.wpress)

```ts
source: { type: 'wpress', file: './site.wpress' },
```

The file is read in place, without unpacking. Its entry names are only used as lookup keys, so a
hostile name cannot write or read anything outside it.

### Duplicator, or any zip or tar

```ts
source: { type: 'archive', file: './site_archive.zip' },
```

This also takes your own `.zip`, `.tar.gz`, `.tgz` or `.tar` that holds the dump and
`wp-content/uploads`. wp2payload picks:

- **The dump:** Duplicator's `dup-installer/dup-database__*.sql`, else `database.sql` at the
  root, else the one `.sql` or `.sql.gz` file outside `wp-content`. If there are several, extract
  the right one and use a `sql` source.
- **The uploads:** the shallowest `wp-content/uploads/` folder, or `uploads/` at the root.

Zip archives are read in place. A `.tar.gz` cannot be read at random, so the dump and the
uploads, and nothing else, are unpacked once into a private temporary folder (under `TMPDIR`). It
is removed when the command ends, also on an error or Ctrl+C.

### Table prefix

You usually don't need to set the table prefix. When `tablePrefix` is unset, wp2payload finds it:

1. From `wp-config.php` inside a zip or tar backup, read as text and never run. Only a plain
   `$table_prefix = '...';` line counts, and only if the dump really has those tables.
2. Otherwise from the dump: the prefix that has `posts`, `postmeta` and `options` tables.

If the dump holds more than one WordPress site (or a multisite network), the run stops with
`DUMP_MULTIPLE_SITES` and lists the prefixes; set `tablePrefix` on the `sql` or `archive` source,
or pass `scan --table-prefix`. `doctor` prints the prefix it found. A `.wpress` file needs
nothing: wp2payload knows the placeholder prefix it uses.

## What a backup gives, and what it does not

| Data | From a backup |
| --- | --- |
| Posts, pages, categories, tags, featured images | Yes |
| Gutenberg block markup and reusable blocks | Yes |
| Yoast and Rank Math SEO | Yes, from post meta |
| Old URLs for redirects | Yes, rebuilt from the permalink settings in the dump |
| Media | Yes, from the uploads. A file missing from the uploads is reported as `MEDIA_404` |
| Author names and slugs | Yes |
| Author emails | No. `user_email` and `user_pass` are never read, so authors cannot become login accounts (`AUTHOR_NO_EMAIL`) |
| Drafts and private content | Yes, when listed in `statuses` |

Encrypted `.wpress` and zip backups cannot be read.

## Safety checks

A backup from a hacked site is treated like any other untrusted source: the same sanitizer,
media verification and quarantine apply. On top of that:

- Triggers, procedures, `CREATE USER`, `GRANT` and every statement other than `CREATE TABLE`
  and `INSERT` for the seven tables wp2payload reads are skipped unread.
- The dump is capped at 8 GB unpacked.
- A media path from the dump must stay inside the uploads folder or archive
  (`SEC_PATH_TRAVERSAL`).
- Zip and tar archives are checked entry by entry before anything is read. A hostile archive is
  refused as a whole with a `SEC_ARCHIVE_*` code: names that leave the archive (`..`, absolute
  paths, drive letters, backslash tricks), symbolic and hard links, device files, Windows device
  names, and overlapping zip entries. Zip bombs are capped at 1,000,000 entries, 64 GB unpacked,
  and a compression ratio of 100:1 for any entry over 1 MB.

The codes are in [docs/reference/codes.md](../reference/codes.md#backup-archives).

## Protecting client backups

Backups hold user emails and possibly customer data.

- Never commit a backup. `init` adds `/backups/`, `*.sql`, `*.sql.gz` and `*.wpress` to
  `.gitignore`; add your zip files too if they sit inside the project.
- Keep backups in an encrypted folder, outside any repository if you can.
- Delete the backup, `.wp2payload/` and the quarantine when the migration is done, with the
  client's agreement.
