import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DumpError, SqlExtractor } from '../../src/extractors/sql/index.js'
import { DumpParser, readDump, type DumpEvent } from '../../src/extractors/sql/dump.js'
import { readLocalMedia } from '../../src/security/media/local.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-sql-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

let n = 0
async function file(content: string | Buffer, ext = '.sql'): Promise<string> {
  const f = path.join(dir, `dump-${++n}${ext}`)
  await writeFile(f, content)
  return f
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const rows = (events: DumpEvent[]) => events.filter((e) => e.kind === 'row').map((e) => (e as { values: unknown[] }).values)

describe('DumpParser (doc 12.7, T13: nothing in the dump runs)', () => {
  const parse = (sql: string, tables = ['t']) => [...new DumpParser(new Set(tables)).feed(sql), ...new DumpParser(new Set()).end()]

  it('reads extended inserts with escapes, NULL, hex and charset prefixes', () => {
    const sql = String.raw`INSERT INTO ` + "`t`" + String.raw` VALUES (1,'a\'b\\c\nd',NULL),(2,'it''s',0x6869),(3,_binary 'raw',X'6869');`
    expect(rows(parse(sql))).toEqual([
      ['1', "a'b\\c\nd", null],
      ['2', "it's", 'hi'],
      ['3', 'raw', 'hi'],
    ])
  })

  it('takes column names from CREATE TABLE or the INSERT column list', () => {
    const sql = "CREATE TABLE `t` (\n  `id` int NOT NULL,\n  `name` varchar(9) DEFAULT 'x,y',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\nINSERT INTO `t` VALUES (1,'a');\nINSERT INTO `t` (`name`, `id`) VALUES ('b',2);\n"
    const events = parse(sql)
    expect(events[0]).toEqual({ kind: 'table', table: 't', columns: ['id', 'name'] })
    expect(events.slice(1).map((e) => e.kind === 'row' && [e.columns, e.values])).toEqual([
      [['id', 'name'], ['1', 'a']],
      [['name', 'id'], ['b', '2']],
    ])
  })

  it('skips comments, other tables, triggers and procedures without being fooled by their contents', () => {
    const sql = [
      "-- INSERT INTO `t` VALUES (9,'comment');",
      "/*!40101 SET NAMES utf8mb4 */;",
      "# INSERT INTO `t` VALUES (8,'hash');",
      "INSERT INTO `other` VALUES (7,'x);INSERT INTO `t` VALUES (6,''y'')');",
      'DELIMITER ;;',
      "/*!50003 CREATE*/ /*!50003 TRIGGER evil AFTER INSERT ON `t` FOR EACH ROW BEGIN INSERT INTO `t` VALUES (5,'trigger'); END */;;",
      'DELIMITER ;',
      "CREATE PROCEDURE p() BEGIN SELECT 1; END;",
      "INSERT INTO `t` VALUES (1,'kept');",
    ].join('\n')
    expect(rows(parse(sql))).toEqual([['1', 'kept']])
  })

  it('handles statements split across chunks at any point', () => {
    const sql = "INSERT INTO `t` VALUES (1,'a\\'b'),(2,'c''d');\n-- x\nINSERT INTO `t` VALUES (3,'e');\n"
    for (let size = 1; size <= 7; size++) {
      const p = new DumpParser(new Set(['t']))
      const out: DumpEvent[] = []
      for (let i = 0; i < sql.length; i += size) out.push(...p.feed(sql.slice(i, i + size)))
      expect(rows(out), `chunk ${size}`).toEqual([['1', "a'b"], ['2', "c'd"], ['3', 'e']])
    }
  })

  it('reads .gz dumps, and refuses ones over the cap after unpacking', async () => {
    const sql = `INSERT INTO \`t\` VALUES ${Array.from({ length: 500 }, (_, i) => `(${i},'${'x'.repeat(100)}')`).join(',')};\n`
    const gz = await file(gzipSync(sql), '.sql.gz')
    expect(rows(await collect(readDump(gz, { tables: new Set(['t']) })))).toHaveLength(500)
    await expect(collect(readDump(gz, { tables: new Set(['t']), maxBytes: 10_000 }))).rejects.toMatchObject({ code: 'DUMP_TOO_LARGE' })
    await expect(collect(readDump(path.join(dir, 'none.sql'), { tables: new Set() }))).rejects.toMatchObject({ code: 'DUMP_NOT_FOUND' })
  })
})

const DUMP = `-- MySQL dump
CREATE TABLE \`wp_options\` (\n  \`option_id\` bigint,\n  \`option_name\` varchar(191),\n  \`option_value\` longtext,\n  \`autoload\` varchar(20)\n);
INSERT INTO \`wp_options\` VALUES (1,'siteurl','https://old.example','yes'),(2,'home','https://old.example/','yes'),(3,'blogname','My &amp; Site','yes'),(4,'permalink_structure','/%year%/%category%/%postname%/','yes');
CREATE TABLE \`wp_users\` (\n  \`ID\` bigint,\n  \`user_login\` varchar(60),\n  \`user_pass\` varchar(255),\n  \`user_nicename\` varchar(50),\n  \`user_email\` varchar(100),\n  \`display_name\` varchar(250)\n);
INSERT INTO \`wp_users\` VALUES (3,'jane','$P$Bsecrethash','jane-d','jane@example.com','Jane <b>Doe</b>');
INSERT INTO \`wp_terms\` VALUES (10,'News','news',0),(11,'World &amp; More','world',0),(20,'Café','caf%c3%a9',0);
INSERT INTO \`wp_term_taxonomy\` VALUES (1,10,'category','',0,1),(2,11,'category','',10,1),(3,20,'post_tag','',0,1),(4,10,'nav_menu','',0,0);
INSERT INTO \`wp_term_relationships\` VALUES (7,2,0),(7,3,0);
INSERT INTO \`wp_postmeta\` VALUES (1,5,'_wp_attached_file','2026/01/photo.jpg'),(2,5,'_wp_attachment_image_alt','Alt <img src=x onerror=alert(1)>'),(3,7,'_thumbnail_id','5'),(4,7,'_yoast_wpseo_title','%%title%% %%sep%% %%sitename%%'),(5,8,'_elementor_edit_mode','builder'),(6,7,'_wp_attachment_metadata','a:9:{}');
INSERT INTO \`wp_posts\` VALUES
(5,3,'2026-01-01 10:00:00','2026-01-01 09:00:00','','Photo','A caption','inherit','open','closed','','photo','','','2026-01-01 10:00:00','2026-01-01 09:00:00','',0,'https://old.example/wp-content/uploads/2026/01/photo.jpg',0,'attachment','image/jpeg',0),
(7,3,'2026-01-02 10:00:00','2026-01-02 09:00:00','<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph --><!-- wp:block {"ref":30} /-->','Hello <script>x</script>world','','publish','open','open','','hello','','','2026-01-03 10:00:00','2026-01-03 09:00:00','',0,'https://old.example/?p=7',0,'post','',0),
(8,3,'2026-01-02 10:00:00','2026-01-02 09:00:00','<p>About</p>','About','','publish','closed','closed','','about','','','2026-01-02 10:00:00','2026-01-02 09:00:00','',0,'https://old.example/?page_id=8',0,'page','',0),
(9,3,'2026-01-02 10:00:00','2026-01-02 09:00:00','<p>Team</p>','Team','','publish','closed','closed','','team','','','2026-01-02 10:00:00','2026-01-02 09:00:00','',8,'https://old.example/?page_id=9',0,'page','',0),
(30,3,'2026-01-02 10:00:00','2026-01-02 09:00:00','<!-- wp:paragraph --><p>Shared</p><!-- /wp:paragraph -->','Block','','publish','closed','closed','','block','','','2026-01-02 10:00:00','2026-01-02 09:00:00','',0,'',0,'wp_block','',0),
(40,3,'2026-01-02 10:00:00','2026-01-02 09:00:00','','Shoe','','publish','closed','closed','','shoe','','','2026-01-02 10:00:00','2026-01-02 09:00:00','',0,'',0,'product','',0),
(41,3,'2026-01-02 10:00:00','2026-01-02 09:00:00','','Draft','','draft','closed','closed','','draft','','','2026-01-02 10:00:00','2026-01-02 09:00:00','',0,'',0,'post','',0);
`

describe('SqlExtractor', () => {
  it('probes the site from the options table and counts what will be migrated', async () => {
    const info = await new SqlExtractor({ file: await file(DUMP) }).probe()
    expect(info).toEqual({
      siteUrl: 'https://old.example',
      counts: { posts: 1, pages: 2, media: 1, categories: 2, tags: 1, users: 1 },
      seoPlugin: 'yoast',
      unmigratedTypes: [{ type: 'product', count: 1 }],
    })
  })

  it('maps media to local files and keeps only name and slug of users', async () => {
    const ex = new SqlExtractor({ file: await file(DUMP) })
    expect(await collect(ex.media())).toEqual([
      { wpId: 5, sourceUrl: 'https://old.example/wp-content/uploads/2026/01/photo.jpg', localPath: '2026/01/photo.jpg', filename: 'photo.jpg', mimeType: 'image/jpeg', alt: 'Alt', caption: 'A caption' },
    ])
    const authors = await collect(ex.authors())
    expect(authors).toEqual([{ wpId: 3, slug: 'jane-d', displayName: 'Jane Doe' }])
    expect(JSON.stringify(authors)).not.toMatch(/secrethash|example\.com/)
    expect(await collect(ex.terms())).toEqual([
      { wpId: 10, taxonomy: 'category', name: 'News', slug: 'news' },
      { wpId: 11, taxonomy: 'category', name: 'World & More', slug: 'world', parentWpId: 10 },
      { wpId: 20, taxonomy: 'post_tag', name: 'Café', slug: 'café' },
    ])
  })

  it('maps documents with permalinks rebuilt from the permalink settings', async () => {
    const warnings: string[] = []
    const ex = new SqlExtractor({ file: await file(DUMP), onWarning: (w) => warnings.push(w.code) })
    const docs = await collect(ex.documents())
    expect(docs.map((d) => [`${d.type}:${d.wpId}`, d.link])).toEqual([
      ['post:7', 'https://old.example/2026/news/world/hello/'],
      ['page:8', 'https://old.example/about/'],
      ['page:9', 'https://old.example/about/team/'],
    ])
    expect(docs[0]).toMatchObject({
      title: 'Hello world',
      publishedAt: '2026-01-02T09:00:00.000Z',
      modifiedAt: '2026-01-03T09:00:00.000Z',
      authorWpId: 3,
      termWpIds: [11, 20],
      featuredMediaWpId: 5,
      seo: { title: 'Hello world - My & Site' },
    })
    expect(docs[0]!.html).toContain('<p>Shared</p>')
    expect(docs[1]!.meta['pageBuilder']).toBe('Elementor')
    expect(docs[2]!.parentWpId).toBe(8)
    expect(warnings).toEqual(['DOC_TYPE_UNMAPPED'])
  })

  it('names the table prefix when the configured one is wrong', async () => {
    const f = await file(DUMP.replaceAll('`wp_', '`blog7_'))
    await expect(new SqlExtractor({ file: f }).probe()).rejects.toThrow(/prefix "blog7_": set source.tablePrefix/)
    expect((await new SqlExtractor({ file: f, tablePrefix: 'blog7_' }).probe()).counts.posts).toBe(1)
    await expect(new SqlExtractor({ file: await file('SELECT 1;') }).probe()).rejects.toBeInstanceOf(DumpError)
  })
})

describe('readLocalMedia (doc 12.7, T10)', () => {
  it('reads files inside the uploads folder only', async () => {
    const uploads = path.join(dir, 'uploads')
    await mkdir(path.join(uploads, '2026'), { recursive: true })
    await writeFile(path.join(uploads, '2026', 'a.jpg'), 'jpeg')
    await writeFile(path.join(dir, 'secret.env'), 'TOKEN=1')
    expect((await readLocalMedia(uploads, '2026/a.jpg', 100)).toString()).toBe('jpeg')
    expect((await readLocalMedia(uploads, '2026\\a.jpg', 100)).toString()).toBe('jpeg')
    for (const bad of ['../secret.env', '2026/../../secret.env', '/etc/passwd', 'C:/Windows/win.ini', 'a\0.jpg', '']) {
      await expect(readLocalMedia(uploads, bad, 100), bad).rejects.toMatchObject({ code: 'SEC_PATH_TRAVERSAL' })
    }
    await expect(readLocalMedia(uploads, '2026/missing.jpg', 100)).rejects.toMatchObject({ code: 'MEDIA_404' })
    await expect(readLocalMedia(uploads, '2026/a.jpg', 2)).rejects.toMatchObject({ code: 'SEC_FILE_TOO_LARGE' })
    await expect(readLocalMedia(path.join(dir, 'nope'), 'a.jpg', 100)).rejects.toMatchObject({ code: 'MEDIA_UPLOADS_MISSING' })
  })

  it('refuses a link that points outside the folder', async () => {
    const uploads = path.join(dir, 'uploads-link')
    await mkdir(uploads, { recursive: true })
    await writeFile(path.join(dir, 'outside.jpg'), 'x')
    try {
      await symlink(path.join(dir, 'outside.jpg'), path.join(uploads, 'link.jpg'))
    } catch {
      return // symlinks need extra rights on Windows; the check is covered on Linux CI
    }
    await expect(readLocalMedia(uploads, 'link.jpg', 100)).rejects.toMatchObject({ code: 'SEC_PATH_TRAVERSAL' })
  })
})
