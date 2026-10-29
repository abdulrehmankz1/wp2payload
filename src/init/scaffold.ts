import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isLink } from './files.js'
import { PRESET_COLLECTIONS, SCAFFOLD_FILES, type ScaffoldFile } from './templates.js'

// Writes the blog preset as new files (AC-A2). Existing files are never overwritten, not even
// with --force: they are the user's code once written.

export interface ScaffoldResult {
  /** Folder the preset lives in, relative to the project (posix separators). */
  dir: string
  written: ScaffoldFile[]
  skipped: ScaffoldFile[]
  /** Set when a folder on the way is a symlink or junction; then nothing was written. */
  symlink?: string
}

/** `src/collections/wp2payload` when the project has `src/`, else `collections/wp2payload`. */
export function scaffoldDir(cwd: string): string {
  return existsSync(path.join(cwd, 'src')) ? 'src/collections/wp2payload' : 'collections/wp2payload'
}

export async function writeScaffold(cwd: string): Promise<ScaffoldResult> {
  const dir = scaffoldDir(cwd)
  const parts = dir.split('/')
  const abs = path.join(cwd, ...parts)
  const written: ScaffoldFile[] = []
  const skipped: ScaffoldFile[] = []
  // Never write through a symlinked or junctioned folder: it could point outside the project.
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/')
    if (await isLink(path.join(cwd, ...parts.slice(0, i)))) return { dir, written, skipped, symlink: sub }
  }
  await mkdir(abs, { recursive: true })
  for (const [name, content] of SCAFFOLD_FILES) {
    try {
      // 'wx' fails when the file exists, so a file created meanwhile is not clobbered either.
      await writeFile(path.join(abs, name), content, { flag: 'wx' })
      written.push(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      skipped.push(name)
    }
  }
  return { dir, written, skipped }
}

export interface ExistingCollection {
  slug: string
  kind: string
  /** Where it was found, relative to the project (posix separators). */
  file: string
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/

/**
 * Collections the project already defines with a preset slug (the Payload website template has
 * posts, pages, categories and media). Looks at `collections/` next to where the preset goes:
 * `Posts.ts` or `Posts/index.ts` style files, matched by a `slug: 'posts'` in their source.
 */
export async function findExistingCollections(cwd: string): Promise<ExistingCollection[]> {
  const base = path.dirname(path.join(cwd, ...scaffoldDir(cwd).split('/')))
  if (!existsSync(base)) return []
  const candidates: string[] = []
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (entry.isFile() && SOURCE.test(entry.name)) candidates.push(path.join(base, entry.name))
    else if (entry.isDirectory() && entry.name !== 'wp2payload') {
      for (const inner of await readdir(path.join(base, entry.name), { withFileTypes: true })) {
        if (inner.isFile() && /^index\./.test(inner.name) && SOURCE.test(inner.name)) candidates.push(path.join(base, entry.name, inner.name))
      }
    }
  }
  const found: ExistingCollection[] = []
  for (const file of candidates.sort()) {
    const text = await readFile(file, 'utf8')
    for (const preset of PRESET_COLLECTIONS) {
      if (found.some((f) => f.slug === preset.slug)) continue
      if (new RegExp(`\\bslug\\s*:\\s*['"\`]${preset.slug}['"\`]`).test(text)) {
        found.push({ ...preset, file: path.relative(cwd, file).split(path.sep).join('/') })
      }
    }
  }
  return found
}
