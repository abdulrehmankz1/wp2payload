import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Transformer } from '../../src/config/types.js'
import { autop, normaliseBlocks, parseBlocks, playerUrl, unwrapCaptions, type NormaliseIssue } from '../../src/transform/gutenberg/index.js'

const fixture = (n: string) => readFileSync(new URL(`../fixtures/gutenberg/${n}.html`, import.meta.url), 'utf8')
const norm = (html: string, transformers: Transformer[] = []) => {
  const issues: NormaliseIssue[] = []
  return { out: normaliseBlocks(parseBlocks(html), transformers, (i) => issues.push(i)), issues }
}
const htmlOf = (html: string) => norm(html).out.map((b) => b.html)

describe('core blocks to clean HTML (AC-A3)', () => {
  it('normalises the core fixture', () => {
    const { out, issues } = norm(fixture('core-blocks'))
    expect(issues).toEqual([])
    expect(out).toEqual([
      { name: 'core/paragraph', html: '<p>This is a <strong>paragraph</strong> with a <a href="https://example.com/">link</a>.</p>' },
      { name: 'core/heading', html: '<h2>Heading two</h2>' },
      { name: 'core/heading', html: '<h4>Heading four</h4>' },
      { name: 'core/list', html: '<ul><li>One</li><li>Two<ol><li>Two point one</li></ol></li></ul>' },
      {
        name: 'core/image',
        html: '<figure><img src="https://wpthemetestdata.files.wordpress.com/2008/06/canola2.jpg" alt="Canola field"><figcaption>A field of <em>canola</em></figcaption></figure>',
      },
      { name: 'core/quote', html: '<blockquote><p>Quote text.</p><cite>Someone</cite></blockquote>' },
      { name: 'core/pullquote', html: '<blockquote><p>Pulled quote.</p><cite>Author</cite></blockquote>' },
      { name: 'core/code', html: '<pre><code>const a = 1 &lt; 2</code></pre>' },
      { name: 'core/preformatted', html: '<pre><code>  preformatted\n    text</code></pre>' },
      { name: 'core/separator', html: '<hr>' },
      {
        name: 'core/table',
        html: '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table><p>Table caption</p>',
      },
      {
        name: 'core/gallery',
        html: '<figure><img src="https://example.com/a.jpg" alt="A"></figure><figure><img src="https://example.com/b.jpg" alt="B"><figcaption>Bee</figcaption></figure><p>Gallery caption</p>',
      },
      { name: 'core/embed', html: '<iframe src="https://www.youtube.com/embed/nwe-H6l4beM"></iframe>' },
      { name: 'core/embed', html: '<p><a href="https://twitter.com/WordPress/status/1">https://twitter.com/WordPress/status/1</a></p>' },
      { name: 'core/paragraph', html: '<p>Left column</p>' },
      { name: 'core/paragraph', html: '<p>Right column, grouped</p>' },
      { name: 'core/html', html: '<div class="custom"><span>Raw HTML</span></div>' },
    ])
  })

  it('normalises pre-5.8 markup: legacy lists, core-embed/*, ul-based galleries', () => {
    expect(norm(fixture('legacy-blocks')).out).toEqual([
      { name: 'core/list', html: '<ol><li>First</li><li>Second</li></ol>' },
      { name: 'core-embed/youtube', html: '<iframe src="https://www.youtube.com/embed/nwe-H6l4beM"></iframe>' },
      { name: 'core-embed/vimeo', html: '<iframe src="https://player.vimeo.com/video/22439234"></iframe>' },
      {
        name: 'core/gallery',
        html: '<figure><img src="https://example.com/1.jpg" alt="One"><figcaption>First image</figcaption></figure><figure><img src="https://example.com/2.jpg" alt=""></figure><p>Legacy gallery</p>',
      },
      { name: 'core/separator', html: '<hr>' },
    ])
  })

  it('wpautops classic content and unwraps [caption]', () => {
    expect(htmlOf(fixture('classic'))).toEqual([
      [
        '<p>This is classic editor content.<br>\nIt has a single line break here.</p>',
        '<p>And a second paragraph with <em>inline</em> markup.</p>',
        '<p><img class="size-medium wp-image-1" src="https://example.com/boat.jpg" alt="Boat" width="300" height="200" /> A boat at sea</p>',
        '<ul>',
        '<li>Classic list item</li>',
        '</ul>',
        '<pre>keep\n\n   this</pre>',
        '<p>[gallery ids="1,2,3"]</p>',
      ].join('\n'),
    ])
  })

  it('headings: attr level wins, else the tag, else h2', () => {
    expect(htmlOf('<!-- wp:heading {"level":5} --><h5>a</h5><!-- /wp:heading -->')).toEqual(['<h5>a</h5>'])
    expect(htmlOf('<!-- wp:heading --><h3 class="x">b</h3><!-- /wp:heading -->')).toEqual(['<h3>b</h3>'])
    expect(htmlOf('<!-- wp:heading {"level":9} -->c<!-- /wp:heading -->')).toEqual(['<h2>c</h2>'])
  })

  it('images: keep only src, alt, caption and a custom link; fall back to attrs.url; escape attribute quotes', () => {
    const linked = '<!-- wp:image --><figure><a href="https://ex.test/x"><img class="a" src="/i.jpg" alt="A" width="5" data-id="1"></a><figcaption>C</figcaption></figure><!-- /wp:image -->'
    expect(htmlOf(linked)).toEqual(['<figure><a href="https://ex.test/x"><img src="/i.jpg" alt="A"></a><figcaption>C</figcaption></figure>'])
    const toFile = '<!-- wp:image --><figure><a href="https://s.test/up/a.jpg"><img src="https://s.test/up/a-1024x768.jpg" alt=""></a></figure><!-- /wp:image -->'
    expect(htmlOf(toFile)).toEqual(['<figure><img src="https://s.test/up/a-1024x768.jpg" alt=""></figure>'])
    const media = '<!-- wp:image {"linkDestination":"media"} --><figure><a href="https://cdn.test/a.jpg"><img src="https://s.test/a.jpg" alt=""></a></figure><!-- /wp:image -->'
    expect(htmlOf(media)).toEqual(['<figure><img src="https://s.test/a.jpg" alt=""></figure>'])
    expect(htmlOf('<!-- wp:image --><a href="/x">before</a><img src="/i.jpg"><!-- /wp:image -->')).toEqual(['<figure><img src="/i.jpg" alt=""></figure>'])
    expect(htmlOf('<!-- wp:image {"url":"/u.jpg","alt":"a\\"b"} /-->')).toEqual(['<figure><img src="/u.jpg" alt="a&quot;b"></figure>'])
    expect(htmlOf(`<!-- wp:image --><img src='/q".jpg'><!-- /wp:image -->`)).toEqual(['<figure><img src="/q&quot;.jpg" alt=""></figure>'])
    expect(htmlOf('<!-- wp:image --><figure></figure><!-- /wp:image -->')).toEqual([])
  })

  it('media-text and cover keep their image; wrappers flatten; spacer/more/nextpage vanish', () => {
    const src =
      '<!-- wp:media-text {"mediaType":"image"} --><div class="wp-block-media-text"><figure><img src="/m.jpg" alt="M"/></figure><div><!-- wp:paragraph --><p>t</p><!-- /wp:paragraph --></div></div><!-- /wp:media-text -->' +
      '<!-- wp:cover {"url":"/bg.jpg","alt":"Bg"} --><div class="wp-block-cover"><span class="dim"></span><img class="wp-block-cover__image-background" src="/bg.jpg" alt="Bg"/><div><!-- wp:heading --><h2>c</h2><!-- /wp:heading --></div></div><!-- /wp:cover -->' +
      '<!-- wp:cover {"url":"/old.jpg"} --><div class="wp-block-cover" style="background-image:url(/old.jpg)"><!-- wp:paragraph --><p>old</p><!-- /wp:paragraph --></div><!-- /wp:cover -->' +
      '<!-- wp:more --><!--more--><!-- /wp:more --><!-- wp:nextpage --><!--nextpage--><!-- /wp:nextpage --><!-- wp:spacer /-->'
    expect(norm(src).out).toEqual([
      { name: 'core/media-text', html: '<figure><img src="/m.jpg" alt="M"></figure>' },
      { name: 'core/paragraph', html: '<p>t</p>' },
      { name: 'core/cover', html: '<figure><img src="/bg.jpg" alt="Bg"></figure>' },
      { name: 'core/heading', html: '<h2>c</h2>' },
      { name: 'core/cover', html: '<figure><img src="/old.jpg" alt=""></figure>' },
      { name: 'core/paragraph', html: '<p>old</p>' },
    ])
  })

  it("flattened wrappers keep text from their own innerContent, in order", () => {
    const src =
      '<!-- wp:group --><div class="wp-block-group"><p>wrapper text</p><!-- wp:paragraph --><p>inner</p><!-- /wp:paragraph -->tail <em>bare</em><!-- wp:separator /--></div><!-- /wp:group -->'
    expect(norm(src).out).toEqual([
      { name: 'core/group', html: '<p>wrapper text</p>' },
      { name: 'core/paragraph', html: '<p>inner</p>' },
      { name: 'core/group', html: '<p>tail <em>bare</em></p>' },
      { name: 'core/separator', html: '<hr>' },
    ])
  })

  it('video and audio become an unknown link to the file; file is one link', () => {
    expect(norm('<!-- wp:video {"id":1} --><figure class="wp-block-video"><video controls src="https://s.test/v/clip.mov"></video><figcaption>Clip</figcaption></figure><!-- /wp:video -->').out).toEqual([
      { name: 'core/video', html: '<p><a href="https://s.test/v/clip.mov">Clip</a></p>', unknown: true },
    ])
    expect(norm('<!-- wp:audio --><figure class="wp-block-audio"><audio controls src="https://s.test/a/step.ogg?x=1"></audio></figure><!-- /wp:audio -->').out).toEqual([
      { name: 'core/audio', html: '<p><a href="https://s.test/a/step.ogg?x=1">step.ogg</a></p>', unknown: true },
    ])
    const fileSrc =
      '<!-- wp:file {"id":759,"href":"https://s.test/f.jpg"} --><div class="wp-block-file"><a id="x" href="https://s.test/f.jpg">Image</a><a href="https://s.test/f.jpg" class="wp-block-file__button" download>Download</a></div><!-- /wp:file -->'
    expect(htmlOf(fileSrc)).toEqual(['<p><a href="https://s.test/f.jpg">Image</a></p>'])
    expect(htmlOf('<!-- wp:file {"href":"https://s.test/doc.pdf"} /-->')).toEqual(['<p><a href="https://s.test/doc.pdf">doc.pdf</a></p>'])
  })

  it('lists drop start/reversed consistently (not in the sanitizer policy)', () => {
    expect(htmlOf('<!-- wp:list {"ordered":true,"start":5,"reversed":true} --><ol start="5" reversed><li>a</li></ol><!-- /wp:list -->')).toEqual(['<ol><li>a</li></ol>'])
  })

  it('embeds: iframe for YouTube/Vimeo players, link for other providers, URL from innerHTML when attrs lack it', () => {
    expect(playerUrl('https://youtu.be/abcdefghijk?t=3')).toBe('https://www.youtube.com/embed/abcdefghijk')
    expect(playerUrl('https://m.youtube.com/watch?v=abcdefghijk&list=x')).toBe('https://www.youtube.com/embed/abcdefghijk')
    expect(playerUrl('https://www.youtube.com/shorts/abcdefghijk')).toBe('https://www.youtube.com/embed/abcdefghijk')
    expect(playerUrl('https://vimeo.com/channels/staff/123456')).toBe('https://player.vimeo.com/video/123456')
    expect(playerUrl('https://player.vimeo.com/video/42')).toBe('https://player.vimeo.com/video/42')
    expect(playerUrl('https://www.youtube.com/watch?v=<script>')).toBeUndefined()
    expect(playerUrl('https://evil.example/youtube.com/watch?v=abcdefghijk')).toBeUndefined()
    expect(playerUrl('javascript:alert(1)')).toBeUndefined()

    const noAttr = '<!-- wp:embed --><figure><div class="wp-block-embed__wrapper">\nhttps://www.youtube.com/watch?v=abcdefghijk&amp;t=1\n</div><figcaption>Cap</figcaption></figure><!-- /wp:embed -->'
    expect(htmlOf(noAttr)).toEqual(['<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe><p>Cap</p>'])
    expect(htmlOf('<!-- wp:embed {"url":"https://x.test/a?b=1&c=\\"2"} /-->')).toEqual([
      '<p><a href="https://x.test/a?b=1&amp;c=&quot;2">https://x.test/a?b=1&amp;c=&quot;2</a></p>',
    ])
    expect(htmlOf('<!-- wp:embed /-->')).toEqual([])
  })

  it('output is well-formed: every opened element is closed', () => {
    const tags = (h: string) => [...h.matchAll(/<(\/?)([a-z][a-z0-9]*)[^>]*>/g)].filter((m) => !['img', 'hr', 'br'].includes(m[2] as string))
    for (const n of ['core-blocks', 'legacy-blocks', 'custom-blocks']) {
      for (const { html } of norm(fixture(n)).out) {
        const stack: string[] = []
        for (const m of tags(html)) {
          if (m[1]) expect(stack.pop()).toBe(m[2])
          else stack.push(m[2] as string)
        }
        expect(stack).toEqual([])
      }
    }
  })
})

