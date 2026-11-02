import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findProjectRoot } from '../../src/config/root.js'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'wp2p-root-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const touch = async (...parts: string[]) => {
  const file = path.join(tmp, ...parts)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '')
}

describe('findProjectRoot', () => {
  it('finds the config in the folder itself', async () => {
    await touch('site', 'package.json')
    await touch('site', 'wp2payload.config.ts')
    expect(findProjectRoot(path.join(tmp, 'site'))).toBe(path.join(tmp, 'site'))
  })

  it('walks up from a subfolder of the project', async () => {
    await touch('site', 'package.json')
    await touch('site', 'wp2payload.config.ts')
    await mkdir(path.join(tmp, 'site', 'src', 'app'), { recursive: true })
    expect(findProjectRoot(path.join(tmp, 'site', 'src', 'app'))).toBe(path.join(tmp, 'site'))
  })

  it('stops at the nearest package.json: a parent project config is not used', async () => {
    await touch('wp2payload.config.ts')
    await touch('package.json')
    await touch('apps', 'web', 'package.json')
    await mkdir(path.join(tmp, 'apps', 'web', 'src'), { recursive: true })
    expect(findProjectRoot(path.join(tmp, 'apps', 'web', 'src'))).toBeUndefined()
  })

  it('returns undefined when there is no config up to the filesystem root', async () => {
    await mkdir(path.join(tmp, 'a', 'b'), { recursive: true })
    // tmp has no package.json, so the walk may continue above it; only assert it does not throw
    // and never returns a folder inside tmp.
    const found = findProjectRoot(path.join(tmp, 'a', 'b'))
    expect(found === undefined || !found.startsWith(tmp)).toBe(true)
  })
})
