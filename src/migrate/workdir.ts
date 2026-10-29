import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { STATE_DIR } from '../state/store.js'

/**
 * Creates `.wp2payload/` with its own `.gitignore`, so state, reports, quarantined fragments and
 * the document cache are never committed by accident, whatever the project's .gitignore says.
 */
export async function ensureWorkDir(root: string): Promise<string> {
  const dir = path.join(root, STATE_DIR)
  await mkdir(dir, { recursive: true })
  const ignore = path.join(dir, '.gitignore')
  if (!existsSync(ignore)) await writeFile(ignore, '# Created by wp2payload: local migration data, never commit it.\n*\n', 'utf8')
  return dir
}