describe('user transformers (AC-A4)', () => {
  const hero: Transformer = { name: 'hero', match: (b) => b.name === 'acme/hero', toHtml: (b) => `<h1>${String(b.attrs.title)}</h1>` }

  it('run before core rules, first match wins, and also apply to inner blocks', () => {
    const para: Transformer = { name: 'para', match: (b) => b.name === 'core/paragraph', toHtml: () => '<p>custom</p>' }
    const never: Transformer = { name: 'never', match: (b) => b.name === 'core/paragraph', toHtml: () => '<p>second</p>' }
    const { out } = norm(fixture('custom-blocks'), [hero, para, never])
    expect(out).toEqual([
      { name: 'acme/hero', html: '<h1>Welcome</h1>' },
      { name: 'acme/callout', html: '<div class="acme-callout"><p>custom</p></div>', unknown: true },
      { name: 'core/paragraph', html: '<p>custom</p>' },
    ])
  })

  it('a throwing match or toHtml is reported as TRANSFORMER_FAILED and falls through', () => {
    const badMatch: Transformer = { name: 'bad-match', match: () => { throw new Error('boom') }, toHtml: () => '' }
    const badHtml: Transformer = { name: 'bad-html', match: (b) => b.name === 'core/paragraph', toHtml: () => { throw new TypeError('nope') } }
    const { out, issues } = norm('<!-- wp:paragraph --><p>kept</p><!-- /wp:paragraph -->', [badMatch, badHtml])
    expect(out).toEqual([{ name: 'core/paragraph', html: '<p>kept</p>' }])
    expect(issues).toEqual([
      { code: 'TRANSFORMER_FAILED', detail: 'bad-match on core/paragraph: boom' },
      { code: 'TRANSFORMER_FAILED', detail: 'bad-html on core/paragraph: nope' },
    ])
  })
})

