import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MAX_BLOCK_DEPTH, parseBlocks, type ParseIssue } from '../../src/transform/gutenberg/index.js'
import type { ParsedBlock } from '../../src/transform/types.js'

const fixture = (n: string) => readFileSync(new URL(`../fixtures/gutenberg/${n}.html`, import.meta.url), 'utf8')
const parse = (html: string) => {
  const issues: ParseIssue[] = []
  return { blocks: parseBlocks(html, (i) => issues.push(i)), issues, codes: () => issues.map((i) => i.code) }
}
const depth = (blocks: ParsedBlock[]): number => {
  let d = 0
  for (let level = blocks; level.length; level = level.flatMap((b) => b.innerBlocks)) d++
  return d
}
const timed = <T>(fn: () => T): [T, number] => {
  const t = performance.now()
  const r = fn()
  return [r, performance.now() - t]
}

describe('parseBlocks grammar (AC-A1)', () => {
  it('parses opener/closer with JSON attrs, bare names get core/', () => {
    const { blocks, issues } = parse('<!-- wp:heading {"level":3,"x":{"y":[1,"}"]}} -->\n<h3>Hi</h3>\n<!-- /wp:heading -->')
    expect(blocks).toEqual([
      { name: 'core/heading', attrs: { level: 3, x: { y: [1, '}'] } }, innerHTML: '\n<h3>Hi</h3>\n', innerBlocks: [], innerContent: ['\n<h3>Hi</h3>\n'] },
    ])
    expect(issues).toEqual([])
  })

  it('parses void blocks and namespaced names', () => {
    const { blocks } = parse('<!-- wp:acme/hero {"title":"a/b"} /--><!-- wp:separator /--><!-- wp:spacer/-->')
    expect(blocks.map((b) => [b.name, b.attrs, b.innerContent])).toEqual([
      ['acme/hero', { title: 'a/b' }, []],
      ['core/separator', {}, []],
      ['core/spacer', {}, []],
    ])
  })

  it('nests inner blocks with null placeholders in innerContent and innerHTML without them', () => {
    const { blocks } = parse(
      '<!-- wp:group --><div><!-- wp:paragraph --><p>a</p><!-- /wp:paragraph --> mid <!-- wp:separator /--></div><!-- /wp:group -->',
    )
    const g = blocks[0] as ParsedBlock
    expect(blocks).toHaveLength(1)
    expect(g.innerContent).toEqual(['<div>', null, ' mid ', null, '</div>'])
    expect(g.innerHTML).toBe('<div> mid </div>')
    expect(g.innerBlocks.map((b) => b.name)).toEqual(['core/paragraph', 'core/separator'])
    expect(g.innerBlocks[0]?.innerHTML).toBe('<p>a</p>')
  })

  it('wraps HTML outside blocks as core/freeform and skips whitespace-only runs', () => {
    const { blocks } = parse('<p>before</p>\n<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->\n\n  \n<!--more--> after')
    expect(blocks.map((b) => [b.name, b.innerHTML])).toEqual([
      ['core/freeform', '<p>before</p>\n'],
      ['core/paragraph', '<p>x</p>'],
      ['core/freeform', '\n\n  \n<!--more--> after'],
    ])
    expect(parse('  \n\t ').blocks).toEqual([])
    expect(parse('').blocks).toEqual([])
  })

  it('treats comments that are not block delimiters as plain text', () => {
    const src = '<!-- wp:Bad --><!--wp:paragraph --><!-- wp:x junk --><!-- /wp:y extra --><!-- not wp -->'
    const { blocks, issues } = parse(src)
    expect(blocks).toEqual([{ name: 'core/freeform', attrs: {}, innerHTML: src, innerBlocks: [], innerContent: [src] }])
    expect(issues).toEqual([])
  })

  it('parses every fixture without issues', () => {
    for (const n of ['core-blocks', 'legacy-blocks', 'custom-blocks', 'classic']) expect(parse(fixture(n)).issues).toEqual([])
    expect(parse(fixture('core-blocks')).blocks.map((b) => b.name)).toEqual([
      'core/paragraph', 'core/heading', 'core/heading', 'core/list', 'core/image', 'core/quote', 'core/pullquote', 'core/code',
      'core/preformatted', 'core/separator', 'core/table', 'core/gallery', 'core/embed', 'core/embed', 'core/columns', 'core/html', 'core/spacer',
    ])
    expect(parse(fixture('legacy-blocks')).blocks.map((b) => b.name)).toContain('core-embed/youtube')
  })
})

