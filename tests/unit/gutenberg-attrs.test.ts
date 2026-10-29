import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normaliseBlocks, parseBlocks, playerUrl } from '../../src/transform/gutenberg/index.js'
import { textOf, tokenize } from '../../src/transform/gutenberg/html.js'
import type { ParsedBlock } from '../../src/transform/types.js'

// R-04: tag boundaries come from htmlparser2's tokenizer, so text inside an attribute value never
// becomes markup in the normalised output.
const dir = new URL('../fixtures/gutenberg/attr-smuggled/', import.meta.url)
const read = (u: URL) => readFileSync(u, 'utf8')
const normalise = (html: string) => normaliseBlocks(parseBlocks(html), [])
const fixtures = [
  ...readdirSync(dir).map((f) => new URL(f, dir)),
  ...['core-blocks', 'legacy-blocks', 'custom-blocks', 'classic'].map((n) => new URL(`../fixtures/gutenberg/${n}.html`, import.meta.url)),
  ...readdirSync(new URL('../fixtures/gutenberg/smuggled/', import.meta.url)).map((f) => new URL(`../fixtures/gutenberg/smuggled/${f}`, import.meta.url)),
]

const GENERATED = /^<(?:p|h[1-6]|ul|ol|li|blockquote|pre|code|figure|figcaption|hr|br)>$/
const GENERATED_URL = /^<(?:img src="([^"]*)" alt="[^"]*"|a href="([^"]*)"|iframe src="([^"]*)")>$/

const jsonStrings = (v: unknown, out: Set<string>) => {
  if (typeof v === 'string') out.add(v)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) jsonStrings(x, out)
}
const walk = (blocks: ParsedBlock[], fn: (b: ParsedBlock) => void) => {
  for (const b of blocks) {
    fn(b)
    walk(b.innerBlocks, fn)
  }
}

/** Every element in the output is an input element verbatim, a bare generated wrapper, or a generated
 * img/a/iframe whose URL is a real src/href in the input, a JSON attr, or a URL in visible text. */
function assertNoNewElements(input: string) {
  const inTags = new Set<string>()
  const urls = new Set<string>()
  const m = tokenize(input)
  for (const t of m.tokens) {
    if (t.type !== 'open') continue
    inTags.add(m.src.slice(t.start, t.end))
    for (const k of ['src', 'href']) {
      const v = t.attrs.get(k)
      if (v !== undefined) urls.add(v.replace(/"/g, '&quot;'))
    }
  }
  walk(parseBlocks(input), (b) => {
    const s = new Set<string>()
    jsonStrings(b.attrs, s)
    for (const v of s) urls.add(v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
  })
  for (const u of textOf(m).match(/https?:\/\/[^\s<>"']+/g) ?? []) urls.add(u)
  for (const u of [...urls]) {
    const p = playerUrl(u.replace(/&amp;/g, '&'))
    if (p) urls.add(p)
  }

  for (const { html } of normalise(input)) {
    const out = tokenize(html)
    for (const t of out.tokens) {
      if (t.type !== 'open') continue
      const s = out.src.slice(t.start, t.end)
      if (inTags.has(s) || GENERATED.test(s)) continue
      const g = GENERATED_URL.exec(s)
      expect(g, `unexpected element ${s}`).not.toBeNull()
      expect(urls, `url in ${s}`).toContain(g?.[1] ?? g?.[2] ?? g?.[3])
    }
  }
}

describe('attribute text never becomes markup (R-04)', () => {
  it.each([
    ['paragraph.html', 'core/paragraph', 'hello'],
    ['heading.html', 'core/heading', 'Title'],
    ['image.html', 'core/image', 'cap'],
  ])('%s keeps its text and yields no link', (f, name, text) => {
    const out = normalise(read(new URL(f, dir)))
    expect(out.map((b) => b.name)).toEqual([name])
    const m = tokenize(out[0]?.html ?? '')
    expect(m.tokens.filter((t) => t.type === 'open' && t.name === 'a')).toEqual([])
    expect(textOf(m).trim()).toBe(text)
  })

  it('variants: links/frames in attributes of images, wrappers, lists, embeds, classic, file, video stay attribute text', () => {
    for (const { html } of normalise(read(new URL('variants.html', dir)))) {
      const m = tokenize(html)
      for (const t of m.tokens) {
        if (t.type === 'open' && (t.name === 'a' || t.name === 'iframe')) expect(t.attrs.get('href') ?? t.attrs.get('src')).not.toContain('casino')
      }
    }
  })

  it.each(fixtures.map((u) => [u.pathname.split('/').slice(-2).join('/'), u] as const))('%s: no element the tokenizer did not see', (_, u) => {
    assertNoNewElements(read(u))
  })

  it('5000 <div> inside an attribute stay attribute text', () => {
    const html = `<!-- wp:paragraph --><p title='${'<div>'.repeat(5000)}'>hello</p><!-- /wp:paragraph -->`
    expect(normalise(html)).toEqual([{ name: 'core/paragraph', html: '<p>hello</p>' }])
  })

  it.each([
    ['100k quoted attributes with >', `<!-- wp:paragraph --><p>${"<b title='a>b'>x</b>".repeat(100_000)}</p><!-- /wp:paragraph -->`],
    ['unterminated quoted attribute', `<!-- wp:paragraph --><p title='${'<a href=x>y</a>'.repeat(100_000)}`],
    ['100k unclosed tags in a wrapper', `<!-- wp:group --><div>${'<span title="a">'.repeat(100_000)}</div><!-- /wp:group -->`],
  ])('%s stays fast', (_, src) => {
    const t = performance.now()
    normalise(src)
    expect(performance.now() - t).toBeLessThan(5000)
  })
})
