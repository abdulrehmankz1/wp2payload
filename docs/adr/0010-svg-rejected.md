# ADR-0010: SVG rejected by default

- Status: Accepted. Amended: with `--allow-svg`, an SVG is checked and rejected on any active content. It is not rewritten.
- Context: SVG can carry scripts and is hard to sanitize completely.
- Decision: SVG uploads are rejected (`SEC_SVG_REJECTED`, medium). With `--allow-svg`, each SVG goes through a strict validate-and-reject check: only an allowlist of SVG elements, attributes and values passes. Anything else (script, `foreignObject`, event handlers, animation, external or `javascript:`/`data:` references, DOCTYPE and entities, CDATA, comments) rejects the whole file (`SEC_SVG_REJECTED`, high). An SVG that passes is imported unchanged and reported (`SEC_SVG_ALLOWED`, low). SVG content under a non-SVG file name is always rejected.
- Consequences: Sites with SVG logos need one flag, and the choice is visible in the report. A check that rejects is simpler to get right than a sanitizer that rewrites.
