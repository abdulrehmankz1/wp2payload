import { readdirSync, readFileSync } from 'node:fs'
import { isTag, type AnyNode } from 'domhandler'
import { parseDocument } from 'htmlparser2'
import { describe, expect, it } from 'vitest'
import type { SecurityFinding } from '../../src/report/types.js'
import {
  ALLOWED_ATTRIBUTES,
  ALLOWED_TAGS,
  countExternalLinks,
  embedPlaceholder,
  linkHeavyFinding,
  sanitizeContent,
  scanDocument,
  spamFinding,
  toPlainText,
} from '../../src/security/content/index.js'
import { MAX_NESTING, markupCost } from '../../src/security/content/depth.js'
import type { SanitizeOptions } from '../../src/transform/types.js'

// Spec 04 slice B: AC-B1..AC-B6. Fixtures from tests/fixtures/hacked-content/generate.mjs.

const DIR = new URL('../fixtures/hacked-content/', import.meta.url)
const fixture = (name: string) => readFileSync(new URL(`${name}.html`, DIR), 'utf8')

const OPTS: SanitizeOptions = {
  doc: 'post:981',
  siteOrigin: 'https://oldsite.example',
  embedHosts: ['www.youtube.com', 'player.vimeo.com'],
  externalLinkRel: 'nofollow noopener',
}
const run = (html: string, opts: Partial<SanitizeOptions> = {}) => sanitizeContent(html, { ...OPTS, ...opts })

type Expect = [SecurityFinding['code'], SecurityFinding['severity'], SecurityFinding['action']]
const SCRIPT: Expect = ['SEC_SCRIPT_TAG', 'high', 'quarantined']
const HANDLER: Expect = ['SEC_EVENT_HANDLER', 'high', 'removed']
const URL_: Expect = ['SEC_DANGEROUS_URL', 'high', 'removed']
const HIDDEN: Expect = ['SEC_HIDDEN_LINKS', 'high', 'quarantined']
const IFRAME: Expect = ['SEC_IFRAME_UNKNOWN_HOST', 'medium', 'quarantined']
const OBF: Expect = ['SEC_OBFUSCATED', 'medium', 'quarantined']
const FORGED: Expect = ['SEC_FORGED_EMBED', 'medium', 'quarantined']

/** Every fixture and the exact findings it must produce, in order. */
const EXPECTED: Record<string, Expect[]> = {
  'script': [SCRIPT],
  'script-src': [SCRIPT],
  'handlers': [HANDLER, HANDLER, HANDLER],
  'js-url': Array.from({ length: 8 }, () => URL_),
  'data-url': [URL_, URL_],
  'vbscript-url': [URL_, URL_],
  'meta-refresh': [['SEC_META_REFRESH', 'high', 'quarantined']],
  'js-redirect': [['SEC_JS_REDIRECT', 'high', 'quarantined']],
  'handler-redirect': [['SEC_JS_REDIRECT', 'high', 'removed']],
  'hidden-display': [HIDDEN],
  'hidden-visibility': [HIDDEN],
  'hidden-font-size': [HIDDEN],
  'hidden-left': [HIDDEN],
  'hidden-text-indent': [HIDDEN],
  'hidden-height': [HIDDEN],
  'hidden-attribute': [HIDDEN],
  'hidden-obfuscated-css': [HIDDEN, HIDDEN],
  'hidden-stylesheet': [HIDDEN],
  'hidden-link-itself': [HIDDEN],
  'hidden-noscript': [HIDDEN],
  'hidden-template': [HIDDEN],
  'hidden-clip': [HIDDEN, HIDDEN],
  'hidden-1px': [HIDDEN, HIDDEN],
  'hidden-scale': [HIDDEN],
  'hidden-offsets': [HIDDEN, HIDDEN, HIDDEN],
  'hidden-colour': [HIDDEN],
  'hidden-nested': [HIDDEN],
  'hidden-text': [['SEC_HIDDEN_TEXT', 'low', 'flagged']],
  'splice-join': [SCRIPT],
  'splice-chain': [SCRIPT, ['SEC_SPAM_KEYWORDS', 'low', 'flagged']],
  'eval-prose': [],
  'iframe-youtube': [],
  'iframe-vimeo': [],
  'iframe-unknown': [IFRAME],
  'iframe-http-youtube': [IFRAME],
  'iframe-lookalike': [IFRAME, IFRAME, IFRAME, IFRAME, IFRAME],
  'forged-embed': [FORGED, FORGED, FORGED],
  'base64': [OBF, OBF, OBF],
  'link-heavy': [],
  'spam-keywords': [['SEC_SPAM_KEYWORDS', 'low', 'flagged']],
  'mxss-svg-style': [HANDLER],
  'mxss-noscript': [],
  'mxss-math': [],
  'mxss-comments': [SCRIPT, SCRIPT],
  'mxss-form-math': [],
  'svg-xlink': [URL_],
  'svg-animate': [URL_],
  'img-title-breakout': [],
  'textarea-script': [],
  'style-attribute': [],
  'protocol-relative': [],
  'clean': [],
}

