import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import type { SecurityFinding } from '../../report/types.js'

// File verification (doc 2.5, 12.6 items 4-9; threats T6, T7, T10; ADR-0010, ADR-0011).

export interface InspectInput {
  bytes: Buffer
  /** Original file name (attacker-controlled). Only its basename is used. */
  filename: string
  declaredMime?: string
  allowSvg: boolean
  /** `media.reencode`. Default true. Disabling it is reported (ADR-0011). */
  reencode?: boolean
}

export interface InspectOk {
  ok: true
  mime: string
  ext: string
  /** SHA-256 of the original bytes (doc 2.5): stable across sharp versions. */
  sha256: string
  /** Bytes to store: re-encoded for raster images, otherwise the original. */
  output: Buffer
  reencoded: boolean
  /** Regenerated name: slug + 8-char hash + canonical extension. */
  filename: string
  /** Non-blocking findings to report (SVG allowed, re-encoding disabled, MIME disagreement). */
  findings: SecurityFinding[]
}

export interface InspectRejected {
  ok: false
  sha256: string
  finding: SecurityFinding
  /** Original bytes and basename for writeQuarantine(kind 'files'). */
  quarantine: { bytes: Buffer; name: string }
}

export type InspectResult = InspectOk | InspectRejected

interface Allowed {
  mime: string
  ext: string
  exts: readonly string[]
  kind: 'raster' | 'pdf' | 'passthrough'
}

/** Doc 12.6 item 4 allowlist, keyed by the type file-type detects from magic bytes. */
const ALLOWED: Record<string, Allowed> = {
  'image/jpeg': { mime: 'image/jpeg', ext: 'jpg', exts: ['jpg', 'jpeg', 'jpe'], kind: 'raster' },
  'image/png': { mime: 'image/png', ext: 'png', exts: ['png'], kind: 'raster' },
  'image/gif': { mime: 'image/gif', ext: 'gif', exts: ['gif'], kind: 'raster' },
  'image/webp': { mime: 'image/webp', ext: 'webp', exts: ['webp'], kind: 'raster' },
  'image/avif': { mime: 'image/avif', ext: 'avif', exts: ['avif'], kind: 'raster' },
  'application/pdf': { mime: 'application/pdf', ext: 'pdf', exts: ['pdf'], kind: 'pdf' },
  'video/mp4': { mime: 'video/mp4', ext: 'mp4', exts: ['mp4', 'm4v'], kind: 'passthrough' },
  // Owner decision 2026-10-29: QuickTime is MP4's parent container, same risk, common from phones.
  'video/quicktime': { mime: 'video/quicktime', ext: 'mov', exts: ['mov', 'qt'], kind: 'passthrough' },
  'audio/mpeg': { mime: 'audio/mpeg', ext: 'mp3', exts: ['mp3'], kind: 'passthrough' },
}

