import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { indexWpress, readWpressMedia, WPRESS_TABLE_PREFIX } from '../../src/extractors/wpress.js'
import { SqlExtractor } from '../../src/extractors/sql/index.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-wpress-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** One .wpress entry: name[255] size[14] mtime[12] prefix[4096], NUL padded, then the content. */
function entry(name: string, prefix: string, content: string | Buffer): Buffer {
  const h = Buffer.alloc(4377)
  h.write(name, 0, 'utf8')
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
  h.write(String(body.length), 255, 'utf8')
  h.write('1700000000', 269, 'utf8')
  h.write(prefix, 281, 'utf8')
  return Buffer.concat([h, body])
}

let n = 0
async function archive(parts: Buffer[], end: 'zeros' | 'trailer' | 'none' = 'zeros'): Promise<string> {
  const body = Buffer.concat(parts)
  let tail = Buffer.alloc(0)
  if (end === 'zeros') tail = Buffer.alloc(4377)
  if (end === 'trailer') {
    tail = Buffer.alloc(4377)
    tail.write(String(body.length), 255, 'utf8')
  }
  const f = path.join(dir, `backup-${++n}.wpress`)
  await writeFile(f, Buffer.concat([body, tail]))
  return f
}

const DB = `INSERT INTO \`${WPRESS_TABLE_PREFIX}options\` VALUES (1,'home','https://old.example','yes');
INSERT INTO \`${WPRESS_TABLE_PREFIX}posts\` VALUES (5,1,'2026-01-01 10:00:00','2026-01-01 10:00:00','','Photo','','inherit','open','closed','','photo','','','2026-01-01 10:00:00','2026-01-01 10:00:00','',0,'',0,'attachment','image/jpeg',0),(7,1,'2026-01-01 10:00:00','2026-01-01 10:00:00','<p>Hi</p>','Hello','','publish','open','open','','hello','','','2026-01-01 10:00:00','2026-01-01 10:00:00','',0,'',0,'post','',0);
INSERT INTO \`${WPRESS_TABLE_PREFIX}postmeta\` VALUES (1,5,'_wp_attached_file','2026/01/photo.jpg');
`

describe('.wpress backups (doc 12.7, T11)', () => {
  it('reads the database and uploads in place, ignoring every other entry', async () => {
    const f = await archive([
      entry('package.json', '', '{"SiteURL":"https://old.example"}'),
      entry('wp-config.php', '', '<?php echo "never read";'),
      entry('evil.php', 'plugins/backdoor', '<?php system($_GET["c"]);'),
      entry('database.sql', '', DB),
      entry('photo.jpg', 'uploads/2026/01', 'JPEGDATA'),
    ], 'trailer')
    const ix = await indexWpress(f)
    expect([...ix.uploads.keys()]).toEqual(['2026/01/photo.jpg'])
    expect((await readWpressMedia(ix, '2026/01/photo.jpg', 100)).toString()).toBe('JPEGDATA')

    const ex = new SqlExtractor({ file: ix.file, range: { start: ix.database.offset, length: ix.database.size }, tablePrefix: WPRESS_TABLE_PREFIX })
    const docs = []
    for await (const d of ex.documents()) docs.push(d)
    expect(docs.map((d) => [d.wpId, d.link])).toEqual([[7, 'https://old.example/?p=7']])
    const media = []
    for await (const m of ex.media()) media.push(m.localPath)
    expect(media).toEqual(['2026/01/photo.jpg'])
  })

  it('treats entry names as lookup keys only, so traversal reaches nothing', async () => {
    const f = await archive([entry('database.sql', '', DB), entry('.env', 'uploads/../..', 'SECRET=1'), entry('a.jpg', 'uploads', 'x')])
    const ix = await indexWpress(f)
    for (const bad of ['../../.env', '../.env', '/etc/passwd', 'C:/x', '']) {
      await expect(readWpressMedia(ix, bad, 100), bad).rejects.toMatchObject({ code: 'SEC_PATH_TRAVERSAL' })
    }
    await expect(readWpressMedia(ix, 'missing.jpg', 100)).rejects.toMatchObject({ code: 'MEDIA_404' })
    await expect(readWpressMedia(ix, 'a.jpg', 0)).rejects.toMatchObject({ code: 'SEC_FILE_TOO_LARGE' })
  })

  it('refuses damaged archives and ones without a database', async () => {
    const good = entry('database.sql', '', DB)
    await expect(indexWpress(await archive([good.subarray(0, good.length - 10)], 'none'))).rejects.toMatchObject({ code: 'DUMP_INVALID' })
    const badSize = entry('database.sql', '', DB)
    badSize.write('12ab', 255, 'utf8')
    await expect(indexWpress(await archive([badSize]))).rejects.toMatchObject({ code: 'DUMP_INVALID' })
    await expect(indexWpress(await archive([entry('a.jpg', 'uploads', 'x')]))).rejects.toMatchObject({ code: 'DUMP_NO_WORDPRESS' })
    await expect(indexWpress(path.join(dir, 'none.wpress'))).rejects.toMatchObject({ code: 'DUMP_NOT_FOUND' })
  })
})
