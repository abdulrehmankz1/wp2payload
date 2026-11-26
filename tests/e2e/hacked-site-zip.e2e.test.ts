import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll } from 'vitest'
import { makeZip, type ZipItem } from '../unit/archive-support.js'
import { hackedSiteSuite } from './hacked-suite.js'

// The hacked site's SQL backup and uploads, packed the way Duplicator packs a site
// (wp-content/uploads plus dup-installer/dup-database__*.sql), migrated through the archive source.
// Same assertions as the SQL-backup variant: the archive changes how bytes are read, not what is kept out.

try {
  process.loadEnvFile('.env')
} catch {
  // No .env: the fixture is not seeded on this machine.
}
const SQL = process.env['HACKED_SQL_FILE']
const UPLOADS = process.env['HACKED_UPLOADS_DIR']

const dir = mkdtempSync(path.join(os.tmpdir(), 'wp2p-hacked-zip-'))
const ZIP = path.join(dir, 'hacked_archive.zip')
if (SQL && UPLOADS && existsSync(SQL) && existsSync(UPLOADS)) {
  const items: ZipItem[] = [
    { name: 'wp-config.php', data: '<?php /* inert stand-in */' },
    { name: 'dup-installer/dup-database__e2e.sql', data: readFileSync(SQL) },
  ]
  for (const e of readdirSync(UPLOADS, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const rel = path.relative(UPLOADS, path.join(e.parentPath, e.name)).split(path.sep).join('/')
    items.push({ name: `wp-content/uploads/${rel}`, data: readFileSync(path.join(e.parentPath, e.name)) })
  }
  writeFileSync(ZIP, makeZip(items))
}
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

hackedSiteSuite('Duplicator zip backup', `{ type: 'archive', file: ${JSON.stringify(ZIP)} }`, { backup: true })