/** Extensions a web server may execute or a browser may render as active content. Any position counts. */
const EXECUTABLE = new Set([
  'php', 'php2', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phtml', 'pht', 'phps', 'phar', 'inc',
  'js', 'mjs', 'cjs', 'html', 'htm', 'xhtml', 'shtml', 'xht', 'svgz', 'htaccess', 'htpasswd', 'ini',
  'asp', 'aspx', 'ashx', 'asmx', 'cer', 'jsp', 'jspx', 'cgi', 'pl', 'py', 'rb', 'sh', 'bash',
  'exe', 'dll', 'bat', 'cmd', 'ps1', 'vbs', 'wsf', 'hta', 'jar', 'swf', 'xml', 'xsl', 'xslt',
])

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function basename(name: string): string {
  const parts = name.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Lowercase extension segments after the first dot. Each segment is reduced to its leading
 * alphanumeric run after removing whitespace and control characters, so `x.php .jpg`,
 * `x.ph\0p.jpg` and `x.php::$DATA` all yield `php`.
 */
function extSegments(base: string): string[] {
  return base
    .toLowerCase()
    .split('.')
    .slice(1)
    .map((s) => /^[a-z0-9]*/.exec(s.replace(/[\s\u0000-\u001f\u007f]/g, ''))?.[0] ?? '')
    .filter(Boolean)
}

export function slugify(stem: string): string {
  const s = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return s || 'file'
}

function regeneratedName(base: string, hash: string, ext: string): string {
  const dot = base.lastIndexOf('.')
  return `${slugify(dot > 0 ? base.slice(0, dot) : base)}-${hash.slice(0, 8)}.${ext}`
}

function reject(bytes: Buffer, hash: string, name: string, finding: Omit<SecurityFinding, 'file'>): InspectRejected {
  return { ok: false, sha256: hash, finding: { ...finding, file: name }, quarantine: { bytes, name } }
}

export async function inspectMedia(input: InspectInput): Promise<InspectResult> {
  const { bytes, allowSvg } = input
  const reencode = input.reencode ?? true
  const hash = sha256(bytes)
  const name = basename(input.filename)
  const exts = extSegments(name)
  const last = exts[exts.length - 1]

  // 1. Executable extension anywhere in the name (logo.jpg.php, photo.php.jpg, .htaccess).
  const exe = exts.find((e) => EXECUTABLE.has(e))
  if (exe) {
    return reject(bytes, hash, name, {
      code: 'SEC_EXECUTABLE_UPLOAD',
      severity: 'high',
      action: 'rejected',
      detail: `File name has an executable extension (.${exe}).`,
    })
  }

  const detected = await fileTypeFromBuffer(bytes)

  // 2. SVG (ADR-0010): by name or by content that looks like SVG.
  if (last === 'svg' || ((!detected || detected.mime === 'application/xml') && looksLikeSvg(bytes))) {
    const check = checkSvg(bytes)
    if (!allowSvg || !check.ok || last !== 'svg') {
      return reject(bytes, hash, name, {
        code: 'SEC_SVG_REJECTED',
        severity: check.ok ? 'medium' : 'high',
        action: 'rejected',
        detail: !check.ok
          ? `SVG contains forbidden content: ${check.reason}.`
          : last !== 'svg'
            ? 'SVG content under a non-SVG file name.'
            : 'SVG files are rejected by default. Use --allow-svg to import sanitised SVG.',
      })
    }
    return {
      ok: true,
      mime: 'image/svg+xml',
      ext: 'svg',
      sha256: hash,
      output: bytes,
      reencoded: false,
      filename: regeneratedName(name, hash, 'svg'),
      findings: [
        { code: 'SEC_SVG_ALLOWED', severity: 'low', action: 'allowed', file: name, detail: 'SVG allowed by --allow-svg after a strict check.' },
      ],
    }
  }

  // 3. Magic bytes must be on the allowlist and agree with the extension. A name that claims an
  // allowed type with other content is a disguise (high); an honest unsupported type is medium.
  const allowed = detected ? ALLOWED[detected.mime] : undefined
  const claimsAllowed = !!last && Object.values(ALLOWED).some((a) => a.exts.includes(last))
  if (!allowed && !claimsAllowed) {
    return reject(bytes, hash, name, {
      code: 'SEC_TYPE_NOT_ALLOWED',
      severity: 'medium',
      action: 'rejected',
      detail: `Content is ${detected ? detected.mime : 'an unrecognised type'}, which is not an allowed media type.`,
    })
  }
  if (!allowed || !last || !allowed.exts.includes(last)) {
    return reject(bytes, hash, name, {
      code: 'SEC_TYPE_MISMATCH',
      severity: 'high',
      action: 'rejected',
      detail: !allowed
        ? `File name says .${last} but content is ${detected ? detected.mime : 'an unrecognised type'}.`
        : `Content is ${allowed.mime} but the extension is ${last ? '.' + last : 'missing'}.`,
    })
  }

  const findings: SecurityFinding[] = []
  if (input.declaredMime) {
    const declared = input.declaredMime.split(';')[0]?.trim().toLowerCase()
    const normalised = declared === 'image/jpg' || declared === 'image/pjpeg' ? 'image/jpeg' : declared === 'audio/mp3' ? 'audio/mpeg' : declared
    if (normalised !== allowed.mime) {
      findings.push({
        code: 'SEC_MIME_MISMATCH',
        severity: 'low',
        action: 'flagged',
        file: name,
        detail: `Declared ${declared ?? '?'} but content is ${allowed.mime}.`,
      })
    }
  }
  const filename = regeneratedName(name, hash, allowed.ext)
  const okResult = (output: Buffer, reencoded: boolean): InspectOk => ({
    ok: true, mime: allowed.mime, ext: allowed.ext, sha256: hash, output, reencoded, filename, findings,
  })

  // 4. PDF: never re-encoded; active content is quarantined (doc 12.6 item 9).
  if (allowed.kind === 'pdf') {
    const hits = scanPdf(bytes)
    if (hits.length > 0) {
      return reject(bytes, hash, name, {
        code: 'SEC_PDF_ACTIVE_CONTENT',
        severity: 'medium',
        action: 'quarantined',
        detail: `PDF contains active content: ${hits.map((h) => '/' + h).join(', ')}.`,
      })
    }
    return okResult(bytes, false)
  }
  if (allowed.kind === 'passthrough') return okResult(bytes, false)

  // 5. Raster: re-encode (ADR-0011). Default sharp output drops all metadata (EXIF, GPS, XMP, ICC, comments).
  if (!reencode) {
    findings.push({
      code: 'SEC_REENCODE_DISABLED',
      severity: 'low',
      action: 'allowed',
      file: name,
      detail: 'media.reencode is false: image stored with original bytes and metadata.',
    })
    return okResult(bytes, false)
  }
  try {
    return okResult(await reencodeRaster(bytes, allowed.mime), true)
  } catch {
    return reject(bytes, hash, name, {
      code: 'SEC_IMAGE_UNDECODABLE',
      severity: 'medium',
      action: 'rejected',
      detail: `File looks like ${allowed.mime} but could not be decoded.`,
    })
  }
}

async function reencodeRaster(bytes: Buffer, mime: string): Promise<Buffer> {
  const animatable = mime === 'image/gif' || mime === 'image/webp'
  const opts = { animated: animatable, failOn: 'error' as const, limitInputPixels: 100_000_000 }
  const pages = animatable ? ((await sharp(bytes, opts).metadata()).pages ?? 1) : 1
  // Apply EXIF orientation before the EXIF is dropped; skipped for multi-frame images.
  let img = sharp(bytes, opts)
  if (pages === 1) img = img.rotate()
  switch (mime) {
    case 'image/jpeg':
      return img.jpeg({ quality: 90 }).toBuffer()
    case 'image/png':
      return img.png().toBuffer()
    case 'image/webp':
      return img.webp({ quality: 90 }).toBuffer()
    case 'image/avif':
      return img.avif({ quality: 90 }).toBuffer()
    case 'image/gif':
      return img.gif().toBuffer()
    default:
      throw new Error(`not a raster type: ${mime}`)
  }
}

// ---------- PDF ----------

const PDF_ACTIVE = new Set(['JavaScript', 'JS', 'OpenAction', 'Launch', 'AA'])
const MAX_INFLATE_TOTAL = 64 * 1024 * 1024

/** Returns the active-content names found (decoded `#xx` escapes), including inside Flate streams. */
export function scanPdf(bytes: Buffer): string[] {
  const found = new Set<string>()
  scanNames(bytes.toString('latin1'), found)
  let budget = MAX_INFLATE_TOTAL
  const text = bytes.toString('latin1')
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) && budget > 0) {
    const start = m.index + m[0].length
    const end = text.indexOf('endstream', start)
    if (end < 0) break
    // Object streams hold whole PDF objects, so an action can hide in one. Image and content
    // streams cannot define actions, so only an undecodable object stream fails closed.
    const dict = text.slice(Math.max(0, m.index - 2048), m.index)
    const objStart = [...dict.matchAll(/\d+\s+\d+\s+obj\b/g)].pop()?.index ?? 0
    const isObjStm = /\/Type\s*\/ObjStm\b/.test(dict.slice(objStart))
    try {
      const out = inflateSync(bytes.subarray(start, end), { maxOutputLength: budget })
      budget -= out.length
      scanNames(out.toString('latin1'), found)
    } catch {
      // Not Flate, truncated or over budget: the raw scan above still applies.
      if (isObjStm) found.add('ObjStm (undecodable)')
    }
    re.lastIndex = end
  }
  return [...found]
}

