import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkNodeVersion, checkPayloadInstalled } from '../../src/doctor/checks.js'

describe('checkNodeVersion', () => {
  it.each(['22.12.0', '22.23.4', '24.0.0', '26.1.0'])('accepts %s', (v) => {
    expect(checkNodeVersion(v).status).toBe('ok')
  })

  it.each(['20.19.0', '22.11.9', '18.0.0'])('rejects %s with a next step', (v) => {
    const result = checkNodeVersion(v)
    expect(result.status).toBe('fail')
    expect(result.detail).toMatch(/Upgrade Node/)
  })
})

describe('checkPayloadInstalled', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-doctor-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeJson(rel: string, value: unknown) {
    const file = path.join(root, rel)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
  }

  // Any directory above tmp could hold a package.json, so start at the filesystem root.
  const fsRoot = path.parse(os.tmpdir()).root
  it.skipIf(existsSync(path.join(fsRoot, 'package.json')))('fails when there is no package.json', async () => {
    expect(await checkPayloadInstalled(fsRoot)).toMatchObject({ status: 'fail', title: 'No package.json found' })
  })

  it('fails when payload is not declared', async () => {
    await writeJson('package.json', { name: 'site', dependencies: { next: '16.0.0' } })
    const result = await checkPayloadInstalled(root)
    expect(result).toMatchObject({ status: 'fail', title: 'Payload is not a dependency of this project' })
  })

  it('fails when payload is declared but not installed', async () => {
    await writeJson('package.json', { dependencies: { payload: '^3.92.0' } })
    const result = await checkPayloadInstalled(root)
    expect(result).toMatchObject({ status: 'fail', title: 'Payload ^3.92.0 is listed but not installed' })
  })

  it('accepts an installed Payload 3', async () => {
    await writeJson('package.json', { devDependencies: { payload: '^3.92.0' } })
    await writeJson('node_modules/payload/package.json', { name: 'payload', version: '3.92.1' })
    expect(await checkPayloadInstalled(root)).toEqual({ status: 'ok', title: 'Payload 3.92.1' })
  })

  it('finds the project from a nested directory', async () => {
    await writeJson('package.json', { dependencies: { payload: '3.92.1' } })
    await writeJson('node_modules/payload/package.json', { version: '3.92.1' })
    await mkdir(path.join(root, 'src', 'app'), { recursive: true })
    expect((await checkPayloadInstalled(path.join(root, 'src', 'app'))).status).toBe('ok')
  })

  it('rejects Payload 2', async () => {
    await writeJson('package.json', { dependencies: { payload: '^2.0.0' } })
    await writeJson('node_modules/payload/package.json', { version: '2.30.0' })
    expect(await checkPayloadInstalled(root)).toMatchObject({ status: 'fail', title: 'Payload 2.30.0 is not supported' })
  })

  it('reports an invalid package.json with its path instead of throwing', async () => {
    await writeJson('package.json', '{ not json')
    expect(await checkPayloadInstalled(root)).toMatchObject({
      status: 'fail',
      title: `${path.join(root, 'package.json')} is not valid JSON`,
    })
  })

  it('accepts a package.json saved with a UTF-8 BOM', async () => {
    await writeJson('package.json', '﻿' + JSON.stringify({ dependencies: { payload: '^3.92.0' } }))
    await writeJson('node_modules/payload/package.json', { version: '3.92.1' })
    expect((await checkPayloadInstalled(root)).status).toBe('ok')
  })

  it('finds Payload hoisted above the project (monorepo)', async () => {
    await writeJson('apps/site/package.json', { dependencies: { payload: '^3.92.0' } })
    await writeJson('node_modules/payload/package.json', { version: '3.92.1' })
    expect(await checkPayloadInstalled(path.join(root, 'apps', 'site'))).toEqual({ status: 'ok', title: 'Payload 3.92.1' })
  })
})
