import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { DumpError } from '../sql/dump.js'
import { ArchiveError, entryPath, overRatio, shown, tooLarge, tooMany, type ArchiveLimits } from './rules.js'

// A minimal, read-only tar reader (ustar, pax and GNU long names) over node:zlib. It never touches
// the file system itself: it hands each regular file to the caller, which decides whether to keep it.
// Only regular files and folders are accepted; links, devices, FIFOs, sparse and volume entries
// refuse the archive. A gzip stream cannot be read at random, so the caller extracts what it needs
// (see index.ts) in one pass.

const BLOCK = 512
/** pax and GNU long-name headers are read into memory; real ones are a few hundred bytes. */
const MAX_META = 1024 * 1024

export interface TarSink {
  write(chunk: Buffer): Promise<void>
  close(): Promise<void>
}

/** Called for each regular file with its checked path; return a sink to keep its content. */
export type TarVisitor = (rel: string, size: number) => Promise<TarSink | undefined>

/** Pulls exact byte counts out of a stream, tracking how much was unpacked. */
class ByteReader {
  readonly #it: AsyncIterator<Buffer>
  #buf: Buffer = Buffer.alloc(0)
  unpacked = 0
  constructor(stream: Readable, private readonly onFill: () => void) {
    this.#it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>
  }

  async #fill(): Promise<boolean> {
    const next = await this.#it.next()
    if (next.done) return false
    this.unpacked += next.value.length
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, next.value]) : next.value
    this.onFill()
    return true
  }

  /** Exactly `n` bytes; null at a clean end of stream. */
  async exact(n: number): Promise<Buffer | null> {
    while (this.#buf.length < n) {
      if (!(await this.#fill())) {
        if (this.#buf.length === 0) return null
        throw new DumpError('DUMP_INVALID', 'The tar archive is truncated.')
      }
    }
    const out = this.#buf.subarray(0, n)
    this.#buf = this.#buf.subarray(n)
    return out
  }

  /** The next `n` bytes in pieces, without holding them all. */
  async *take(n: number): AsyncGenerator<Buffer> {
    let left = n
    while (left > 0) {
      if (this.#buf.length === 0 && !(await this.#fill())) throw new DumpError('DUMP_INVALID', 'The tar archive is truncated.')
      const part = this.#buf.subarray(0, Math.min(left, this.#buf.length))
      this.#buf = this.#buf.subarray(part.length)
      left -= part.length
      yield part
    }
  }
}

const cstring = (b: Buffer) => {
  const end = b.indexOf(0)
  return (end === -1 ? b : b.subarray(0, end)).toString('utf8')
}

/** A numeric header field: octal text, or GNU base-256 when the top bit is set. NaN if invalid. */
function number(h: Buffer, off: number, len: number): number {
  const field = h.subarray(off, off + len)
  if ((field[0] ?? 0) & 0x80) {
    if (field[0] === 0xff) return NaN // negative
    let n = (field[0] as number) & 0x7f
    for (let i = 1; i < field.length; i++) n = n * 256 + (field[i] as number)
    return Number.isSafeInteger(n) ? n : NaN
  }
  const text = field.toString('latin1').replace(/[\0 ]+$/, '').replace(/^ +/, '')
  if (text === '') return 0
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : NaN
}

/** The header checksum: the unsigned byte sum with the checksum field read as spaces (signed sums accepted too). */
function checksumOk(h: Buffer): boolean {
  const stored = number(h, 148, 8)
  let unsigned = 0
  let signed = 0
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : (h[i] as number)
    unsigned += b
    signed += b > 127 ? b - 256 : b
  }
  return stored === unsigned || stored === signed
}

/** pax records: "<len> <key>=<value>\n". Only path and size matter here. */
function parsePax(archive: string, data: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {}
  let pos = 0
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos)
    const len = space === -1 ? NaN : Number(data.toString('latin1', pos, space))
    if (!Number.isSafeInteger(len) || len <= 0 || pos + len > data.length) throw new DumpError('DUMP_INVALID', `${archive} has a damaged pax header.`)
    const record = data.toString('utf8', space + 1, pos + len).replace(/\n$/, '')
    const eq = record.indexOf('=')
    const key = record.slice(0, eq)
    const value = record.slice(eq + 1)
    if (key === 'path') out.path = value
    if (key === 'size') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new DumpError('DUMP_INVALID', `${archive} has a damaged pax header.`)
      out.size = Number(value)
    }
    pos += len
  }
  return out
}