/** No executable vector survives: string checks from the brief plus a structural allowlist walk. */
function assertInert(html: string): void {
  expect(html).not.toMatch(/<script/i)
  expect(html).not.toMatch(/\son\w+\s*=/i)
  expect(html).not.toMatch(/javascript:|vbscript:/i)
  expect(html).not.toMatch(/style=/i)
  expect(html).not.toMatch(/(?:href|src)="\s*(?:data:|\/\/)/i)
  const allowedTags = new Set([...ALLOWED_TAGS, 'wp2p-embed'])
  const stack: AnyNode[] = [parseDocument(html)]
  while (stack.length) {
    const n = stack.pop()!
    if (isTag(n)) {
      expect(allowedTags.has(n.name), `tag <${n.name}>`).toBe(true)
      const ok = n.name === 'wp2p-embed' ? ['data-url'] : n.name === 'a' ? ['href', 'title', 'rel'] : (ALLOWED_ATTRIBUTES[n.name] ?? [])
      for (const a of Object.keys(n.attribs)) expect(ok, `attribute ${a} on <${n.name}>`).toContain(a)
      if (n.name === 'wp2p-embed') {
        expect(n.children).toHaveLength(0)
        expect(n.attribs['data-url']).toMatch(/^https:\/\/(www\.youtube\.com|player\.vimeo\.com)\//)
      }
    }
    if ('children' in n) stack.push(...n.children)
  }
}

describe('hacked-content fixtures (AC-B1)', () => {
  it('every generated fixture has an expectation, and the reverse', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5)).sort()
    expect(files).toEqual(Object.keys(EXPECTED).sort())
  })

  it('samples are inert: scripts only alert(1), redirects only to evil.example', () => {
    for (const name of [...Object.keys(EXPECTED), ...Object.keys(DOCUMENTS).map((d) => `documents/${d}`)]) {
      const s = fixture(name)
      for (const m of s.matchAll(/<script>(.*?)<\/script>/g)) expect(m[1]).toMatch(/^(x|alert\(\d\)|window\.location = "https:\/\/evil\.example\/")?$/)
      for (const m of s.matchAll(/https?:\/\/(?:[^@/\s"]*@)?([a-z0-9.-]+)/gi)) expect(m[1]).toMatch(/(\.example|^example|\.test|youtube\.com|vimeo\.com|rhs\.org\.uk|example\.org)$/)
    }
  })
})

describe('sanitizeContent over every fixture (AC-B2, AC-B4, AC-B6)', () => {
  it.each(Object.entries(EXPECTED))('%s', (name, expected) => {
    const r = run(fixture(name))
    assertInert(r.html)
    expect(r.findings.map((f) => [f.code, f.severity, f.action])).toEqual(expected)
    for (const f of r.findings) {
      expect(f.doc).toBe('post:981')
      expect(f.detail).toBeTruthy()
    }
    // Every quarantined finding comes with its fragment; nothing else does.
    expect(r.quarantine.map((q) => q.finding)).toEqual(r.findings.filter((f) => f.action === 'quarantined'))
    for (const q of r.quarantine) expect(q.html.length).toBeGreaterThan(0)

    // AC-B6: idempotent. Only low flags describing kept content repeat; nothing new appears.
    const again = run(r.html)
    expect(again.html).toBe(r.html)
    const flagged = r.findings.filter((f) => f.action === 'flagged')
    for (const f of again.findings) expect(flagged).toContainEqual(f)
  })
})

describe('allowlist and links (AC-B2)', () => {
  it('a clean post keeps its meaning: allowlisted structure intact, presentation attributes dropped', () => {
    const r = run(fixture('clean'))
    expect(r.findings).toEqual([])
    expect(r.html).toBe(
      [
        '<h2>Planting a spring garden</h2>',
        '<p>Start with <strong>good soil</strong> and <em>patience</em>. See our <a href="https://oldsite.example/soil-guide/">soil guide</a> and the <a href="https://www.rhs.org.uk/advice" rel="nofollow noopener">RHS advice pages</a>.</p>',
        '<figure><img src="https://oldsite.example/wp-content/uploads/2024/03/beds-1024x683.jpg" alt="Raised beds" width="1024" height="683" /><figcaption>Raised beds in March</figcaption></figure>',
        '<ul><li>Peas</li><li>Lettuce<ul><li>Butterhead</li></ul></li></ul>',
        '<blockquote><p>The best time to plant a tree was twenty years ago.</p></blockquote>',
        '<p>Mail <a href="mailto:hello@oldsite.example">hello@oldsite.example</a> or call <a href="tel:+441234567890">01234 567890</a>.</p>',
        '<table><thead><tr><th>Crop</th><th>Sow</th></tr></thead><tbody><tr><td>Peas</td><td colspan="2">March</td></tr></tbody></table>',
        '<pre><code>&lt;script&gt;not code, just text&lt;/script&gt; &amp; eval(x)</code></pre>',
        '<hr />',
        '<p>H<sub>2</sub>O and E = mc<sup>2</sup>. Fish &amp; chips.<br />New line.</p>',
        '',
      ].join('\n'),
    )
  })

  it('rel is set only on external links, replaces any input rel, and treats www as the same site', () => {
    const r = run(
      '<a href="https://www.oldsite.example/a" rel="me">in</a><a href="/b" rel="nofollow">rel</a>' +
        '<a href="https://other.example/" rel="author">out</a><a href="mailto:x@y.example">m</a>',
    )
    expect(r.html).toBe(
      '<a href="https://www.oldsite.example/a">in</a><a href="/b">rel</a>' +
        '<a href="https://other.example/" rel="nofollow noopener">out</a><a href="mailto:x@y.example">m</a>',
    )
    expect(run('<a href="https://x.example/">x</a>', { externalLinkRel: 'nofollow' }).html).toContain('rel="nofollow"')
  })

  it('removes protocol-relative and non-allowlisted schemes, keeps the link text', () => {
    expect(run(fixture('protocol-relative')).html).toBe('<a>protocol relative</a>\n')
    expect(run('<a href="ftp://x.example/">f</a><img src="file:///etc/passwd" alt="p">').html).toBe('<a>f</a><img alt="p" />')
    for (const href of ['&#106avascript:alert(1)', 'java\u0000script:alert(1)', ' javascript:alert(1)', 'java&NewLine;script:x', '&#0000106;avascript:x']) {
      const r = run(`<a href="${href}">x</a>`)
      expect(r.html, href).toBe('<a>x</a>')
      expect(r.findings.map((f) => f.code), href).toEqual(['SEC_DANGEROUS_URL'])
    }
  })

  it('drops disallowed tags but keeps their text; drops style and every on* attribute', () => {
    expect(run('<div class="x"><span style="color:red" onmouseenter="x()">Hi</span></div>').html).toBe('Hi')
    expect(run('<p ONCLICK="x()" onfoo="y">t</p>').findings.map((f) => f.code)).toEqual(['SEC_EVENT_HANDLER', 'SEC_EVENT_HANDLER'])
  })

  it('a hidden element without links is not a link farm: kept, style dropped, flagged low once', () => {
    const r = run('<p style="display:none">Note <span hidden>more</span></p>')
    expect(r.html).toBe('<p>Note more</p>')
    expect(r.findings).toEqual([
      { code: 'SEC_HIDDEN_TEXT', severity: 'low', action: 'flagged', doc: 'post:981', detail: '9 chars of text in hidden <p> (display:none), kept' },
    ])
    // No text, no flag: the usual lazy-load <noscript><img> fallback.
    expect(run('<noscript><img src="/a.jpg" alt=""></noscript>').findings).toEqual([])
  })

  it('quarantine carries the original fragment as text', () => {
    const r = run(fixture('hidden-display'))
    expect(r.quarantine[0]?.html).toMatch(/^<div style="display:none"><a href="https:\/\/spam0\.example\/">casino 0<\/a>.*<\/div>$/)
    expect(r.quarantine[0]?.finding.detail).toBe('3 links in hidden <div> (display:none)')
    expect(run(fixture('script')).quarantine[0]?.html).toBe('<script>alert(1)</script>')
  })

  it('handles deep nesting without recursion, and refuses hostile depth unparsed', () => {
    const nest = (n: number) => '<div>'.repeat(n) + '<a href="https://x.example/" style="display:none">x</a>' + '</div>'.repeat(n)
    const r = run(nest(1000))
    expect(r.findings.map((f) => f.code)).toEqual(['SEC_HIDDEN_LINKS'])
    expect(r.html).toBe('')
    // The parsers' stacks grow quadratically with depth: past the limit nothing is parsed.
    const t = performance.now()
    for (const res of [run(nest(200_000)), scanDocument(nest(200_000), OPTS)]) {
      expect(res.html).toBe('')
      expect(res.findings.map((f) => [f.code, f.severity, f.action])).toEqual([['SEC_NESTING_LIMIT', 'high', 'quarantined']])
      expect(res.quarantine).toHaveLength(1)
    }
    expect(toPlainText('<b>'.repeat(200_000) + 'Title')).toBe('Title')
    expect(performance.now() - t).toBeLessThan(3000)
    // Flat markup at any size is not "deep": 5000 paragraphs, list items and images.
    expect(run('<p>x<p>y</p><ul><li>a<li>b</ul><img src="/a.jpg" alt=""><table><tr><td>1<td>2<tr><td>3</table>'.repeat(5000)).findings).toEqual([])
    // Unclosed <p> inside <li> really nests in htmlparser2 (implied close checks the stack top only).
    expect(markupCost('<p>x<li>y'.repeat(5000)).depth).toBe(10_000)
  })

  it('implied end tags do not let a removal cut into a sibling (text on both sides survives)', () => {
    const r = run('<p>keep<div style="display:none"><a href="https://s.example/">s</a></div>also')
    // Splicing re-joins the text into the open <p>: structure may shift, content does not.
    // The space is the anti-join separator left by a cut that follows text.
    expect(r.html).toBe('<p>keep also</p>')
  })
})

describe('pre-scan cuts never build markup; the pass cap fails closed (S04-02)', () => {
  it('a cut does not glue `<` and `b>` into a new tag', () => {
    const r = run(fixture('splice-join'))
    expect(r.html).toBe('<p>a&lt; b&gt;c</p>\n')
    expect(scanDocument('<p>a<<script>x</script>b>c</p>', OPTS).html).toBe('<p>a< b>c</p>')
  })

  it('a chain of cuts does not assemble hidden markup; what survives is visible and flagged', () => {
    const r = run(fixture('splice-chain'))
    expect(r.html).not.toMatch(/<(meta|script|div)/)
    expect(r.html).toContain('casino</a>')
    expect(r.findings.map((f) => f.code)).toEqual(['SEC_SCRIPT_TAG', 'SEC_SPAM_KEYWORDS'])
  })

  it('a separator is only added after text, so tag-adjacent cuts stay byte-exact', () => {
    expect(scanDocument('<p>a</p><script>x</script><p>b</p>', OPTS).html).toBe('<p>a</p><p>b</p>')
    expect(scanDocument('x <script>y</script>z', OPTS).html).toBe('x z')
  })

  it('input still changing at the pass cap is dropped whole and quarantined', () => {
    const html = '<p>ok</p><script>x</script>'
    for (const r of [sanitizeContent(html, OPTS, { maxPasses: 1 }), scanDocument(html, OPTS, { maxPasses: 1 })]) {
      expect(r.html).toBe('')
      expect(r.findings.map((f) => [f.code, f.severity, f.action])).toEqual([SCRIPT, ['SEC_SCAN_UNSTABLE', 'high', 'quarantined']])
      expect(r.quarantine.at(-1)?.html).toBe(html)
    }
    // Two passes are enough for it: one cut, one confirming scan.
    expect(sanitizeContent(html, OPTS, { maxPasses: 2 }).html).toBe('<p>ok</p>')
  })
})

/** Raw posts for scanDocument: findings, and what must be gone. */
const DOCUMENTS: Record<string, { findings: Expect[]; gone: RegExp[] }> = {
  'wrapper-across-blocks': { findings: [HIDDEN], gone: [/spam\.test/, /display:none/] },
  'hidden-paragraph': { findings: [HIDDEN], gone: [/casino/] },
  'hidden-group': { findings: [HIDDEN], gone: [/casino/, /wp-block-group/, /wp:image/] },
  'stylesheet-other-block': { findings: [HIDDEN], gone: [/casino/] },
  'script-in-group': { findings: [SCRIPT], gone: [/<script/] },
  'clean': { findings: [], gone: [] },
}

/** Every non-self-closing block delimiter has its partner, in order. */
function delimitersPair(html: string): boolean {
  const open: string[] = []
  for (const m of html.matchAll(/<!--\s*(\/)?wp:([a-z][a-z0-9_/-]*)[^]*?(\/)?-->/g)) {
    if (m[3]) continue
    if (!m[1]) open.push(m[2]!)
    else if (open.pop() !== m[2]) return false
  }
  return open.length === 0
}

describe('scanDocument over raw posts (S04-01, S04-06a, S04-07, F1)', () => {
  it('every document fixture has an expectation', () => {
    const files = readdirSync(new URL('documents/', DIR)).map((f) => f.slice(0, -5)).sort()
    expect(files).toEqual(Object.keys(DOCUMENTS).sort())
  })

  it.each(Object.entries(DOCUMENTS))('%s', (name, { findings, gone }) => {
    const src = fixture(`documents/${name}`)
    const r = scanDocument(src, OPTS)
    expect(r.findings.map((f) => [f.code, f.severity, f.action])).toEqual(findings)
    for (const re of gone) expect(r.html).not.toMatch(re)
    expect(delimitersPair(r.html)).toBe(true)
    expect(r.quarantine.map((q) => q.finding)).toEqual(r.findings)
    if (!findings.length) expect(r.html).toBe(src) // byte for byte, comments, iframes and attributes included
    // The per-block pass afterwards does not report the same thing again.
    const again = run(r.html)
    for (const f of again.findings) expect(findings.map((e) => e[0])).not.toContain(f.code)
    // And a second document scan finds nothing.
    expect(scanDocument(r.html, OPTS).findings).toEqual([])
  })

  it('keeps unpaired delimiters from inside a cut so the outside still pairs', () => {
    const r = scanDocument(fixture('documents/wrapper-across-blocks'), OPTS)
    expect(r.html).toContain('<!-- wp:html --><!-- /wp:html --><!-- wp:html --><!-- /wp:html -->')
    expect(r.html).toContain('<p>Intro</p>')
    expect(r.html).toContain('<p>Outro</p>')
  })

  it('flags hidden text once, cuts obfuscated text, leaves iframes and handlers to the block pass', () => {
    const r = scanDocument(`<div style="display:none"><p>FAQ answer</p></div><p>${'QUJD'.repeat(60)}</p><img src="x" onerror="alert(1)"><iframe src="https://evil.example/"></iframe>`, OPTS)
    expect(r.findings.map((f) => f.code)).toEqual(['SEC_OBFUSCATED', 'SEC_HIDDEN_TEXT'])
    expect(r.html).toBe('<div style="display:none"><p>FAQ answer</p></div><p></p><img src="x" onerror="alert(1)"><iframe src="https://evil.example/"></iframe>')
  })
})

describe('document-level low flags (spam option)', () => {
  it('spam: false leaves SEC_SPAM_KEYWORDS and SEC_HIDDEN_TEXT to the document pass', () => {
    const html = '<a href="https://x.example/">casino</a><div hidden>note</div>'
    expect(run(html).findings.map((f) => f.code)).toEqual(['SEC_HIDDEN_TEXT', 'SEC_SPAM_KEYWORDS'])
    expect(run(html, { spam: false }).findings).toEqual([])
    expect(run(html, { spam: false }).html).toBe('<a href="https://x.example/" rel="nofollow noopener">casino</a>note')
  })

  it('spamFinding checks joined sanitized HTML once', () => {
    expect(spamFinding('<p><a href="/a">Viagra</a></p><p><a href="/b">casino</a></p>', { doc: 'post:1' })).toEqual({
      code: 'SEC_SPAM_KEYWORDS', severity: 'low', action: 'flagged', doc: 'post:1',
      detail: '2 links with spam keywords in link text: casino, viagra',
    })
    expect(spamFinding('<p>casino</p>', { doc: 'post:1' })).toBeUndefined()
  })
})

describe('linear time on hostile input (S04-05)', () => {
  const timed = (fn: () => void) => {
    const t = performance.now()
    fn()
    return performance.now() - t
  }

  it('a 200 KB <style> without braces, or with unclosed comments, scans fast', () => {
    expect(timed(() => run(`<style>${'a'.repeat(200_000)}</style><p>x</p>`))).toBeLessThan(3000)
    expect(timed(() => run(`<style>${'/*'.repeat(100_000)}</style><p>x</p>`))).toBeLessThan(3000)
    expect(timed(() => run(`<style>${'.a{'.repeat(70_000)}</style><p>x</p>`))).toBeLessThan(3000)
    expect(timed(() => run(`<p style="left:${'1'.repeat(200_000)}x">x</p>`))).toBeLessThan(3000)
  })

  it('nested hidden containers are judged once, at the outermost', () => {
    const nested = (n: number) => '<div style="display:none">'.repeat(n) + 'text' + '</div>'.repeat(n)
    expect(timed(() => expect(run(nested(1000)).findings.map((f) => f.code)).toEqual(['SEC_HIDDEN_TEXT']))).toBeLessThan(3000)
    const farm = '<div style="display:none">'.repeat(1000) + '<a href="https://s.example/">s</a>' + '</div>'.repeat(1000)
    expect(timed(() => expect(scanDocument(farm, OPTS).findings.map((f) => f.detail)).toEqual(['1 link in hidden <div> (display:none)']))).toBeLessThan(3000)
    // 20k deep is past the nesting limit: refused in linear time.
    expect(timed(() => expect(run(nested(20_000)).findings.map((f) => f.code)).toEqual(['SEC_NESTING_LIMIT']))).toBeLessThan(3000)
  })

  it('stray end tags do not hide depth from the estimate (R-02)', () => {
    const html = '<div></x>'.repeat(40_000)
    expect(markupCost(html).depth).toBe(40_000) // the Parser ignores </x>: depth really is 40k
    for (const fn of [() => run(html), () => scanDocument(html, OPTS)]) {
      let codes: string[] = []
      expect(timed(() => { codes = fn().findings.map((f) => f.code) })).toBeLessThan(3000)
      expect(codes).toEqual(['SEC_NESTING_LIMIT'])
    }
    // Implied closes only happen at the top of the stack: <p><span> nests 2 per repeat.
    expect(markupCost('<p><span>'.repeat(3000)).depth).toBe(6000)
    expect(markupCost('<div><p>x</div>'.repeat(10)).depth).toBe(2)
  })

  it('a parse-work backstop refuses shallow-but-costly input (R-02)', () => {
    // 4000 deep (under the nesting limit) plus 60k stray end tags, each scanning the whole stack.
    const html = '<div>'.repeat(4000) + '</x>'.repeat(60_000)
    let codes: string[] = []
    expect(timed(() => { codes = run(html).findings.map((f) => f.code) })).toBeLessThan(3000)
    expect(codes).toEqual(['SEC_MARKUP_LIMIT'])
  })

  it('tags inside attribute values, comments and raw text do not count as nesting (A-02)', () => {
    const tags = '<div>'.repeat(5000)
    expect(run(`<p title="${tags}">hello</p>`).html).toBe('<p>hello</p>')
    expect(run(`<!-- ${tags} --><p>hello</p>`).html).toBe('<p>hello</p>')
    expect(run(`<textarea>${tags}</textarea><p>hello</p>`).html).toBe('<p>hello</p>')
    expect(toPlainText(`<b title="${tags}">Title</b>`)).toBe('Title')
  })

  it('nesting up to MAX_NESTING parses; one more is refused', () => {
    const nest = (n: number) => '<div>'.repeat(n) + '<p>x</p>' + '</div>'.repeat(n)
    expect(timed(() => expect(run(nest(MAX_NESTING - 1)).html).toBe('<p>x</p>'))).toBeLessThan(3000)
    expect(run(nest(MAX_NESTING)).findings.map((f) => f.code)).toEqual(['SEC_NESTING_LIMIT'])
  })

  it('100k siblings do not overflow argument spreading', () => {
    expect(run('<a href="https://x.example/">x</a>'.repeat(100_000)).html.length).toBeGreaterThan(0)
  })
})

describe('embeds (AC-B3)', () => {
  it('allowlisted https iframes become placeholders with a canonical URL', () => {
    expect(run(fixture('iframe-youtube')).html).toBe(
      '<p>Watch:</p><wp2p-embed data-url="https://www.youtube.com/embed/abc123?si=x&amp;t=1"></wp2p-embed>\n',
    )
    expect(run(fixture('iframe-vimeo')).html).toBe(`${embedPlaceholder('https://player.vimeo.com/video/123456')}\n`)
  })

  it('host match is exact and case-insensitive; https only', () => {
    expect(run('<iframe src="https://WWW.YouTube.com/embed/x"></iframe>').html).toBe(embedPlaceholder('https://www.youtube.com/embed/x'))
    expect(run('<iframe src="https://youtube.com/embed/x"></iframe>').findings[0]?.detail).toBe('<iframe> to youtube.com')
    expect(run(fixture('iframe-http-youtube')).findings[0]?.detail).toBe('<iframe> to http://www.youtube.com')
    expect(run('<iframe src="https://x.example/"></iframe>', { embedHosts: [] }).html).toBe('')
  })

  it('placeholders written by an attacker are removed unless in the exact sanitizer shape', () => {
    const r = run(fixture('forged-embed'))
    expect(r.html).not.toContain('wp2p-embed')
    // The sanitizer's own output shape is accepted, which keeps sanitizing idempotent.
    const own = embedPlaceholder('https://www.youtube.com/embed/x')
    expect(run(own).html).toBe(own)
    expect(run('<wp2p-embed data-url="https://www.youtube.com/embed/x" onload="x()" style="a">text</wp2p-embed>').html).toBe('')
  })
})

describe('signals (AC-B4)', () => {
  it('low findings never remove content', () => {
    const r = run(fixture('spam-keywords'))
    expect(r.html).toContain('best online casino')
    expect(r.html).toContain('cheap Viagra')
    expect(r.findings[0]?.detail).toBe('3 links with spam keywords in link text: casino, payday loan, viagra')
    expect(r.quarantine).toEqual([])
  })

  it('spam words outside link text, or inside words, are not flagged', () => {
    expect(run('<p>The casino closed.</p><a href="/x">Occasional notes</a>').findings).toEqual([])
  })

  it('hidden spam links are quarantined, not double-reported as spam keywords', () => {
    expect(run(fixture('hidden-display')).findings.map((f) => f.code)).toEqual(['SEC_HIDDEN_LINKS'])
  })

  it('link-heavy is judged by the caller from countExternalLinks and the site median', () => {
    const html = fixture('link-heavy')
    expect(countExternalLinks(html, OPTS.siteOrigin)).toBe(30)
    expect(countExternalLinks('<a href="https://www.oldsite.example/">a</a><a href="/b">b</a>', OPTS.siteOrigin)).toBe(0)
    expect(linkHeavyFinding(30, 2, 'post:981')).toEqual({
      code: 'SEC_LINK_HEAVY', severity: 'low', action: 'flagged', doc: 'post:981', detail: '30 external links, site median 2',
    })
    expect(linkHeavyFinding(9, 0, 'post:981')).toBeUndefined() // under the floor of 10
    expect(linkHeavyFinding(30, 12, 'post:981')).toBeUndefined() // under 3x median
    expect(linkHeavyFinding(30, 12, 'post:981', { factor: 2 })?.code).toBe('SEC_LINK_HEAVY')
    expect(linkHeavyFinding(5, 1, 'post:981', { min: 5 })?.code).toBe('SEC_LINK_HEAVY')
    // The content itself is untouched by sanitizeContent.
    expect(run(html).findings).toEqual([])
  })

  it('obfuscation heuristics skip code samples and prose about code (S04-08)', () => {
    expect(run('<pre><code>eval(atob(x))</code></pre>').findings).toEqual([])
    expect(run('<p>eval(atob(x))</p>').findings.map((f) => f.code)).toEqual(['SEC_OBFUSCATED'])
    expect(run('<p>Never call eval() on user input.</p>').html).toBe('<p>Never call eval() on user input.</p>')
    expect(run(`<p>${'\\x41'.repeat(10)}</p>`).findings.map((f) => f.detail)).toEqual(['hex escapes in text'])
    // Attributes keep the function-name heuristics.
    expect(run('<a href="/x" title="eval(run(1))">t</a>').html).toBe('<a href="/x">t</a>')
  })

  it('hidden-style heuristics keep ordinary layout (S04-10)', () => {
    for (const style of ['margin-left:-20px', 'left:-50px', 'text-indent:-2em', 'opacity:0.5', 'transform:scale(0.9)', 'height:0', 'clip:rect(0 0 0 0)', 'color:#000;background:#fff']) {
      expect(run(`<p style="${style}"><a href="/x">x</a></p>`).findings, style).toEqual([])
    }
  })
})

describe('toPlainText (AC-B5)', () => {
  it.each([
    ['<b>Hello</b> <i>world</i>', 'Hello world'],
    ['Fish &amp;amp; chips', 'Fish &amp; chips'],
    ['&amp;lt;script&amp;gt;', '&lt;script&gt;'],
    ['&lt;b&gt;bold&lt;/b&gt;', '<b>bold</b>'],
    ['Title<script>alert(1)</script><style>p{}</style>', 'Title'],
    ['<img src=x onerror=alert(1)>Caption', 'Caption'],
    ['<p>One</p><p>Two</p>Three<br>Four', 'One Two Three Four'],
    ['  lots \n\t of   space&nbsp;here  ', 'lots of space here'],
    ['a\u0000b\u0007c', 'abc'],
    ['<!-- hidden -->Shown', 'Shown'],
    ['Using <textarea> in forms', 'Using in forms'],
    ['The <title> element &amp; SEO', 'The element & SEO'],
    ['Why <script> tags block rendering', 'Why tags block rendering'],
    ['<iframe>Embeds</iframe> explained', 'Embeds explained'],
    ['A <plaintext> tag', 'A tag'],
    ['x<script>a</script>y<style>b</style>z', 'xyz'],
    ['&amp;lt;textarea&amp;gt;', '&lt;textarea&gt;'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(toPlainText(input)).toBe(expected)
  })
})
