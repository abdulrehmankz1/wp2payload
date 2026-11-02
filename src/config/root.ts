import { existsSync } from 'node:fs'
import path from 'node:path'

const CONFIG_FILE = 'wp2payload.config.ts'

/**
 * The project folder for a command started in `start`: the nearest folder, going up, that has
 * wp2payload.config.ts, so running from `src/` works. The walk stops at the first folder with a
 * package.json, so a config from an unrelated parent project is never picked up.
 */
export function findProjectRoot(start: string): string | undefined {
  let dir = path.resolve(start)
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir
    if (existsSync(path.join(dir, 'package.json'))) return undefined
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}
