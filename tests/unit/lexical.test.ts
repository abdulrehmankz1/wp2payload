import { describe, expect, it } from 'vitest'
import { FORMAT, htmlToLexical } from '../../src/transform/lexical/index.js'
import type { LexicalOptions, UrlResolver } from '../../src/transform/types.js'

const SITE = 'https://oldsite.test'

const resolver: UrlResolver & { isOldSite(url: string): boolean } = {
  media: (url) => (url.includes('/uploads/known') ? 42 : undefined),
  doc: (url) => (url.replace(/\/$/, '') === `${SITE}/hello-world` ? { relationTo: 'posts', value: 7 } : undefined),
  isOldSite: (url) => url.startsWith('/') || url.startsWith(SITE),
}

function convert(html: string, over: Partial<LexicalOptions> = {}) {
  const r = htmlToLexical(html, { resolver, mediaCollection: 'media', blocks: {}, doc: 'post:1', ...over })
  return { ...r, children: (r.state.root as { children: Node[] }).children }
}

type Node = { type: string; children?: Node[]; text?: string; [k: string]: unknown }

/** Compact view: text nodes as strings (with format), elements as [type, ...children]. */
function view(nodes: Node[]): unknown[] {
  return nodes.map((node) => {
    if (node.type === 'text') return node.format ? `${node.text}|${String(node.format)}` : node.text
    if (node.type === 'linebreak') return '<br>'
    if (!node.children) return node.type
    return [node.type, ...view(node.children)]
  })
}

describe('htmlToLexical node shapes (lexical 0.50 / richtext-lexical 3.92.1 exportJSON)', () => {
  it('writes root, paragraph and text exactly as Lexical serializes them', () => {
    const { state, warnings } = convert('<p>Hello</p>')
    expect(warnings).toEqual([])
    expect(state).toEqual({
      root: {
        type: 'root',
        version: 1,
        direction: null,
        format: '',
        indent: 0,
        children: [
          {
            type: 'paragraph',
            version: 1,
            direction: null,
            format: '',
            indent: 0,
            textFormat: 0,
            textStyle: '',
            children: [{ type: 'text', version: 1, detail: 0, format: 0, mode: 'normal', style: '', text: 'Hello' }],
          },
        ],
      },
    })
  })

  it('maps headings, quote, hr and the list fields', () => {
    const { children } = convert('<h3>T</h3><blockquote>q</blockquote><hr><ol><li>a</li></ol>')
    expect(children[0]).toMatchObject({ type: 'heading', tag: 'h3', version: 1 })
    expect(children[1]).toMatchObject({ type: 'quote', version: 1 })
    expect(children[2]).toEqual({ type: 'horizontalrule', version: 1 })
    expect(children[3]).toMatchObject({ type: 'list', listType: 'number', start: 1, tag: 'ol', version: 1 })
    expect(children[3]!.children![0]).toMatchObject({ type: 'listitem', value: 1, version: 1 })
  })
})

describe('inline formatting', () => {
  it('combines nested format bits', () => {
    const { children } = convert('<p><strong>b<em>bi</em></strong> <u>u</u><s>s</s><code>c</code>x<sub>2</sub><sup>3</sup></p>')
    expect(view(children)).toEqual([
      [
        'paragraph',
        'b|1',
        `bi|${FORMAT.bold | FORMAT.italic}`,
        ' ',
        'u|8',
        's|4',
        'c|16',
        'x',
        '2|32',
        '3|64',
      ],
    ])
    expect(children[0]).toMatchObject({ textFormat: 1 })
  })

  it('collapses whitespace and keeps spaces between inline elements', () => {
    const { children } = convert('<p>\n  a  <a href="https://x.test/">b</a>\n c </p>')
    expect(view(children)).toEqual([['paragraph', 'a ', ['link', 'b'], ' c']])
  })

  it('keeps a space that starts a link after text', () => {
    const { children } = convert('<p>a<a href="https://x.test/"> b</a></p>')
    expect(view(children)).toEqual([['paragraph', 'a', ['link', ' b']]])
  })

  it('maps <br> to linebreak nodes', () => {
    expect(view(convert('<p>a<br>b</p>').children)).toEqual([['paragraph', 'a', '<br>', 'b']])
  })
})

