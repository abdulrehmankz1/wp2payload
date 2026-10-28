import { defineConfig } from '../../../src/index.js'

export default defineConfig({
  source: { type: 'rest', url: 'https://example.com', auth: { user: 'admin', appPassword: process.env.WP_APP_PASSWORD! } },
})
