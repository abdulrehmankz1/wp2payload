import { isText, type AnyNode } from 'domhandler'
import fc from 'fast-check'
import { parseDocument } from 'htmlparser2'
import { describe, expect, it } from 'vitest'
import type { IRDocument } from '../../src/ir/types.js'
import { MemoryReport } from '../../src/report/types.js'
import {
  ALLOWED_ATTRIBUTES,
  ALLOWED_TAGS,
  EMBED_ATTR,
  EMBED_TAG,
  normalisePlain,
  sanitizeContent,
  scanDocument,
  toPlainText,
} from '../../src/security/content/index.js'
import { transformDocument, type TransformContext } from '../../src/transform/index.js'
import { htmlToLexical } from '../../src/transform/lexical/index.js'
import type { SanitizeOptions } from '../../src/transform/types.js'
import {
  INVISIBLE_OR_CONTROL,
  anyCase,
  elements,
  fuzzParams,
  fuzzTimeout,
  hostileHtml,
  hostileUrl,
  isBrowserDangerousUrl,
  isDangerousUrl,
  noise,
  violations,
} from './fuzz-support.js'

// Doc 12.14: for any generated input, sanitizer output never contains <script, on*= attributes,
// javascript: or data: URLs. Seed and run count: see fuzz-support.ts (FUZZ_RUNS, FUZZ_SEED, FUZZ_PATH).

const OPTS: SanitizeOptions = {
  doc: 'post:1',
  siteOrigin: 'https://oldsite.example',
  embedHosts: ['www.youtube.com', 'player.vimeo.com'],
  externalLinkRel: 'nofollow noopener',
}

const TAGS = new Set([...ALLOWED_TAGS, EMBED_TAG])
const ATTRS = (tag: string): ReadonlySet<string> =>
  new Set(tag === 'a' ? [...ALLOWED_ATTRIBUTES.a!, 'rel'] : tag === EMBED_TAG ? [EMBED_ATTR] : (ALLOWED_ATTRIBUTES[tag] ?? []))
const POLICY = { tags: TAGS, attrs: ATTRS }

/** What a reader gets from sanitized HTML: its text, and every link, image and embed with its attributes. */
function content(html: string): { text: string; refs: string[] } {
  const els = elements(html)
  const refs = els
    .filter((e) => e.name === 'a' || e.name === 'img' || e.name === EMBED_TAG)
    .map((e) => `${e.name} ${JSON.stringify(Object.entries(e.attribs).sort())}`)
    .sort()
  const text = toPlainTextRaw(html)
  return { text, refs }
}

/** Text nodes only, whitespace collapsed (no entity decoding beyond the parser's single pass). */
function toPlainTextRaw(html: string): string {
  let out = ''
  const stack: AnyNode[] = [parseDocument(html)]
  while (stack.length) {
    const n = stack.pop()!
    if (isText(n)) out += n.data + ' '
    if ('children' in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!)
  }
  return out.replace(/\s+/g, ' ').trim()
}

const show = (v: unknown) => JSON.stringify(v)

