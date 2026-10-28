import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Status } from '../ui/output.js'

export interface CheckResult {
  status: Status
  title: string
  // What happened and what to do next (Section 8.5).
  detail?: string
}

// Payload 3 itself requires ^22.23.4 || >=24.22.1; this is the floor for the CLI.
export const MIN_NODE = { major: 22, minor: 12 } as const
export const SUPPORTED_PAYLOAD_MAJOR = 3

export function checkNodeVersion(version: string = process.versions.node): CheckResult {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)
  if (ok) return { status: 'ok', title: `Node ${version}` }
  return {
    status: 'fail',
    title: `Node ${version} is too old`,
    detail: `wp2payload needs Node ${MIN_NODE.major}.${MIN_NODE.minor} or newer. Upgrade Node and run doctor again.`,
  }
}

interface PackageJson {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

class PackageReadError extends Error {
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`${file}: ${reason}`)
  }
}

async function readJson(file: string): Promise<PackageJson | undefined> {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw new PackageReadError(file, `could not be read (${code ?? 'unknown error'})`)
  }
  try {
    // npm accepts a UTF-8 BOM, which some Windows editors and PowerShell 5.1 add.
    return JSON.parse(text.replace(/^﻿/, '')) as PackageJson
  } catch {
    throw new PackageReadError(file, 'is not valid JSON')
  }
}

function readFailure(error: unknown): CheckResult {
  if (!(error instanceof PackageReadError)) throw error
  return {
    status: 'fail',
    title: `${error.file} ${error.reason}`,
    detail: 'Fix the file and run doctor again.',
  }
}

// Walks up from `start` and returns the first directory where `relative` exists.
async function findUp(start: string, relative: string): Promise<{ dir: string; json: PackageJson } | undefined> {
  let dir = path.resolve(start)
  for (;;) {
    const json = await readJson(path.join(dir, relative))
    if (json) return { dir, json }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export async function checkPayloadInstalled(cwd: string = process.cwd()): Promise<CheckResult> {
  let project
  try {
    project = await findUp(cwd, 'package.json')
  } catch (error) {
    return readFailure(error)
  }
  if (!project) {
    return {
      status: 'fail',
      title: 'No package.json found',
      detail: 'Run wp2payload from inside your Payload project.',
    }
  }

  const declared = project.json.dependencies?.payload ?? project.json.devDependencies?.payload
  if (!declared) {
    return {
      status: 'fail',
      title: 'Payload is not a dependency of this project',
      detail: `Checked ${path.join(project.dir, 'package.json')}.\nRun wp2payload from inside your Payload 3 project.`,
    }
  }

  let installed
  try {
    installed = await findUp(project.dir, path.join('node_modules', 'payload', 'package.json'))
  } catch (error) {
    return readFailure(error)
  }
  if (!installed?.json.version) {
    return {
      status: 'fail',
      title: `Payload ${declared} is listed but not installed`,
      detail: "Run your package manager's install command, then run doctor again.",
    }
  }

  const version = installed.json.version
  const major = Number(version.split('.')[0])
  if (major !== SUPPORTED_PAYLOAD_MAJOR) {
    return {
      status: 'fail',
      title: `Payload ${version} is not supported`,
      detail: `wp2payload supports Payload ${SUPPORTED_PAYLOAD_MAJOR}.x.`,
    }
  }
  return { status: 'ok', title: `Payload ${version}` }
}
