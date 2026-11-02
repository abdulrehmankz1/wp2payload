import { isTag, type AnyNode, type Element } from 'domhandler'
import fc from 'fast-check'
import { parseDocument } from 'htmlparser2'

// Shared settings and arbitraries for the property-based fuzz tests (doc 12.14).
//
// Run counts and seed:
// - FUZZ_RUNS=<n>   runs per property (default 300; some properties scale it down).
// - FUZZ_SEED=<n>   seed for every property (default FIXED_SEED, so CI is deterministic);
//   FUZZ_SEED=random picks a fresh seed per run for exploratory local fuzzing.
// - FUZZ_PATH=<p>   replay one shrunk counterexample; combine with `-t "<property name>"`.
// A failure prints `{ seed: ..., path: "..." }`. Replay it with, for example:
//   FUZZ_SEED=123 FUZZ_PATH="45:2:1" corepack pnpm vitest run --project unit tests/unit/fuzz-sanitize.test.ts -t "never emits"

const FIXED_SEED = 20261031

const envRuns = Number(process.env.FUZZ_RUNS)
export const FUZZ_RUNS = Number.isFinite(envRuns) && envRuns > 0 ? Math.floor(envRuns) : 300

const envSeed = process.env.FUZZ_SEED
export const FUZZ_SEED =
  envSeed === 'random' ? (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0 : envSeed ? Number(envSeed) | 0 : FIXED_SEED

/** fast-check parameters; `scale` lowers the run count for expensive properties. */
export function fuzzParams(scale = 1): fc.Parameters<unknown> {
  const p: fc.Parameters<unknown> = { numRuns: Math.max(1, Math.round(FUZZ_RUNS * scale)), seed: FUZZ_SEED }
  if (process.env.FUZZ_PATH) p.path = process.env.FUZZ_PATH
  return p
}

/** Test timeout that grows with FUZZ_RUNS (vitest's default 5 s is too short for deep runs). */
export const fuzzTimeout = (scale = 1) => Math.max(30_000, FUZZ_RUNS * scale * 20)

// ---------------------------------------------------------------------------------------------
// Strings

/** Any UTF-16 code unit, lone surrogates included (JSON from a hostile site can carry them). */
export const codeUnit = fc.integer({ min: 0, max: 0xffff }).map((c) => String.fromCharCode(c))
/** Characters that matter to the code under test: controls, bidi, zero-width, separators, combining marks. */
export const trickyChar = fc.constantFrom(
  '\u0000', '\u0001', '\t', '\n', '\u000b', '\f', '\r', '\u001f', ' ', '\u007f', '\u0085', '\u009f', '\u00a0', '\u00ad',
  '\u061c', '\u1680', '\u180e', '\u2000', '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u2028', '\u2029',
  '\u202a', '\u202e', '\u202f', '\u205f', '\u2060', '\u2066', '\u2069', '\u3000', '\ufeff', '\ud800', '\udfff',
  '\u0301', '\u0308', 'e', 'A', '\u0130', '\u00df', '%', '%2F', '%2e', '%00', '%E2%80%AE', '%c3%a9', 'e\u0301', '/', '?', '#',
  '\\', '.', '..', '<', '>', '&', '"', "'", '`', '=', ':', '&amp;', '&lt;', '&#0;', '&#x202e;',
)
/** Mixed noise: tricky characters, arbitrary code units and full Unicode. */
export const noise = (maxLength = 24) =>
  fc.oneof(
    fc.string({ unit: trickyChar, maxLength }),
    fc.string({ unit: codeUnit, maxLength }),
    fc.string({ unit: 'binary', maxLength }),
    fc.string({ maxLength }),
  )

// ---------------------------------------------------------------------------------------------
// Hostile HTML grammar

/** Random ASCII casing of a word. */
export const anyCase = (word: string) =>
  fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length })
    .map((up) => [...word].map((c, i) => (up[i] ? c.toUpperCase() : c)).join(''))

