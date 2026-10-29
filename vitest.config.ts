import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      // Real Payload + SQLite: slower, one file at a time to keep memory flat.
      { test: { name: 'int', include: ['tests/int/**/*.int.test.ts'], testTimeout: 60_000, hookTimeout: 120_000, fileParallelism: false } },
    ],
  },
})