function scanNames(text: string, found: Set<string>): void {
  // A PDF name: '/' followed by regular characters (ISO 32000 7.3.5); '#xx' escapes any byte.
  for (const m of text.matchAll(/\/([^\s/[\]()<>{}%\u0000]+)/g)) {
    const raw = m[1] ?? ''
    const decoded = raw.replace(/#([0-9a-fA-F]{2})/g, (_s, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
    if (PDF_ACTIVE.has(decoded)) found.add(decoded)
  }
}

// ---------- SVG ----------

function looksLikeSvg(bytes: Buffer): boolean {
  return /<svg[\s>/]/i.test(bytes.subarray(0, 4096).toString('utf8'))
}

const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'metadata', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'text', 'tspan', 'textpath', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask',
  'pattern', 'marker', 'style',
])

const SVG_ATTRS = new Set([
  'id', 'class', 'style', 'width', 'height', 'viewbox', 'xmlns', 'xmlns:xlink', 'version', 'x', 'y', 'x1', 'y1', 'x2',
  'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'd', 'points', 'pathlength', 'fill', 'fill-opacity', 'fill-rule', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-opacity', 'opacity', 'transform', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
  'spreadmethod', 'clip-path', 'clippathunits', 'clip-rule', 'mask', 'maskunits', 'maskcontentunits', 'patternunits',
  'patterncontentunits', 'patterntransform', 'preserveaspectratio', 'font-family', 'font-size', 'font-weight',
  'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'word-spacing', 'dx', 'dy', 'rotate',
  'visibility', 'display', 'color', 'href', 'xlink:href', 'xml:space', 'markerwidth', 'markerheight', 'refx', 'refy',
  'orient', 'markerunits', 'vector-effect', 'shape-rendering', 'enable-background', 'data-name',
])

