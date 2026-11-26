# ADR-0002: CLI first, admin plugin later

- Status: Accepted.
- Context: Both a CLI and a wizard in the Payload admin are useful. A plugin UI is harder to test and slower to build, and time is limited.
- Decision: Ship the CLI first. Keep extraction, transformation, security checks and loading in modules that do not depend on the CLI (`src/extractors`, `src/transform`, `src/security`, `src/loaders`), so a later plugin can reuse them. The files in `src/commands` parse options, call those modules and print.
- Consequences: Users need a terminal. A later admin plugin (see [the roadmap](../roadmap.md)) is mostly UI work on the same core.
