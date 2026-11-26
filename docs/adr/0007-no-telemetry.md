# ADR-0007: No telemetry

- Status: Accepted.
- Context: Usage data would help, but the audience is privacy-sensitive (GDPR), migrations handle client data, and trust is the product.
- Decision: No telemetry, not even opt-in. wp2payload only connects to the configured WordPress source, allowed media hosts and the user's own database. Usage signals come from npm downloads and GitHub issues.
- Consequences: Less insight into failures. The bug template asks for the anonymised `report.json` instead, which holds no passwords and no email addresses unless `--include-pii` was used.