/** One character of a URL scheme, written literally or as a (possibly sloppy) character reference. */
const schemeChar = (c: string) =>
  fc.oneof(
    { weight: 6, arbitrary: anyCase(c) },
    fc.constant(`&#${c.charCodeAt(0)};`),
    fc.constant(`&#x${c.charCodeAt(0).toString(16)};`),
    fc.constant(`&#X${c.charCodeAt(0).toString(16).toUpperCase()};`),
    fc.constant(`&#0000${c.charCodeAt(0)};`),
    fc.constant(`&#${c.charCodeAt(0)}`), // no semicolon: browsers still decode it
  )

/** Noise a browser or the project ignores inside a scheme (doc 12.4 signals SCHEME_NOISE). */
const schemeNoise = fc.constantFrom(
  '', '', '', '', '\t', '\n', '\r', '&#x09;', '&#9;', '&#10;', '&#x0A;', '&#13;', '&Tab;', '&NewLine;', '\u0000',
  '&#0;', '&#x0;', '\u0001', '&#1;', '\u000c', ' ', '&nbsp;', '\u00ad', '&shy;', '\u200b', '&#x200b;', '\u200e', '\ufeff',
  '\u2028', '\u3000',
)

const COLON = fc.constantFrom(':', ':', ':', '&colon;', '&#58;', '&#x3a;', '&#X3A;', '&#58', '%3a')

/** A scheme such as `javascript`, obfuscated character by character. */
const obfuscatedScheme = fc
  .constantFrom('javascript', 'javascript', 'vbscript', 'data', 'data', 'livescript', 'mocha', 'http', 'https', 'mailto', 'tel', 'ftp', 'jar', 'blob')
  .chain((word) => fc.tuple(...[...word].map((c) => fc.tuple(schemeNoise, schemeChar(c)).map(([n, ch]) => n + ch))).map((parts) => parts.join('')))

const PAYLOADS = [
  'alert(1)', '//%0aalert(1)', 'text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', 'text/html,<script>alert(1)</script>',
  'image/svg+xml,<svg onload=alert(1)>', 'msgbox(1)', '//evil.example/', '', 'alert`1`', 'void(0)', '0;url=javascript:alert(1)',
  "location='https://evil.example/'",
]

/** A URL value: mostly an obfuscated scheme and a payload, sometimes ordinary or random. */
export const hostileUrl = fc.oneof(
  { weight: 6, arbitrary: fc.tuple(schemeNoise, schemeNoise, obfuscatedScheme, COLON, fc.constantFrom(...PAYLOADS)).map((p) => p.join('')) },
  fc.constantFrom(
    'https://oldsite.example/hello/', 'https://www.youtube.com/embed/x', 'https://evil.example/', '/relative', '#top',
    '//evil.example/x', 'mailto:a@b.example', 'tel:+1', '?p=1', 'x.png 1x, javascript:alert(1) 2x', 'java\u0000script:alert(1)',
    ' &#14;  javascript:alert(1)', 'jav&#x09;ascript:alert(1)', 'javascript&colon;alert(1)', '&#106avascript:alert(1)',
    'jav&amp;#x09;ascript:alert(1)', 'data:,x', 'DATA:text/html,x', 'vbscript:msgbox', 'javascript:', 'https://player.vimeo.com/video/1',
    'https://user:pw@www.youtube.com/embed/x', 'http://www.youtube.com/embed/x', 'https://www.youtube.com.evil.example/',
  ),
  fc.webUrl(),
  noise(16),
)

const ATTR_NAMES = [
  'onclick', 'onload', 'onerror', 'onmouseover', 'onfocus', 'onbegin', 'onanimationstart', 'onpointerenter', 'on', 'onx',
  'href', 'src', 'xlink:href', 'formaction', 'action', 'srcset', 'data', 'srcdoc', 'background', 'poster', 'values', 'to', 'from',
  'style', 'class', 'id', 'title', 'alt', 'data-url', 'hidden', 'http-equiv', 'content', 'rel', 'width', 'height', 'colspan',
  'rowspan', 'name', 'type', 'value', 'autofocus', 'is', 'xmlns', 'attributeName', 'target', 'ping', 'cite', 'lowsrc',
]
const URL_LIKE = new Set(['href', 'src', 'xlink:href', 'formaction', 'action', 'srcset', 'data', 'background', 'poster', 'values', 'to', 'from', 'data-url', 'ping', 'cite', 'lowsrc', 'content'])

