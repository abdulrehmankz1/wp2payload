import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { DEFAULT_CONFIG_FILE } from '../config/index.js'
import { addEnvNames, addEnvValue, exists, isLink, writeGitignore, type EditResult } from '../init/files.js'
import { findExistingCollections, writeScaffold } from '../init/scaffold.js'
import { configTemplate } from '../init/templates.js'
import { clean } from '../report/summary.js'
import { formatLine } from '../ui/output.js'

export interface InitOptions {
  cwd?: string
  /** WordPress site URL. Written to .env as WP_URL, never into the config file. */
  url?: string
  /** Write the blog preset collections (doc 4.7). */
  scaffold?: boolean
  /** Overwrite an existing wp2payload.config.ts. Never overwrites scaffolded collection files. */
  force?: boolean
  /** No questions: flags only. */
  yes?: boolean
  isTTY?: boolean
  log?: (line: string) => void
  /** Asks a question; an empty answer means `fallback`. Defaults to a readline prompt. */
  prompt?: (question: string, fallback?: string) => Promise<string>
}

const ENV_NAMES = ['WP_URL', 'WP_USER', 'WP_APP_PASSWORD'] as const

// Written unquoted into .env and read by dotenv-style parsers: whitespace, quotes, '#' (comment),
// '$' (expansion), '\' (escapes) and control characters would change what the parser reads.
const ENV_UNSAFE = /[\s"'#`$\\\u0000-\u001f\u007f-\u009f]/

/** The normalised URL to write as WP_URL, or why it cannot be used. */
function parseUrl(input: string): { href: string } | { problem: string } {
  if (ENV_UNSAFE.test(input)) return { problem: 'it contains spaces, quotes, #, $, \ or control characters' }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { problem: 'it is not a valid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: 'it is not an http(s) URL' }
  // Normalisation never adds unsafe characters, but the written value is what must be safe.
  if (ENV_UNSAFE.test(url.href)) return { problem: 'it contains characters .env cannot hold unquoted' }
  return { href: url.href }
}

class InitCancelled extends Error {}

const isYes = (answer: string) => /^y(es)?$/i.test(answer.trim())

const SYMLINK_FIX = 'wp2payload does not write through symbolic links or junctions. Replace it with a regular file, or edit it yourself.'

function logEdit(log: (line: string) => void, name: string, result: EditResult, detail?: string): void {
  if (result === 'symlink') log(formatLine('warn', `Skipped ${name}: it is a symbolic link`, SYMLINK_FIX))
  else if (result !== 'unchanged') log(formatLine('ok', `${result === 'created' ? 'Created' : 'Updated'} ${name}`, detail))
}

/** `wp2payload init` (doc 4.1, 4.5, 4.7). Returns the process exit code: 0 done, 1 refused. */
export async function runInit(opts: InitOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const log = opts.log ?? console.log
  const configFile = path.join(cwd, DEFAULT_CONFIG_FILE)

  // Refuse before asking anything, so nobody answers questions for nothing.
  if (await isLink(configFile)) {
    log(formatLine('fail', `${DEFAULT_CONFIG_FILE} is a symbolic link`, `${SYMLINK_FIX} --force does not change this.`))
    return 1
  }
  if ((await exists(configFile)) && !opts.force) {
    log(formatLine('fail', `${DEFAULT_CONFIG_FILE} already exists`, 'Edit it directly, or run wp2payload init --force to replace it.'))
    return 1
  }

  let input = opts.url?.trim() ?? ''
  let scaffold = opts.scaffold === true
  const interactive = !opts.yes && (opts.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true))
  if (interactive) {
    const ask = opts.prompt ?? readlinePrompt
    try {
      input = (await ask('WordPress site URL (leave empty to set WP_URL yourself)', input || undefined)).trim()
      scaffold = isYes(await ask('Scaffold the blog preset collections (posts, pages, categories, tags, authors, media)? [y/N]', scaffold ? 'y' : 'n'))
    } catch (error) {
      if (!(error instanceof InitCancelled)) throw error
      log('Cancelled. Nothing was written.')
      return 1
    }
  }
  let url: string | undefined
  if (input) {
    const parsed = parseUrl(input)
    if ('problem' in parsed) {
      // The input may hold terminal escapes: never echo it raw.
      log(formatLine('fail', `Cannot use ${JSON.stringify(clean(input))} as the WordPress URL: ${parsed.problem}`, 'Pass the site address, e.g. --url https://example.com'))
      return 1
    }
    url = parsed.href
  }

  await writeFile(configFile, configTemplate())
  log(formatLine('ok', `Wrote ${DEFAULT_CONFIG_FILE}`, 'It reads WP_URL, WP_USER and WP_APP_PASSWORD from the environment.'))

  if (url) {
    // The URL is not a secret, but it lives in .env so the config stays the same on every machine.
    const result = await addEnvValue(path.join(cwd, '.env'), 'WP_URL', url)
    if (result === 'unchanged') log(formatLine('warn', '.env already sets WP_URL; left it as it is', `Change it there if ${url} is the site you want.`))
    else logEdit(log, '.env', result, `WP_URL=${url}`)
  }
  const example = await addEnvNames(path.join(cwd, '.env.example'), ENV_NAMES)
  logEdit(log, '.env.example', example.result, `Added ${example.added.join(', ')}`)

  const gitignore = await writeGitignore(path.join(cwd, '.gitignore'))
  if (gitignore.result === 'unchanged') log(formatLine('ok', '.gitignore already covers wp2payload files'))
  else logEdit(log, '.gitignore', gitignore.result, `Added ${gitignore.added.join(', ')}`)

  let scaffoldDir: string | undefined
  if (scaffold) {
    const existing = await findExistingCollections(cwd)
    const result = await writeScaffold(cwd)
    if (result.symlink) {
      log(formatLine('warn', `Skipped the blog preset: ${result.symlink} is a symbolic link`, SYMLINK_FIX))
    } else {
      scaffoldDir = result.dir
    }
    if (result.written.length) log(formatLine('ok', `Wrote the blog preset to ${result.dir}/`, result.written.join(', ')))
    if (result.skipped.length) {
      log(formatLine('warn', `Kept existing files in ${result.dir}/ (never overwritten)`, `${result.skipped.join(', ')}\nDelete them first to get the generated version.`))
    }
    if (existing.length && scaffoldDir) {
      log(
        formatLine(
          'warn',
          `Your project already defines ${existing.map((e) => e.slug).join(', ')}`,
          [
            ...existing.map((e) => `${e.slug}: ${e.file}`),
            'Two collections with the same slug will not boot, so pick one per slug:',
            `- keep yours: ${DEFAULT_CONFIG_FILE} maps WordPress types to them via collections.<kind>.to`,
            ...existing.map((e) => `    collections.${e.kind}.to = '${e.slug}'`),
            `  add the wpMeta field to each (the copy in ${result.dir}/wpMeta.ts: fields: [...yourFields, wpMeta])`,
            `  and import only the preset collections you lack from ${result.dir}/ instead of wp2payloadCollections;`,
            '- or remove yours and use the preset.',
          ].join('\n'),
        ),
      )
    }
  }

  for (const line of nextSteps(scaffoldDir)) log(line)
  return 0
}

function nextSteps(scaffoldDir: string | undefined): string[] {
  const out = ['', 'Next steps:']
  let n = 1
  if (scaffoldDir) {
    const importPath = `./${scaffoldDir.replace(/^src\//, '')}`
    out.push(
      `  ${n++}. Add the preset to payload.config.ts:`,
      `       import { wp2payloadCollections } from '${importPath}'`,
      '       collections: [...wp2payloadCollections, /* your collections */],',
      '     then regenerate types: npx payload generate:types',
    )
  }
  out.push(
    `  ${n++}. Optional, to keep old WordPress URLs working inside Payload: pnpm add @payloadcms/plugin-redirects, then`,
    "       import { redirectsPlugin } from '@payloadcms/plugin-redirects'",
    "       plugins: [redirectsPlugin({ collections: ['posts', 'pages'] })],",
    '     Without it, wp2payload writes .wp2payload/redirects.json for next.config redirects().',
    `  ${n++}. Set in .env or your shell: WP_URL, and for private content WP_USER and WP_APP_PASSWORD.`,
    '     Create the Application Password for a least-privilege user (Editor is enough) and revoke it after the migration.',
    `  ${n++}. npx wp2payload doctor`,
    `  ${n++}. npx wp2payload migrate --dry-run`,
  )
  return out
}

async function readlinePrompt(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const abort = new AbortController()
  rl.once('SIGINT', () => abort.abort())
  try {
    const answer = await rl.question(fallback ? `${question} (${fallback}) ` : `${question} `, { signal: abort.signal })
    return answer.trim() || (fallback ?? '')
  } catch (error) {
    // Ctrl+C: stop the command rather than carry on with half the answers.
    if ((error as { name?: string }).name === 'AbortError') throw new InitCancelled()
    throw error
  } finally {
    rl.close()
  }
}