describe('block structure', () => {
  it('wraps inline text at the root in paragraphs', () => {
    const { children } = convert('loose <b>text</b><p>p</p>tail')
    expect(view(children)).toEqual([['paragraph', 'loose ', 'text|1'], ['paragraph', 'p'], ['paragraph', 'tail']])
  })

  it('nests lists the Lexical way: the nested list sits in its own list item', () => {
    const { children } = convert('<ol><li>one<ul><li>a</li><li>b</li></ul></li><li>two</li></ol>')
    expect(view(children)).toEqual([
      ['list', ['listitem', 'one'], ['listitem', ['list', ['listitem', 'a'], ['listitem', 'b']]], ['listitem', 'two']],
    ])
    const items = children[0]!.children!
    expect(items.map((i) => i.value)).toEqual([1, 2, 2])
    expect(items.map((i) => i.indent)).toEqual([0, 0, 0])
    expect(items[1]!.children![0]!.children!.map((i) => i.indent)).toEqual([1, 1])
    expect(items[1]!.children![0]).toMatchObject({ listType: 'bullet', tag: 'ul' })
  })

  it('honours <ol start>', () => {
    const { children } = convert('<ol start="4"><li>a</li><li>b</li></ol>')
    expect(children[0]).toMatchObject({ start: 4 })
    expect(children[0]!.children!.map((i) => i.value)).toEqual([4, 5])
  })

  it('joins paragraphs inside list items and quotes with linebreaks', () => {
    expect(view(convert('<ul><li><p>a</p><p>b</p></li></ul>').children)).toEqual([['list', ['listitem', 'a', '<br>', 'b']]])
    expect(view(convert('<blockquote>\n<p>a</p>\n<p>b</p>\n</blockquote>').children)).toEqual([['quote', 'a', '<br>', 'b']])
  })

  it('splits a quote around a nested list', () => {
    expect(view(convert('<blockquote>a<ul><li>x</li></ul>b</blockquote>').children)).toEqual([
      ['quote', 'a'],
      ['list', ['listitem', 'x']],
      ['quote', 'b'],
    ])
  })

  it('maps <pre><code> to a code-formatted paragraph with linebreaks', () => {
    const { children } = convert('<pre><code>if (a) {\n  b()\n}\n</code></pre>')
    expect(view(children)).toEqual([['paragraph', 'if (a) {|16', '<br>', '  b()|16', '<br>', '}|16']])
  })

  it('survives odd nesting without throwing and keeps all text', () => {
    const odd = '<a href="https://x.test/"><p>in link</p></a><li>stray</li><ul>loose<li>i</li></ul><strong><ul><li>bold item</li></ul></strong>'
    const { children } = convert(odd)
    const text = JSON.stringify(children)
    for (const s of ['in link', 'stray', 'loose', 'bold item']) expect(text).toContain(s)
    for (const c of children) expect(['paragraph', 'list', 'heading', 'quote']).toContain(c.type)
  })

  it('flattens hostile nesting depth instead of overflowing the stack', () => {
    const deep = '<b>'.repeat(5000) + 'deep' + '</b>'.repeat(5000)
    const { children, warnings } = convert(deep)
    expect(JSON.stringify(children)).toContain('deep')
    expect(warnings.map((w) => w.code)).toContain('LEXICAL_FALLBACK')
  })

  it('reports removed script-like elements', () => {
    const { warnings, children } = convert('<p>a</p><script>alert(1)</script>')
    expect(JSON.stringify(children)).not.toContain('alert')
    expect(warnings).toEqual([{ code: 'CONTENT_DROPPED', detail: '<script> element removed' }])
  })
})

describe('links', () => {
  it('turns a migrated permalink into an internal link', () => {
    const { children, warnings } = convert(`<p><a href="${SITE}/hello-world/">post</a></p>`)
    expect(children[0]!.children![0]).toEqual({
      type: 'link',
      version: 3,
      direction: null,
      format: '',
      indent: 0,
      fields: { linkType: 'internal', newTab: false, doc: { relationTo: 'posts', value: 7 } },
      children: [expect.objectContaining({ type: 'text', text: 'post' })],
    })
    expect(warnings).toEqual([])
  })

  it('keeps an unmigrated old-site link unchanged with LINK_NOT_MIGRATED', () => {
    const { children, warnings } = convert(`<p><a href="${SITE}/gone/">x</a> <a href="/rel">y</a></p>`)
    const links = children[0]!.children!.filter((c) => c.type === 'link')
    expect(links.map((l) => l.fields)).toEqual([
      { linkType: 'custom', newTab: false, url: `${SITE}/gone/` },
      { linkType: 'custom', newTab: false, url: '/rel' },
    ])
    expect(warnings).toEqual([
      { code: 'LINK_NOT_MIGRATED', detail: `${SITE}/gone/` },
      { code: 'LINK_NOT_MIGRATED', detail: '/rel' },
    ])
  })

  it('writes externalLinkRel on external http(s) links only', () => {
    const { children } = convert(
      `<p><a href="https://elsewhere.test/">e</a><a href="${SITE}/gone/">o</a><a href="mailto:a@b.test">m</a><a href="${SITE}/hello-world/">i</a></p>`,
      { externalLinkRel: 'noopener nofollow' },
    )
    expect(children[0]!.children!.map((l) => l.fields)).toEqual([
      { linkType: 'custom', newTab: false, url: 'https://elsewhere.test/', rel: 'noopener nofollow' },
      { linkType: 'custom', newTab: false, url: `${SITE}/gone/` },
      { linkType: 'custom', newTab: false, url: 'mailto:a@b.test' },
      { linkType: 'internal', newTab: false, doc: { relationTo: 'posts', value: 7 } },
    ])
  })

  it('keeps external links custom without a warning', () => {
    const { children, warnings } = convert('<p><a href="https://elsewhere.test/a" rel="nofollow">e</a> <a href="mailto:a@b.test">m</a></p>')
    expect(children[0]!.children!.filter((c) => c.type === 'link').map((l) => l.fields)).toEqual([
      { linkType: 'custom', newTab: false, url: 'https://elsewhere.test/a' },
      { linkType: 'custom', newTab: false, url: 'mailto:a@b.test' },
    ])
    expect(warnings).toEqual([])
  })

  it('drops a disallowed scheme but keeps the text, with a warning', () => {
    const { children, warnings } = convert('<p><a href="java&#9;script:alert(1)">t</a></p>')
    expect(view(children)).toEqual([['paragraph', 't']])
    expect(warnings[0]?.code).toBe('LEXICAL_FALLBACK')
  })
})

