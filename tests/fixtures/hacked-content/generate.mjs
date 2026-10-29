// Generates the hacked-content fixtures (doc 12.3 T1-T5, 12.14, spec 04 AC-B1). Every sample is
// inert: scripts only call alert(), redirects point at evil.example (RFC 2606), links at *.example.
// Deterministic: running it twice yields byte-identical files.
// Usage: node tests/fixtures/hacked-content/generate.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const out = (name, html) => writeFileSync(join(dir, `${name}.html`), html.trim() + '\n')

// Deterministic pseudo-base64 (not real data).
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const b64 = (n) => Array.from({ length: n }, (_, i) => ALPHA[(i * 7 + 3) % 64]).join('') + '=='

const farm = (n, kw = 'casino') =>
  Array.from({ length: n }, (_, i) => `<a href="https://spam${i}.example/">${kw} ${i}</a>`).join(' ')

// T1: script injection.
out('script', '<p>Hello</p><script>alert(1)</script><p>World</p>')
out('script-src', '<p>Hello</p><script src="https://evil.example/x.js"></script>')
out('handlers', `
<p onclick="alert(1)">Click</p>
<img src="/wp-content/uploads/a.jpg" alt="A" onerror="alert(1)">
<a href="/about/" ONMOUSEOVER="alert(1)">About</a>
`)
out('js-url', `
<a href="javascript:alert(1)">1</a>
<a href="JaVaScRiPt:alert(1)">2</a>
<a href="jav&#x09;ascript:alert(1)">3</a>
<a href="&#106;avascript:alert(1)">4</a>
<a href="&#x6A;&#x61;vascript:alert(1)">5</a>
<a href=" javascript:alert(1)">6</a>
<a href="java&#10;script:alert(1)">7</a>
<a href="javascript&colon;alert(1)">8</a>
`)
out('data-url', `
<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">1</a>
<img src="data:image/svg+xml,&lt;svg onload=alert(1)&gt;" alt="x">
`)
out('vbscript-url', '<a href="vbscript:msgbox(1)">1</a> <a href="VBScript&#58;msgbox(1)">2</a>')

// T4: redirects.
out('meta-refresh', '<meta http-equiv="Refresh" content="0;url=https://evil.example/"><p>Text</p>')
out('js-redirect', '<p>Text</p><script>window.location = "https://evil.example/"</script>')
out('handler-redirect', `<img src="/a.jpg" alt="a" onload="document.location.href='https://evil.example/'">`)

// T3: hidden link farms, one per hiding style.
out('hidden-display', `<p>Intro</p><div style="display:none">${farm(3)}</div><p>Outro</p>`)
out('hidden-visibility', `<p>Intro</p><div style="visibility: hidden">${farm(2, 'viagra')}</div>`)
out('hidden-font-size', `<p>Intro</p><span style="font-size:0px">${farm(2)}</span>`)
out('hidden-left', `<p>Intro</p><div style="position:absolute;left:-9999px">${farm(2)}</div>`)
out('hidden-text-indent', `<p>Intro</p><p style="text-indent:-9999px">${farm(2)}</p>`)
out('hidden-height', `<p>Intro</p><div style="height:0;overflow:hidden">${farm(2)}</div>`)
out('hidden-attribute', `<p>Intro</p><div hidden>${farm(2)}</div>`)
out('hidden-obfuscated-css', `<p>Intro</p><div style="DISPLAY : /* x */ NONE !important">${farm(1)}</div><div style="d\\69splay:none">${farm(1)}</div>`)
out('hidden-stylesheet', `<style>.seo-x { display: none }</style><p>Intro</p><div class="wrap seo-x">${farm(2)}</div>`)
out('hidden-link-itself', `<p>Intro <a href="https://spam.example/" style="opacity:0">casino</a></p>`)

