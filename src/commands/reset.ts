import { lstat, realpath, rm, unlink } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { CACHE_DIR } from '../migrate/spill.js'
import { STATE_DIR, STATE_FILE } from '../state/store.js'
import { colorEnabled, formatLine } from '../ui/output.js'

export interface ResetOptions {
  cwd?: string
  log?: (line: string) => void
  /** Defaults to colorEnabled(). */
  color?: boolean
}

async function lstatOrUndefined(p: string): Promise<Stats | undefined> {
  try {
    return await lstat(p)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// `wp2payload reset`: forget progress. Deletes .wp2payload/state.json and .wp2payload/cache/ only.
// Quarantine and report.json are kept, and Payload is never touched: the database stays the
// source of truth (ADR-0004), so the next run re-resolves ids from it. Returns the exit code.
export async function runReset(opts: ResetOptions = {}): Promise<number> {
  const root = path.resolve(opts.cwd ?? process.cwd())
  const log = opts.log ?? console.log
  const color = opts.color ?? colorEnabled()
  const dir = path.join(root, STATE_DIR)
  const refuse = (title: string, detail: string): number => {
    log(formatLine('fail', title, detail, color))
    log('Nothing was removed. Your Payload database was not changed.')
    return 1
  }

  // Check everything before deleting anything, and never follow a link out of the project.
  const dirStat = await lstatOrUndefined(dir)
  if (!dirStat) {
    log(`Nothing to reset: there is no ${STATE_DIR} folder here. Your Payload database was not changed.`)
    return 0
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    return refuse(`${STATE_DIR} is not a plain folder`, `It is a link or a file. Remove ${STATE_DIR}/${STATE_FILE} and ${STATE_DIR}/${CACHE_DIR}/ by hand.`)
  }
  const realRoot = await realpath(root)
  const realDir = await realpath(dir)
  if (!inside(realRoot, realDir)) {
    return refuse(`${STATE_DIR} resolves outside this project`, `Remove ${STATE_DIR}/${STATE_FILE} and ${STATE_DIR}/${CACHE_DIR}/ by hand.`)
  }

  const stateFile = path.join(dir, STATE_FILE)
  const cacheDir = path.join(dir, CACHE_DIR)
  const stateStat = await lstatOrUndefined(stateFile)
  const cacheStat = await lstatOrUndefined(cacheDir)
  if (stateStat?.isDirectory()) {
    return refuse(`${STATE_DIR}/${STATE_FILE} is a folder`, 'Expected a file. Check it and remove it by hand.')
  }
  if (cacheStat && (cacheStat.isSymbolicLink() || !cacheStat.isDirectory())) {
    return refuse(`${STATE_DIR}/${CACHE_DIR} is not a plain folder`, 'It is a link or a file. Check it and remove it by hand.')
  }
  if (cacheStat && !inside(realDir, await realpath(cacheDir))) {
    return refuse(`${STATE_DIR}/${CACHE_DIR} resolves outside this project`, 'Check it and remove it by hand.')
  }

  const removed: string[] = []
  if (stateStat) {
    // unlink removes a link itself, never its target.
    await unlink(stateFile)
    removed.push(`${STATE_DIR}/${STATE_FILE}`)
  }
  if (cacheStat) {
    // fs.rm removes links inside the folder without following them.
    await rm(cacheDir, { recursive: true, force: true })
    removed.push(`${STATE_DIR}/${CACHE_DIR}/`)
  }

  if (removed.length === 0) {
    log(`Nothing to reset: no state or cache in ${STATE_DIR}. Your Payload database was not changed.`)
    return 0
  }
  for (const r of removed) log(formatLine('ok', `Removed ${r}`, undefined, color))
  log(`Kept ${STATE_DIR}/quarantine/ and ${STATE_DIR}/report.json.`)
  log('Your Payload database was not changed. The next run re-resolves migrated items from it.')
  return 0
}
