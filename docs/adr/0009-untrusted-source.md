# ADR-0009: All source content is untrusted

- Status: Accepted.
- Context: Many sites that get migrated were compromised. A migration tool that copies content as it is carries the attack into the new site.
- Decision: Every value from the source is treated as attacker-controlled. A security scan runs over each raw post, then an allowlist sanitizer (`sanitize-html` with the policy in `src/security/content/policy.ts`) runs on every block, including the output of custom transformers. Titles, excerpts, alt text, captions and SEO fields become plain text. Removed fragments are saved as inert text under `.wp2payload/quarantine/` and listed as findings. Loosening a rule needs an explicit flag or config key, and the report shows it.
- Consequences: Some legitimate inline styles, classes and unusual markup are lost, and the report lists this. The full model is in [docs/security.md](../security.md).
