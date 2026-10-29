import { lstat, readFile, writeFile } from 'node:fs/promises'

// Line-level edits to the user's dotfiles. Each one only ever appends missing lines and never
// rewrites, reorders or prints what is already there (.env holds secrets).

/** Lines of a file without their line ending; trailing empty line dropped. */
function lines(text: string): string[] {
  const out = text.split(/\r?\n/)
  if (out.at(-1) === '') out.pop()
  return out
}

/** `text` with `added` appended, keeping the file's own line ending and a newline between. */
export function appendLines(text: string, added: readonly string[]): string {
  if (added.length === 0) return text
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const sep = text === '' || text.endsWith('\n') ? '' : eol
  return `${text}${sep}${added.join(eol)}${eol}`
}

const GITIGNORE_ENTRIES = ['.wp2payload/', '.env', '/backups/', '*.sql', '*.sql.gz', '*.wpress']
// Any of these already keeps .env out of git.
const ENV_RULES = new Set(['.env', '/.env', '.env*', '/.env*'])

/** Lines that ignore `entry`. Negations of any of them (`!.env`, `!/.env`...) un-ignore it. */
function rulesFor(entry: string): Set<string> {
  if (entry === '.env') return ENV_RULES
  const bare = entry.replace(/^\//, '')
  return new Set([entry, bare, `/${bare}`])
}

/**
 * The .gitignore entries still missing. An entry counts as present when an exact line ignores it
 * and no later line negates it (git applies the last matching rule), so this is idempotent.
 */
export function missingGitignoreEntries(text: string): string[] {
  const all = lines(text).map((l) => l.trim())
  return GITIGNORE_ENTRIES.filter((entry) => {
    const rules = rulesFor(entry)
    let ignored = false
    for (const line of all) {
      if (rules.has(line)) ignored = true
      else if (line.startsWith('!') && rules.has(line.slice(1))) ignored = false
    }
    return !ignored
  })
}

export function updateGitignore(text: string): { text: string; added: string[] } {
  const added = missingGitignoreEntries(text)
  if (added.length === 0) return { text, added }
  const block = ['', '# wp2payload: migration state, secrets and WordPress backups (never commit these)', ...added]
  // No leading blank line in a new file.
  return { text: appendLines(text, text.trim() === '' ? block.slice(1) : block), added }
}

/** True when an env file assigns `name` (`NAME=`, `export NAME=`), commented lines excluded. */
export function definesEnv(text: string, name: string): boolean {
  return new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, 'm').test(text)
}

/** 'symlink': the path is a symbolic link or junction, so nothing was written through it. */
export type EditResult = 'created' | 'updated' | 'unchanged' | 'symlink'

/** True when `file` is a symbolic link (or, on Windows, a junction). False when it does not exist. */
export async function isLink(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isSymbolicLink()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

/** Exists as anything, a dangling symlink included (existsSync follows links and would say no). */
export async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

async function readOrEmpty(file: string): Promise<string | undefined> {
  return (await exists(file)) ? await readFile(file, 'utf8') : undefined
}

// Every writer refuses a symlinked target: following one could write outside the project.

/** Appends `.gitignore` entries; creates the file when missing. */
export async function writeGitignore(file: string): Promise<{ result: EditResult; added: string[] }> {
  if (await isLink(file)) return { result: 'symlink', added: [] }
  const before = await readOrEmpty(file)
  const { text, added } = updateGitignore(before ?? '')
  if (added.length === 0) return { result: 'unchanged', added }
  await writeFile(file, text)
  return { result: before === undefined ? 'created' : 'updated', added }
}

/** Sets `name=value` in an env file unless it already defines `name`. Creates the file when missing. */
export async function addEnvValue(file: string, name: string, value: string): Promise<EditResult> {
  if (await isLink(file)) return 'symlink'
  const before = await readOrEmpty(file)
  if (before !== undefined && definesEnv(before, name)) return 'unchanged'
  await writeFile(file, appendLines(before ?? '', [`${name}=${value}`]))
  return before === undefined ? 'created' : 'updated'
}

/** Adds empty `NAME=` lines to an existing env example file. Never creates one. */
export async function addEnvNames(file: string, names: readonly string[]): Promise<{ result: EditResult; added: string[] }> {
  if (await isLink(file)) return { result: 'symlink', added: [] }
  const before = await readOrEmpty(file)
  if (before === undefined) return { result: 'unchanged', added: [] }
  const added = names.filter((name) => !definesEnv(before, name))
  if (added.length === 0) return { result: 'unchanged', added }
  await writeFile(file, appendLines(before, added.map((name) => `${name}=`)))
  return { result: 'updated', added }
}