const attrName = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom(...ATTR_NAMES).chain(anyCase) },
  fc.string({ unit: fc.constantFrom('o', 'n', 'O', 'N', 'x', '-', ':', 'e', 'r'), minLength: 1, maxLength: 8 }),
  fc.string({ unit: 'binary', minLength: 1, maxLength: 6 }).filter((s) => !/[\s/>="'<]/.test(s)),
)

const attrValueFor = (name: string) =>
  fc.oneof(
    { weight: URL_LIKE.has(name.toLowerCase()) ? 8 : 1, arbitrary: hostileUrl },
    { weight: name.toLowerCase().startsWith('on') ? 6 : 1, arbitrary: fc.constantFrom('alert(1)', 'location="https://evil.example/"', 'eval(atob("YWxlcnQoMSk="))', 'this.src=1') },
    fc.constantFrom(
      'display:none', 'd\\69splay:/**/none', 'font-size:0', 'position:absolute;left:-9999px', 'x', '"><script>alert(1)</script>',
      "'><img src=x onerror=alert(1)>", '</noscript><img src=x onerror=alert(1)>', '0', 'refresh', 'canonical',
    ),
    noise(12),
  )

const quoted = (v: string) =>
  fc.constantFrom<(s: string) => string>(
    (s) => `"${s.replace(/"/g, '&quot;')}"`,
    (s) => `'${s.replace(/'/g, '&#39;')}'`,
    (s) => s.replace(/[\s>]/g, ''),
    (s) => `"${s}"`, // unescaped: may break out of the value
    (s) => `\`${s}\``,
  ).map((q) => q(v))

const attrSep = fc.constantFrom(' ', ' ', ' ', '\t', '\n', '/', '\f', '  ', ' / ', '\r\n', '')
const attr = attrName.chain((name) =>
  fc.oneof(
    { weight: 1, arbitrary: fc.constant(name) },
    { weight: 6, arbitrary: fc.tuple(attrValueFor(name).chain(quoted), fc.constantFrom('=', ' = ', '=\n')).map(([v, eq]) => `${name}${eq}${v}`) },
  ),
)

const TAGS = [
  'script', 'script', 'style', 'iframe', 'frame', 'svg', 'math', 'img', 'img', 'a', 'a', 'object', 'embed', 'form', 'input',
  'button', 'p', 'div', 'span', 'noscript', 'template', 'textarea', 'title', 'xmp', 'plaintext', 'noembed', 'noframes', 'base',
  'meta', 'link', 'select', 'option', 'table', 'tr', 'td', 'foreignObject', 'animate', 'set', 'use', 'image', 'video', 'source',
  'wp2p-embed', 'code', 'pre', 'h1', 'li', 'ul', 'figure', 'annotation-xml', 'mglyph', 'mtext', 'body', 'html', 'head', 'isindex',
  'details', 'x-foo', 'sCrIpT', 'scr\u0000ipt',
]

const tagName = fc.oneof({ weight: 10, arbitrary: fc.constantFrom(...TAGS).chain(anyCase) }, fc.string({ unit: 'binary', minLength: 1, maxLength: 5 }))

/** Complete hostile snippets from known XSS and hacked-WordPress payloads. */
const SNIPPETS = [
  '<script>alert(1)</script>', '<SCRIPT SRC=//evil.example/x.js></SCRIPT>', '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<img src=x onerror=alert(1)>', '<img src=x oNeRrOr = alert(1) >', '<img/src/onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>',
  '<svg><script>alert(1)</script></svg>', '<svg/onload=alert(1)>', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>', '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">', '<!--[if IE]><script>alert(1)</script><![endif]-->',
  '<![CDATA[<script>alert(1)</script>]]>', '<?xml version="1.0"?><script>alert(1)</script>', '<!DOCTYPE html>', '<!-->', '<!--->',
  '<!-- x --!>', '<!--', '-->', '</', '<', '>', '<//', '<a', '<img', '&lt;script&gt;alert(1)&lt;/script&gt;', '&#60;script&#62;alert(1)&#60;/script&#62;',
  '<style>.x{display:none}</style>', '<div class="x"><a href="https://spam.example">casino</a></div>',
  '<div style="display:none"><a href="https://spam.example/">cheap pills</a></div>', '<iframe src="https://www.youtube.com/embed/x"></iframe>',
  '<iframe src="javascript:alert(1)"></iframe>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<wp2p-embed data-url="https://www.youtube.com/embed/x"></wp2p-embed>', '<wp2p-embed data-url="javascript:alert(1)"></wp2p-embed>',
  '<wp2p-embed data-url="https://www.youtube.com/embed/x"><img src=x onerror=alert(1)></wp2p-embed>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">', '<base href="javascript:alert(1)//">',
  '<form><button formaction="javascript:alert(1)">x</button></form>', '<form action="javascript:alert(1)"><input type=submit></form>',
  '<object data="data:text/html,<script>alert(1)</script>"></object>', '<embed src="javascript:alert(1)">',
  '<img srcset="x.png 1x, javascript:alert(1) 2x">', '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>',
  '<a href=" &#14;  javascript:alert(1)">x</a>', '<a href="jav&#x09;ascript:alert(1)">x</a>', '<a href="javascript&colon;alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>', '<a href="vbscript:msgbox(1)">x</a>',
  '<a href=javascript:alert(1)>x</a>', '<a href="\u0001javascript:alert(1)">x</a>', '<a href="java\u00adscript:alert(1)">x</a>',
  '<a href="https://oldsite.example/x" rel="dofollow" onclick="x()">ok</a>', '<textarea><script>alert(1)</script></textarea>',
  '<title><script>alert(1)</script></title>', '<xmp><script>alert(1)</script></xmp>', '<plaintext><script>alert(1)</script>',
  '<template><script>alert(1)</script></template>', '<select><style><img src=x onerror=alert(1)></style></select>',
  '<p>eval(atob("YWxlcnQoMSk="))</p>', `<p>${'QUFB'.repeat(60)}</p>`, '<script>window.location="https://evil.example/"</script>',
  '<a href="https://x.example"><script>alert(1)</script></a>', '<!-- wp:html -->', '<!-- /wp:html -->', '<table><td>x</td></table>',
  '<img src="https://oldsite.example/wp-content/uploads/photo.jpg" alt="&lt;b&gt;">', '<p>casino <a href="https://e.example">casino</a></p>',
]

const opener = fc.constantFrom('>', '>', '>', '>', '/>', ' >', '', '\u0000>', '\n>')
const closer = (name: string) =>
  fc.constantFrom(`</${name}>`, `</${name}>`, `</${name}>`, `</${name.toUpperCase()} >`, '', `</${name}`, `</${name}/>`, `</ ${name}>`)

const leaf = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...SNIPPETS) },
  { weight: 2, arbitrary: noise(12) },
  { weight: 1, arbitrary: fc.constantFrom('text', 'Hello world', ' ', '&amp;', '&', '&#x202e;', 'a<b', 'x>y', '"', "'") },
)

