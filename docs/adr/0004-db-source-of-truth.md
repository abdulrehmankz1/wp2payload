# ADR-0004: Database is the source of truth for idempotency

- Status: Accepted. Amended on 2026-10-29: the WordPress ID field is `wpMeta.wpId`, not `wpMeta.id`.
- Context: Re-runs must never create duplicates, even if local files are lost.
- Decision: Store `wpMeta.site` (normalised source URL) and `wpMeta.wpId` on every migrated document and upsert by them. The state file `.wp2payload/state.json` is only a cache and progress marker. `wpMetaField` (exported from the package) is the field definition users add to each target collection; the blog preset adds it automatically.
- Why `wpId`: a group sub-field named `id` breaks queries on Payload's SQLite adapter. With Payload 3.92.1 and `@payloadcms/db-sqlite`, `where: { 'wpMeta.id': { equals: 5 } }` produced the SQL `... and  = ?` (empty column) and failed. The same query on `wpMeta.wpId` works. Avoiding a reserved name also keeps the Postgres and MongoDB adapters out of the question.
- Consequences: target collections need a `wpMeta` group with `site` and `wpId` (both indexed). Sections 2.4, 4.7 and 4.9 of the project documentation should say `wpId`.
