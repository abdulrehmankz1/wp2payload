import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IRDocument } from '../../src/ir/types.js'
import { MemoryReport } from '../../src/report/types.js'
import { transformDocument, type TransformContext } from '../../src/transform/index.js'

const SITE = 'https://oldsite.test'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-pipeline-'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

const doc = (html: string, over: Partial<IRDocument> = {}): IRDocument => ({
  wpId: 981,
  type: 'post',
  status: 'publish',
  slug: 'hello',
  title: 'Hello',
  html,
  link: `${SITE}/hello/`,
  publishedAt: '2024-01-01T00:00:00Z',
  modifiedAt: '2024-01-01T00:00:00Z',
  termWpIds: [],
  meta: {},
  ...over,
})

function context(over: Partial<TransformContext> = {}) {
  const report = new MemoryReport()
  const ctx: TransformContext = {
    siteOrigin: SITE,
    embedHosts: ['www.youtube.com', 'player.vimeo.com'],
    externalLinkRel: 'nofollow noopener',
    transformers: [],
    lexical: {
      mediaCollection: 'media',
      blocks: { embed: 'embed', wpRawHtml: 'wpRawHtml' },
      resolver: {
        media: (url) => (url.endsWith('/photo.jpg') ? 7 : undefined),
        doc: (url) => (url === `${SITE}/other-post/` ? { relationTo: 'posts', value: 12 } : undefined),
      },
    },
    report,
    root,
    dryRun: false,
    ...over,
  }
  return { ctx, report }
}

const nodes = (state: { root: Record<string, unknown> }): Record<string, any>[] => {
  const out: Record<string, any>[] = []
  const walk = (n: Record<string, any>) => {
    out.push(n)
    for (const c of (n.children as Record<string, any>[] | undefined) ?? []) walk(c)
  }
  walk(state.root)
  return out
}

const POST = [
  '<!-- wp:heading --><h2>Intro</h2><!-- /wp:heading -->',
  '<!-- wp:paragraph --><p>See <a href="https://oldsite.test/other-post/">the other post</a> and <a href="https://example.org/">a friend</a>.</p><!-- /wp:paragraph -->',
  '<!-- wp:image {"id":7} --><figure class="wp-block-image"><img src="https://oldsite.test/wp-content/uploads/photo.jpg" alt="A &lt;b&gt;photo"/></figure><!-- /wp:image -->',
  '<!-- wp:embed {"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","providerNameSlug":"youtube"} --><figure><div>https://www.youtube.com/watch?v=dQw4w9WgXcQ</div></figure><!-- /wp:embed -->',
  '<!-- wp:html --><script>document.location="https://evil.example/"</script><!-- /wp:html -->',
  '<!-- wp:paragraph --><p>Bye</p><!-- /wp:paragraph -->',
].join('\n')

