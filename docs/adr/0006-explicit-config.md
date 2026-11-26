# ADR-0006: Explicit mapping config with presets

- Status: Accepted.
- Context: WordPress sites vary too much to guess the target schema. Automatic mapping produces wrong data quietly.
- Decision: The mapping lives in `wp2payload.config.ts`, loaded with `jiti` and validated with zod. Every object in the schema is strict, so a misspelt key is an error. Defaults follow the `blog` preset, and `init --scaffold` writes matching collections. Secrets must come from environment variables: a literal `appPassword` is rejected.
- Consequences: Slightly more setup than "zero config", but errors surface before anything connects or writes, with the exact field and expected value (exit code 2). The keys are in [docs/reference/config.md](../reference/config.md).
