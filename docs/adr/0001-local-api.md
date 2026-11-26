# ADR-0001: Write through the Payload Local API

- Status: Accepted.
- Context: The tool writes thousands of documents and needs the target editor config to build valid Lexical JSON. Payload also has a REST API, but that needs a running server and an API key, adds HTTP overhead, and gives no access to the editor config.
- Decision: Boot the user's own `payload.config.ts` (or `payload.config.js`) with `getPayload()` and write with `payload.create` and `payload.update`. Collections, hooks and validation apply as they do for any other write.
- Consequences: Fast, and it works with every official database adapter. The tool must run inside the user's Payload project and needs `PAYLOAD_SECRET` and the database connection (`DATABASE_URI`), which the project's `.env` already holds. `migrate` checks every mapped collection before it writes anything.