describe('images', () => {
  it('turns a migrated image into a top-level upload node, splitting the paragraph', () => {
    const { children, warnings } = convert(`<p>before <img src="${SITE}/wp-content/uploads/known-300x200.jpg" alt="a"> after</p>`)
    expect(view(children)).toEqual([['paragraph', 'before'], 'upload', ['paragraph', 'after']])
    expect(children[1]).toEqual({
      type: 'upload',
      version: 3,
      format: '',
      id: expect.stringMatching(/^[0-9a-f]{24}$/),
      fields: {},
      relationTo: 'media',
      value: 42,
    })
    expect(warnings).toEqual([])
  })

  it('writes deterministic node ids per document', () => {
    const html = `<img src="${SITE}/wp-content/uploads/known.jpg">`
    expect(convert(html).children[0]!.id).toBe(convert(html).children[0]!.id)
    expect(convert(html).children[0]!.id).not.toBe(convert(html, { doc: 'post:2' }).children[0]!.id)
  })

  it('maps figure + figcaption to upload then caption paragraph', () => {
    const { children } = convert(`<figure><img src="${SITE}/wp-content/uploads/known.jpg"><figcaption>Cap</figcaption></figure>`)
    expect(view(children)).toEqual(['upload', ['paragraph', 'Cap']])
  })

  it('splits list items around an upload and keeps the numbering', () => {
    const { children } = convert(`<ol><li>a</li><li>b<img src="${SITE}/wp-content/uploads/known.jpg">c</li><li>d</li></ol>`)
    expect(view(children)).toEqual([['list', ['listitem', 'a'], ['listitem', 'b']], 'upload', ['list', ['listitem', 'c'], ['listitem', 'd']]])
    expect(children[2]).toMatchObject({ start: 3 })
    expect(children[2]!.children!.map((i) => i.value)).toEqual([3, 4])
  })

  it('keeps an unmigrated image as a link to its URL with MEDIA_NOT_MIGRATED', () => {
    const src = `${SITE}/wp-content/uploads/missing.png`
    const { children, warnings } = convert(`<p><img src="${src}" alt="Logo"></p>`)
    expect(view(children)).toEqual([['paragraph', ['link', 'Logo']]])
    expect(children[0]!.children![0]!.fields).toEqual({ linkType: 'custom', newTab: false, url: src })
    expect(warnings).toEqual([{ code: 'MEDIA_NOT_MIGRATED', detail: src }])
  })

  it('reports a link around a migrated image that the upload cannot keep', () => {
    const { children, warnings } = convert(`<a href="https://shop.test/"><img src="${SITE}/wp-content/uploads/known.jpg"></a>`)
    expect(view(children)).toEqual(['upload'])
    expect(warnings).toEqual([{ code: 'LEXICAL_FALLBACK', detail: 'link around image not kept on the upload: https://shop.test/' }])
  })

  it('does not warn when the link only points at the full-size file', () => {
    const { warnings } = convert(`<a href="${SITE}/wp-content/uploads/known.jpg"><img src="${SITE}/wp-content/uploads/known-300x200.jpg"></a>`)
    expect(warnings).toEqual([])
  })

  it('drops an image with an unusable src with CONTENT_DROPPED, keeping alt text', () => {
    const { children, warnings } = convert('<p><img src="data:image/png;base64,AAAA" alt="pic"></p>')
    expect(view(children)).toEqual([['paragraph', 'pic']])
    expect(warnings[0]?.code).toBe('CONTENT_DROPPED')
  })
})

