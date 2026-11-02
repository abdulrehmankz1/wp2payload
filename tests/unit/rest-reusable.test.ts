import { describe, expect, it } from 'vitest'
import { RestExtractor } from '../../src/extractors/rest/index.js'
import { MAX_REUSABLE_DEPTH, inlineReusableBlocks, reusableRef, type ReusableContent } from '../../src/extractors/rest/reusable.js'
import type { Issue } from '../../src/report/types.js'

const ref = (n: unknown) => `<!-- wp:block ${JSON.stringify({ ref: n })} /-->`

describe('reusableRef', () => {
  it('accepts positive integers only', () => {
    expect(reusableRef({ ref: 12 })).toBe(12)
    expect(reusableRef({ ref: '12' })).toBe(12)
    for (const bad of [0, -1, 1.5, '012', '1e3', ' 1', 'x', null, true, [1], Number.MAX_SAFE_INTEGER + 1, undefined]) {
      expect(reusableRef({ ref: bad }), String(bad)).toBeUndefined()
    }
  })
})

describe('inlineReusableBlocks', () => {
  const store = (blocks: Record<number, ReusableContent>) => {
    const loads: number[] = []
    const load = async (n: number) => {
      loads.push(n)
      return blocks[n] ?? { reason: 'not found' }
    }
    return { load, loads }
  }

  it('inlines nested blocks in place and leaves other content alone', async () => {
    const { load } = store({ 1: { html: `<p>one</p>${ref(2)}` }, 2: { html: '<p>two</p>' } })
    const out = await inlineReusableBlocks(`<p>a</p>${ref(1)}<p>b</p><!-- wp:blockquote -->q<!-- /wp:blockquote -->`, load, () => {})
    expect(out).toBe('<p>a</p><p>one</p><p>two</p><p>b</p><!-- wp:blockquote -->q<!-- /wp:blockquote -->')
  })

  it('removes unusable blocks and reports why; keeps delimiters without a valid ref', async () => {
    const { load } = store({ 1: { html: `x${ref(1)}` }, 3: { reason: 'not published (draft)' } })
    const skipped: string[] = []
    const html = `${ref(1)}${ref(3)}${ref(404)}${ref('nope')}<!-- wp:block /-->`
    const out = await inlineReusableBlocks(html, load, (n, why) => skipped.push(`${n} ${why}`))
    expect(out).toBe(`x${ref('nope')}<!-- wp:block /-->`)
    expect(skipped).toEqual(['1 contains itself', '3 not published (draft)', '404 not found'])
  })

  it('stops at the depth limit', async () => {
    const chain: Record<number, ReusableContent> = {}
    for (let i = 1; i <= 20; i++) chain[i] = { html: `${i};${ref(i + 1)}` }
    const skipped: string[] = []
    const out = await inlineReusableBlocks(ref(1), store(chain).load, (n, why) => skipped.push(`${n} ${why}`))
    expect(out.split(';').filter(Boolean)).toHaveLength(MAX_REUSABLE_DEPTH)
    expect(skipped).toEqual([`${MAX_REUSABLE_DEPTH + 1} nested more than ${MAX_REUSABLE_DEPTH} deep`])
  })

  it('bounds a block repeated exponentially', async () => {
    // Each level holds the next one ten times: 10^8 inlines without a budget.
    const fan: Record<number, ReusableContent> = {}
    for (let i = 1; i <= 8; i++) fan[i] = { html: ref(i + 1).repeat(10) }
    fan[9] = { html: 'x' }
    const reasons = new Set<string>()
    const out = await inlineReusableBlocks(ref(1), store(fan).load, (_n, why) => reasons.add(why))
    expect(out.length).toBeLessThan(1_000_000)
    expect([...reasons].some((r) => r.startsWith('more than'))).toBe(true)
  })

  it('ignores delimiter-shaped text inside attributes and raw-text elements', async () => {
    const { load, loads } = store({ 1: { html: 'x' } })
    const html = `<a title="${ref(1).replace(/"/g, '&quot;')}">t</a><script>${ref(1)}</script><textarea>${ref(1)}</textarea>`
    expect(await inlineReusableBlocks(html, load, () => {})).toBe(html)
    expect(loads).toEqual([])
  })
})