describe('parseBlocks degrades without throwing (AC-A1)', () => {
  it('malformed JSON attrs become {} and are reported once with a count', () => {
    const { blocks, issues } = parse('<!-- wp:image {"id":1,} --><img src="a.jpg"><!-- /wp:image --><!-- wp:x {a:1} /-->')
    expect(blocks.map((b) => [b.name, b.attrs])).toEqual([['core/image', {}], ['core/x', {}]])
    expect(issues).toEqual([{ code: 'BLOCK_ATTRS_INVALID', detail: expect.stringContaining('2 times') }])
    expect(parse('<!-- wp:x {"a":[1]} /--><!-- wp:y {} /-->').issues).toEqual([])
  })

  it('unclosed blocks close at the end, keeping their content', () => {
    const { blocks, codes } = parse('<!-- wp:group --><div><!-- wp:paragraph --><p>a</p>')
    expect(codes()).toEqual(['BLOCK_UNCLOSED'])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.innerContent).toEqual(['<div>', null])
    expect(blocks[0]?.innerBlocks[0]?.innerHTML).toBe('<p>a</p>')
  })

  it('stray closers stay as text; mismatched closers close inner blocks implicitly', () => {
    const stray = parse('<p>a</p><!-- /wp:paragraph --><p>b</p>')
    expect(stray.blocks.map((b) => [b.name, b.innerHTML])).toEqual([['core/freeform', '<p>a</p><!-- /wp:paragraph --><p>b</p>']])
    expect(stray.codes()).toEqual(['BLOCK_CLOSER_STRAY'])

    const mis = parse('<!-- wp:group --><!-- wp:column --><p>x</p><!-- /wp:group --><p>after</p>')
    expect(mis.codes()).toEqual(['BLOCK_CLOSER_MISMATCH'])
    expect(mis.blocks.map((b) => b.name)).toEqual(['core/group', 'core/freeform'])
    expect(mis.blocks[0]?.innerBlocks[0]).toMatchObject({ name: 'core/column', innerHTML: '<p>x</p>' })
  })

  it('an unterminated comment leaves the rest as text', () => {
    const { blocks } = parse('<!-- wp:paragraph --><p>a</p><!-- /wp:paragraph --><!-- wp:paragraph <p>never closed')
    expect(blocks.map((b) => [b.name, b.innerHTML])).toEqual([
      ['core/paragraph', '<p>a</p>'],
      ['core/freeform', '<!-- wp:paragraph <p>never closed'],
    ])
  })
})

describe('parseBlocks on hostile input (AC-A2)', () => {
  it(`caps nesting at ${MAX_BLOCK_DEPTH}; deeper markup stays raw in the deepest block`, () => {
    const n = 100
    const src = '<!-- wp:group -->'.repeat(n) + '<p>core</p>' + '<!-- /wp:group -->'.repeat(n) + '<p>after</p>'
    const { blocks, codes } = parse(src)
    expect(codes()).toEqual(['BLOCK_DEPTH_EXCEEDED'])
    expect(depth(blocks)).toBe(MAX_BLOCK_DEPTH)
    let deepest = blocks[0] as ParsedBlock
    while (deepest.innerBlocks[0]) deepest = deepest.innerBlocks[0]
    const extra = n - MAX_BLOCK_DEPTH
    expect(deepest.innerHTML).toBe('<!-- wp:group -->'.repeat(extra) + '<p>core</p>' + '<!-- /wp:group -->'.repeat(extra))
    expect(blocks.at(-1)).toMatchObject({ name: 'core/freeform', innerHTML: '<p>after</p>' })
  })

  it('100k nested unclosed openers finish fast', () => {
    const [r, ms] = timed(() => parse('<!-- wp:group -->'.repeat(100_000) + 'x'))
    expect(ms).toBeLessThan(5000)
    expect(depth(r.blocks)).toBe(MAX_BLOCK_DEPTH)
    expect(r.codes().sort()).toEqual(['BLOCK_DEPTH_EXCEEDED', 'BLOCK_UNCLOSED'])
  })

  it.each([
    ['100k openers without any closing -->', '<!-- wp:a '.repeat(100_000)],
    ['100k openers sharing one far -->', '<!-- wp:a {"x":1} '.repeat(100_000) + '-->'],
    ['100k stray closers', '<!-- /wp:a -->'.repeat(100_000)],
    ['100k void blocks', '<!-- wp:separator /-->'.repeat(100_000)],
    ['100k malformed attrs', '<!-- wp:a {"x": /-->'.repeat(100_000)],
    ['5 MB attrs', `<!-- wp:a {"x":"${'a'.repeat(5_000_000)}"} /-->`],
    ['5 MB whitespace, unterminated', `<!-- wp:a ${' '.repeat(5_000_000)}{`],
    ['alternating open and mismatched close', '<!-- wp:a --><!-- wp:b --><!-- /wp:a -->'.repeat(50_000)],
  ])('%s: finishes fast and does not throw', (_, src) => {
    const [r, ms] = timed(() => parse(src))
    expect(ms).toBeLessThan(5000)
    expect(Array.isArray(r.blocks)).toBe(true)
  })
})
