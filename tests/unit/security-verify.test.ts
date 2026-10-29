import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { inspectMedia, scanPdf, checkSvg, type InspectOk, type InspectRejected } from '../../src/security/media/verify.js'

const fx = (name: string) => readFileSync(new URL(`../fixtures/hacked-media/${name}`, import.meta.url))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function ok(name: string, bytes = fx(name), extra: { allowSvg?: boolean; reencode?: boolean; declaredMime?: string } = {}) {
  const r = await inspectMedia({ bytes, filename: name, allowSvg: false, ...extra })
  if (!r.ok) throw new Error(`expected ok for ${name}, got ${r.finding.code}: ${r.finding.detail}`)
  return r as InspectOk
}
async function bad(name: string, bytes = fx(name), extra: { allowSvg?: boolean } = {}) {
  const r = await inspectMedia({ bytes, filename: name, allowSvg: false, ...extra })
  if (r.ok) throw new Error(`expected rejection for ${name}`)
  return r as InspectRejected
}

/** True when the EXIF block holds the GPS IFD pointer (tag 0x8825) in either byte order. */
const hasGpsPointer = (exif: Buffer | undefined) =>
  !!exif && (exif.includes(Buffer.from([0x25, 0x88])) || exif.includes(Buffer.from([0x88, 0x25])))

describe('allowlisted clean samples (AC-B3, AC-B4)', () => {
  it.each([
    ['ok.jpg', 'image/jpeg', 'jpg'],
    ['ok.png', 'image/png', 'png'],
    ['ok.gif', 'image/gif', 'gif'],
    ['ok.webp', 'image/webp', 'webp'],
    ['ok.pdf', 'application/pdf', 'pdf'],
    ['ok.mp4', 'video/mp4', 'mp4'],
    ['ok.mp3', 'audio/mpeg', 'mp3'],
  ])('%s passes as %s', async (name, mime, ext) => {
    const r = await ok(name)
    expect(r.mime).toBe(mime)
    expect(r.ext).toBe(ext)
    expect(r.sha256).toBe(sha(fx(name)))
    expect(r.filename).toMatch(new RegExp(`^ok-${r.sha256.slice(0, 8)}\\.${ext}$`))
    expect(r.findings).toEqual([])
  })

  it('accepts AVIF (generated at test time)', async () => {
    const avif = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } }).avif().toBuffer()
    const r = await ok('photo.avif', avif)
    expect(r.mime).toBe('image/avif')
    expect(r.reencoded).toBe(true)
  })

  it('accepts QuickTime .mov, with or without an ftyp box, byte-identical', async () => {
    const box = (t: string, body = Buffer.alloc(0)) => {
      const b = Buffer.alloc(8 + body.length)
      b.writeUInt32BE(b.length, 0)
      b.write(t, 4, 'latin1')
      body.copy(b, 8)
      return b
    }
    const modern = Buffer.concat([box('ftyp', Buffer.from('qt  \0\0\x02\0qt  ', 'latin1')), box('free')])
    const legacy = Buffer.concat([box('wide'), box('mdat', Buffer.alloc(8))])
    for (const [name, bytes] of [['Clip.MOV', modern], ['old.mov', legacy]] as const) {
      const r = await ok(name, bytes, { declaredMime: 'video/quicktime' })
      expect(r).toMatchObject({ mime: 'video/quicktime', ext: 'mov', reencoded: false, findings: [] })
      expect(r.output.equals(bytes)).toBe(true)
    }
  })

  it('accepts .jpeg as the extension of a JPEG and regenerates the filename', async () => {
    const r = await ok('Café Photo (1).JPEG', fx('ok.jpg'))
    expect(r.filename).toMatch(/^cafe-photo-1-[0-9a-f]{8}\.jpg$/)
  })

  it('PDF, MP4, MP3 pass through byte-identical; raster is re-encoded', async () => {
    for (const n of ['ok.pdf', 'ok.mp4', 'ok.mp3']) {
      const r = await ok(n)
      expect(r.output.equals(fx(n))).toBe(true)
      expect(r.reencoded).toBe(false)
    }
    const j = await ok('ok.jpg')
    expect(j.reencoded).toBe(true)
    expect((await sharp(j.output).metadata()).format).toBe('jpeg')
  })

  it('keeps GIF animation through re-encoding', async () => {
    const frame = (bg: string) => sharp({ create: { width: 4, height: 4, channels: 4, background: bg } }).png().toBuffer()
    const anim = await sharp([await frame('#000'), await frame('#fff')], { join: { animated: true } })
      .gif({ loop: 0, delay: [100, 100] })
      .toBuffer()
    const animated = await sharp(anim, { animated: true }).metadata()
    expect(animated.pages).toBe(2)
    const r = await ok('anim.gif', anim)
    expect((await sharp(r.output, { animated: true }).metadata()).pages).toBe(2)
  })
})

