import { existsSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDoctor } from '../../src/commands/doctor.js'
import { runScanCommand, sourceFor } from '../../src/commands/scan.js'
import { resolveConfig } from '../../src/config/index.js'
import { openArchive, openUploadsArchives, removeTempFoldersSync, type OpenArchiveOptions } from '../../src/extractors/archive/index.js'
import { entryPath, insideRoot, pickDump, uploadsPart } from '../../src/extractors/archive/rules.js'
import { openSource } from '../../src/extractors/source.js'
import { SqlExtractor, type SqlExtractorOptions } from '../../src/extractors/sql/index.js'
import type { ScanReport } from '../../src/scan/run.js'
import { makeTar, makeTarGz, makeZip, WP_DUMP, type TarItem, type ZipItem } from './archive-support.js'

// Zip and tar backups (doc 0.7, 12.7, T11; roadmap v1.2). Hostile archives must be refused with
// their SEC_ARCHIVE_* code, and nothing may be written outside the private temp folder.

let dir: string
/** Parent of the tar temp folders: empty again after every open + close, or failed open. */
let tmp: string
let png: Buffer
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-archive-'))
  png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#468' } }).png().toBuffer()
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})
beforeEach(async () => {
  tmp = await mkdtemp(path.join(dir, 'tmp-'))
})

let n = 0
async function file(name: string, data: Buffer | string): Promise<string> {
  const f = path.join(dir, `${++n}-${name}`)
  await writeFile(f, data)
  return f
}
const zip = (items: ZipItem[], name = 'backup.zip') => file(name, makeZip(items))
const tgz = (items: TarItem[], name = 'backup.tar.gz') => file(name, makeTarGz(items))
const opts = (o: Partial<OpenArchiveOptions> = {}): OpenArchiveOptions => ({ database: true, media: true, maxMediaBytes: 1024 ** 2, tempDir: tmp, ...o })

const probe = (database: SqlExtractorOptions['file']) => new SqlExtractor({ file: database }).probe()

const duplicator = (): ZipItem[] => [
  { name: 'wp-config.php', data: '<?php /* inert test file */' },
  { name: 'dup-installer/', mode: 0o040755 },
  { name: 'dup-installer/dup-database__6f1e2d.sql', data: WP_DUMP },
  // A plugin's own .sql file must not be mistaken for the site dump.
  { name: 'wp-content/plugins/demo/install.sql', data: 'CREATE TABLE x (id int);' },
  { name: 'wp-content/themes/demo/functions.php', data: '<?php /* inert */' },
  { name: 'wp-content/uploads/2026/01/photo.png', data: png },
  { name: 'wp-content/uploads/2026/01/café.png', data: png, method: 0 },
]

describe('zip backups (Duplicator, read in place)', () => {
  it('finds the dump and the uploads, and reads media without unpacking anything', async () => {
    const a = await openArchive(await zip(duplicator(), 'site_archive.zip'), opts())
    try {
      expect(a.tempRoot).toBeUndefined()
      expect(a.uploads).toBe(2)
      expect(typeof a.database).toBe('object')
      expect((await probe(a.database!)).siteUrl).toBe('https://old.example')
      expect(await a.readMedia!('2026/01/photo.png', 1024 ** 2)).toEqual(png)
      expect(await a.readMedia!('2026/01/café.png', 1024 ** 2)).toEqual(png)
      await expect(a.readMedia!('2026/01/photo.png', 10)).rejects.toMatchObject({ code: 'SEC_FILE_TOO_LARGE' })
      await expect(a.readMedia!('2026/01/missing.png', 1024 ** 2)).rejects.toMatchObject({ code: 'MEDIA_404' })
      // Paths named by the dump are untrusted too (T10).
      for (const bad of ['../../wp-config.php', '../plugins/demo/install.sql', '/etc/passwd', 'C:/x', '']) {
        await expect(a.readMedia!(bad, 1024 ** 2), bad).rejects.toMatchObject({ code: 'SEC_PATH_TRAVERSAL' })
      }
    } finally {
      await a.close()
    }
    expect(await readdir(tmp)).toEqual([])
  })

  it('takes database.sql at the root (older Duplicator) and a gzipped dump', async () => {
    const a = await openArchive(await zip([{ name: 'database.sql', data: WP_DUMP }, { name: 'backup.sql', data: 'x' }]), opts())
    expect((await probe(a.database!)).siteUrl).toBe('https://old.example')
    await a.close()
    const b = await openArchive(await zip([{ name: 'site/db.sql.gz', data: gzipSync(WP_DUMP), method: 0 }]), opts())
    expect((await probe(b.database!)).siteUrl).toBe('https://old.example')
    expect(b.uploads).toBe(0)
    await b.close()
  })

  it('refuses a backup with no dump, or with several it cannot choose between', async () => {
    await expect(openArchive(await zip([{ name: 'wp-content/uploads/a.png', data: png }]), opts())).rejects.toMatchObject({ code: 'DUMP_NO_WORDPRESS' })
    await expect(openArchive(await zip([{ name: 'a.sql', data: 'x' }, { name: 'b.sql', data: 'y' }]), opts())).rejects.toMatchObject({ code: 'DUMP_INVALID', message: /several SQL dumps/ })
  })
})