out('hidden-noscript', `<p>Intro</p><noscript>${farm(2)}</noscript><noscript><img src="/lazy.jpg" alt="lazy"></noscript>`)
out('hidden-template', `<p>Intro</p><template>${farm(2)}</template>`)
out('hidden-clip', `<p>Intro</p><div style="position:absolute;clip:rect(0 0 0 0)">${farm(1)}</div><div style="clip-path: inset(100%)">${farm(1)}</div>`)
out('hidden-1px', `<p>Intro</p><div style="height:1px;overflow:hidden">${farm(1)}</div><div style="width:1px;overflow:hidden">${farm(1)}</div>`)
out('hidden-scale', `<p>Intro</p><div style="transform:scale(0)">${farm(1)}</div>`)
out('hidden-offsets', `<p>Intro</p><div style="position:absolute;left:-499px">${farm(1)}</div><p style="text-indent:-100%">${farm(1)}</p><div style="position:absolute;top:-120px">${farm(1)}</div>`)
out('hidden-colour', `<p>Intro</p><p style="color:#fff;background-color:#fff">${farm(1)}</p>`)
out('hidden-nested', `<p>Intro</p><div style="display:none"><div style="display:none"><div hidden>${farm(2)}</div></div></div>`)
// Hidden content without links (accordions, tab panels) is kept and only flagged.
out('hidden-text', '<p>FAQ</p><div class="accordion-panel" style="display:none"><p>Answer text.</p><div style="display:none">Nested.</div></div>')

// Cuts must not let neighbours join into new markup; chains must not outlast the pass cap.
out('splice-join', '<p>a<<script>x</script>b>c</p>')
out('splice-chain', '<<<<<script></script>meta http-equiv=refresh>script></script>meta http-equiv=refresh>div hidden><a href="https://spam.example">casino</a></div>')

// T5: iframes.
out('iframe-youtube', '<p>Watch:</p><iframe width="560" height="315" src="https://www.youtube.com/embed/abc123?si=x&amp;t=1" frameborder="0" allowfullscreen></iframe>')
out('iframe-vimeo', '<iframe src="https://player.vimeo.com/video/123456" onload="alert(1)"></iframe>')
out('iframe-unknown', '<p>x</p><iframe src="https://evil.example/frame"></iframe>')
out('iframe-http-youtube', '<iframe src="http://www.youtube.com/embed/abc123"></iframe>')
out('iframe-lookalike', `
<iframe src="https://www.youtube.com.evil.example/embed/x"></iframe>
<iframe src="https://user:pw@www.youtube.com/embed/x"></iframe>
<iframe src="https://www.youtube.com:8443/embed/x"></iframe>
<iframe src="javascript:alert(1)"></iframe>
<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>
`)
out('forged-embed', `
<wp2p-embed data-url="javascript:alert(1)"></wp2p-embed>
<wp2p-embed data-url="https://evil.example/"></wp2p-embed>
<wp2p-embed data-url="https://www.youtube.com/embed/x"><img src="x" onerror="alert(1)"></wp2p-embed>
`)

// Obfuscated payloads.
out('base64', `
<p>Normal text.</p>
<p>${b64(300)}</p>
<p>eval(atob("aGVsbG8gd29ybGQ="))</p>
<a href="/x" title="${b64(250)}">Link</a>
<pre><code>const s = eval("1 + 1") // a code sample stays</code></pre>
`)

// Prose about code is not an obfuscated payload.
out('eval-prose', '<p>Never call eval() on user input, and avoid atob() for secrets. Use String.fromCharCode sparingly.</p>')

// Spam signals that keep content (low, flagged).
out('link-heavy', '<p>Resources:</p>' + Array.from({ length: 30 }, (_, i) => `<p><a href="https://site${i}.example/page">Site ${i}</a></p>`).join(''))
out('spam-keywords', '<p>Try <a href="https://spam.example/">best online casino</a> and <a href="https://pills.example/">cheap Viagra</a>, or <a href="https://loans.example/">payday loans</a>.</p>')

