import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WxrError, WxrExtractor } from '../../src/extractors/wxr/index.js'
import { readWxr } from '../../src/extractors/wxr/xml.js'
import type { IRDocument } from '../../src/ir/types.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'wp2p-wxr-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

let n = 0
async function file(xml: string): Promise<string> {
  const f = path.join(dir, `export-${++n}.xml`)
  await writeFile(f, xml)
  return f
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
<title>My &amp; Site</title>
<link>https://old.example</link>
<wp:wxr_version>1.2</wp:wxr_version>
<wp:base_site_url>https://old.example</wp:base_site_url>
<wp:base_blog_url>https://old.example/blog</wp:base_blog_url>`
const wxr = (body: string) => `${HEAD}\n${body}\n</channel>\n</rss>\n`

const meta = (k: string, v: string) => `<wp:postmeta><wp:meta_key>${k}</wp:meta_key><wp:meta_value><![CDATA[${v}]]></wp:meta_value></wp:postmeta>`
const item = (o: { id: number; type?: string; status?: string; slug?: string; title?: string; content?: string; extra?: string; creator?: string }) => `<item>
<title><![CDATA[${o.title ?? `Item ${o.id}`}]]></title>
<link>https://old.example/blog/${o.slug ?? `item-${o.id}`}/</link>
<dc:creator><![CDATA[${o.creator ?? 'jane'}]]></dc:creator>
<content:encoded><![CDATA[${o.content ?? '<!-- wp:paragraph --><p>Body</p><!-- /wp:paragraph -->'}]]></content:encoded>
<excerpt:encoded><![CDATA[]]></excerpt:encoded>
<wp:post_id>${o.id}</wp:post_id>
<wp:post_date>2026-01-02 03:04:05</wp:post_date>
<wp:post_date_gmt>2026-01-02 01:04:05</wp:post_date_gmt>
<wp:post_name><![CDATA[${o.slug ?? `item-${o.id}`}]]></wp:post_name>
<wp:status><![CDATA[${o.status ?? 'publish'}]]></wp:status>
<wp:post_parent>0</wp:post_parent>
<wp:post_type><![CDATA[${o.type ?? 'post'}]]></wp:post_type>
${o.extra ?? ''}
</item>`

describe('readWxr: hostile XML (doc 12.7, T12)', () => {
  it('refuses a DOCTYPE, so external entities (XXE) are never resolved', async () => {
    const f = await file(`<?xml version="1.0"?>\n<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n<rss><channel><title>&xxe;</title></channel></rss>`)
    await expect(collect(readWxr(f))).rejects.toMatchObject({ code: 'WXR_DOCTYPE' })
  })

  it('refuses entity expansion ("billion laughs")', async () => {
    const lol = ['<!ENTITY lol "lol">', ...Array.from({ length: 9 }, (_, i) => `<!ENTITY lol${i + 1} "${`&lol${i || ''};`.repeat(10)}">`)].join('')
    const f = await file(`<?xml version="1.0"?>\n<!DOCTYPE lolz [${lol}]>\n<rss><channel><title>&lol9;</title></channel></rss>`)
    await expect(collect(readWxr(f))).rejects.toMatchObject({ code: 'WXR_DOCTYPE' })
  })

  it('leaves undeclared entities as text and keeps CDATA verbatim', async () => {
    const f = await file(wxr(item({ id: 1, title: 'A &amp; B &xxe;', content: '<p>&amp; ]]]]><![CDATA[></p>' })))
    const records = await collect(readWxr(f))
    const it = records.find((r) => r.name === 'item')!.node
    expect(it.kids.find((k) => k.name === 'title')!.text).toBe('A &amp; B &xxe;')
    expect(it.kids.find((k) => k.name === 'content:encoded')!.text).toBe('<p>&amp; ]]></p>')
    expect(records.find((r) => r.name === 'title')!.node.text).toBe('My & Site')
  })

  it('refuses files over the size cap, non-exports and deep nesting', async () => {
    await expect(collect(readWxr(await file(wxr('')), { maxBytes: 100 }))).rejects.toMatchObject({ code: 'WXR_TOO_LARGE' })
    await expect(collect(readWxr(await file('<html><body>hi</body></html>')))).rejects.toMatchObject({ code: 'WXR_INVALID' })
    await expect(collect(readWxr(await file(`<rss>${'<a>'.repeat(40)}</rss>`)))).rejects.toMatchObject({ code: 'WXR_INVALID' })
    await expect(collect(readWxr(path.join(dir, 'nope.xml')))).rejects.toBeInstanceOf(WxrError)
    await expect(collect(readWxr(await file(wxr(`<item>${'<x/>'.repeat(100_001)}</item>`))))).rejects.toMatchObject({ code: 'WXR_TOO_LARGE' })
  })
})

describe('WxrExtractor', () => {
  const site = wxr(`
<wp:author><wp:author_id>3</wp:author_id><wp:author_login><![CDATA[jane]]></wp:author_login><wp:author_email>jane@example.com</wp:author_email><wp:author_display_name><![CDATA[Jane <b>Doe</b>]]></wp:author_display_name></wp:author>
<wp:category><wp:term_id>11</wp:term_id><wp:category_nicename><![CDATA[child]]></wp:category_nicename><wp:category_parent><![CDATA[parent]]></wp:category_parent><wp:cat_name><![CDATA[Child &amp; Co]]></wp:cat_name></wp:category>
<wp:category><wp:term_id>10</wp:term_id><wp:category_nicename><![CDATA[parent]]></wp:category_nicename><wp:category_parent><![CDATA[]]></wp:category_parent><wp:cat_name><![CDATA[Parent]]></wp:cat_name></wp:category>
<wp:tag><wp:term_id>20</wp:term_id><wp:tag_slug><![CDATA[caf%c3%a9]]></wp:tag_slug><wp:tag_name><![CDATA[Café]]></wp:tag_name></wp:tag>
${item({ id: 5, type: 'attachment', status: 'inherit', title: 'Photo', extra: `<wp:attachment_url>https://old.example/wp-content/uploads/photo.JPG</wp:attachment_url>${meta('_wp_attachment_image_alt', 'Alt <img src=x onerror=alert(1)>')}` })}
${item({
  id: 7,
  slug: 'hello',
  title: 'Hello <script>alert(1)</script>world',
  content: '<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph --><!-- wp:block {"ref":30} /--><!-- wp:block {"ref":31} /-->',
  extra: `<category domain="category" nicename="child"><![CDATA[Child]]></category><category domain="post_tag" nicename="caf%c3%a9"><![CDATA[Café]]></category>${meta('_thumbnail_id', '5')}${meta('_yoast_wpseo_title', '%%title%% %%sep%% %%sitename%%')}${meta('_yoast_wpseo_metadesc', 'About %%focuskw%%')}${meta('_yoast_wpseo_meta-robots-noindex', '1')}`,
})}
${item({ id: 8, type: 'page', slug: 'about', extra: meta('_elementor_edit_mode', 'builder') })}
${item({ id: 9, status: 'draft', slug: 'draft' })}
${item({ id: 30, type: 'wp_block', content: '<!-- wp:paragraph --><p>Shared</p><!-- /wp:paragraph -->' })}
${item({ id: 31, type: 'wp_block', status: 'draft', content: '<p>Not yet</p>' })}
${item({ id: 40, type: 'product', slug: 'shoe' })}
${item({ id: 41, type: 'product', slug: 'boot' })}
${item({ id: 42, type: 'nav_menu_item' })}`)

  it('probes the site from the export, counting what will be migrated', async () => {
    const info = await new WxrExtractor({ file: await file(site) }).probe()
    expect(info).toEqual({
      siteUrl: 'https://old.example/blog',
      counts: { posts: 1, pages: 1, media: 1, categories: 2, tags: 1, users: 1 },
      seoPlugin: 'yoast',
      unmigratedTypes: [{ type: 'product', count: 2 }],
    })
  })

  it('maps media, terms and authors as plain text, never reading the email', async () => {
    const ex = new WxrExtractor({ file: await file(site) })
    expect(await collect(ex.media())).toEqual([
      { wpId: 5, sourceUrl: 'https://old.example/wp-content/uploads/photo.JPG', filename: 'photo.JPG', mimeType: 'image/jpeg', link: 'https://old.example/blog/item-5/', alt: 'Alt' },
    ])
    expect(await collect(ex.terms())).toEqual([
      { wpId: 20, taxonomy: 'post_tag', name: 'Café', slug: 'café' },
      { wpId: 11, taxonomy: 'category', name: 'Child & Co', slug: 'child', parentWpId: 10 },
      { wpId: 10, taxonomy: 'category', name: 'Parent', slug: 'parent' },
    ])
    expect(await collect(ex.authors())).toEqual([{ wpId: 3, slug: 'jane', displayName: 'Jane Doe' }])
  })

  it('maps documents like the REST source, inlining reusable blocks and filling SEO variables', async () => {
    const warnings: { code: string; detail: string }[] = []
    const ex = new WxrExtractor({ file: await file(site), onWarning: (w) => warnings.push(w) })
    const docs = await collect(ex.documents())
    expect(docs.map((d) => `${d.type}:${d.wpId}`)).toEqual(['post:7', 'page:8'])
    const post = docs[0] as IRDocument
    expect(post).toMatchObject({
      slug: 'hello',
      title: 'Hello world',
      status: 'publish',
      publishedAt: '2026-01-02T01:04:05.000Z',
      authorWpId: 3,
      termWpIds: [11, 20],
      featuredMediaWpId: 5,
      seo: { title: 'Hello world - My & Site', noindex: true },
      meta: { contentFormat: 'raw' },
    })
    expect(post.seo?.description).toBeUndefined()
    expect(post.html).toContain('<p>Shared</p>')
    expect(post.html).not.toContain('Not yet')
    expect(docs[1]!.meta['pageBuilder']).toBe('Elementor')
    expect(warnings.map((w) => w.code)).toEqual(['DOC_TYPE_UNMAPPED', 'REUSABLE_BLOCK_MISSING', 'SEO_TEMPLATE_UNRESOLVED'])
    expect(warnings[0]!.detail).toBe('Post type "product" (2 items) was not migrated: the WXR source migrates posts and pages')
    expect(warnings[1]!.detail).toMatch(/#31 not published \(draft\) \(post:7\)/)
  })

  it('reads drafts only when the config asks for them, and Rank Math SEO when chosen', async () => {
    const f = await file(wxr(item({ id: 9, status: 'draft', extra: `${meta('rank_math_title', '%title% | %sitename%')}${meta('rank_math_robots', 'a:1:{i:0;s:7:"noindex";}')}` })))
    expect(await collect(new WxrExtractor({ file: f }).documents())).toEqual([])
    const [doc] = await collect(new WxrExtractor({ file: f, statuses: ['publish', 'draft'] }).documents())
    expect(doc).toMatchObject({ wpId: 9, status: 'draft', seo: { title: 'Item 9 | My & Site', noindex: true } })
    const [none] = await collect(new WxrExtractor({ file: f, statuses: ['draft'], seoPlugin: 'none' }).documents())
    expect(none!.seo).toBeUndefined()
  })

  it('refuses an RSS feed that is not a WordPress export', async () => {
    const f = await file('<rss><channel><title>Feed</title><item><title>x</title></item></channel></rss>')
    await expect(new WxrExtractor({ file: f }).probe()).rejects.toMatchObject({ code: 'WXR_INVALID' })
  })
})