/** Reads a .tar or .tar.gz once, from the start, handing each regular file to `visit`. */
export async function readTar(archive: string, gzip: boolean, limits: ArchiveLimits, visit: TarVisitor): Promise<void> {
  const raw = createReadStream(archive, { highWaterMark: 64 * 1024 })
  let packed = 0
  raw.on('data', (chunk) => {
    packed += chunk.length
  })
  let stream: Readable = raw
  if (gzip) {
    const gunzip = createGunzip()
    raw.on('error', (error) => gunzip.destroy(error))
    stream = raw.pipe(gunzip)
  }
  const reader = new ByteReader(stream, () => {
    // Over the whole stream: a gzip bomb shows as unpacked bytes racing ahead of packed ones.
    if (gzip && overRatio(reader.unpacked, packed, limits)) {
      throw new ArchiveError('SEC_ARCHIVE_RATIO', archive, `it unpacks to over ${limits.maxRatio} times its packed size.`)
    }
  })

  let entries = 0
  let total = 0
  let longName: string | undefined
  let pax: { path?: string; size?: number } = {}
  const meta = async (size: number, what: string) => {
    if (size > MAX_META) throw new DumpError('DUMP_INVALID', `${archive} has a ${what} header over ${MAX_META} bytes.`)
    const data = size ? await reader.exact(size) : Buffer.alloc(0)
    if (!data) throw new DumpError('DUMP_INVALID', 'The tar archive is truncated.')
    await skip(size)
    return Buffer.from(data)
  }
  const skip = async (size: number) => {
    // Content is padded to whole blocks.
    const pad = (BLOCK - (size % BLOCK)) % BLOCK
    if (pad && !(await reader.exact(pad))) throw new DumpError('DUMP_INVALID', 'The tar archive is truncated.')
  }
  const drain = async (size: number) => {
    for await (const part of reader.take(size)) void part
    await skip(size)
  }

  try {
    for (;;) {
      const h = await reader.exact(BLOCK)
      // An all-zero block ends the archive; some writers stop without one.
      if (!h || h.every((b) => b === 0)) break
      if (!checksumOk(h)) {
        throw new DumpError('DUMP_INVALID', entries === 0 ? `${archive} is not a tar archive${gzip ? ' (a gzipped SQL dump goes in a sql source)' : ''}.` : `${archive} is a damaged tar archive.`)
      }
      if (++entries > limits.maxFiles) throw tooMany(archive, limits)
      const type = String.fromCharCode(h[156] as number)
      const headerSize = number(h, 124, 12)
      if (!Number.isSafeInteger(headerSize)) throw new DumpError('DUMP_INVALID', `${archive} is a damaged tar archive.`)
      const ustar = h.toString('latin1', 257, 263) === 'ustar\0'
      const prefix = ustar ? cstring(h.subarray(345, 500)) : ''
      const name = longName ?? pax.path ?? (prefix ? `${prefix}/${cstring(h.subarray(0, 100))}` : cstring(h.subarray(0, 100)))
      const size = pax.size ?? headerSize

      // Headers that describe the next entry.
      if (type === 'x') {
        pax = parsePax(archive, await meta(headerSize, 'pax'))
        continue
      }
      if (type === 'L') {
        longName = cstring(await meta(headerSize, 'long name'))
        continue
      }
      if (type === 'g' || type === 'K') {
        // Global pax defaults and long link names: nothing here uses them (links are refused).
        await meta(headerSize, 'pax')
        continue
      }
      longName = undefined
      pax = {}

      if (type === '1' || type === '2') throw new ArchiveError('SEC_ARCHIVE_LINK', archive, `the entry ${shown(name)} is a ${type === '1' ? 'hard' : 'symbolic'} link.`)
      const rel = entryPath(archive, name)
      if (type === '5') {
        await drain(size)
        continue
      }
      if (type !== '0' && type !== '\0' && type !== '7') {
        const what = type === '3' || type === '4' ? 'a device' : type === '6' ? 'a FIFO' : `of an unsupported type (${JSON.stringify(type)})`
        throw new ArchiveError('SEC_ARCHIVE_SPECIAL_FILE', archive, `the entry ${shown(name)} is ${what}, not a file.`)
      }
      // A tar.gz is unpacked whole, so every file counts, kept or not.
      total += size
      if (total > limits.maxTotalBytes) throw tooLarge(archive, limits)
      const sink = rel ? await visit(rel, size) : undefined
      try {
        for await (const part of reader.take(size)) if (sink) await sink.write(part)
      } finally {
        await sink?.close()
      }
      await skip(size)
    }
  } catch (error) {
    if (error instanceof DumpError) throw error
    if ((error as { code?: string }).code?.startsWith('Z_')) throw new DumpError('DUMP_INVALID', `${archive} is a damaged .tar.gz file.`)
    if ((error as { code?: string }).code === 'ENOENT') throw new DumpError('DUMP_NOT_FOUND', `Backup not found: ${archive}`)
    throw error
  } finally {
    raw.destroy()
    stream.destroy()
  }
}
