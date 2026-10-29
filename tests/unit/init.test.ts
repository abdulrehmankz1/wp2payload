import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runInit, type InitOptions } from '../../src/commands/init.js'
import { loadConfig, resolveConfig } from '../../src/config/index.js'
import { appendLines, definesEnv, missingGitignoreEntries, updateGitignore } from '../../src/init/files.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SECRET = 'abcd EFGH 1234 ijkl MNOP 5678'

describe('runInit', () => {
  let root: string
  let lines: string[]
  const log = (line: string) => lines.push(line)
  const output = () => lines.join('\n')
  const read = (rel: string) => readFile(path.join(root, rel), 'utf8')
  const init = (opts: InitOptions = {}) => runInit({ cwd: root, log, yes: true, ...opts })

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-init-'))
    lines = []
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  describe('wp2payload.config.ts (AC-A1)', () => {
    it('reads URL and credentials from env and never writes them as literals', async () => {
      expect(await init({ url: 'https://blog.example.test' })).toBe(0)
      const config = await read('wp2payload.config.ts')
      expect(config).toContain("import { defineConfig } from 'wp2payload'")
      expect(config).toContain('url: process.env.WP_URL!')
      expect(config).toContain('appPassword: process.env.WP_APP_PASSWORD')
      expect(config).toContain('redirects: { enabled: true }')
      expect(config).not.toContain('blog.example.test')
      expect(config).not.toMatch(/appPassword:\s*['"`]/)
    })

    it('loads with the literal-secret rule satisfied and maps the blog preset', async () => {
      await init()
      // The project would resolve 'wp2payload' from node_modules; point it at the source instead.
      const file = path.join(root, 'wp2payload.config.ts')
      const src = (await read('wp2payload.config.ts')).replace("'wp2payload'", JSON.stringify(path.join(repoRoot, 'src/config/index.ts').split(path.sep).join('/')))
      await writeFile(file, src)
      const env = { WP_URL: 'https://blog.example.test', WP_USER: 'editor', WP_APP_PASSWORD: SECRET }
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
      const config = await loadConfig(undefined, root, env)
      expect(config.source).toEqual({ type: 'rest', url: 'https://blog.example.test', auth: { user: 'editor', appPassword: SECRET } })
      expect(config.collections).toEqual(resolveConfig({ source: { type: 'rest', url: 'https://x.test' } }).collections)
      expect(config.redirects.enabled).toBe(true)

      // No password in the environment: public content only, no auth.
      vi.stubEnv('WP_USER', undefined)
      vi.stubEnv('WP_APP_PASSWORD', undefined)
      const anonymous = await loadConfig(undefined, root, { WP_URL: 'https://blog.example.test' })
      expect(anonymous.source).toEqual({ type: 'rest', url: 'https://blog.example.test' })
    })

    it('refuses to overwrite an existing config without --force, writing nothing', async () => {
      await writeFile(path.join(root, 'wp2payload.config.ts'), '// mine\n')
      expect(await init({ url: 'https://blog.example.test', scaffold: true })).toBe(1)
      expect(output()).toMatch(/wp2payload\.config\.ts already exists/)
      expect(output()).toContain('--force')
      expect(await read('wp2payload.config.ts')).toBe('// mine\n')
      expect(await readdir(root)).toEqual(['wp2payload.config.ts'])
    })

    it('replaces the config with --force', async () => {
      await writeFile(path.join(root, 'wp2payload.config.ts'), '// mine\n')
      expect(await init({ force: true })).toBe(0)
      expect(await read('wp2payload.config.ts')).toContain('defineConfig')
    })

    it('rejects a URL that is not http(s) before writing anything', async () => {
      expect(await init({ url: 'ftp://blog.example.test' })).toBe(1)
      expect(await init({ url: 'https://x.test/#frag' })).toBe(1)
      expect(existsSync(path.join(root, 'wp2payload.config.ts'))).toBe(false)
    })

    it.each([
      ['$', 'https://x.test/$HOME'],
      ['backslash', 'https://x.test\\evil'],
      ['C0 control', 'https://x.test/\u001b[31mred'],
      ['C1 control', 'https://x.test/\u009bcsi'],
      ['quote', "https://x.test/'a"],
    ])('rejects a URL with %s, never echoing it raw', async (_what, url) => {
      expect(await init({ url })).toBe(1)
      expect(existsSync(path.join(root, 'wp2payload.config.ts'))).toBe(false)
      expect(output()).toMatch(/Cannot use .* as the WordPress URL/)
      expect(output()).not.toMatch(/[\u001b\u009b]/)
    })
  })

  describe('.env and .env.example', () => {
    it('creates .env with the normalised WP_URL when a URL is given', async () => {
      await init({ url: 'HTTPS://Blog.Example.test' })
      expect(await read('.env')).toBe('WP_URL=https://blog.example.test/\n')
    })

    it('appends WP_URL to an existing .env, keeping every other line', async () => {
      await writeFile(path.join(root, '.env'), 'PAYLOAD_SECRET=s3cret\r\nDATABASE_URI=file:./x.db')
      await init({ url: 'https://blog.example.test' })
      expect(await read('.env')).toBe('PAYLOAD_SECRET=s3cret\r\nDATABASE_URI=file:./x.db\r\nWP_URL=https://blog.example.test/\r\n')
      expect(output()).not.toContain('s3cret')
    })

    it('leaves a .env that already sets WP_URL untouched', async () => {
      await writeFile(path.join(root, '.env'), 'export WP_URL=https://old.example.test\n')
      await init({ url: 'https://blog.example.test' })
      expect(await read('.env')).toBe('export WP_URL=https://old.example.test\n')
      expect(output()).toMatch(/\.env already sets WP_URL/)
    })

    it('does not create .env without a URL', async () => {
      await init()
      expect(existsSync(path.join(root, '.env'))).toBe(false)
    })

    it('adds missing env names (empty) to an existing .env.example and never creates one', async () => {
      await init()
      expect(existsSync(path.join(root, '.env.example'))).toBe(false)
      await writeFile(path.join(root, '.env.example'), 'PAYLOAD_SECRET=\nWP_URL=https://example.com\n')
      await init({ force: true })
      expect(await read('.env.example')).toBe('PAYLOAD_SECRET=\nWP_URL=https://example.com\nWP_USER=\nWP_APP_PASSWORD=\n')
      await init({ force: true })
      expect(await read('.env.example')).toBe('PAYLOAD_SECRET=\nWP_URL=https://example.com\nWP_USER=\nWP_APP_PASSWORD=\n')
    })
  })

  describe('.gitignore', () => {
    it('creates .gitignore with the wp2payload entries', async () => {
      await init()
      const text = await read('.gitignore')
      expect(text.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['.wp2payload/', '.env', '/backups/', '*.sql', '*.sql.gz', '*.wpress'])
    })

    it('appends only missing entries, skips .env when a .env* rule exists, and is idempotent', async () => {
      await writeFile(path.join(root, '.gitignore'), 'node_modules\n.env*\n*.sql\n')
      await init()
      const once = await read('.gitignore')
      expect(once.startsWith('node_modules\n.env*\n*.sql\n\n# wp2payload')).toBe(true)
      expect(once.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['node_modules', '.env*', '*.sql', '.wp2payload/', '/backups/', '*.sql.gz', '*.wpress'])
      await init({ force: true })
      expect(await read('.gitignore')).toBe(once)
      expect(output()).toMatch(/\.gitignore already covers wp2payload files/)
    })

    it('appends an entry again when a later line negates it', async () => {
      await writeFile(path.join(root, '.gitignore'), '.env\n.wp2payload/\n!.env\n!/.wp2payload/\n/backups/\n*.sql\n*.sql.gz\n*.wpress\n!.env.example\n')
      await init()
      const added = (await read('.gitignore')).split('\n').slice(9).filter((l) => l && !l.startsWith('#'))
      expect(added).toEqual(['.wp2payload/', '.env'])
      await init({ force: true })
      expect(output()).toMatch(/\.gitignore already covers wp2payload files/)
    })
  })

  describe('symbolic links and junctions', () => {
    let outside: string
    beforeEach(async () => {
      outside = await mkdtemp(path.join(os.tmpdir(), 'wp2p-init-outside-'))
    })
    afterEach(async () => {
      await rm(outside, { recursive: true, force: true })
    })

    /** A file symlink, or undefined where the OS does not permit one (Windows without Developer Mode). */
    async function fileLink(name: string, content?: string): Promise<string | undefined> {
      const target = path.join(outside, name)
      if (content !== undefined) await writeFile(target, content)
      try {
        await symlink(target, path.join(root, name), 'file')
        return target
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return undefined
        throw error
      }
    }

    it('skips the scaffold when src/collections is a junction, writing nothing through it', async () => {
      await mkdir(path.join(root, 'src'))
      // 'junction' needs no privilege on Windows and is ignored elsewhere (a dir symlink).
      await symlink(outside, path.join(root, 'src', 'collections'), 'junction')
      expect(await init({ scaffold: true })).toBe(0)
      expect(output()).toMatch(/Skipped the blog preset: src\/collections is a symbolic link/)
      expect(await readdir(outside)).toEqual([])
      expect(output()).not.toContain('wp2payloadCollections')
    })

    it('skips the scaffold when the wp2payload folder itself is a junction', async () => {
      await mkdir(path.join(root, 'collections'))
      await symlink(outside, path.join(root, 'collections', 'wp2payload'), 'junction')
      await init({ scaffold: true })
      expect(output()).toMatch(/collections\/wp2payload is a symbolic link/)
      expect(await readdir(outside)).toEqual([])
    })

    // Runs everywhere: junctions need no privilege on Windows. lstat reports them like symlinks,
    // so the same check covers file symlinks (tested below where the OS permits them).
    it('treats junctions at the dotfile and config paths as links: refuses or skips, writes nothing', async () => {
      for (const name of ['.gitignore', '.env', '.env.example']) {
        await symlink(outside, path.join(root, name), 'junction')
      }
      expect(await init({ url: 'https://blog.example.test' })).toBe(0)
      for (const name of ['.gitignore', '.env', '.env.example']) expect(output()).toContain(`Skipped ${name}: it is a symbolic link`)
      expect(await readdir(outside)).toEqual([])
      await rm(path.join(root, 'wp2payload.config.ts'))
      await symlink(outside, path.join(root, 'wp2payload.config.ts'), 'junction')
      expect(await init({ force: true })).toBe(1)
      expect(output()).toMatch(/wp2payload\.config\.ts is a symbolic link/)
      expect(await readdir(outside)).toEqual([])
    })

    it('refuses a symlinked wp2payload.config.ts, even with --force and when dangling', async (ctx) => {
      const target = await fileLink('wp2payload.config.ts')
      if (!target) return ctx.skip()
      expect(await init({ force: true })).toBe(1)
      expect(output()).toMatch(/wp2payload\.config\.ts is a symbolic link/)
      expect(existsSync(target)).toBe(false)
    })

    it('skips symlinked .gitignore, .env and .env.example with a warning', async (ctx) => {
      const gitignore = await fileLink('.gitignore', 'node_modules\n')
      if (!gitignore) return ctx.skip()
      await fileLink('.env', 'A=1\n')
      await fileLink('.env.example', 'A=\n')
      expect(await init({ url: 'https://blog.example.test' })).toBe(0)
      expect(await readFile(gitignore, 'utf8')).toBe('node_modules\n')
      expect(await readFile(path.join(outside, '.env'), 'utf8')).toBe('A=1\n')
      expect(await readFile(path.join(outside, '.env.example'), 'utf8')).toBe('A=\n')
      for (const name of ['.gitignore', '.env', '.env.example']) expect(output()).toContain(`Skipped ${name}: it is a symbolic link`)
    })
  })

  describe('--scaffold (AC-A2)', () => {
    const FILES = ['Authors.ts', 'Categories.ts', 'Media.ts', 'Pages.ts', 'Posts.ts', 'Tags.ts', 'access.ts', 'blocks.ts', 'editor.ts', 'index.ts', 'wpMeta.ts']

    it('writes the preset under src/collections/wp2payload when src/ exists', async () => {
      await mkdir(path.join(root, 'src'))
      expect(await init({ scaffold: true })).toBe(0)
      const dir = path.join(root, 'src/collections/wp2payload')
      expect((await readdir(dir)).sort()).toEqual(FILES)
      const posts = await readFile(path.join(dir, 'Posts.ts'), 'utf8')
      expect(posts.startsWith('// Generated by wp2payload init. Edit freely.\n')).toBe(true)
      expect(posts).toContain("import type { CollectionConfig } from 'payload'")
      expect(posts).toContain('versions: { drafts: true }')
      expect(posts).toContain("{ name: 'heroImage', type: 'upload', relationTo: 'media' }")
      expect(posts).toContain("name: 'meta'")
      expect(posts).toContain('access: { read: publishedOrLoggedIn }')
      const pages = await readFile(path.join(dir, 'Pages.ts'), 'utf8')
      expect(pages).toContain("{ name: 'parent', type: 'relationship', relationTo: 'pages'")
      expect(pages).toContain('versions: { drafts: true }')
      expect(await readFile(path.join(dir, 'Media.ts'), 'utf8')).toContain("upload: { staticDir: 'media' }")
      const editor = await readFile(path.join(dir, 'editor.ts'), 'utf8')
      expect(editor).toContain("{ name: 'rel', type: 'text'")
      expect(editor).toContain('BlocksFeature({ blocks: [Embed, WpRawHtml] })')
      // Own copy of wpMeta: the production build must not import wp2payload.
      for (const file of FILES) expect(await readFile(path.join(dir, file), 'utf8')).not.toContain("from 'wp2payload'")
      expect(output()).toContain("import { wp2payloadCollections } from './collections/wp2payload'")
    })

    it('uses collections/wp2payload when there is no src/', async () => {
      await init({ scaffold: true })
      expect((await readdir(path.join(root, 'collections/wp2payload'))).sort()).toEqual(FILES)
    })

    it('never overwrites an existing preset file, even with --force', async () => {
      const dir = path.join(root, 'collections/wp2payload')
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'Posts.ts'), '// edited by me\n')
      await init({ scaffold: true, force: true })
      expect(await readFile(path.join(dir, 'Posts.ts'), 'utf8')).toBe('// edited by me\n')
      expect(output()).toMatch(/Kept existing files in collections\/wp2payload\/ \(never overwritten\)\n.*Posts\.ts/)
      expect((await readdir(dir)).sort()).toEqual(FILES)
    })

    it('warns when the project already defines preset slugs (Payload website template)', async () => {
      const cols = path.join(root, 'src/collections')
      await mkdir(path.join(cols, 'Posts'), { recursive: true })
      await writeFile(path.join(cols, 'Posts/index.ts'), "export const Posts = {\n  slug: 'posts',\n  fields: [],\n}\n")
      await writeFile(path.join(cols, 'Media.ts'), 'export const Media = { slug: "media", upload: true, fields: [] }\n')
      await writeFile(path.join(cols, 'Users.ts'), "export const Users = { slug: 'users', auth: true, fields: [] }\n")
      expect(await init({ scaffold: true })).toBe(0)
      const out = output()
      expect(out).toMatch(/! Your project already defines media, posts/)
      expect(out).toContain('src/collections/Posts/index.ts')
      expect(out).toContain("collections.post.to = 'posts'")
      expect(out).toContain('src/collections/wp2payload/wpMeta.ts')
      expect(out).not.toMatch(/defines[^\n]*users/)
    })

    it('writes no collection files without --scaffold', async () => {
      await mkdir(path.join(root, 'src'))
      await init()
      expect(existsSync(path.join(root, 'src/collections'))).toBe(false)
      expect(output()).not.toContain('wp2payloadCollections')
    })
  })

  describe('modes (AC-A4)', () => {
    it('non-interactive: flags only, no prompt, prints next steps', async () => {
      const prompt = () => Promise.reject(new Error('must not prompt'))
      expect(await runInit({ cwd: root, log, isTTY: false, prompt, url: 'https://blog.example.test' })).toBe(0)
      const out = output()
      for (const name of ['WP_URL', 'WP_USER', 'WP_APP_PASSWORD']) expect(out).toContain(name)
      expect(out).toMatch(/Editor/)
      expect(out).toContain("redirectsPlugin({ collections: ['posts', 'pages'] })")
      expect(out).toContain('npx wp2payload doctor')
      expect(out).toContain('npx wp2payload migrate --dry-run')
    })

    it('--yes skips the questions even in a TTY', async () => {
      const prompt = () => Promise.reject(new Error('must not prompt'))
      expect(await runInit({ cwd: root, log, isTTY: true, yes: true, prompt })).toBe(0)
    })

    it('interactive: asks for the URL and the scaffold, with flag values as defaults', async () => {
      const asked: [string, string | undefined][] = []
      const answers = ['https://typed.example.test', 'y']
      const prompt = async (question: string, fallback?: string) => {
        asked.push([question, fallback])
        return answers.shift() ?? ''
      }
      expect(await runInit({ cwd: root, log, isTTY: true, prompt, url: 'https://flag.example.test' })).toBe(0)
      expect(asked[0]).toEqual([expect.stringMatching(/WordPress site URL/), 'https://flag.example.test'])
      expect(asked[1]).toEqual([expect.stringMatching(/blog preset/), 'n'])
      expect(await read('.env')).toBe('WP_URL=https://typed.example.test/\n')
      expect(existsSync(path.join(root, 'collections/wp2payload/index.ts'))).toBe(true)
    })

    it('interactive: an empty URL answer leaves WP_URL to the user', async () => {
      const prompt = async (_q: string, fallback?: string) => fallback ?? ''
      expect(await runInit({ cwd: root, log, isTTY: true, prompt })).toBe(0)
      expect(existsSync(path.join(root, '.env'))).toBe(false)
      expect(existsSync(path.join(root, 'collections'))).toBe(false)
    })
  })
})

describe('init file helpers', () => {
  it('appendLines keeps the line ending and adds a separator newline only when needed', () => {
    expect(appendLines('', ['a'])).toBe('a\n')
    expect(appendLines('x', ['a', 'b'])).toBe('x\na\nb\n')
    expect(appendLines('x\r\n', ['a'])).toBe('x\r\na\r\n')
    expect(appendLines('x\n', [])).toBe('x\n')
  })

  it('treats /.env and .env* as already ignoring .env, but not .env.local', () => {
    expect(missingGitignoreEntries('/.env\n')).not.toContain('.env')
    expect(missingGitignoreEntries('  .env*  \n')).not.toContain('.env')
    expect(missingGitignoreEntries('.env.local\n')).toContain('.env')
    expect(updateGitignore(updateGitignore('').text).added).toEqual([])
  })

  it('definesEnv ignores comments and other names', () => {
    expect(definesEnv('# WP_URL=x\nWP_URL_OLD=y\n', 'WP_URL')).toBe(false)
    expect(definesEnv('a=1\n  WP_URL = x\n', 'WP_URL')).toBe(true)
  })
})