const XML_DECL = /^﻿?\s*<\?xml\s[^<>?]*\?>/
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g

/** Checks CSS text (style attribute or <style> body): no imports, escapes or URLs except local `url(#id)`. */
function cssSafe(css: string): boolean {
  const withoutLocalUrls = css.replace(/url\(\s*(['"]?)#[A-Za-z_][\w.-]*\1\s*\)/gi, '')
  return !/[\\<>@]|url\s*\(|expression|javascript|behavio(u)?r|-moz-binding|image-set|src\s*\(/i.test(withoutLocalUrls)
}

/**
 * Strict SVG check (ADR-0010): validate-and-reject, not a rewriting sanitiser. The SVG is accepted
 * unchanged only when every element, attribute and value is on a small allowlist; anything else
 * (script, foreignObject, event handlers, animation, external or javascript:/data: references,
 * DOCTYPE/entities, CDATA, comments, processing instructions) rejects the whole file.
 */
export function checkSvg(bytes: Buffer): { ok: true } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason })
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return fail('not valid UTF-8')
  }
  text = text.replace(XML_DECL, '')
  if (/<[!?]/.test(text)) return fail('DOCTYPE, entity, CDATA, comment or processing instruction')
  if (!/^\s*<svg[\s>/]/.test(text)) return fail('document does not start with <svg>')

  // Tokenise: everything is either a tag or text between tags.
  const tagRe = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y
  let pos = 0
  const stack: string[] = []
  while (pos < text.length) {
    const lt = text.indexOf('<', pos)
    const chunk = lt < 0 ? text.slice(pos) : text.slice(pos, lt)
    if (chunk.includes('>') && stack[stack.length - 1] !== 'style') return fail('stray ">" in text')
    if (chunk.replace(ENTITY, '').includes('&')) return fail('entity reference')
    if (stack[stack.length - 1] === 'style' && !cssSafe(chunk)) return fail('unsafe CSS in <style>')
    if (lt < 0) break
    tagRe.lastIndex = lt
    const m = tagRe.exec(text)
    if (!m) return fail('malformed tag')
    const [, closing, rawName = '', attrs = '', selfClose] = m
    const name = rawName.toLowerCase()
    if (!SVG_ELEMENTS.has(name)) return fail(`element <${rawName}>`)
    if (closing) {
      if (attrs.trim() || selfClose) return fail('malformed closing tag')
      if (stack.pop() !== name) return fail('unbalanced tags')
    } else {
      for (const a of attrs.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const an = (a[1] ?? '').toLowerCase()
        const rawValue = a[2] ?? a[3] ?? ''
        if (!SVG_ATTRS.has(an)) return fail(`attribute ${a[1]}`)
        if (rawValue.replace(ENTITY, '').includes('&')) return fail('entity reference in attribute')
        if (/&#/.test(rawValue)) return fail('character reference in attribute')
        const v = rawValue.trim()
        if (an === 'href' || an === 'xlink:href') {
          if (!/^#[A-Za-z_][\w.-]*$/.test(v)) return fail(`${an} must be a local #fragment`)
        } else if (an === 'style') {
          if (!cssSafe(v)) return fail('unsafe style attribute')
        } else if (/url\s*\(/i.test(v) && !/^url\(\s*(['"]?)#[A-Za-z_][\w.-]*\1\s*\)$/i.test(v)) {
          return fail(`${an} references a non-local url()`)
        } else if (/(java|vb)script\s*:|data\s*:/i.test(v)) {
          return fail(`${an} contains a script or data URL`)
        }
      }
      if (!selfClose) stack.push(name)
    }
    pos = tagRe.lastIndex
  }
  if (stack.length) return fail('unclosed tags')
  return { ok: true }
}
