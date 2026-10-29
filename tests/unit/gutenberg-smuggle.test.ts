import { readdirSync, readFileSync } from 'node:fs'
import { parseDocument } from 'htmlparser2'
import type { AnyNode } from 'domhandler'
import { describe, expect, it } from 'vitest'
import { normaliseBlocks, parseBlocks } from '../../src/transform/gutenberg/index.js'
import { realComments } from '../../src/transform/gutenberg/parse.js'
import type { ParsedBlock } from '../../src/transform/types.js'

// R-01: only comments an HTML tokenizer sees can be block delimiters, so delimiter-shaped text in
// attribute values or raw-text elements cannot split a hidden link farm into its own block.
const dir = new URL('../fixtures/gutenberg/smuggled/', import.meta.url)
const smuggled = readdirSync(dir).filter((f) => f.endsWith('.html'))
const read = (u: URL) => readFileSync(u, 'utf8')
const names = (blocks: ParsedBlock[]): string[] => blocks.flatMap((b) => [b.name, ...names(b.innerBlocks)])

/** Start offsets of the comment nodes the security pre-scan (htmlparser2 Parser) sees. */
function scannerComments(html: string): Set<number> {
  const out = new Set<number>()
  const stack: AnyNode[] = [parseDocument(html, { withStartIndices: true })]
  while (stack.length) {
    const n = stack.pop() as AnyNode
    if (n.type === 'comment' && n.startIndex !== null) out.add(n.startIndex)
    if ('children' in n) stack.push(...n.children)
  }
  return out
}

describe('delimiters hidden from the HTML tokenizer are text (R-01)', () => {
  it('fixtures cover attributes and every raw-text element', () => {
    expect(smuggled.sort()).toEqual([
      'attr-double.html', 'attr-single.html', 'iframe.html', 'noembed.html', 'noframes.html', 'plaintext.html',
      'script.html', 'style.html', 'textarea.html', 'title.html', 'xmp.html',
    ])
  })

  it.each(smuggled)('%s stays inside core/html, no paragraph block', (f) => {
    const html = read(new URL(f, dir))
    const blocks = parseBlocks(html)
    expect(blocks.map((b) => b.name)).toEqual(['core/html'])
    expect(names(blocks)).not.toContain('core/paragraph')
    expect(normaliseBlocks(blocks, []).map((b) => b.name)).toEqual(['core/html'])
  })

  it('raw-text and attribute cases keep the casino link inside the core/html markup', () => {
    for (const f of smuggled.filter((n) => n !== 'attr-double.html')) {
      const [b] = parseBlocks(read(new URL(f, dir)))
      expect(b?.innerBlocks).toEqual([])
      expect(b?.innerHTML).toContain('casino.example')
    }
  })

  it('every comment the parser accepts is a comment node for the security scan', () => {
    const inputs = [
      ...smuggled.map((f) => read(new URL(f, dir))),
      ...['core-blocks', 'legacy-blocks', 'custom-blocks', 'classic'].map((n) => read(new URL(`../fixtures/gutenberg/${n}.html`, import.meta.url))),
      '<svg><style><!-- wp:paragraph --></style></svg><math><title><!-- wp:x /--></title></math>',
      '<!-- a --!><!-- wp:separator /--><!---><!-- wp:b /--><![CDATA[<!-- wp:c /-->]]><? <!-- wp:d /--> ?>',
      '<div a="<!--" b=\'-->\'><!-- wp:e /--></div><textarea/><!-- wp:f /--></textarea>',
    ]
    for (const html of inputs) {
      const scan = scannerComments(html)
      const ours = realComments(html)
      for (let i = 0; i < ours.length; i += 3) expect(scan.has(ours[i] as number)).toBe(true)
    }
  })
})