describe('RestExtractor reusable blocks', () => {
  const PASSWORD = 'abcd EFGH 1234 ijkl'
  const blocks: Record<number, { status: number; body: unknown }> = {
    10: { status: 200, body: { id: 10, status: 'publish', type: 'wp_block', content: { raw: `<!-- wp:paragraph --><p>Shared</p><!-- /wp:paragraph -->${ref(11)}`, protected: false } } },
    11: { status: 200, body: { id: 11, status: 'publish', type: 'wp_block', content: { raw: '<p>Inner</p>', protected: false } } },
    12: { status: 200, body: { id: 12, status: 'draft', type: 'wp_block', content: { raw: '<p>Draft</p>', protected: false } } },
    13: { status: 200, body: { id: 13, status: 'publish', type: 'wp_block', content: { raw: '<p>Secret</p>', protected: true } } },
    14: { status: 403, body: { code: 'rest_forbidden', message: 'no', data: { status: 403 } } },
    15: { status: 500, body: { code: 'oops' } },
  }

  function make(posts: { id: number; html: string }[], auth = true) {
    const calls: string[] = []
    const fetch = (async (input: string | URL) => {
      const url = new URL(String(input))
      calls.push(url.pathname + url.search)
      let status = 200
      let body: unknown = []
      const block = /\/wp\/v2\/blocks\/(\d+)$/.exec(url.pathname)
      if (block) {
        const b = blocks[Number(block[1])]
        status = b?.status ?? 404
        body = b?.body ?? { code: 'rest_post_invalid_id', message: 'Invalid post ID.', data: { status: 404 } }
      } else if (url.pathname.endsWith('/wp/v2/posts')) {
        body = posts.map((p) => ({ id: p.id, slug: `p${p.id}`, status: 'publish', link: `https://example.com/p${p.id}/`, title: { raw: 'T' }, content: auth ? { raw: p.html } : { rendered: p.html } }))
      }
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-wp-totalpages': '1' } })
    }) as unknown as typeof globalThis.fetch
    const warnings: Issue[] = []
    const ex = new RestExtractor({
      url: 'https://example.com/',
      fetch,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      sleep: async () => {},
      maxRetries: 0,
      seoPlugin: 'none',
      ...(auth ? { auth: { user: 'ed', appPassword: PASSWORD } } : {}),
      onWarning: (i) => warnings.push(i),
    })
    return { ex, calls, warnings }
  }

  async function docs(ex: RestExtractor) {
    const out: { wpId: number; html: string }[] = []
    for await (const d of ex.documents()) out.push({ wpId: d.wpId, html: d.html })
    return out
  }

  it('inlines raw content with context=edit, fetching each ref once per run', async () => {
    const posts = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, html: `<p>Before</p>${ref(10)}` }))
    const { ex, calls, warnings } = make(posts)
    const out = await docs(ex)
    expect(out.map((d) => d.html)).toEqual(Array(3).fill('<p>Before</p><!-- wp:paragraph --><p>Shared</p><!-- /wp:paragraph --><p>Inner</p>'))
    expect(calls.filter((c) => c.includes('/blocks/'))).toEqual(['/wp-json/wp/v2/blocks/10?context=edit', '/wp-json/wp/v2/blocks/11?context=edit'])
    expect(warnings).toEqual([])
  })

  it('leaves out missing, forbidden, unpublished and protected blocks with one aggregated warning', async () => {
    const posts = Array.from({ length: 500 }, (_, i) => ({ id: i + 1, html: `<p>x</p>${ref(999)}` }))
    posts.push({ id: 501, html: `${ref(12)}${ref(13)}${ref(14)}${ref(15)}${ref(999)}` })
    const { ex, calls, warnings } = make(posts)
    const out = await docs(ex)
    expect(out[0]!.html).toBe('<p>x</p>')
    expect(out[500]!.html).toBe('')
    expect(calls.filter((c) => c.includes('/blocks/999'))).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.code).toBe('REUSABLE_BLOCK_MISSING')
    const detail = warnings[0]!.detail
    expect(detail).toContain('left out of 501 documents')
    expect(detail).toContain('#999 not found (deleted, or not a reusable block) (post:1, post:2, post:3, post:4, post:5, ... 501 documents)')
    expect(detail).toContain('#12 not published (draft) (post:501)')
    expect(detail).toContain('#13 password protected')
    expect(detail).toContain('#14 not readable with these credentials')
    expect(detail).toContain('#15 not readable (REST_HTTP)')
    expect(detail).not.toContain(PASSWORD)
  })

  it('does nothing for rendered content (WordPress already inlined published blocks)', async () => {
    const { ex, calls, warnings } = make([{ id: 1, html: `<p>x</p>${ref(10)}` }], false)
    const out = await docs(ex)
    expect(out[0]!.html).toBe(`<p>x</p>${ref(10)}`)
    expect(calls.some((c) => c.includes('/blocks/'))).toBe(false)
    expect(warnings).toEqual([])
  })
})
