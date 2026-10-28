import { defineConfig } from '../../../src/index.js'

export default defineConfig({
  source: { type: 'wxr', file: './export.xml' },
  statuses: ['publish', 'draft'],
})