describe('unknown blocks (AC-A5)', () => {
  it('keep their HTML (inner blocks normalised in place) with unknown: true; empty ones are also dynamic', () => {
    expect(norm(fixture('custom-blocks')).out).toEqual([
      { name: 'acme/hero', html: '', unknown: true, dynamic: true },
      { name: 'acme/callout', html: '<div class="acme-callout"><p>Inside a custom block.</p></div>', unknown: true },
      { name: 'core/paragraph', html: '<p>After the custom blocks.</p>' },
    ])
    expect(norm('<!-- wp:acme/x --><div class="x"> &nbsp; <span></span></div><!-- /wp:acme/x -->').out).toEqual([
      { name: 'acme/x', html: '', unknown: true, dynamic: true },
    ])
    expect(norm('<!-- wp:acme/x --><div><a href="/y"></a></div><!-- /wp:acme/x -->').out).toEqual([
      { name: 'acme/x', html: '<div><a href="/y"></a></div>', unknown: true },
    ])
  })
})

describe('dynamic (server-rendered) blocks', () => {
  it('produce no HTML and drop their inner template blocks', () => {
    const src =
      '<!-- wp:query {"queryId":1} --><div class="wp-block-query"><!-- wp:post-template --><!-- wp:post-title /--><!-- wp:paragraph --><p>template</p><!-- /wp:paragraph --><!-- /wp:post-template --></div><!-- /wp:query -->' +
      '<!-- wp:navigation {"ref":4} /--><!-- wp:latest-posts /--><!-- wp:site-title /--><!-- wp:comments-title /--><!-- wp:block {"ref":12} /-->' +
      '<!-- wp:search {"label":"Search"} /--><!-- wp:query-pagination-next /--><!-- wp:template-part {"slug":"header"} /-->'
    expect(norm(src).out).toEqual(
      ['core/query', 'core/navigation', 'core/latest-posts', 'core/site-title', 'core/comments-title', 'core/block', 'core/search', 'core/query-pagination-next', 'core/template-part']
        .map((name) => ({ name, html: '', dynamic: true })),
    )
  })

  it('social-links: dynamic when empty, else a list of links', () => {
    expect(norm('<!-- wp:social-links --><ul class="wp-block-social-links"></ul><!-- /wp:social-links -->').out).toEqual([
      { name: 'core/social-links', html: '', dynamic: true },
    ])
    const links = '<!-- wp:social-links --><ul><!-- wp:social-link {"url":"https://w.org/","service":"wordpress"} /--><!-- wp:social-link {"service":"x"} /--></ul><!-- /wp:social-links -->'
    expect(htmlOf(links)).toEqual(['<ul><li><a href="https://w.org/">wordpress</a></li></ul>'])
  })

  it('a user transformer still wins over the dynamic set', () => {
    const t: Transformer = { name: 'lp', match: (b) => b.name === 'core/latest-posts', toHtml: () => '<p>see the blog</p>' }
    expect(norm('<!-- wp:latest-posts /-->', [t]).out).toEqual([{ name: 'core/latest-posts', html: '<p>see the blog</p>' }])
  })
})

