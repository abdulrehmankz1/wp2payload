// Generates the hacked-media fixtures (doc 12.14, AC-B1). Every sample is inert:
// PHP only echoes a word, scripts only call alert(). No real malware.
// Deterministic: running it twice yields byte-identical files.
// Usage: node tests/fixtures/hacked-media/generate.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const dir = dirname(fileURLToPath(import.meta.url))
const out = (name, bytes) => writeFileSync(join(dir, name), bytes)

const PHP = '<?php echo "x"; ?>'

// A small deterministic gradient, 16x16 RGB.
const W = 16
const H = 16
const raw = Buffer.alloc(W * H * 3)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3
    raw[i] = x * 16
    raw[i + 1] = y * 16
    raw[i + 2] = 128
  }
}
const img = () => sharp(raw, { raw: { width: W, height: H, channels: 3 } })

const jpeg = await img().jpeg({ quality: 80 }).toBuffer()
const png = await img().png().toBuffer()
const gif = await img().gif().toBuffer()
const webp = await img().webp({ quality: 80 }).toBuffer()

// Clean samples.
out('ok.jpg', jpeg)
out('ok.png', png)
out('ok.gif', gif)
out('ok.webp', webp)
out('ok.pdf', pdf(['<< /Type /Catalog /Pages 2 0 R >>']))
out('ok.mp4', mp4())
out('ok.mp3', mp3())

// T6: backdoor files.
out('logo.jpg.php', Buffer.from(PHP + '\n'))
out('shell.phtml', Buffer.from(PHP + '\n'))

// T6: PHP-in-JPEG polyglot: PHP in a COM segment right after SOI, and appended after EOI.
const com = Buffer.from(PHP, 'latin1')
const seg = Buffer.alloc(4)
seg.writeUInt16BE(0xfffe, 0)
seg.writeUInt16BE(com.length + 2, 2)
out('polyglot.jpg', Buffer.concat([jpeg.subarray(0, 2), seg, com, jpeg.subarray(2), Buffer.from(PHP)]))

// T7: scripted SVG.
out(
  'scripted.svg',
  Buffer.from(
    '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<script>alert(1)</script><rect width="10" height="10" onload="alert(2)"/></svg>\n',
  ),
)

// PDF with an automatic JavaScript action.
out(
  'js.pdf',
  pdf([
    '<< /Type /Catalog /Pages 2 0 R /OpenAction 3 0 R >>',
    '<< /Type /Action /S /JavaScript /JS (app.alert\\(1\\)) >>',
  ]),
)

// HTML disguised as an image.
out('fake.png', Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>\n'))

// JPEG carrying EXIF GPS tags (privacy: must be stripped by re-encoding).
out(
  'exif-gps.jpg',
  await img()
    .withExif({
      IFD0: { Make: 'wp2payload-fixture' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '0/1 7/1 0/1' },
    })
    .jpeg({ quality: 80 })
    .toBuffer(),
)

/** Minimal PDF. objs[0] is the catalog (object 1); object 2 is an empty page tree. */
function pdf(objs) {
  const all = [objs[0], '<< /Type /Pages /Kids [] /Count 0 >>', ...objs.slice(1)]
  let body = '%PDF-1.4\n'
  const offsets = []
  all.forEach((o, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${all.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${all.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/** Minimal ISO BMFF: an ftyp box (isom) plus an empty free box. */
function mp4() {
  const ftyp = Buffer.alloc(24)
  ftyp.writeUInt32BE(24, 0)
  ftyp.write('ftyp', 4, 'latin1')
  ftyp.write('isom', 8, 'latin1')
  ftyp.writeUInt32BE(0x200, 12)
  ftyp.write('isom', 16, 'latin1')
  ftyp.write('mp41', 20, 'latin1')
  const free = Buffer.alloc(8)
  free.writeUInt32BE(8, 0)
  free.write('free', 4, 'latin1')
  return Buffer.concat([ftyp, free])
}

/** Minimal MP3: an empty ID3v2.4 tag followed by one silent MPEG-1 Layer III frame header. */
function mp3() {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0])
  const frame = Buffer.alloc(417)
  frame.set([0xff, 0xfb, 0x90, 0x64])
  return Buffer.concat([id3, frame])
}