describe('hacked samples (AC-B3)', () => {
  it('rejects logo.jpg.php high, as executable', async () => {
    const r = await bad('logo.jpg.php')
    expect(r.finding).toMatchObject({ code: 'SEC_EXECUTABLE_UPLOAD', severity: 'high', action: 'rejected' })
    expect(r.quarantine.name).toBe('logo.jpg.php')
    expect(r.quarantine.bytes.equals(fx('logo.jpg.php'))).toBe(true)
  })

  it('rejects shell.phtml high', async () => {
    expect((await bad('shell.phtml')).finding).toMatchObject({ code: 'SEC_EXECUTABLE_UPLOAD', severity: 'high' })
  })

  it('rejects a real JPEG hidden behind an inner executable extension', async () => {
    for (const n of ['photo.php.jpg', 'photo.phar.jpg', 'x.PHP5.jpg', 'a.js.png', 'a.html.gif', '.htaccess', 'x.svgz', 'x.php.', 'x.php .jpg', 'x.php\u0000.jpg']) {
      const r = await bad(n, n.endsWith('png') ? fx('ok.png') : n.endsWith('gif') ? fx('ok.gif') : fx('ok.jpg'))
      expect(r.finding.code, n).toBe('SEC_EXECUTABLE_UPLOAD')
      expect(r.finding.severity).toBe('high')
    }
  })

  it('rejects HTML disguised as a PNG as a type mismatch', async () => {
    expect((await bad('fake.png')).finding).toMatchObject({ code: 'SEC_TYPE_MISMATCH', severity: 'high', action: 'rejected' })
  })

  it('rejects a valid image whose extension does not match its content', async () => {
    expect((await bad('photo.png', fx('ok.jpg'))).finding.code).toBe('SEC_TYPE_MISMATCH')
    expect((await bad('doc.pdf', fx('ok.png'))).finding.code).toBe('SEC_TYPE_MISMATCH')
    expect((await bad('noext', fx('ok.png'))).finding.code).toBe('SEC_TYPE_MISMATCH')
  })

  it('rejects types outside the allowlist as not allowed (medium), not as a disguise', async () => {
    const tiff = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).tiff().toBuffer()
    expect((await bad('a.tiff', tiff)).finding).toMatchObject({ code: 'SEC_TYPE_NOT_ALLOWED', severity: 'medium', action: 'rejected' })
    const zip = Buffer.from('504b0304140000000000000000000000000000000000000000000000000000', 'hex')
    expect((await bad('a.zip', zip)).finding.code).toBe('SEC_TYPE_NOT_ALLOWED')
    expect((await bad('notes.txt', Buffer.from('plain text'))).finding.code).toBe('SEC_TYPE_NOT_ALLOWED')
  })

  it('treats a disallowed type under an allowed extension as a disguise (high)', async () => {
    const zip = Buffer.from('504b0304140000000000000000000000000000000000000000000000000000', 'hex')
    expect((await bad('photo.jpg', zip)).finding).toMatchObject({ code: 'SEC_TYPE_MISMATCH', severity: 'high' })
    expect((await bad('clip.mov', fx('ok.png'))).finding.code).toBe('SEC_TYPE_MISMATCH')
  })

  it('polyglot JPEG comes out re-encoded without the PHP bytes', async () => {
    const src = fx('polyglot.jpg')
    expect(src.includes('<?php')).toBe(true)
    const r = await ok('polyglot.jpg')
    expect(r.output.includes('<?php')).toBe(false)
    expect(r.output.includes('echo')).toBe(false)
    expect(r.sha256).toBe(sha(src))
  })

  it('strips EXIF including GPS', async () => {
    const before = await sharp(fx('exif-gps.jpg')).metadata()
    expect(hasGpsPointer(before.exif)).toBe(true)
    const r = await ok('exif-gps.jpg')
    const after = await sharp(r.output).metadata()
    expect(after.exif).toBeUndefined()
    expect(r.output.includes('wp2payload-fixture')).toBe(false)
  })

  it('rejects a corrupt image that claims to be a JPEG', async () => {
    const broken = Buffer.concat([fx('ok.jpg').subarray(0, 20), Buffer.alloc(30, 7)])
    const r = await bad('broken.jpg', broken)
    expect(r.finding).toMatchObject({ code: 'SEC_IMAGE_UNDECODABLE', action: 'rejected' })
  })
})

