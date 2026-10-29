import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runReset } from '../../src/commands/reset.js'

let dir: string
let outside: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-reset-'))
  outside = await mkdtemp(path.join(os.tmpdir(), 'wp2p-outside-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const run = async () => {
  const lines: string[] = []
  const code = await runReset({ cwd: dir, log: (l) => lines.push(l), color: false })
  return { code, lines, text: lines.join('\n') }
}
const s = (...p: string[]) => path.join(dir, '.wp2payload', ...p)

// Symlinks need Developer Mode or admin on Windows; skip those cases when not permitted.
async function trySymlink(target: string, at: string, type: 'dir' | 'junction'): Promise<boolean> {
  try {
    await symlink(target, at, type)
    return true
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

describe('runReset (AC-B4)', () => {
  it('deletes state.json and cache/, keeps quarantine and report.json, says the database was not changed', async () => {
    await mkdir(s('cache', 'nested'), { recursive: true })
    await mkdir(s('quarantine', 'content'), { recursive: true })
    await writeFile(s('state.json'), '{}')
    await writeFile(s('cache', 'documents.jsonl'), '{}\n')
    await writeFile(s('cache', 'nested', 'x'), 'x')
    await writeFile(s('quarantine', 'content', 'a.html.txt'), 'bad')
    await writeFile(s('report.json'), '{}')
    const { code, text } = await run()
    expect(code).toBe(0)
    expect((await readdir(s())).sort()).toEqual(['quarantine', 'report.json'])
    expect(existsSync(s('quarantine', 'content', 'a.html.txt'))).toBe(true)
    expect(text).toContain('Removed .wp2payload/state.json')
    expect(text).toContain('Removed .wp2payload/cache/')
    expect(text).toContain('Kept .wp2payload/quarantine/ and .wp2payload/report.json.')
    expect(text).toMatch(/database was not changed/)
  })

  it('only state.json present', async () => {
    await mkdir(s(), { recursive: true })
    await writeFile(s('state.json'), '{}')
    const { code, lines } = await run()
    expect(code).toBe(0)
    expect(lines.filter((l) => l.includes('Removed'))).toEqual(['✔ Removed .wp2payload/state.json'])
  })

  it('nothing to remove says so, exit 0', async () => {
    let r = await run()
    expect(r.code).toBe(0)
    expect(r.text).toMatch(/^Nothing to reset.*database was not changed/)
    await mkdir(s('quarantine'), { recursive: true })
    await writeFile(s('report.json'), '{}')
    r = await run()
    expect(r.code).toBe(0)
    expect(r.text).toMatch(/^Nothing to reset: no state or cache/)
    expect((await readdir(s())).sort()).toEqual(['quarantine', 'report.json'])
  })

  it('refuses a symlinked .wp2payload pointing outside the project', async (ctx) => {
    await mkdir(path.join(outside, 'cache'), { recursive: true })
    await writeFile(path.join(outside, 'state.json'), '{}')
    await writeFile(path.join(outside, 'cache', 'keep'), 'k')
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    if (!(await trySymlink(outside, path.join(dir, '.wp2payload'), type))) return ctx.skip()
    const { code, text } = await run()
    expect(code).toBe(1)
    expect(text).toMatch(/not a plain folder[\s\S]*Nothing was removed/)
    expect(existsSync(path.join(outside, 'state.json'))).toBe(true)
    expect(existsSync(path.join(outside, 'cache', 'keep'))).toBe(true)
  })

  it('refuses a symlinked cache pointing outside the project and removes nothing', async (ctx) => {
    await mkdir(s(), { recursive: true })
    await writeFile(s('state.json'), '{}')
    await writeFile(path.join(outside, 'keep'), 'k')
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    if (!(await trySymlink(outside, s('cache'), type))) return ctx.skip()
    const { code, text } = await run()
    expect(code).toBe(1)
    expect(text).toMatch(/cache is not a plain folder/)
    expect(existsSync(s('state.json'))).toBe(true)
    expect(existsSync(path.join(outside, 'keep'))).toBe(true)
  })

  it('refuses when .wp2payload is a file', async () => {
    await writeFile(path.join(dir, '.wp2payload'), 'x')
    const { code } = await run()
    expect(code).toBe(1)
  })
})