describe('UpdraftPlus backups (a dump plus split uploads archives)', () => {
  it('reads media from every uploads archive through the sql source', async () => {
    const db = await file('backup_2026-01-01-1200_Site_abc123-db.gz', gzipSync(WP_DUMP))
    const up1 = await zip([{ name: 'uploads/2026/01/photo.png', data: png }], 'backup_2026-01-01-1200_Site_abc123-uploads.zip')
    const up2 = await zip([{ name: 'uploads/2026/02/other.png', data: png }], 'backup_2026-01-01-1200_Site_abc123-uploads2.zip')
    const config = resolveConfig({ source: { type: 'sql', file: db, uploads: [up1, up2] } })
    const s = await openSource(config, dir)
    try {
      expect(s.uploadFiles).toBe(2)
      expect((await s.extractor.probe()).siteUrl).toBe('https://old.example')
      expect(await s.readLocalMedia!('2026/01/photo.png', 1024 ** 2)).toEqual(png)
      expect(await s.readLocalMedia!('2026/02/other.png', 1024 ** 2)).toEqual(png)
      await expect(s.readLocalMedia!('2026/03/none.png', 1024 ** 2)).rejects.toMatchObject({ code: 'MEDIA_404' })
      await expect(s.readLocalMedia!('../x', 1024 ** 2)).rejects.toMatchObject({ code: 'SEC_PATH_TRAVERSAL' })
    } finally {
      await s.close!()
    }
  })

  it('refuses an uploads archive with no uploads folder', async () => {
    const other = await zip([{ name: 'plugins/x.php', data: '<?php' }])
    await expect(openUploadsArchives([other], { media: true, maxMediaBytes: 100 })).rejects.toMatchObject({ code: 'DUMP_INVALID', message: /no uploads folder/ })
  })
})

