import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateCorruptError, StateStore } from '../../src/state/index.js'
import { withRetry } from '../../src/state/retry.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-state-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const file = () => path.join(dir, '.wp2payload', 'state.json')

describe('StateStore', () => {
  it('starts fresh, saves atomically (no temp left), and reloads', async () => {
    const s = await StateStore.open(dir, 'https://a.test')
    s.set('category', 5, 9)
    s.updatePhase('terms', { status: 'in_progress', processed: 3, total: 10, cursor: 4 })
    await s.flush()
    await s.flush() // overwrite an existing file (Windows rename path)
    expect(await readdir(path.join(dir, '.wp2payload'))).toEqual(['state.json'])
    const raw = JSON.parse(await readFile(file(), 'utf8'))
    expect(raw).toMatchObject({ version: 1, site: 'https://a.test', idMap: { category: { '5': 9 } } })
    const again = await StateStore.open(dir, 'https://a.test')
    expect(again.get('category', 5)).toBe(9)
    expect(again.get('category', 6)).toBeUndefined()
    expect(again.phase('terms')).toEqual({ status: 'in_progress', processed: 3, total: 10, cursor: 4 })
    expect(again.phase('x')).toEqual({ status: 'pending', processed: 0 })
  })

  it('corrupt JSON gives a clear error with a next step', async () => {
    await mkdir(path.dirname(file()), { recursive: true })
    await writeFile(file(), '{ not json', 'utf8')
    const err = await StateStore.open(dir, 's').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StateCorruptError)
    expect((err as Error).message).toMatch(/delete it and re-run/i)
  })

  it('a different site starts fresh instead of mixing ids', async () => {
    const a = await StateStore.open(dir, 'https://a.test')
    a.set('post', 1, 100)
    await a.flush()
    const b = await StateStore.open(dir, 'https://b.test')
    expect(b.resetReason).toBe('site_mismatch')
    expect(b.get('post', 1)).toBeUndefined()
    expect(b.site).toBe('https://b.test')
  })

  it('a different version starts fresh', async () => {
    await mkdir(path.dirname(file()), { recursive: true })
    await writeFile(file(), JSON.stringify({ version: 0, site: 's', startedAt: 'x', phases: {}, idMap: {} }))
    const s = await StateStore.open(dir, 's')
    expect(s.resetReason).toBe('version_mismatch')
  })

  it('flushIfDue throttles', async () => {
    const s = await StateStore.open(dir, 's')
    s.set('post', 1, 1)
    await s.flush()
    s.set('post', 2, 2)
    await s.flushIfDue(60_000)
    expect(JSON.parse(await readFile(file(), 'utf8')).idMap.post['2']).toBeUndefined()
    await s.flushIfDue(0)
    expect(JSON.parse(await readFile(file(), 'utf8')).idMap.post['2']).toBe(2)
  })
})

describe('withRetry', () => {
  it('retries up to 3 times then succeeds or throws', async () => {
    let n = 0
    expect(await withRetry(async () => (++n < 3 ? Promise.reject(new Error('x')) : 'ok'), { baseMs: 1 })).toBe('ok')
    n = 0
    await expect(
      withRetry(async () => {
        n++
        throw new Error('boom')
      }, { baseMs: 1 }),
    ).rejects.toThrow('boom')
    expect(n).toBe(3)
  })
})