const tree = fc.letrec<{ node: string; element: string }>((tie) => ({
  node: fc.oneof({ depthSize: 'small', maxDepth: 6 }, leaf, tie('element')),
  element: tagName.chain((name) =>
    fc.tuple(fc.array(fc.tuple(attrSep, attr), { maxLength: 4 }), opener, fc.array(tie('node'), { maxLength: 4 }), closer(name))
      .map(([attrs, open, kids, close]) => `<${name}${attrs.map(([s, a]) => (s || ' ') + a).join('')}${open}${kids.join('')}${close}`),
  ),
}))

/** Hostile HTML built from the grammar above, sometimes with random noise spliced in. */
export const hostileHtml = fc.oneof(
  { weight: 5, arbitrary: fc.array(tree.node, { maxLength: 8 }).map((a) => a.join('')) },
  {
    weight: 2,
    arbitrary: fc.tuple(fc.array(tree.node, { minLength: 1, maxLength: 6 }), noise(8), fc.nat()).map(([parts, n, at]) => {
      const s = parts.join('')
      const i = s.length ? at % (s.length + 1) : 0
      return s.slice(0, i) + n + s.slice(i)
    }),
  },
  { weight: 1, arbitrary: noise(64) },
)

// ---------------------------------------------------------------------------------------------
// Checkers