// Mutation-XSS classics: inputs that re-parse differently in a browser than in a sanitizer.
out('mxss-svg-style', '<svg><style><img src=x onerror=alert(1)></style></svg>')
out('mxss-noscript', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>')
out('mxss-math', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>')
out('mxss-comments', '<!--><script>alert(1)</script>--><!-- <!-- nested --> <script>alert(2)</script> --><p>ok</p>')
out('mxss-form-math', '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>')
out('svg-xlink', '<svg><a xlink:href="javascript:alert(1)"><text x="0" y="20">x</text></a></svg>')
out('svg-animate', '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>y</text></a></svg>')
out('img-title-breakout', '<img src="x" alt="a" title="</title><script>alert(1)</script>">')
out('textarea-script', '<textarea><script>alert(1)</script></textarea><p>after</p>')
out('style-attribute', '<a href="https://ok.example/" style="background:url(javascript:alert(1))">styled</a>')
out('protocol-relative', '<a href="//evil.example/">protocol relative</a>')

// A clean, realistic post: must come out with the same meaning and zero findings.
out('clean', `
<h2>Planting a spring garden</h2>
<p>Start with <strong>good soil</strong> and <em>patience</em>. See our <a href="https://oldsite.example/soil-guide/">soil guide</a> and the <a href="https://www.rhs.org.uk/advice">RHS advice pages</a>.</p>
<figure class="wp-block-image size-large"><img src="https://oldsite.example/wp-content/uploads/2024/03/beds-1024x683.jpg" alt="Raised beds" width="1024" height="683"><figcaption>Raised beds in March</figcaption></figure>
<ul><li>Peas</li><li>Lettuce<ul><li>Butterhead</li></ul></li></ul>
<blockquote><p>The best time to plant a tree was twenty years ago.</p></blockquote>
<p style="text-align:center">Mail <a href="mailto:hello@oldsite.example">hello@oldsite.example</a> or call <a href="tel:+441234567890">01234 567890</a>.</p>
<table><thead><tr><th>Crop</th><th>Sow</th></tr></thead><tbody><tr><td>Peas</td><td colspan="2">March</td></tr></tbody></table>
<pre><code>&lt;script&gt;not code, just text&lt;/script&gt; &amp; eval(x)</code></pre>
<hr>
<p>H<sub>2</sub>O and E = mc<sup>2</sup>. Fish &amp; chips.<br>New line.</p>
`)

// Raw WordPress posts (block comments included) for the document-level scan (scanDocument).
mkdirSync(join(dir, 'documents'), { recursive: true })
const doc = (name, html) => writeFileSync(join(dir, 'documents', `${name}.html`), html.trim() + '\n')
doc('wrapper-across-blocks', `
<!-- wp:paragraph --><p>Intro</p><!-- /wp:paragraph -->
<!-- wp:html --><div style="display:none"><!-- /wp:html -->
<!-- wp:paragraph --><p><a href="https://spam.test/">cheap</a></p><!-- /wp:paragraph -->
<!-- wp:html --></div><!-- /wp:html -->
<!-- wp:paragraph --><p>Outro</p><!-- /wp:paragraph -->
`)
doc('hidden-paragraph', `
<!-- wp:paragraph --><p>Visible</p><!-- /wp:paragraph -->
<!-- wp:paragraph --><p style="display:none"><a href="https://casino.example/">casino</a></p><!-- /wp:paragraph -->
`)
doc('hidden-group', `
<!-- wp:group {"className":"x"} --><div class="wp-block-group" style="display:none"><!-- wp:paragraph --><p><a href="https://spam.example/">casino</a></p><!-- /wp:paragraph --><!-- wp:image {"id":5} --><figure class="wp-block-image"><img src="/a.jpg" alt=""/></figure><!-- /wp:image --></div><!-- /wp:group -->
<!-- wp:paragraph --><p>After</p><!-- /wp:paragraph -->
`)
doc('stylesheet-other-block', `
<!-- wp:html --><style>.sx{display:none}</style><!-- /wp:html -->
<!-- wp:paragraph --><p class="sx"><a href="https://spam.example/">casino</a></p><!-- /wp:paragraph -->
`)
doc('script-in-group', `
<!-- wp:group --><div class="wp-block-group"><!-- wp:html --><script>alert(1)</script><!-- /wp:html --><!-- wp:paragraph --><p>Text</p><!-- /wp:paragraph --></div><!-- /wp:group -->
`)
doc('clean', `
<!-- wp:heading --><h2 class="wp-block-heading">Title &amp; more</h2><!-- /wp:heading -->
<!-- wp:paragraph --><p>Text with <a href="https://example.org/">a link</a>.</p><!-- /wp:paragraph -->
<!-- wp:embed {"url":"https://www.youtube.com/watch?v=x"} --><figure class="wp-block-embed"><div class="wp-block-embed__wrapper">https://www.youtube.com/watch?v=x</div></figure><!-- /wp:embed -->
<!-- wp:separator /--><!-- wp:html --><iframe src="https://evil.example/"></iframe><!-- /wp:html -->
`)