describe('transformDocument', () => {
  it('turns a block post into Lexical with media, internal links and embeds', async () => {
    const { ctx, report } = context()
    const out = await transformDocument(doc(POST), ctx)
    const all = nodes(out.content)
    expect(all.find((n) => n.type === 'heading')).toMatchObject({ tag: 'h2' })
    expect(all.find((n) => n.type === 'upload')).toMatchObject({ relationTo: 'media', value: 7 })
    const links = all.filter((n) => n.type === 'link')
    expect(links.find((l) => l.fields.linkType === 'internal')?.fields.doc).toEqual({ relationTo: 'posts', value: 12 })
    expect(links.find((l) => l.fields.url === 'https://example.org/')).toBeTruthy()
    expect(all.find((n) => n.type === 'block')?.fields).toMatchObject({ blockType: 'embed', url: expect.stringContaining('youtube.com/embed/dQw4w9WgXcQ') })
    expect(JSON.stringify(out.content)).not.toMatch(/evil\.example|<script/)
    expect(out.externalLinks).toBe(1)
    expect(report.errors).toEqual([])
  })

  it('reports and quarantines removed scripts with the document reference', async () => {
    const { ctx, report } = context()
    await transformDocument(doc(POST), ctx)
    const f = report.findings.find((x) => x.severity === 'high')!
    expect(f).toMatchObject({ doc: 'post:981', action: 'quarantined' })
    expect(f.quarantine).toMatch(/^content\/[0-9a-f]{16}-post-981\.html\.txt$/)
    const saved = readFileSync(path.join(root, '.wp2payload', 'quarantine', f.quarantine!), 'utf8')
    expect(saved).toContain('evil.example')
  })

  it('writes no quarantine in dry run but still reports', async () => {
    const { ctx, report } = context({ dryRun: true })
    await transformDocument(doc(POST), ctx)
    expect(report.findings.some((f) => f.severity === 'high')).toBe(true)
    expect(report.findings.every((f) => f.quarantine === undefined)).toBe(true)
    expect(existsSync(path.join(root, '.wp2payload'))).toBe(false)
  })

  it('converts the excerpt to plain text and keeps already-plain title and SEO text as written (T2)', async () => {
    const { ctx } = context()
    const out = await transformDocument(
      doc('<p>x</p>', {
        // Extractors decode titles and SEO fields: what arrives is text, so `&lt;b&gt;` is literal.
        title: 'Use &lt;b&gt; tags  today',
        excerpt: 'Short   summary',
        seo: { title: 'SEO[31m', description: 'A &lt;b&gt;', canonical: `${SITE}/hello/` },
      }),
      ctx,
    )
    expect(out.title).toBe('Use &lt;b&gt; tags today')
    expect(out.excerpt).toBe('Short summary')
    expect(out.seo).toMatchObject({ title: 'SEO[31m', description: 'A &lt;b&gt;', canonical: `${SITE}/hello/` })
  })

  it('sanitizes custom transformer output and reports unknown blocks', async () => {
    const { ctx, report } = context({
      transformers: [{ name: 'callout', match: (b) => b.name === 'acme/callout', toHtml: (b) => `<blockquote onclick="x()">${b.innerHTML}</blockquote>` }],
    })
    const out = await transformDocument(
      doc('<!-- wp:acme/callout --><p>Note</p><!-- /wp:acme/callout --><!-- wp:acme/hero --><p>Hero</p><!-- /wp:acme/hero -->'),
      ctx,
    )
    expect(JSON.stringify(out.content)).not.toContain('onclick')
    expect(nodes(out.content).some((n) => n.type === 'quote')).toBe(true)
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_BLOCK', doc: 'post:981', detail: expect.stringContaining('acme/hero') }))
    expect(JSON.stringify(out.content)).toContain('Hero')
  })

  it('handles classic-editor content without block comments', async () => {
    const { ctx, report } = context()
    const out = await transformDocument(doc('First line\n\nSecond <em>para</em>'), ctx)
    expect(nodes(out.content).filter((n) => n.type === 'paragraph')).toHaveLength(2)
    expect(report.warnings).toEqual([])
  })

  it('reports every finding and warning with the document reference', async () => {
    const { ctx, report } = context()
    await transformDocument(doc(POST + '<!-- wp:acme/x --><p>x</p><!-- /wp:acme/x -->'), ctx)
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.warnings.length).toBeGreaterThan(0)
    expect([...report.findings, ...report.warnings].every((x) => x.doc === 'post:981')).toBe(true)
  })

  // Review S04-01 / F1: hidden wrappers are found on the raw post, before the normaliser drops them.
  it.each([
    ['a hidden paragraph block', '<!-- wp:paragraph --><p style="display:none"><a href="https://casino.example/">cheap</a></p><!-- /wp:paragraph -->'],
    ['a hidden group around blocks', '<!-- wp:group --><div class="wp-block-group" style="display:none"><!-- wp:paragraph --><p><a href="https://casino.example/">cheap</a></p><!-- /wp:paragraph --></div><!-- /wp:group -->'],
    ['a wrapper spanning blocks', '<!-- wp:html --><div style="display:none"><!-- /wp:html --><!-- wp:paragraph --><p><a href="https://casino.example/">cheap</a></p><!-- /wp:paragraph --><!-- wp:html --></div><!-- /wp:html -->'],
    ['a stylesheet rule in another block', '<!-- wp:html --><style>.spm{display:none}</style><!-- /wp:html --><!-- wp:html --><div class="spm"><a href="https://casino.example/">cheap</a></div><!-- /wp:html -->'],
  ])('removes hidden link farms in %s', async (_name, html) => {
    const { ctx, report } = context()
    const out = await transformDocument(doc(html + '<!-- wp:paragraph --><p>Real text</p><!-- /wp:paragraph -->'), ctx)
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'SEC_HIDDEN_LINKS', severity: 'high' }))
    expect(JSON.stringify(out.content)).not.toContain('casino.example')
    expect(JSON.stringify(out.content)).toContain('Real text')
  })

  it('checks spam keywords once per document, not per block', async () => {
    const { ctx, report } = context()
    const p = '<!-- wp:paragraph --><p><a href="https://casino.example/">casino</a></p><!-- /wp:paragraph -->'
    await transformDocument(doc(p + p + p), ctx)
    expect(report.findings.filter((f) => f.code === 'SEC_SPAM_KEYWORDS')).toHaveLength(1)
  })

  it('aggregates dynamic blocks into one warning and flags reusable blocks', async () => {
    const { ctx, report } = context()
    await transformDocument(
      doc('<!-- wp:search /--><!-- wp:search /--><!-- wp:latest-posts /--><!-- wp:block {"ref":12} /--><!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->'),
      ctx,
    )
    const codes = report.warnings.map((w) => w.code)
    expect(codes.filter((c) => c === 'DYNAMIC_BLOCK_SKIPPED')).toHaveLength(1)
    expect(report.warnings.find((w) => w.code === 'DYNAMIC_BLOCK_SKIPPED')!.detail).toContain('core/search x2')
    expect(codes).toContain('REUSABLE_BLOCK_SKIPPED')
    expect(codes).not.toContain('UNKNOWN_BLOCK')
  })

  it('warns when a block had content but nothing safe remained', async () => {
    const { ctx, report } = context()
    await transformDocument(doc('<!-- wp:html --><textarea>Form text</textarea><!-- /wp:html -->'), ctx)
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'CONTENT_DROPPED', detail: expect.stringContaining('core/html') }))
  })

  it('reuses quarantine files across runs instead of piling up copies', async () => {
    const first = context()
    await transformDocument(doc(POST), first.ctx)
    const second = context()
    await transformDocument(doc(POST), second.ctx)
    const q = (r: MemoryReport) => r.findings.map((f) => f.quarantine).filter(Boolean)
    expect(q(second.report)).toEqual(q(first.report))
  })

  it('drops a non-http canonical URL', async () => {
    const { ctx, report } = context()
    const out = await transformDocument(doc('<p>x</p>', { seo: { canonical: 'javascript:alert(1)' } }), ctx)
    expect(out.seo?.canonical).toBeUndefined()
    expect(report.warnings).toContainEqual(expect.objectContaining({ code: 'SEO_CANONICAL_INVALID' }))
  })

  // Security re-review R-03: a long post type must not cut the hash and make findings share a file.
  it('keeps one quarantine file per fragment even with a very long post type', async () => {
    const { ctx, report } = context()
    const html = '<script>benign()</script><div hidden><a href="https://casino.example/">casino</a></div><meta http-equiv="refresh" content="0;url=https://evil.example/">'
    await transformDocument(doc(html, { type: 'x'.repeat(99) }), ctx)
    const files = report.findings.map((f) => f.quarantine).filter(Boolean)
    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(new Set(files).size).toBe(files.length)
    for (const f of report.findings.filter((x) => x.quarantine)) {
      const saved = readFileSync(path.join(root, '.wp2payload', 'quarantine', f.quarantine!), 'utf8')
      expect(saved.length).toBeGreaterThan(0)
    }
  })

  it('writes the configured rel on external links by default', async () => {
    const { ctx } = context()
    const out = await transformDocument(doc('<p><a href="https://example.org/">friend</a></p>'), ctx)
    expect(nodes(out.content).find((n) => n.type === 'link')?.fields.rel).toBe('nofollow noopener')
  })
})