// Characters a browser strips inside a URL scheme (tab, LF, CR anywhere; C0 and space at the start),
// widened to the invisible separators the project also treats as noise (signals.ts SCHEME_NOISE).
const URL_NOISE = /[\u0000- \u007f-\u00a0\u00ad\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g
const BAD_SCHEME = /^(?:javascript|vbscript|livescript|mocha|data):/

/** True when a decoded URL value (or any srcset/SMIL candidate in it) has a script-capable scheme. */
export function isDangerousUrl(decoded: string): boolean {
  return decoded.split(/[,;]/).some((part) => BAD_SCHEME.test(part.replace(URL_NOISE, '').toLowerCase()))
}

/**
 * Browser-exact check (WHATWG URL parser): leading/trailing C0 controls and spaces are trimmed,
 * tab/LF/CR are removed anywhere, and nothing else. `java\u00adscript:` is a relative URL here.
 */
export function isBrowserDangerousUrl(decoded: string): boolean {
  const v = decoded.replace(/^[\u0000- ]+/, '').replace(/[\t\n\r]/g, '').toLowerCase()
  return BAD_SCHEME.test(v)
}

/** Attributes whose value a browser loads or navigates to. Independent of signals.ts on purpose. */
const URL_ATTRS = new Set([
  'href', 'src', 'xlink:href', 'action', 'formaction', 'background', 'poster', 'cite', 'data', 'srcset', 'lowsrc', 'dynsrc',
  'longdesc', 'ping', 'codebase', 'archive', 'manifest', 'icon', 'profile', 'usemap', 'classid', 'to', 'from', 'values', 'by',
  'data-url', 'srcdoc',
])

/** Every element of `html` as htmlparser2 parses it. */
export function elements(html: string): Element[] {
  const out: Element[] = []
  const stack: AnyNode[] = [parseDocument(html)]
  while (stack.length) {
    const n = stack.pop()!
    if (isTag(n)) out.push(n)
    if ('children' in n) for (const c of n.children) stack.push(c)
  }
  return out
}

export interface Violation {
  kind: string
  detail: string
}

/**
 * Parses HTML the way a reader of the output would (htmlparser2, entities decoded once) and lists
 * every unsafe construct: a `<script` anywhere in the raw text, a script element, an on* attribute,
 * a URL attribute with a dangerous scheme. `allow` additionally restricts tags and attributes.
 */
export function violations(html: string, allow?: { tags: ReadonlySet<string>; attrs: (tag: string) => ReadonlySet<string> }): Violation[] {
  const out: Violation[] = []
  if (html.toLowerCase().includes('<script')) out.push({ kind: 'raw <script', detail: html })
  const stack: AnyNode[] = [parseDocument(html)]
  while (stack.length) {
    const n = stack.pop()!
    if (isTag(n)) {
      const name = n.name.toLowerCase()
      if (name === 'script') out.push({ kind: 'script element', detail: name })
      if (allow && !allow.tags.has(name)) out.push({ kind: 'tag not allowed', detail: name })
      for (const [k, v] of Object.entries(n.attribs)) {
        const key = k.toLowerCase()
        if (/^\s*on/.test(key)) out.push({ kind: 'event handler', detail: `${name} ${key}` })
        if (URL_ATTRS.has(key) && isDangerousUrl(v)) out.push({ kind: 'dangerous URL', detail: `${name} ${key}=${JSON.stringify(v)}` })
        if (allow && !allow.attrs(name).has(key)) out.push({ kind: 'attribute not allowed', detail: `${name} ${key}` })
      }
    }
    if ('children' in n) for (const c of n.children) stack.push(c)
  }
  return out
}

/** Controls, bidi and zero-width characters that must never survive into plain text. */
export const INVISIBLE_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/