describe('table prefix from the backup (wp-config.php, else the dump)', () => {
  const abc = WP_DUMP.replaceAll('`wp_', '`abc_')
  const config = (php: string) => `<?php\ndefine('AUTH_KEY', 'k/*ey');\n$table_prefix = ${php};\nrequire_once ABSPATH . 'wp-settings.php';\n`
  const prefixOf = async (archive: string, tablePrefix?: string) => {
    const s = await openSource(resolveConfig({ source: { type: 'archive', file: archive, ...(tablePrefix ? { tablePrefix } : {}) } }), dir, { media: false })
    try {
      return (await s.extractor.probe()).tablePrefix
    } finally {
      await s.close?.()
    }
  }

  it("reads $table_prefix from a zip's wp-config.php as text, and an explicit tablePrefix wins", async () => {
    const both = WP_DUMP + abc.replaceAll('https://old.example', 'https://other.example')
    const f = await zip([{ name: 'site/wp-config.php', data: config("'abc_'") }, { name: 'site/database.sql', data: both }])
    expect(await prefixOf(f)).toEqual({ value: 'abc_', from: 'wp-config.php' })
    expect(await prefixOf(f, 'wp_')).toEqual({ value: 'wp_', from: 'config' })
  })

  it("reads Duplicator's wp-config copy and a tar.gz's wp-config.php, without unpacking either", async () => {
    const dup = await zip([{ name: 'dup-installer/dup-wp-config-arc__6f1e2d.txt', data: config('"abc_"') }, { name: 'dup-installer/dup-database__6f1e2d.sql', data: abc }])
    expect(await prefixOf(dup)).toEqual({ value: 'abc_', from: 'wp-config.php' })
    const t = await tgz([{ name: 'public_html/wp-config.php', data: config("'abc_'") }, { name: 'db.sql', data: abc }])
    const a = await openArchive(t, opts())
    try {
      expect(a.wpConfig).toContain("$table_prefix = 'abc_'")
      expect(await readdir(a.tempRoot!, { recursive: true })).toEqual(['db.sql'])
    } finally {
      await a.close()
    }
    expect(await prefixOf(t)).toEqual({ value: 'abc_', from: 'wp-config.php' })
  })

  it('rejects a hostile $table_prefix and detects the prefix from the dump instead', async () => {
    for (const hostile of ["''; system('x'); //'", "'wp_'.system('id')", '"wp_${x}"', "'abc_; DROP TABLE x'"]) {
      const f = await zip([{ name: 'wp-config.php', data: config(hostile) }, { name: 'database.sql', data: abc }])
      const p = await prefixOf(f)
      expect(p, hostile).toMatchObject({ value: 'abc_', from: 'dump', note: expect.stringMatching(/^wp-config\.php was ignored: /) })
      expect(p?.note, hostile).not.toMatch(/system|DROP|\$\{/)
    }
  })

  it('ignores wp-config.php under wp-content, and two that tie', async () => {
    const plugin = await zip([{ name: 'wp-content/plugins/x/wp-config.php', data: config("'zz_'") }, { name: 'database.sql', data: abc }])
    expect(await prefixOf(plugin)).toEqual({ value: 'abc_', from: 'dump' })
    const tie = await zip([{ name: 'a/wp-config.php', data: config("'zz_'") }, { name: 'b/wp-config.php', data: config("'abc_'") }, { name: 'database.sql', data: abc }])
    const a = await openArchive(tie, opts())
    expect(a.wpConfig).toBeUndefined()
    await a.close()
  })

  it('scan <dump> detects the prefix, refuses two installs, and takes --table-prefix', async () => {
    const cwd = await mkdtemp(path.join(dir, 'scan-prefix-'))
    const one = await file('one.sql', abc)
    expect(await runScanCommand({ cwd, target: one, media: false, log: () => {}, env: {} })).toBe(0)
    const two = await file('two.sql', WP_DUMP + abc.replaceAll('https://old.example', 'https://other.example'))
    const lines: string[] = []
    expect(await runScanCommand({ cwd, target: two, media: false, log: (l) => lines.push(l), env: { NO_COLOR: '1' } })).toBe(1)
    expect(lines.join('\n')).toMatch(/more than one WordPress site, with the table prefixes "wp_", "abc_"[\s\S]*--table-prefix/)
    lines.length = 0
    expect(await runScanCommand({ cwd, target: two, tablePrefix: 'abc_', media: false, log: (l) => lines.push(l), env: { NO_COLOR: '1' } })).toBe(0)
    expect(lines.join('\n')).toMatch(/Backup of https:\/\/other\.example/)
    expect(await runScanCommand({ cwd, target: two, tablePrefix: "abc_'--", media: false, log: () => {}, env: {} })).toBe(2)
    expect(await runScanCommand({ cwd, target: 'https://example.com', tablePrefix: 'abc_', log: () => {}, env: {} })).toBe(2)
  })

  it('doctor prints the prefix and where it came from', async () => {
    const cwd = await mkdtemp(path.join(dir, 'doctor-prefix-'))
    const f = await zip([{ name: 'wp-config.php', data: config("'abc_'") }, { name: 'database.sql', data: abc }])
    await writeFile(path.join(cwd, 'wp2payload.config.ts'), `export default { source: { type: 'archive', file: ${JSON.stringify(f)} } }`)
    const out: string[] = []
    await runDoctor({ cwd, log: (l) => out.push(l), env: { NO_COLOR: '1' } })
    expect(out.join('\n')).toMatch(/Table prefix abc_ \(from the backup's wp-config\.php\)/)
  })
})

describe('tar backups (extracted to a private temp folder)', () => {
  it('extracts only the dump and the uploads, and removes them on close', async () => {
    const f = await tgz([
      { name: 'site/', type: '5' },
      { name: 'site/wp-config.php', data: '<?php /* inert */' },
      { name: 'site/backup.sql', data: WP_DUMP },
      { name: 'site/wp-content/plugins/demo/evil.php', data: '<?php /* inert */' },
      { name: 'site/wp-content/uploads/2026/01/photo.png', data: png },
      { name: `site/wp-content/uploads/2026/01/${'long-'.repeat(30)}name.png`, data: png },
      { name: 'site/wp-content/uploads/2026/01/huge.png', data: Buffer.alloc(4096, 1) },
    ])
    const a = await openArchive(f, opts({ maxMediaBytes: 2048 }))
    const root = a.tempRoot!
    expect(path.dirname(root)).toBe(await realpath(tmp))
    expect(a.uploads).toBe(3)
    expect(typeof a.database).toBe('string')
    expect((a.database as string).startsWith(root + path.sep)).toBe(true)
    expect((await probe(a.database!)).siteUrl).toBe('https://old.example')
    expect(await a.readMedia!('2026/01/photo.png', 2048)).toEqual(png)
    expect(await a.readMedia!(`2026/01/${'long-'.repeat(30)}name.png`, 2048)).toEqual(png)
    await expect(a.readMedia!('2026/01/huge.png', 2048)).rejects.toMatchObject({ code: 'SEC_FILE_TOO_LARGE' })
    await expect(a.readMedia!('../../wp-config.php', 2048)).rejects.toMatchObject({ code: 'SEC_PATH_TRAVERSAL' })
    // Nothing but the dump and the uploads was written.
    expect(existsSync(path.join(root, 'site', 'wp-config.php'))).toBe(false)
    expect(existsSync(path.join(root, 'site', 'wp-content', 'plugins'))).toBe(false)
    expect(existsSync(path.join(root, 'site', 'wp-content', 'uploads', '2026', '01', 'huge.png'))).toBe(false)
    await a.close()
    expect(existsSync(root)).toBe(false)
    expect(await readdir(tmp)).toEqual([])
  })

  it('reads a plain .tar and skips media extraction when media is off', async () => {
    const f = await file('b.tar', makeTar([{ name: 'db.sql', data: WP_DUMP }, { name: 'wp-content/uploads/a.png', data: png }]))
    const a = await openArchive(f, opts({ media: false }))
    expect(a.uploads).toBe(1)
    expect(a.readMedia).toBeUndefined()
    expect(existsSync(path.join(a.tempRoot!, 'wp-content'))).toBe(false)
    await a.close()
    expect(await readdir(tmp)).toEqual([])
  })

  it('says so when a gzipped SQL dump is given as an archive', async () => {
    await expect(openArchive(await file('x-db.gz', gzipSync(WP_DUMP)), opts())).rejects.toMatchObject({ code: 'DUMP_INVALID', message: /not a tar archive/ })
    expect(await readdir(tmp)).toEqual([])
  })
})

describe('hostile archives (T11): refused with a code, nothing written outside the root', () => {
  const ESCAPES = ['../../evil.txt', '..\\..\\evil.txt', 'wp-content/uploads/../../../evil.txt', '/tmp/evil.txt', 'C:/evil.txt', 'C:\\evil.txt', 'a/C:evil.txt', '\\\\host\\share\\evil.txt', 'ok\0.txt']

  it.each(ESCAPES)('zip entry %j: SEC_ARCHIVE_PATH_TRAVERSAL', async (name) => {
    const f = await zip([{ name: 'database.sql', data: WP_DUMP }, { name, data: 'INERT' }])
    await expect(openArchive(f, opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_PATH_TRAVERSAL' })
  })

  // A ustar name ends at its first NUL; only a pax path (long names) can carry one.
  const TAR_ESCAPES = [...ESCAPES.filter((e) => !e.includes('\0')), `${'deep/'.repeat(25)}../../../../../../../../../../../../../../../../../../../../../../../../../../evil.txt`, `${'a'.repeat(120)}\0.txt`]

  it.each(TAR_ESCAPES)('tar entry %j: SEC_ARCHIVE_PATH_TRAVERSAL, after good entries were extracted', async (name) => {
    const f = await tgz([{ name: 'database.sql', data: WP_DUMP }, { name: 'wp-content/uploads/a.png', data: png }, { name, data: 'INERT' }])
    await expect(openArchive(f, opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_PATH_TRAVERSAL' })
    // The temp folder is gone and nothing landed beside it or beside the archive.
    expect(await readdir(tmp)).toEqual([])
    expect(existsSync(path.join(dir, 'evil.txt'))).toBe(false)
    expect(existsSync(path.join(path.dirname(dir), 'evil.txt'))).toBe(false)
  })

  it('refuses tar names Windows reserves for devices when they would be written', async () => {
    const f = await tgz([{ name: 'database.sql', data: WP_DUMP }, { name: 'wp-content/uploads/aux.png', data: png }])
    await expect(openArchive(f, opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_PATH_TRAVERSAL', message: /reserves/ })
    expect(await readdir(tmp)).toEqual([])
  })

  it('refuses symlink and hardlink entries: SEC_ARCHIVE_LINK', async () => {
    const z = await zip([{ name: 'database.sql', data: WP_DUMP }, { name: 'wp-content/uploads/link.png', data: '/etc/passwd', mode: 0o120777 }])
    await expect(openArchive(z, opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_LINK' })
    for (const type of ['1', '2']) {
      const t = await tgz([{ name: 'database.sql', data: WP_DUMP }, { name: 'wp-content/uploads/link.png', type, linkname: '../../../../etc/passwd' }])
      await expect(openArchive(t, opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_LINK' })
    }
    expect(await readdir(tmp)).toEqual([])
  })

  it('refuses device, FIFO and other special entries: SEC_ARCHIVE_SPECIAL_FILE', async () => {
    const z = await zip([{ name: 'database.sql', data: WP_DUMP }, { name: 'dev/null', mode: 0o020666 }])
    await expect(openArchive(z, opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_SPECIAL_FILE' })
    for (const type of ['3', '4', '6', 'S']) {
      const t = await tgz([{ name: 'database.sql', data: WP_DUMP }, { name: 'special', type }])
      await expect(openArchive(t, opts()), type).rejects.toMatchObject({ code: 'SEC_ARCHIVE_SPECIAL_FILE' })
    }
    expect(await readdir(tmp)).toEqual([])
  })

  it('refuses a zip bomb by compression ratio: SEC_ARCHIVE_RATIO', async () => {
    // 8 MiB of zeros deflates to a few KB: over 100:1.
    const zeros = Buffer.alloc(8 * 1024 ** 2)
    const z = await zip([{ name: 'database.sql', data: WP_DUMP }, { name: 'wp-content/uploads/bomb.png', data: zeros }])
    await expect(openArchive(z, opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_RATIO' })
    const db = await zip([{ name: 'database.sql', data: zeros }])
    await expect(openArchive(db, opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_RATIO' })
    const t = await tgz([{ name: 'database.sql', data: WP_DUMP }, { name: 'junk/bomb.bin', data: zeros }])
    await expect(openArchive(t, opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_RATIO' })
    expect(await readdir(tmp)).toEqual([])
  })

  it('refuses too many files: SEC_ARCHIVE_TOO_MANY_FILES', async () => {
    const items = [{ name: 'database.sql', data: WP_DUMP }, ...Array.from({ length: 6 }, (_, i) => ({ name: `wp-content/uploads/${i}.png`, data: 'x' }))]
    await expect(openArchive(await zip(items), opts({ limits: { maxFiles: 5 } }))).rejects.toMatchObject({ code: 'SEC_ARCHIVE_TOO_MANY_FILES' })
    await expect(openArchive(await tgz(items), opts({ limits: { maxFiles: 5 } }))).rejects.toMatchObject({ code: 'SEC_ARCHIVE_TOO_MANY_FILES' })
    expect(await readdir(tmp)).toEqual([])
  })

  it('refuses archives that unpack past the size cap: SEC_ARCHIVE_TOO_LARGE', async () => {
    const items = [{ name: 'database.sql', data: WP_DUMP }, { name: 'wp-content/uploads/a.png', data: png }]
    await expect(openArchive(await zip(items), opts({ limits: { maxTotalBytes: 200 } }))).rejects.toMatchObject({ code: 'SEC_ARCHIVE_TOO_LARGE' })
    await expect(openArchive(await tgz(items), opts({ limits: { maxTotalBytes: 200 } }))).rejects.toMatchObject({ code: 'SEC_ARCHIVE_TOO_LARGE' })
    expect(await readdir(tmp)).toEqual([])
  })

  it('puts the code and a next step in the message', async () => {
    const f = await zip([{ name: 'database.sql', data: WP_DUMP }, { name: '../\u001b[31mevil', data: 'x' }])
    const error = (await openArchive(f, opts()).catch((e: unknown) => e)) as Error
    expect(error.message).toMatch(/^Refused the backup .*: the entry ".*evil" leaves the archive folder/)
    expect(error.message).toMatch(/\(SEC_ARCHIVE_PATH_TRAVERSAL\)$/)
    // The escape from the hostile name never reaches the terminal raw.
    expect(error.message).not.toContain('\u001b')
  })

  it('refuses encrypted entries, damaged and missing archives', async () => {
    await expect(openArchive(await zip([{ name: 'database.sql', data: WP_DUMP, encrypted: true }]), opts())).rejects.toMatchObject({ code: 'DUMP_INVALID', message: /encrypted/ })
    await expect(openArchive(await file('junk.zip', 'not an archive at all'), opts())).rejects.toMatchObject({ code: 'DUMP_INVALID' })
    const truncated = makeTarGz([{ name: 'database.sql', data: WP_DUMP }]).subarray(0, 40)
    await expect(openArchive(await file('t.tar.gz', truncated), opts())).rejects.toMatchObject({ code: 'DUMP_INVALID' })
    await expect(openArchive(path.join(dir, 'none.zip'), opts())).rejects.toMatchObject({ code: 'DUMP_NOT_FOUND' })
    expect(await readdir(tmp)).toEqual([])
  })
})

describe('security review fixes (SEC-02, SEC-03, SEC-04, SEC-08)', () => {
  // SEC-02: Windows reads the part before the first dot, trailing spaces trimmed.
  const DEVICES = ['con .sql', 'nul .jpg', 'sub/aux  .txt', 'CONOUT$', 'conin$.txt', 'com¹.txt', 'LPT³', 'Prn', 'a/b/NUL.tar.gz', 'aux /x.png', 'com0.txt']
  const ALLOWED = ['console.sql', 'nullable.jpg', 'auxiliary/x.png', 'com10.txt', 'lpt.txt', 'conout.txt', 'my con.sql', 'x.con']

  it.each(DEVICES)('refuses the device name %j in any segment', (rel) => {
    expect(() => insideRoot('a.tar', path.resolve(tmp), rel)).toThrow(expect.objectContaining({ code: 'SEC_ARCHIVE_PATH_TRAVERSAL', message: expect.stringMatching(/reserves/) }))
  })

  it.each(ALLOWED)('allows the ordinary name %j', (rel) => {
    expect(insideRoot('a.tar', path.resolve(tmp), rel)).toBe(path.resolve(tmp, ...rel.split('/')))
  })

  it('refuses a tar upload named like a device with a space before the dot', async () => {
    const f = await tgz([{ name: 'database.sql', data: WP_DUMP }, { name: 'wp-content/uploads/sub/nul .jpg', data: png }])
    await expect(openArchive(f, opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_PATH_TRAVERSAL', message: /reserves/ })
    expect(await readdir(tmp)).toEqual([])
  })

  // SEC-03: dump candidates are capped before they are written, and only possible winners are kept.
  it('refuses a tar dump candidate over the dump cap before writing it', async () => {
    const f = await tgz([{ name: 'database.sql', data: Buffer.alloc(4096, 0x41) }])
    await expect(openArchive(f, opts({ limits: { maxDumpBytes: 1024 } }))).rejects.toMatchObject({ code: 'SEC_ARCHIVE_TOO_LARGE', message: /SQL dumps/ })
    expect(await readdir(tmp)).toEqual([])
  })

  it('caps the bytes of tar dump candidates kept together', async () => {
    const sql = Buffer.alloc(400, 0x41)
    const f = await tgz([{ name: 'a.sql', data: sql }, { name: 'b.sql', data: sql }, { name: 'c.sql', data: sql }])
    await expect(openArchive(f, opts({ limits: { maxDumpBytes: 1000 } }))).rejects.toMatchObject({ code: 'SEC_ARCHIVE_TOO_LARGE' })
    expect(await readdir(tmp)).toEqual([])
  })

  it('keeps only the tar dump candidates that can still be picked', async () => {
    const filler = Buffer.alloc(300, 0x41)
    const dup = 'site/dup-installer/dup-database__6f1e2d.sql'
    const f = await tgz([
      { name: 'deep/a/b/old.sql', data: filler },
      { name: 'database.sql', data: filler },
      { name: dup, data: WP_DUMP },
      // Dominated once Duplicator's dump is seen: never written, so not counted, even when huge.
      { name: 'later.sql', data: filler },
      { name: 'old/huge.sql.gz', data: Buffer.alloc(8192, 0x42) },
    ])
    const cap = Math.max(filler.length, WP_DUMP.length) + 10
    const a = await openArchive(f, opts({ limits: { maxDumpBytes: cap } }))
    try {
      expect(a.database).toBe(path.join(a.tempRoot!, ...dup.split('/')))
      expect((await probe(a.database!)).siteUrl).toBe('https://old.example')
      for (const gone of ['deep/a/b/old.sql', 'database.sql', 'later.sql', 'old/huge.sql.gz']) expect(existsSync(path.join(a.tempRoot!, ...gone.split('/'))), gone).toBe(false)
    } finally {
      await a.close()
    }
    expect(await readdir(tmp)).toEqual([])
  })

  it('picks the same dump as before the ranking was shared', () => {
    expect(pickDump('a', ['x/y.sql', 'database.sql', 'z.sql'])).toBe('database.sql')
    expect(pickDump('a', ['database.sql', 'database.sql'])).toBe('database.sql')
    expect(pickDump('a', ['database.sql', 'b/dup-installer/dup-database__1.sql'])).toBe('b/dup-installer/dup-database__1.sql')
    expect(pickDump('a', ['a/b/dup-installer/dup-database__1.sql', 'b/dup-installer/dup-database__2.sql'])).toBe('b/dup-installer/dup-database__2.sql')
    expect(pickDump('a', ['x/y.sql', 'q.sql.gz'])).toBe('q.sql.gz')
    expect(() => pickDump('a', ['a.sql', 'b.sql'])).toThrow(/several SQL dumps/)
    expect(() => pickDump('a', ['dup-installer/dup-database__1.sql', 'dup-installer/dup-database__2.sql'])).toThrow(/several SQL dumps/)
    expect(() => pickDump('a', [])).toThrow(expect.objectContaining({ code: 'DUMP_NO_WORDPRESS' }))
  })

  // SEC-04: cleanup hooks cover every signal that ends a run, and never leak.
  const EVENTS = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const
  const counts = () => EVENTS.map((e) => process.listenerCount(e))
  const tarItems = () => [{ name: 'db.sql', data: WP_DUMP }]

  it('adds its exit and signal hooks once while a tar is open, and removes them on close', async () => {
    const warnings: Error[] = []
    const onWarning = (w: Error) => warnings.push(w)
    process.on('warning', onWarning)
    try {
      const before = counts()
      const f = await tgz(tarItems())
      for (let i = 0; i < 15; i++) {
        const a = await openArchive(f, opts())
        const b = await openArchive(f, opts())
        expect(counts()).toEqual(before.map((c) => c + 1))
        await a.close()
        expect(counts()).toEqual(before.map((c) => c + 1))
        await b.close()
        expect(counts()).toEqual(before)
      }
      // A failed open removes them too.
      await expect(openArchive(await tgz([{ name: '../evil.sql', data: 'x' }]), opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_PATH_TRAVERSAL' })
      expect(counts()).toEqual(before)
      await new Promise((r) => setImmediate(r))
      expect(warnings.filter((w) => w.name === 'MaxListenersExceededWarning')).toEqual([])
    } finally {
      process.off('warning', onWarning)
    }
    expect(await readdir(tmp)).toEqual([])
  })

  it('removes every temp folder it can, and names the ones it cannot', async () => {
    const before = counts()
    const f = await tgz(tarItems())
    const a = await openArchive(f, opts())
    const b = await openArchive(f, opts())
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      removeTempFoldersSync((d) => {
        if (d === a.tempRoot) throw Object.assign(new Error('EBUSY: secret detail'), { code: 'EBUSY' })
        rmSync(d, { recursive: true, force: true })
      })
      expect(existsSync(b.tempRoot!)).toBe(false)
      expect(existsSync(a.tempRoot!)).toBe(true)
      const out = stderr.mock.calls.map((c) => String(c[0])).join('')
      expect(out).toContain(a.tempRoot!)
      expect(out).not.toContain(b.tempRoot!)
      expect(out).not.toContain('secret detail')
      expect(counts()).toEqual(before)
    } finally {
      stderr.mockRestore()
      await a.close()
      await b.close()
      await rm(a.tempRoot!, { recursive: true, force: true })
    }
    expect(await readdir(tmp)).toEqual([])
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
    ['SIGBREAK', 149],
  ] as const)('on %s alone, removes the temp folder and exits with %i', async (signal, code) => {
    const f = await tgz(tarItems())
    const others = process.listeners(signal)
    for (const l of others) process.off(signal, l)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    try {
      const a = await openArchive(f, opts())
      process.emit(signal, signal)
      expect(exit).toHaveBeenCalledWith(code)
      expect(existsSync(a.tempRoot!)).toBe(false)
      expect(process.listenerCount(signal)).toBe(0)
      await a.close()
    } finally {
      exit.mockRestore()
      for (const l of others) process.on(signal, l)
    }
    expect(await readdir(tmp)).toEqual([])
  })

  it('leaves Ctrl+C to a command that handles it (migrate)', async () => {
    const f = await tgz(tarItems())
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const own = vi.fn()
    process.on('SIGINT', own)
    try {
      const a = await openArchive(f, opts())
      process.emit('SIGINT', 'SIGINT')
      expect(own).toHaveBeenCalledOnce()
      expect(exit).not.toHaveBeenCalled()
      expect(existsSync(a.tempRoot!)).toBe(true)
      await a.close()
    } finally {
      process.off('SIGINT', own)
      exit.mockRestore()
    }
    expect(await readdir(tmp)).toEqual([])
  })

  // SEC-08: zip entries whose local records overlap (overlap bombs) refuse the archive.
  /** Points central directory record `index` at local offset `offset`. */
  function repoint(zipData: Buffer, index: number, offset: number): Buffer {
    const out = Buffer.from(zipData)
    const end = out.length - 22
    let pos = out.readUInt32LE(end + 16)
    for (let i = 0; i < index; i++) pos += 46 + out.readUInt16LE(pos + 28) + out.readUInt16LE(pos + 30) + out.readUInt16LE(pos + 32)
    out.writeUInt32LE(offset, pos + 42)
    return out
  }

  it('refuses zip entries that share data: SEC_ARCHIVE_OVERLAP', async () => {
    const items: ZipItem[] = [{ name: 'database.sql', data: WP_DUMP }, { name: 'wp-content/uploads/a.png', data: png }, { name: 'wp-content/uploads/b.png', data: png }]
    const good = makeZip(items)
    // Full overlap: two records over the same local header.
    await expect(openArchive(await file('full.zip', repoint(good, 2, 0)), opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_OVERLAP', message: /entries 1 and 3/ })
    // A record that starts inside another entry's data.
    await expect(openArchive(await file('part.zip', repoint(good, 1, 40)), opts())).rejects.toMatchObject({ code: 'SEC_ARCHIVE_OVERLAP' })
    // The untouched zip still opens and reads.
    const a = await openArchive(await file('good.zip', good), opts())
    expect(await a.readMedia!('b.png', 1024 ** 2)).toEqual(png)
    await a.close()
  })
})

describe('entry path rules', () => {
  it('normalises harmless forms and finds the uploads folder', () => {
    expect(entryPath('a.zip', './site//wp-content/./uploads/x.png')).toBe('site/wp-content/uploads/x.png')
    expect(entryPath('a.zip', 'dir\\file.png')).toBe('dir/file.png')
    expect(uploadsPart('site/wp-content/uploads/2026/x.png')).toEqual({ prefix: 'site/wp-content/uploads/', rel: '2026/x.png' })
    expect(uploadsPart('uploads/x.png')).toEqual({ prefix: 'uploads/', rel: 'x.png' })
    expect(uploadsPart('wp-content/uploadsx/x.png')).toBeUndefined()
    expect(uploadsPart('wp-content/uploads/')).toBeUndefined()
  })
})

describe('config, scan and doctor over archives', () => {
  it('accepts the archive source and exactly one of uploadsDir and uploads', () => {
    expect(resolveConfig({ source: { type: 'archive', file: 'a.zip' } }).source).toEqual({ type: 'archive', file: 'a.zip' })
    expect(resolveConfig({ source: { type: 'sql', file: 'a-db.gz', uploads: 'u.zip' } }).source).toMatchObject({ uploads: 'u.zip' })
    expect(() => resolveConfig({ source: { type: 'sql', file: 'a.sql', uploadsDir: 'u', uploads: ['u.zip'] } })).toThrow(/source\.uploadsDir: expected either/)
    expect(() => resolveConfig({ source: { type: 'sql', file: 'a.sql', uploads: [] } })).toThrow(/at least one uploads archive/)
  })

  it('reads archive targets and UpdraftPlus sets from the scan target', async () => {
    expect(sourceFor('a/site_archive.zip', dir, undefined, {}).source).toEqual({ type: 'archive', file: 'a/site_archive.zip' })
    expect(sourceFor('b.TGZ', dir, undefined, {}).source).toEqual({ type: 'archive', file: 'b.TGZ' })
    expect(sourceFor('c.tar.gz', dir, undefined, {}).source).toEqual({ type: 'archive', file: 'c.tar.gz' })
    expect(sourceFor('x-db.gz', dir, ['u1.zip', 'u2.zip'], {}).source).toEqual({ type: 'sql', file: 'x-db.gz', uploads: ['u1.zip', 'u2.zip'] })
    expect(() => sourceFor('c.zip', dir, ['u.zip'], {})).toThrow(/holds its own uploads/)
    expect(() => sourceFor('x.sql', dir, ['folder', 'u.zip'], {})).toThrow(/once per uploads archive/)

    // UpdraftPlus siblings are found by name, in part order.
    const set = path.join(dir, 'updraft')
    await mkdir(set)
    for (const name of ['backup_X_abc-uploads2.zip', 'backup_X_abc-uploads.zip', 'backup_X_abc-uploads10.zip', 'backup_X_abc-plugins.zip', 'backup_X_other-uploads.zip']) {
      await writeFile(path.join(set, name), '')
    }
    expect(sourceFor(path.join('updraft', 'backup_X_abc-db.gz'), dir, undefined, {}).source).toEqual({
      type: 'sql',
      file: path.join('updraft', 'backup_X_abc-db.gz'),
      uploads: ['backup_X_abc-uploads.zip', 'backup_X_abc-uploads2.zip', 'backup_X_abc-uploads10.zip'].map((n) => path.join('updraft', n)),
    })
  })

  it('scans a Duplicator zip end to end without Payload', async () => {
    const cwd = await mkdtemp(path.join(dir, 'scan-'))
    const f = await zip(duplicator(), 'site_archive.zip')
    const lines: string[] = []
    const code = await runScanCommand({ cwd, target: f, log: (l) => lines.push(l), env: { NO_COLOR: '1' } })
    expect(code, lines.join('\n')).toBe(0)
    const json = JSON.parse(await readFile(path.join(cwd, '.wp2payload', 'scan.json'), 'utf8')) as ScanReport
    expect(json).toMatchObject({ kind: 'scan', source: 'archive', documents: { scanned: 1 }, media: { scanned: 1, clean: 1 } })
  })

  it('scans a tar.gz and leaves no temp folder behind', async () => {
    const cwd = await mkdtemp(path.join(dir, 'scan-'))
    const before = new Set((await readdir(os.tmpdir())).filter((n) => n.startsWith('wp2payload-backup-')))
    const f = await tgz([{ name: 'db.sql', data: WP_DUMP }, { name: 'wp-content/uploads/2026/01/photo.png', data: png }])
    expect(await runScanCommand({ cwd, target: f, log: () => {}, env: {} })).toBe(0)
    const after = (await readdir(os.tmpdir())).filter((n) => n.startsWith('wp2payload-backup-') && !before.has(n))
    expect(after).toEqual([])
  })

  it('fails scan and doctor on a hostile archive, showing the code', async () => {
    const cwd = await mkdtemp(path.join(dir, 'doctor-'))
    const bad = await zip([{ name: 'database.sql', data: WP_DUMP }, { name: '../../evil.php', data: 'INERT' }])
    const lines: string[] = []
    expect(await runScanCommand({ cwd, target: bad, log: (l) => lines.push(l), env: { NO_COLOR: '1' } })).toBe(1)
    expect(lines.join('\n')).toMatch(/SEC_ARCHIVE_PATH_TRAVERSAL/)

    const good = await zip(duplicator(), 'site_archive.zip')
    await writeFile(path.join(cwd, 'wp2payload.config.ts'), `export default { source: { type: 'archive', file: ${JSON.stringify(good)} } }`)
    const out: string[] = []
    await runDoctor({ cwd, log: (l) => out.push(l), env: { NO_COLOR: '1' } })
    expect(out.join('\n')).toMatch(/Backup of https:\/\/old\.example/)
    expect(out.join('\n')).toMatch(/Uploads in the backup: 2 files/)

    await writeFile(path.join(cwd, 'wp2payload.config.ts'), `export default { source: { type: 'archive', file: ${JSON.stringify(bad)} } }`)
    out.length = 0
    expect(await runDoctor({ cwd, log: (l) => out.push(l), env: { NO_COLOR: '1' } })).toBe(1)
    expect(out.join('\n')).toMatch(/Refused the backup[\s\S]*SEC_ARCHIVE_PATH_TRAVERSAL/)
  })
})
