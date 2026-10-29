import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { renameWithFallback, STATE_DIR } from '../state/store.js'
import type { ReportJson } from './types.js'

export const REPORT_FILE = 'report.json'
/** Path shown to users, relative to the project root. */
export const REPORT_PATH = `${STATE_DIR}/${REPORT_FILE}`

export class ReportCorruptError extends Error {
  constructor(
    readonly file: string,
    reason: string,
  ) {
    super(
      `Report ${file} cannot be read (${reason}). ` +
        `Next step: run \`wp2payload migrate --dry-run\` to write a new one.`,
    )
    this.name = 'ReportCorruptError'
  }
}

/** Writes `<root>/.wp2payload/report.json` atomically. Returns the path relative to root. */
export async function writeReport(root: string, json: ReportJson): Promise<string> {
  const file = path.join(root, STATE_DIR, REPORT_FILE)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(json, null, 2) + '\n', 'utf8')
  try {
    await renameWithFallback(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
  return REPORT_PATH
}

/** The last report, or undefined when none exists. Throws ReportCorruptError on bad content. */
export async function readReport(root: string): Promise<ReportJson | undefined> {
  const file = path.join(root, STATE_DIR, REPORT_FILE)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ReportCorruptError(REPORT_PATH, `not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) throw new ReportCorruptError(REPORT_PATH, 'not a JSON object')
  const o = parsed as Record<string, unknown>
  if (o['version'] !== 1) throw new ReportCorruptError(REPORT_PATH, `unsupported version ${JSON.stringify(o['version'])}`)
  const sec = o['security'] as Record<string, unknown> | null | undefined
  const ok =
    typeof o['dryRun'] === 'boolean' &&
    typeof o['site'] === 'string' &&
    typeof o['startedAt'] === 'string' &&
    typeof o['durationSec'] === 'number' &&
    typeof o['summary'] === 'object' &&
    o['summary'] !== null &&
    Array.isArray(o['warnings']) &&
    Array.isArray(o['errors']) &&
    typeof sec === 'object' &&
    sec !== null &&
    typeof sec['summary'] === 'object' &&
    sec['summary'] !== null &&
    Array.isArray(sec['findings'])
  if (!ok) throw new ReportCorruptError(REPORT_PATH, 'missing required fields')
  return parsed as ReportJson
}
