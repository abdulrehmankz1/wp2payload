# ADR-0003: Normalised intermediate representation

- Status: Accepted.
- Context: wp2payload reads several sources with different shapes: the REST API, WXR export files, SQL dumps, `.wpress` backups and zip or tar archives.
- Decision: Every extractor implements one `Extractor` interface (`src/ir/types.ts`) and emits the same plain objects: `IRMedia`, `IRTerm`, `IRAuthor` and `IRDocument`. Transformers and loaders only see the IR. The `.wpress` and archive sources reuse the SQL extractor on the dump they contain, with media read from the backup.
- Consequences: Adding a source means writing one extractor, and the security suite runs over each source the same way. The IR must change carefully, because custom transformers and every loader depend on it.