describe('hostile input stays fast (AC-A2)', () => {
  // Generous bound for slow CI; the inputs are big enough that quadratic code takes far longer.
  const fast = (fn: () => unknown) => {
    const t = performance.now()
    fn()
    expect(performance.now() - t).toBeLessThan(5000)
  }
  it.each([
    ['100k nested groups', '<!-- wp:group -->'.repeat(100_000) + '<p>x</p>'],
    ['100k unclosed [caption', '[caption]'.repeat(100_000)],
    ['100k unclosed <pre', `<!-- wp:freeform -->${'<pre>'.repeat(100_000)}`],
    ['100k <figcaption without >', `<!-- wp:image --><img src="a">${'<figcaption'.repeat(100_000)}<!-- /wp:image -->`],
    ['20k images in a legacy gallery', `<!-- wp:gallery --><ul>${'<li><a href="/p"><img src="a"></a></li>'.repeat(20_000)}</ul><!-- /wp:gallery -->`],
    ['100k images in a legacy gallery without </li>', `<!-- wp:gallery -->${'<img src="a">'.repeat(100_000)}<!-- /wp:gallery -->`],
    ['100k images and unclosed links', `<!-- wp:gallery -->${'<a href="/p"><img src="a">'.repeat(100_000)}<!-- /wp:gallery -->`],
    ['100k < in an embed', `<!-- wp:embed -->${'<'.repeat(100_000)}<!-- /wp:embed -->`],
    ['50k wrapper text pieces', `<!-- wp:group --><div>${'<p>t</p><!-- wp:separator /-->'.repeat(50_000)}</div><!-- /wp:group -->`],
    ['100k unterminated comments in a wrapper', `<!-- wp:group --><div>${'<!-- x'.repeat(100_000)}`],
    ['100k empty unknown blocks', '<!-- wp:acme/x --><div></div><!-- /wp:acme/x -->'.repeat(100_000)],
    ['1 MB classic text with newlines', 'a\n'.repeat(500_000)],
  ])('%s', (_, src) => fast(() => normaliseBlocks(parseBlocks(src), [])))

  it('helpers are linear on their own', () => {
    fast(() => unwrapCaptions('[caption a]x'.repeat(100_000)))
    fast(() => autop(`\n${' '.repeat(1_000_000)}x\n`))
  })
})
