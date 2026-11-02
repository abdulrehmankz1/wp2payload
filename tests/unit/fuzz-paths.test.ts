import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { normaliseSlug } from '../../src/extractors/rest/decode.js'
import { MAX_HEAD_CHARS, parseRankMathHead } from '../../src/extractors/rest/rankmath.js'
import {
  escapeSource,
  hasDotSegment,
  isNormalisedPath,
  isReserved,
  newPathOf,
  pathKey,
} from '../../src/loaders/redirects.js'
import { anyCase, codeUnit, fuzzParams, fuzzTimeout, hostileHtml, hostileUrl, noise, trickyChar } from './fuzz-support.js'

// Property-based fuzzing of slug, SEO-head and redirect-path handling (doc 12.14).
// Seed and run count: see fuzz-support.ts (FUZZ_RUNS, FUZZ_SEED, FUZZ_PATH).

const BIDI_ZW = /[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/

/** Slug-like input: percent-escapes (valid, malformed, encoded separators), Unicode and noise. */
const slugish = fc.oneof(
  fc.array(
    fc.oneof(
      { weight: 3, arbitrary: fc.stringMatching(/^[a-z0-9-]{1,8}$/) },
      { weight: 2, arbitrary: trickyChar },
      fc.constantFrom('%2F', '%2f', '%3F', '%23', '%5C', '%2E', '%2E%2E', '%', '%zz', '%e2%80%ae', '%E2%80%8B', '%0A', '%00', '%C3%A9', 'e%CC%81', '%ED%A0%80', '%25'),
      fc.string({ unit: 'binary', maxLength: 4 }),
    ),
    { maxLength: 10 },
  ).map((p) => p.join('')),
  noise(32),
)

describe('fuzz: normaliseSlug (src/extractors/rest/decode.ts)', () => {
  it('never throws and never keeps separators, whitespace, controls or invisible characters', () => {
    fc.assert(
      fc.property(slugish, (raw) => {
        const s = normaliseSlug(raw)
        expect(s).not.toMatch(/[/?#\\]/)
        expect(s).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}\s]/u)
        expect(s).not.toMatch(BIDI_ZW)
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())

  it('returns NFC text', () => {
    fc.assert(
      fc.property(slugish, (raw) => {
        const s = normaliseSlug(raw)
        expect(s).toBe(s.normalize('NFC'))
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())

  // Found by this suite: NFC ran before removals, so 'a%0A\u0301' stayed 'a\u0301', not '\u00e1'.
  it('a removed character before a combining mark still leaves NFC', () => {
    const s = normaliseSlug('a%0A\u0301')
    expect(s).toBe(s.normalize('NFC'))
  })
})

// ---------------------------------------------------------------------------------------------

const metaTag = fc.oneof(
  fc.tuple(fc.constantFrom('link').chain(anyCase), fc.constantFrom('canonical', 'CANONICAL', 'alternate canonical', 'canonical\t'), hostileUrl)
    .map(([t, rel, href]) => `<${t} rel="${rel}" href="${href.replace(/"/g, '&quot;')}">`),
  fc.tuple(fc.constantFrom('og:url', 'og:title', 'OG:URL'), hostileUrl).map(([p, c]) => `<meta property="${p}" content="${c.replace(/"/g, '&quot;')}">`),
  fc.tuple(fc.constantFrom('description', 'robots', 'twitter:title'), fc.oneof(noise(24), fc.constantFrom('noindex, follow', 'NOINDEX', '&lt;b&gt;x'))).map(([n, c]) => `<meta name="${n}" content="${c.replace(/"/g, '&quot;')}">`),
  noise(24).map((t) => `<title>${t}</title>`),
  fc.constantFrom('<script type="application/ld+json">{"url":"javascript:alert(1)"}</script>', '<noscript><link rel="canonical" href="javascript:alert(1)"></noscript>', '<title>', '<style>', '<!--', '<template>'),
  hostileHtml,
)
const head = fc.oneof({ weight: 4, arbitrary: fc.array(metaTag, { maxLength: 8 }).map((t) => t.join('\n')) }, noise(64))

describe('fuzz: parseRankMathHead (src/extractors/rest/rankmath.ts)', () => {
  it('never throws; any canonical is an absolute http(s) URL; text fields are clean plain text', () => {
    fc.assert(
      fc.property(head, (h) => {
        const seo = parseRankMathHead(h)
        if (!seo) return
        if (seo.canonical !== undefined) {
          expect(['http:', 'https:']).toContain(new URL(seo.canonical).protocol)
          expect(seo.canonical).not.toMatch(/[\u0000- \u007f]/)
        }
        for (const t of [seo.title, seo.description]) {
          if (t === undefined) continue
          expect(t).not.toBe('')
          expect(t).toBe(t.trim())
          expect(t).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u)
          expect(t).not.toMatch(BIDI_ZW)
        }
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())

  it('ignores heads over MAX_HEAD_CHARS', () => {
    const big = `<link rel="canonical" href="https://x.example/">${' '.repeat(MAX_HEAD_CHARS)}`
    expect(parseRankMathHead(big)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------

const PATTERNS = ['/:slug', '/posts/:slug', '/blog/:slug/amp', '/news/:slug', '/a/b/:slug']
/** A slug as the redirects loader receives it; JSON from WordPress can carry lone surrogates too. */
const loaderSlug = fc.oneof({ weight: 4, arbitrary: slugish }, fc.string({ unit: codeUnit, maxLength: 12 }))
/** Lone UTF-16 surrogates, which encodeURIComponent rejects. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

describe('fuzz: redirect path helpers (src/loaders/redirects.ts)', () => {
  it('hasDotSegment, isReserved, pathKey, escapeSource and isNormalisedPath never throw', () => {
    fc.assert(
      fc.property(loaderSlug, (s) => {
        hasDotSegment(s)
        isReserved(s)
        isReserved(`/${s}`, ['/cms', 'x'])
        pathKey(s)
        isNormalisedPath(s)
        // escapeSource is reversible: every special character is backslash-escaped.
        expect(escapeSource(s).replace(/\\(.)/gs, '$1')).toBe(s)
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())

  it('newPathOf yields a normalised path for every slug the loader accepts', () => {
    // The loader skips slugs with no segment or a dot segment before calling newPathOf.
    const accepted = loaderSlug.filter((s) => s.split('/').some(Boolean) && !hasDotSegment(s))
    fc.assert(
      fc.property(fc.constantFrom(...PATTERNS), accepted, (pattern, slug) => {
        const p = newPathOf(pattern, slug)
        expect(isNormalisedPath(p)).toBe(true)
        expect(p.startsWith(pattern.split(':slug')[0]!)).toBe(true)
        expect(p).not.toMatch(/[\s?#\\]/)
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())

  // Found by this suite: a JSON \ud800 escape in a slug made encodeURIComponent throw, failing
  // the whole redirects phase.
  it('newPathOf does not throw on a slug with a lone surrogate', () => {
    expect(() => newPathOf('/:slug', '\ud800')).not.toThrow()
    expect(LONE_SURROGATE.test(normaliseSlug('a\ud800b'))).toBe(false)
  })

  it('framework prefixes stay reserved under any casing, encoding and suffix', () => {
    const prefix = fc.constantFrom('admin', 'api', '_next', 'next').chain((p) =>
      fc.oneof(anyCase(p), fc.constant(p.replace(/a/g, '%61')), fc.constant(p.replace(/^./, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))),
    )
    fc.assert(
      fc.property(prefix, fc.oneof(fc.constant(''), slugish.map((s) => `/${s}`)), (p, rest) => {
        expect(isReserved(`/${p}${rest}`)).toBe(true)
      }),
      fuzzParams(),
    )
  }, fuzzTimeout())
})

