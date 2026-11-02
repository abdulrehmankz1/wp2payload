import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      // Real Payload + SQLite: slower, one file at a time to keep memory flat.
      { test: { name: 'int', include: ['tests/int/**/*.int.test.ts'], testTimeout: 60_000, hookTimeout: 120_000, fileParallelism: false } },
      // Against the Docker fixtures; skipped when they are not seeded (see tests/e2e).
      { test: { name: 'e2e', include: ['tests/e2e/**/*.e2e.test.ts'], testTimeout: 60_000, hookTimeout: 300_000, fileParallelism: false } },
    ],
  },
})
