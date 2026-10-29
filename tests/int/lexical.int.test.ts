import { convertLexicalToHTML, defaultHTMLConverters, LinkHTMLConverter, type HTMLConverters } from '@payloadcms/richtext-lexical/html'
import { editorConfigFactory, getEnabledNodes } from '@payloadcms/richtext-lexical'
import { createHeadlessEditor } from '@payloadcms/richtext-lexical/lexical/headless'
import type { RichTextField } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { IdKind, IdMap } from '../../src/loaders/types.js'
import type { PayloadId } from '../../src/loaders/wpmeta.js'
import { htmlToLexical } from '../../src/transform/lexical/index.js'
import { buildUrlResolver } from '../../src/transform/urls.js'
import { BLOCKS, startLexicalPayload, type LexicalTestPayload } from './lexical-harness.js'

type SerializedEditorState = Parameters<typeof convertLexicalToHTML>[0]['data']

const SITE = 'https://oldsite.test'
const UP = `${SITE}/wp-content/uploads/2021/04`
// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const SAMPLE = `
<h2>Heading <em>two</em></h2>
<p>Plain, <strong>bold <em>both</em></strong>, <s>struck</s>, <code>code</code>, H<sub>2</sub>O and x<sup>2</sup>.<br>Next line.</p>
<p>See <a href="${SITE}/2021/04/target/">the target post</a>, <a href="https://external.test/page" rel="noopener">an external page</a>
and <a href="${SITE}/never-migrated/">an old page</a>.</p>
<figure><img src="${UP}/photo-300x200.jpg" alt="Photo"><figcaption>A caption</figcaption></figure>
<p>Missing image: <img src="${UP}/missing.jpg" alt="Gone"></p>
<ol><li>one<ul><li>nested</li></ul></li><li>two</li></ol>
<blockquote><p>Quoted</p></blockquote>
<hr>
<pre><code>line 1
line 2</code></pre>
<wp2p-embed data-url="https://www.youtube.com/watch?v=abc"></wp2p-embed>
<table><tr><th>Col</th></tr><tr><td>Cell</td></tr></table>
`

function idMap(): IdMap {
  const m = new Map<string, PayloadId>()
  return { get: (k: IdKind, w) => m.get(`${k}:${w}`), set: (k: IdKind, w, id) => void m.set(`${k}:${w}`, id) }
}

const field = (node: { fields: object }, key: string) => String((node.fields as Record<string, unknown>)[key])

let t: LexicalTestPayload
beforeAll(async () => {
  t = await startLexicalPayload()
})
afterAll(async () => {
  await t?.close()
})

describe('htmlToLexical output through a real Payload lexicalEditor() field', () => {
  it('saves, reads back and renders with Payload’s own HTML converter', async () => {
    const { payload } = t
    const media = await payload.create({
      collection: 'media',
      data: { alt: 'Photo' },
      file: { data: PNG, mimetype: 'image/png', name: 'photo.png', size: PNG.length },
    })
    const target = await payload.create({ collection: 'posts', data: { title: 'Target' } })

    const ids = idMap()
    ids.set('media', 101, media.id)
    ids.set('post', 201, target.id)
    const resolver = buildUrlResolver({
      siteOrigin: SITE,
      media: [{ wpId: 101, sourceUrl: `${UP}/photo.jpg` }],
      documents: [{ wpId: 201, type: 'post', link: `${SITE}/2021/04/target/` }],
      ids,
      docCollections: { post: 'posts' },
    })
    const { state, warnings } = htmlToLexical(SAMPLE, { resolver, mediaCollection: 'media', blocks: BLOCKS, doc: 'post:202' })
    expect(warnings.map((w) => w.code).sort()).toEqual(['LINK_NOT_MIGRATED', 'MEDIA_NOT_MIGRATED'])

    const created = await payload.create({ collection: 'posts', data: { title: 'Rich', content: state as never } })
    // Payload stores the JSON as written: no node was rewritten or stripped by validation or hooks.
    const raw = await payload.findByID({ collection: 'posts', id: created.id, depth: 0 })
    expect(raw.content).toEqual(state)
    const read = await payload.findByID({ collection: 'posts', id: created.id, depth: 1 })
    const content = read.content as unknown as SerializedEditorState

    const converters: HTMLConverters = {
      ...defaultHTMLConverters,
      ...LinkHTMLConverter({
        internalDocToHref: ({ linkNode }) => {
          const doc = linkNode.fields.doc
          const id = doc && typeof doc.value === 'object' ? doc.value.id : doc?.value
          return `/${doc?.relationTo}/${String(id)}`
        },
      }),
      blocks: {
        [BLOCKS.embed]: ({ node }) => `<div data-embed="${field(node, 'url')}" data-host="${field(node, 'host')}"></div>`,
        [BLOCKS.wpRawHtml]: ({ node }) => `<div data-raw>${field(node, 'html')}</div>`,
      },
    }
    const html = convertLexicalToHTML({ data: content, converters, disableContainer: true })

    expect(html).toMatch(/<h2[^>]*>Heading <em>two<\/em><\/h2>/)
    expect(html).toContain('<strong>bold </strong>')
    expect(html).toMatch(/<strong><em>both<\/em><\/strong>|<em><strong>both<\/strong><\/em>/)
    expect(html).toMatch(/<span style="text-decoration: line-through;">struck<\/span>/)
    for (const s of [ '<code>code</code>', '<sub>2</sub>', '<sup>2</sup>', 'Next line.', 'Quoted', 'A caption', 'nested']) {
      expect(html).toContain(s)
    }
    expect(html).toMatch(/<br\s*\/?>/)
    expect(html).toMatch(/<hr\s*\/?>/)
    expect(html).toMatch(new RegExp(`<a[^>]*href="/posts/${String(target.id)}"[^>]*>the target post</a>`))
    expect(html).toMatch(/<a[^>]*href="https:\/\/external\.test\/page"[^>]*>an external page<\/a>/)
    expect(html).toMatch(new RegExp(`<a[^>]*href="${SITE}/never-migrated/"[^>]*>an old page</a>`))
    expect(html).toMatch(new RegExp(`<a[^>]*href="${UP}/missing.jpg"[^>]*>Gone</a>`))
    expect(html).toMatch(new RegExp(`<img[^>]*src="${String((media as { url?: string }).url)}"`))
    expect(html).toMatch(/<ol[^>]*>[\s\S]*<ul[^>]*>[\s\S]*nested[\s\S]*<\/ul>[\s\S]*two[\s\S]*<\/ol>/)
    expect(html).toContain('data-embed="https://www.youtube.com/watch?v=abc" data-host="www.youtube.com"')
    expect(html).toContain('<div data-raw><table><tr><th>Col</th></tr><tr><td>Cell</td></tr></table></div>')
    expect(html).toMatch(/line 1[\s\S]*<br\s*\/?>[\s\S]*line 2/)
  })

  it('saves the fallback forms when the editor has no blocks', async () => {
    const resolver = buildUrlResolver({ siteOrigin: SITE, media: [], documents: [], ids: idMap(), docCollections: {} })
    const { state, warnings } = htmlToLexical('<wp2p-embed data-url="https://vimeo.com/1"></wp2p-embed><table><tr><td>a</td><td>b</td></tr></table>', {
      resolver,
      mediaCollection: 'media',
      blocks: {},
      doc: 'post:203',
    })
    expect(warnings.map((w) => w.code)).toEqual(['LEXICAL_FALLBACK', 'LEXICAL_FALLBACK'])
    const created = await t.payload.create({ collection: 'posts', data: { title: 'Fallback', content: state as never } })
    const read = await t.payload.findByID({ collection: 'posts', id: created.id })
    const html = convertLexicalToHTML({ data: read.content as unknown as SerializedEditorState, disableContainer: true })
    expect(html).toMatch(/<a[^>]*href="https:\/\/vimeo\.com\/1"[^>]*>https:\/\/vimeo\.com\/1<\/a>/)
    expect(html).toContain('a | b')
  })

  it('has teeth: Payload rejects a node shape it cannot validate', async () => {
    const resolver = { media: () => 1, doc: () => undefined }
    const { state } = htmlToLexical(`<img src="${UP}/x.jpg">`, { resolver, mediaCollection: 'not-a-collection', blocks: {}, doc: 'post:204' })
    await expect(t.payload.create({ collection: 'posts', data: { title: 'Bad', content: state as never } })).rejects.toThrow(/invalid: Content/i)
  })

  it('rel: kept when the link feature has a rel field, and usable by a frontend converter', async () => {
    const resolver = buildUrlResolver({ siteOrigin: SITE, media: [], documents: [], ids: idMap(), docCollections: {} })
    const opts = { resolver, mediaCollection: 'media', blocks: BLOCKS, doc: 'post:205', externalLinkRel: 'noopener nofollow' }
    const { state } = htmlToLexical('<p><a href="https://external.test/">ext</a></p>', opts)
    const created = await t.payload.create({ collection: 'relposts', data: { title: 'Rel', content: state as never } })
    const read = await t.payload.findByID({ collection: 'relposts', id: created.id, depth: 0 })
    expect(read.content).toEqual(state)
    const html = convertLexicalToHTML({
      data: read.content as unknown as SerializedEditorState,
      disableContainer: true,
      converters: {
        ...defaultHTMLConverters,
        link: ({ node, nodesToHTML }) =>
          `<a href="${String(node.fields.url)}" rel="${String(node.fields.rel)}">${nodesToHTML({ nodes: node.children }).join('')}</a>`,
      },
    })
    expect(html).toBe('<p><a href="https://external.test/" rel="noopener nofollow">ext</a></p>')
  })

  it('rel: a link feature without a rel field stores the extra key unchanged (no strip, no reject)', async () => {
    const resolver = buildUrlResolver({ siteOrigin: SITE, media: [], documents: [], ids: idMap(), docCollections: {} })
    const opts = { resolver, mediaCollection: 'media', blocks: BLOCKS, doc: 'post:206', externalLinkRel: 'noopener nofollow' }
    const { state } = htmlToLexical('<p><a href="https://external.test/">ext</a></p>', opts)
    const created = await t.payload.create({ collection: 'posts', data: { title: 'NoRel', content: state as never } })
    const read = await t.payload.findByID({ collection: 'posts', id: created.id, depth: 0 })
    expect(read.content).toEqual(state)
  })

  it('round-trips unchanged through a headless editor built from the real editor config', async () => {
    const posts = t.payload.collections.posts!.config
    const field = posts.fields.find((f) => 'name' in f && f.name === 'content') as RichTextField
    const editorConfig = editorConfigFactory.fromField({ field })
    const editor = createHeadlessEditor({ nodes: getEnabledNodes({ editorConfig }), onError: (e) => { throw e } })
    const resolver = {
      media: (url: string) => (url.includes('photo') ? 1 : undefined),
      doc: (url: string) => (url.includes('target') ? { relationTo: 'posts', value: 1 } : undefined),
      isOldSite: (url: string) => url.startsWith(SITE) || url.startsWith('/'),
    }
    const { state } = htmlToLexical(SAMPLE + '<ul><li>a<ul><li>b<ol><li>c</li></ol></li></ul></li></ul>', {
      resolver,
      mediaCollection: 'media',
      blocks: BLOCKS,
      doc: 'post:207',
    })
    editor.setEditorState(editor.parseEditorState(state as never))
    const after = editor.getEditorState().toJSON()
    expect(after).toEqual(state)
    expect(JSON.stringify(state)).toMatch(/"indent":2,"type":"listitem"/)
  })
})
