# ADR-0008: TypeScript, ESM, Node 22.12+

- Status: Accepted. Supersedes the "Node 20+" version of this ADR in the project documentation (v1.4).
- Context: Payload 3 is ESM. The documentation planned `engines.node >= 20` and a CI matrix of Node 20 and 22. On 2026-10-29, Payload 3.92.1 declares `engines.node: ^22.23.4 || >=24.22.1`, and Node 20 reached end of life in April 2026. wp2payload runs inside the user's Payload project, so it can never run on a Node version Payload rejects.
- Decision: ESM-only package built with `tsup`, `engines.node >= 22.12.0`. CI matrix: Node 22 and 24.
- Consequences: no CommonJS and no Node 20 support, matching Payload. `doctor` checks the Node floor. Sections 1.7, 2.11 and 4.x of the documentation should say Node 22 and 24.
