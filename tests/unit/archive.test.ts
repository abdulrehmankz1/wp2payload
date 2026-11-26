import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runDoctor } from '../../src/commands/doctor.js'
import { runScanCommand, sourceFor } from '../../src/commands/scan.js'
import { resolveConfig } from '../../src/config/index.js'
import { openArchive, openUploadsArchives, type OpenArchiveOptions } from '../../src/extractors/archive/index.js'
import { entryPath, uploadsPart } from '../../src/extractors/archive/rules.js'
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
    expect(resolveConfig({ source: { type: 'archive', file: 'a.zip' } }).source).toEqual({ type: 'archive', file: 'a.zip', tablePrefix: 'wp_' })
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