describe('SVG (AC-B3, ADR-0010)', () => {
  const clean = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
      '<g style="fill: #000; stroke-width: 2"><rect width="10" height="10" fill="url(#g)"/><use xlink:href="#g"/>' +
      '<text x="1" y="5">Hi &amp; bye</text></g></svg>',
  )

  it('rejects SVG by default, even a clean one', async () => {
    expect((await bad('logo.svg', clean)).finding).toMatchObject({ code: 'SEC_SVG_REJECTED', severity: 'medium', action: 'rejected' })
    expect((await bad('scripted.svg')).finding).toMatchObject({ code: 'SEC_SVG_REJECTED', severity: 'high' })
  })

  it('with allowSvg, a clean SVG passes unchanged and is still reported', async () => {
    const r = await ok('logo.svg', clean, { allowSvg: true })
    expect(r.mime).toBe('image/svg+xml')
    expect(r.output.equals(clean)).toBe(true)
    expect(r.findings).toEqual([expect.objectContaining({ code: 'SEC_SVG_ALLOWED', severity: 'low', action: 'allowed' })])
  })

  it('with allowSvg, the scripted fixture is still rejected high', async () => {
    expect((await bad('scripted.svg', fx('scripted.svg'), { allowSvg: true })).finding).toMatchObject({ code: 'SEC_SVG_REJECTED', severity: 'high' })
  })

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT>alert(1)</SCRIPT></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect ONCLICK="alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="data:image/svg+xml;base64,AAAA"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://evil.example/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(javascript:alert(1))"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/#a)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/a.css);</style></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    '<?xml-stylesheet href="https://evil.example/a.xsl"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="href" to="javascript:alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" values="javascript:alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect/ onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="jav&#x61;script:alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[<script>alert(1)</script>]]></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><!-- --><rect/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script></svg>',
    'not svg at all',
  ])('checkSvg rejects %s', (s) => {
    expect(checkSvg(Buffer.from(s)).ok).toBe(false)
  })
})

describe('PDF active content (AC-B3)', () => {
  it('quarantines js.pdf as medium SEC_PDF_ACTIVE_CONTENT', async () => {
    const r = await bad('js.pdf')
    expect(r.finding).toMatchObject({ code: 'SEC_PDF_ACTIVE_CONTENT', severity: 'medium', action: 'quarantined' })
    expect(r.quarantine.bytes.equals(fx('js.pdf'))).toBe(true)
  })

  it.each([
    ['/JavaScript'], ['/JS'], ['/OpenAction'], ['/Launch'], ['/AA'], ['/J#61vaScript'], ['/#4F#70enAction'], ['/L#61unch'],
  ])('scanPdf finds %s', (name) => {
    const pdf = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog ${name} 2 0 R >> endobj\n%%EOF`)
    expect(scanPdf(pdf).length).toBeGreaterThan(0)
  })

  it('does not flag names that merely start with a keyword', () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /JSONData 1 /AAPL 2 /Launcher 3 >> endobj\n%%EOF')
    expect(scanPdf(pdf)).toEqual([])
  })

  it('finds actions hidden inside a Flate-compressed stream', async () => {
    const { deflateSync } = await import('node:zlib')
    const inner = deflateSync(Buffer.from('<< /S /JavaScript /JS (app.alert(1)) >>'))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.5\n1 0 obj << /Type /ObjStm /Filter /FlateDecode /Length ' + inner.length + ' >>\nstream\n'),
      inner,
      Buffer.from('\nendstream\nendobj\n%%EOF'),
    ])
    expect(scanPdf(pdf)).toContain('JavaScript')
  })

  it('fails closed on an object stream it cannot decode (ASCIIHex, LZW, filter chains)', () => {
    const pdf = Buffer.from(
      '%PDF-1.5\n1 0 obj << /Type /ObjStm /Filter /ASCIIHexDecode /DecodeParms << /Columns 4 >> /Length 8 >>\nstream\n2F4A5320>\nendstream\nendobj\n%%EOF',
    )
    expect(scanPdf(pdf)).toEqual(['ObjStm (undecodable)'])
  })

  it('ignores undecodable image streams, which cannot carry actions', () => {
    const pdf = Buffer.from('%PDF-1.5\n1 0 obj << /Type /XObject /Subtype /Image /Filter /DCTDecode /Length 4 >>\nstream\n\xff\xd8\xff\xe0\nendstream\nendobj\n%%EOF', 'latin1')
    expect(scanPdf(pdf)).toEqual([])
  })
})

describe('reencode disabled (ADR-0011)', () => {
  it('keeps the original bytes and emits a low finding', async () => {
    const r = await ok('polyglot.jpg', fx('polyglot.jpg'), { reencode: false })
    expect(r.output.equals(fx('polyglot.jpg'))).toBe(true)
    expect(r.reencoded).toBe(false)
    expect(r.findings).toEqual([expect.objectContaining({ code: 'SEC_REENCODE_DISABLED', severity: 'low' })])
  })

  it('still rejects executables and mismatches with reencode off', async () => {
    const r = await inspectMedia({ bytes: fx('fake.png'), filename: 'fake.png', allowSvg: false, reencode: false })
    expect(r.ok).toBe(false)
  })
})

describe('declared MIME', () => {
  it('flags (low) a declared MIME that disagrees with the content', async () => {
    const r = await ok('ok.jpg', fx('ok.jpg'), { declaredMime: 'image/png' })
    expect(r.findings).toEqual([expect.objectContaining({ code: 'SEC_MIME_MISMATCH', severity: 'low', action: 'flagged' })])
    const s = await ok('ok.jpg', fx('ok.jpg'), { declaredMime: 'image/jpeg; charset=binary' })
    expect(s.findings).toEqual([])
  })
})
