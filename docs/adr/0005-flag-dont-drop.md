# ADR-0005: Flag unknown content, never drop it

- Status: Accepted.
- Context: Silent data loss is the worst migration outcome, and it is often found only after launch.
- Decision: Blocks that no rule or custom transformer handles are kept as sanitized HTML and reported (`UNKNOWN_BLOCK`). Server-rendered blocks with no stored content, page-builder layouts, shortcodes, unmigrated post types and unresolved links each have their own report code. Dangerous content is quarantined, not silently dropped (see [ADR-0009](0009-untrusted-source.md)). When a block had text and nothing safe remained, the report says so (`CONTENT_DROPPED`).
- Consequences: Some content needs manual clean-up, but nothing disappears without a report entry. The codes are listed in [docs/reference/codes.md](../reference/codes.md).