describe('embeds and tables', () => {
  const embed = '<p>x</p><wp2p-embed data-url="https://www.youtube.com/watch?v=abc"></wp2p-embed>'

  it('maps <wp2p-embed> to an embed block node', () => {
    const { children, warnings } = convert(embed, { blocks: { embed: 'embed' } })
    expect(children[1]).toEqual({
      type: 'block',
      version: 2,
      format: '',
      fields: { id: expect.stringMatching(/^[0-9a-f]{24}$/), blockName: '', blockType: 'embed', url: 'https://www.youtube.com/watch?v=abc', host: 'www.youtube.com' },
    })
    expect(warnings).toEqual([])
  })

  it('falls back to a paragraph link without an embed block', () => {
    const { children, warnings } = convert(embed)
    expect(view(children)).toEqual([['paragraph', 'x'], ['paragraph', ['link', 'https://www.youtube.com/watch?v=abc']]])
    expect(warnings.map((w) => w.code)).toEqual(['LEXICAL_FALLBACK'])
  })

  const table = '<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td colspan="2" style="x">a &amp; <b>b</b></td></tr></tbody></table>'

  it('carries a table as a wpRawHtml block with allowlisted HTML only', () => {
    const { children, warnings } = convert(table, { blocks: { wpRawHtml: 'wpRawHtml' } })
    expect(children).toHaveLength(1)
    expect(children[0]!.fields).toMatchObject({
      blockType: 'wpRawHtml',
      html: '<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td colspan="2">a &amp; <b>b</b></td></tr></tbody></table>',
    })
    expect(warnings).toEqual([])
  })

  it('never hotlinks images from a raw table and reports them', () => {
    const html = `<table><tr><td><img src="${SITE}/wp-content/uploads/known.jpg" alt="K"><img src="${SITE}/wp-content/uploads/gone.jpg"></td></tr></table>`
    const { children, warnings } = convert(html, { blocks: { wpRawHtml: 'wpRawHtml' } })
    expect(children[0]!.fields).toMatchObject({ html: '<table><tr><td>K</td></tr></table>' })
    expect(warnings).toEqual([
      { code: 'LEXICAL_FALLBACK', detail: `image inside a table removed: ${SITE}/wp-content/uploads/known.jpg` },
      { code: 'MEDIA_NOT_MIGRATED', detail: `${SITE}/wp-content/uploads/gone.jpg` },
    ])
  })

  it('keeps an embed inside a raw table as a link, reports links and drops unsafe hrefs', () => {
    const html = `<table><tr><td><wp2p-embed data-url="https://youtu.be/x"></wp2p-embed><a href="/old">o</a><a href="javascript:x">j</a><script>bad()</script></td></tr></table>`
    const { children, warnings } = convert(html, { blocks: { wpRawHtml: 'wpRawHtml' } })
    expect(children[0]!.fields).toMatchObject({ html: '<table><tr><td><a href="https://youtu.be/x">https://youtu.be/x</a><a href="/old">o</a><a>j</a></td></tr></table>' })
    expect(warnings.map((w) => w.code)).toEqual(['LEXICAL_FALLBACK', 'LINK_NOT_MIGRATED', 'LEXICAL_FALLBACK', 'CONTENT_DROPPED'])
  })

  it('serializes a hostile-depth table without overflowing the stack', () => {
    const html = `<table><tr><td>${'<b>'.repeat(20_000)}x</td></tr></table>`
    const { children } = convert(html, { blocks: { wpRawHtml: 'wpRawHtml' } })
    expect(String(children[0]!.fields && (children[0]!.fields as { html: string }).html)).toContain('x')
    expect(() => convert(html)).not.toThrow()
  })

  it('trims long whitespace runs in linear time', () => {
    const t0 = performance.now()
    convert(`<pre>a${' '.repeat(200_000)}b</pre><pre>${' '.repeat(200_000)}</pre>`)
    expect(performance.now() - t0).toBeLessThan(500)
  })

  it('flattens table rows to paragraphs with LEXICAL_FALLBACK otherwise', () => {
    const { children, warnings } = convert(table)
    expect(view(children)).toEqual([
      ['paragraph', 'H1|1', ' | ', 'H2|1'],
      ['paragraph', 'a & ', 'b|1'],
    ])
    expect(warnings.map((w) => w.code)).toEqual(['LEXICAL_FALLBACK'])
  })
})