describe('fuzz: sanitizeContent (doc 12.4, 12.14)', () => {
  it('never throws and never emits <script, on* attributes, dangerous URLs or anything off the allowlist', () => {
    fc.assert(
      fc.property(hostileHtml, (html) => {
        const out = sanitizeContent(html, OPTS).html
        const bad = violations(out, POLICY)
        if (bad.length) throw new Error(`unsafe output ${show(out)}: ${show(bad)}`)
        // A placeholder survives only as an allowed https embed URL.
        for (const el of elements(out).filter((e) => e.name === EMBED_TAG)) {
          const url = new URL(el.attribs[EMBED_ATTR] ?? '')
          expect(url.protocol).toBe('https:')
          expect(OPTS.embedHosts).toContain(url.host)
        }
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())

  // Byte-for-byte idempotence does not hold and is not a design goal (only the embed placeholder
  // is documented as idempotent): an unwrapped disallowed element can leave block markup nested
  // where the next parse closes it, e.g. `<p><x><h1>a</h1></x>` -> `<p><h1>a</h1></p>` ->
  // `<p></p><h1>a</h1><p></p>`. The invariant that matters: a second pass keeps the same text,
  // links, images and embeds.
  it('is stable: sanitizing its own output keeps the same text, links, images and embeds', () => {
    fc.assert(
      fc.property(hostileHtml, (html) => {
        const once = sanitizeContent(html, OPTS).html
        const twice = sanitizeContent(once, OPTS).html
        expect(content(twice)).toEqual(content(once))
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())

  // Found by this suite: the pre-scan skips raw-text elements, so their text must go with them.
  it('drops text inside <noembed>/<noframes>/<title> with the element', () => {
    for (const tag of ['noembed', 'noframes', 'title']) {
      const r = sanitizeContent(`<${tag}>eval(atob("YWxlcnQoMSk="))</${tag}>`, OPTS)
      expect(r.html).not.toContain('eval(atob(')
    }
  })

  it('scanDocument never throws, and the pipeline order (scan, then sanitize) stays safe', () => {
    fc.assert(
      fc.property(hostileHtml, (html) => {
        const scanned = scanDocument(html, OPTS).html
        const bad = violations(sanitizeContent(scanned, OPTS).html, POLICY)
        if (bad.length) throw new Error(`unsafe output for ${show(html)}: ${show(bad)}`)
      }),
      fuzzParams(0.5),
    )
  }, fuzzTimeout(0.5))
})

// ---------------------------------------------------------------------------------------------

const LEXICAL = {
  mediaCollection: 'media',
  blocks: { embed: 'embed', wpRawHtml: 'wpRawHtml' },
  resolver: {
    media: (url: string) => (url.endsWith('/photo.jpg') ? 7 : undefined),
    doc: (url: string) => (url === 'https://oldsite.example/other/' ? { relationTo: 'posts', value: 12 } : undefined),
  },
}

/** Every URL-ish string and every raw-HTML string in a Lexical state, with its key path. */
function lexicalProblems(state: unknown, dangerous: (url: string) => boolean = isDangerousUrl): string[] {
  const problems: string[] = []
  const stack: [unknown, string][] = [[state, '']]
  while (stack.length) {
    const [v, at] = stack.pop()!
    if (Array.isArray(v)) v.forEach((c, i) => stack.push([c, `${at}[${i}]`]))
    else if (v && typeof v === 'object') {
      for (const [k, c] of Object.entries(v)) {
        if (typeof c === 'string') {
          if (/^(?:url|href|src|link)$/i.test(k) && dangerous(c)) problems.push(`${at}.${k}=${show(c)}`)
          if (k === 'html') for (const bad of violations(c)) problems.push(`${at}.html: ${show(bad)}`)
        } else stack.push([c, `${at}.${k}`])
      }
    }
  }
  return problems
}

const BLOCK_NAMES = ['paragraph', 'html', 'heading', 'image', 'embed', 'core-embed/youtube', 'button', 'buttons', 'group', 'block', 'shortcode', 'list', 'table', 'cover', 'acme/thing', 'latest-posts', 'freeform']
const blockAttrs = fc.oneof(
  fc.constant(''),
  fc.constantFrom(
    ' {"url":"javascript:alert(1)"}', ' {"ref":1}', ' {"id":7}', ' {"url":"https://www.youtube.com/watch?v=x","providerNameSlug":"youtube"}',
    ' {"href":"data:text/html,x"}', ' {"content":"\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"}', ' {"text":"<img src=x onerror=alert(1)>"}',
    ' {bad json', ' {"url":"jav\\tascript:alert(1)","linkTarget":"_blank"}', ' {"level":99}',
  ),
  fc.record({ url: hostileUrl, href: hostileUrl, content: hostileHtml }, { requiredKeys: [] }).map((o) => ` ${JSON.stringify(o)}`),
)
const block = fc.tuple(fc.constantFrom(...BLOCK_NAMES), blockAttrs, hostileHtml, fc.constantFrom('pair', 'pair', 'self', 'bare')).map(([name, attrs, inner, shape]) =>
  shape === 'self' ? `<!-- wp:${name}${attrs} /-->` : shape === 'bare' ? inner : `<!-- wp:${name}${attrs} -->${inner}<!-- /wp:${name} -->`,
)
const post = fc.array(block, { maxLength: 5 }).map((b) => b.join('\n'))

function context(report: MemoryReport): TransformContext {
  return {
    siteOrigin: OPTS.siteOrigin,
    embedHosts: OPTS.embedHosts,
    externalLinkRel: OPTS.externalLinkRel,
    transformers: [],
    lexical: LEXICAL,
    report,
    root: '.', // dryRun: nothing is written
    dryRun: true,
  }
}

const irDoc = (html: string, title: string, excerpt: string): IRDocument => ({
  wpId: 1, type: 'post', status: 'publish', slug: 'x', title, excerpt, html, link: 'https://oldsite.example/x/',
  publishedAt: '2024-01-01T00:00:00Z', modifiedAt: '2024-01-01T00:00:00Z', termWpIds: [], meta: {},
})

describe('fuzz: transformDocument to Lexical (doc 2.3)', () => {
  it('never throws and never yields a dangerous link URL or unsafe raw HTML', async () => {
    await fc.assert(
      fc.asyncProperty(post, noise(), noise(), async (html, title, excerpt) => {
        const out = await transformDocument(irDoc(html, title, excerpt), context(new MemoryReport()))
        const problems = lexicalProblems(out.content)
        if (problems.length) throw new Error(`unsafe Lexical for ${show(html)}: ${problems.join('; ')}`)
        for (const t of [out.title, out.excerpt ?? '']) {
          expect(t).not.toMatch(INVISIBLE_OR_CONTROL)
          expect(t).toBe(t.trim())
        }
      }),
      fuzzParams(0.5),
    )
  }, fuzzTimeout(0.5))

  // The converter's own scheme check strips only C0 and space, so here the check is browser-exact
  // (isBrowserDangerousUrl): `java<U+00AD>script:` is a relative URL to a browser and is let
  // through by the converter. The full pipeline above uses the stricter project-wide check.
  it('htmlToLexical alone (defence in depth, unsanitized input) never throws or links a dangerous URL', () => {
    fc.assert(
      fc.property(hostileHtml, (html) => {
        const { state } = htmlToLexical(html, { ...LEXICAL, externalLinkRel: OPTS.externalLinkRel, doc: 'post:1' })
        const problems = lexicalProblems(state, isBrowserDangerousUrl).filter((p) => !p.includes('.html:'))
        if (problems.length) throw new Error(`dangerous URL for ${show(html)}: ${problems.join('; ')}`)
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())
})

// ---------------------------------------------------------------------------------------------

/** What every plain-text field promises (doc 12.4, T2): no controls or invisibles, single spaces, trimmed. */
function expectPlain(s: string) {
  expect(s).not.toMatch(INVISIBLE_OR_CONTROL)
  expect(s).not.toMatch(/\s\s|[^\S ]/) // whitespace is single plain spaces only
  expect(s).toBe(s.trim())
}

const plainInput = fc.oneof(hostileHtml, noise(48))

describe('fuzz: plain text (src/security/content/text.ts)', () => {
  it('normalisePlain never throws, yields clean text and is idempotent', () => {
    fc.assert(
      fc.property(plainInput, (s) => {
        const once = normalisePlain(s)
        expectPlain(once)
        expect(normalisePlain(once)).toBe(once)
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())

  it('toPlainText never throws and yields clean text that normalisePlain leaves alone', () => {
    // Not idempotent by design: it decodes references once, so `&amp;lt;` -> `&lt;` -> `<`.
    fc.assert(
      fc.property(plainInput, (s) => {
        const out = toPlainText(s)
        expectPlain(out)
        expect(normalisePlain(out)).toBe(out)
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())

  it('toPlainText never surfaces the content of a closed <script> or <style> in otherwise plain text', () => {
    const MARK = 'QZXSECRETQZX'
    const plain = noise(24).filter((s) => !/[<&]/.test(s) && !s.includes(MARK))
    fc.assert(
      fc.property(plain, fc.constantFrom('script', 'style').chain(anyCase), plain, (pre, tag, post) => {
        expect(toPlainText(`${pre}<${tag}>${MARK}</${tag}>${post}`)).not.toContain(MARK)
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())
})
