import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// writeAtomic's temporary name must not be guessable, and must never follow or replace a file or
// symlink someone planted under it. randomBytes is pinned here so a test can plant one in advance.
const pinned = vi.hoisted(() => ({ hex: undefined as string | undefined, calls: [] as number[] }))
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>()
  return {
    ...real,
    randomBytes: (n: number) => {
      pinned.calls.push(n)
      return pinned.hex !== undefined ? Buffer.from(pinned.hex, 'hex') : real.randomBytes(n)
    },
  }
})

const { writeAtomic } = await import('../../src/report/write.js')

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-atomic-'))
  pinned.hex = undefined
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writeAtomic', () => {
  it('writes the file and leaves no temporary file behind', async () => {
    const file = path.join(dir, 'sub', 'out.html')
    await writeAtomic(file, 'one')
    await writeAtomic(file, 'two')
    expect(await readFile(file, 'utf8')).toBe('two')
    expect(await readdir(path.join(dir, 'sub'))).toEqual(['out.html'])
  })

  it('takes at least 96 random bits for each temporary name', async () => {
    pinned.calls.length = 0
    await writeAtomic(path.join(dir, 'a.html'), 'a')
    await writeAtomic(path.join(dir, 'a.html'), 'b')
    expect(pinned.calls).toHaveLength(2)
    for (const n of pinned.calls) expect(n).toBeGreaterThanOrEqual(12)
  })

  it('refuses to write through a file planted at the temporary name, and leaves it alone', async () => {
    const hex = 'ab'.repeat(12)
    pinned.hex = hex
    const file = path.join(dir, 'out.html')
    await writeFile(file, 'old', 'utf8')
    const planted = `${file}.${hex}.tmp`
    await writeFile(planted, 'planted', 'utf8')
    await expect(writeAtomic(file, 'new')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(planted, 'utf8')).toBe('planted')
    expect(await readFile(file, 'utf8')).toBe('old')
  })

  it('never follows a symlink planted at the temporary name', async (ctx) => {
    const hex = 'cd'.repeat(12)
    pinned.hex = hex
    const victim = path.join(dir, 'victim.ts')
    await writeFile(victim, 'export default {}\n', 'utf8')
    const file = path.join(dir, 'out.html')
    try {
      await symlink(victim, `${file}.${hex}.tmp`, 'file')
    } catch (error) {
      // Windows without Developer Mode cannot create symlinks; the planted-file test covers `wx`.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw error
    }
    await expect(writeAtomic(file, '<html>')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(victim, 'utf8')).toBe('export default {}\n')
  })
})
