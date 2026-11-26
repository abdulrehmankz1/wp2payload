# ADR-0012: SQL dumps are parsed, never executed

- Status: Accepted. Supersedes the earlier version of this ADR ("SQL dumps only in a throwaway container"), which planned to import dumps into a disposable MySQL container. That design was never built.
- Context: A SQL dump from a backup is executable SQL from an untrusted source. A hacked site's dump can create users, define triggers or procedures, or touch other databases. Running it against a real MySQL server is unsafe, and requiring Docker for backup mode would shut out many users.
- Decision: wp2payload reads dumps with its own streaming parser (`src/extractors/sql/dump.ts`) and never runs a database.
  - The dump (`.sql` or `.sql.gz`, on its own or inside a `.wpress`, zip or tar backup) is read as text. Only `CREATE TABLE` column lists and `INSERT` rows of seven tables are kept: `options`, `users`, `posts`, `postmeta`, `terms`, `term_taxonomy` and `term_relationships`, with the configured table prefix. Triggers, procedures, `CREATE USER`, `GRANT` and every other statement are skipped unread.
  - Each table has an explicit list of columns to keep (`src/extractors/sql/index.ts`). `user_pass` and `user_email` are not on the list for `users`, so password hashes and emails never leave the parser. Only a few options are kept: site URL, home, blog name, permalink structure, upload path and front page settings.
  - A dump without `CREATE TABLE` statements is read with the column order of a default WordPress install.
  - Limits: 8 GB unpacked (`DUMP_TOO_LARGE`), 64 M characters per value, 1 MB per statement head. A `.gz` is capped by what it unpacks to.
  - Media is read from the uploads folder or archive, never downloaded. Paths from the dump must stay inside it (`SEC_PATH_TRAVERSAL`).
- Consequences: Backup mode needs no Docker and no MySQL, and nothing in a dump can run. The parser has to handle MySQL quoting and escapes itself. It is covered by unit tests with hostile dumps (comments, triggers, procedures) and by the hacked-site suite over a SQL backup and a zip backup. Data that would only exist after running SQL (for example rows a trigger creates) is not seen, which is intended.
