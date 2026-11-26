import type { Readable } from 'node:stream'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { MediaError, SecurityError } from '../../security/errors.js'
import { DumpError } from '../sql/dump.js'
import { ArchiveError, checkMode, entryPath, shown, type ArchiveLimits } from './rules.js'

// Zip backups (Duplicator, UpdraftPlus uploads, hand-made) are read in place with yauzl: the central
// directory is indexed once, and each entry is inflated only when it is read. Nothing is written to
// disk. Names are decoded here, not by yauzl, so a hostile name gets a SEC_ARCHIVE_* code instead of
// a generic parse error. yauzl checks every entry's real size against the declared one as it
// streams, so declared sizes can be trusted for the caps. Entries whose data overlap (a zip bomb
// that inflates the same bytes many times) refuse the archive.

/** What is kept of a yauzl Entry: an index of up to a million entries holds only these fields. */
export interface ZipEntry {
  /** Offset of the local file header. */
  offset: number
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  generalPurposeBitFlag: number
}

export interface ZipIndex {
  file: string
  zip: ZipFile
  /** Regular files by checked path; the first of duplicate names wins. */
  files: Map<string, ZipEntry>
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The smallest local record: a 30-byte header (name and extra field may add more) and the data. */
const LOCAL_HEADER = 30

/**
 * The entry name. Zips flag UTF-8 names, or carry them in an Info-ZIP extra field; otherwise the
 * spec says CP437, but PHP (Duplicator, UpdraftPlus) writes raw UTF-8 without the flag, and an
 * upload named café.jpg must match the dump. So valid UTF-8 is read as UTF-8, the rest as yauzl does.
 */
function entryName(e: Entry): string {
  const flagged = (e.generalPurposeBitFlag & 0x800) !== 0 || e.extraFields.some((f) => f.id === 0x7075)
  if (!flagged) {
    try {
      return utf8.decode(e.fileNameRaw)
    } catch {
      // Not UTF-8: fall through to CP437.
    }
  }
  return yauzl.getFileNameLowLevel(e.generalPurposeBitFlag, e.fileNameRaw, e.extraFields, true)
}

/**
 * Refuses entries whose local records overlap. Each record takes at least 30 + compressedSize
 * bytes from its offset, so a record that starts before the previous one ends shares its bytes:
 * real zip tools never write that, overlap bombs (several entries over one deflate stream) do.
 */
function checkOverlap(file: string, starts: Float64Array, ends: Float64Array): void {
  const order = new Uint32Array(starts.length)
  for (let i = 0; i < order.length; i++) order[i] = i
  order.sort((a, b) => (starts[a] as number) - (starts[b] as number))
  for (let i = 1; i < order.length; i++) {
    const prev = order[i - 1] as number
    const cur = order[i] as number
    if ((starts[cur] as number) < (ends[prev] as number)) {
      // Entry numbers, not names: the index keeps no name for folders and skipped entries.
      throw new ArchiveError('SEC_ARCHIVE_OVERLAP', file, `entries ${Math.min(prev, cur) + 1} and ${Math.max(prev, cur) + 1} of the zip share data.`)
    }
  }
}

export async function indexZip(file: string, limits: ArchiveLimits): Promise<ZipIndex> {
  let zip: ZipFile
  try {
    zip = await yauzl.openPromise(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true, strictFileNames: false })
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw new DumpError('DUMP_NOT_FOUND', `Backup not found: ${file}`)
    throw new DumpError('DUMP_INVALID', `${file} is not a zip archive, or it is damaged.`)
  }
  // Errors reach the caller through the promise APIs; a stray one must not crash the process.
  zip.on('error', () => {})
  const files = new Map<string, ZipEntry>()
  try {
    // The count is in the end record: refuse before reading a single entry.
    if (zip.entryCount > limits.maxFiles) {
      throw new ArchiveError('SEC_ARCHIVE_TOO_MANY_FILES', file, `it has ${zip.entryCount} entries; the limit is ${limits.maxFiles}.`)
    }
    // Every entry's record, folders and skipped names included: overlaps are judged over all of them.
    const starts = new Float64Array(zip.entryCount)
    const ends = new Float64Array(zip.entryCount)
    let i = 0
    for await (const entry of zip.eachEntry()) {
      const raw = entryName(entry)
      const rel = entryPath(file, raw)
      checkMode(file, raw, entry.externalFileAttributes >>> 16)
      starts[i] = entry.relativeOffsetOfLocalHeader
      ends[i] = entry.relativeOffsetOfLocalHeader + LOCAL_HEADER + entry.compressedSize
      i++
      if (/[/\\]$/.test(raw) || !rel) continue
      if (!files.has(rel)) {
        files.set(rel, {
          offset: entry.relativeOffsetOfLocalHeader,
          compressedSize: entry.compressedSize,
          uncompressedSize: entry.uncompressedSize,
          compressionMethod: entry.compressionMethod,
          generalPurposeBitFlag: entry.generalPurposeBitFlag,
        })
      }
    }
    checkOverlap(file, starts.subarray(0, i), ends.subarray(0, i))
  } catch (error) {
    zip.close()
    if (error instanceof DumpError) throw error
    throw new DumpError('DUMP_INVALID', `${file} is a damaged zip archive.`)
  }
  return { file, zip, files }
}

const isEncrypted = (e: ZipEntry) => (e.generalPurposeBitFlag & 0x1) !== 0

/** An entry wp2payload will read: refused up front if it is encrypted or packed in a way yauzl cannot unpack. */
export function checkReadable(ix: ZipIndex, rel: string, e: ZipEntry): void {
  if (isEncrypted(e)) throw new DumpError('DUMP_INVALID', `The entry ${shown(rel)} is encrypted; encrypted backups cannot be read.`)
  if (e.compressionMethod !== 0 && e.compressionMethod !== 8) {
    throw new DumpError('DUMP_INVALID', `The entry ${shown(rel)} uses compression method ${e.compressionMethod}; only stored and deflated zip entries can be read.`)
  }
}

/**
 * The entry's content as a stream, from the kept fields: yauzl reads the local header to find the
 * data, then inflates it (deflate) or reads it as is (stored, where yauzl has already checked that
 * both sizes agree), checking the unpacked size as it streams.
 */
export function openZipEntry(ix: ZipIndex, e: ZipEntry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    if (!ix.zip.isOpen) {
      reject(new Error('closed'))
      return
    }
    if (isEncrypted(e) || (e.compressionMethod !== 0 && e.compressionMethod !== 8)) {
      reject(new Error(`unsupported zip entry (method ${e.compressionMethod})`))
      return
    }
    // readLocalFileHeader reads only these two fields of the entry.
    const located = { relativeOffsetOfLocalHeader: e.offset, compressedSize: e.compressedSize } as Entry
    ix.zip.readLocalFileHeader(located, { minimal: true }, (error, header) => {
      if (error) return reject(error)
      ix.zip.openReadStreamLowLevel(header.fileDataStart, e.compressedSize, 0, e.compressedSize, e.compressionMethod === 8, e.uncompressedSize, (err, stream) =>
        err ? reject(err) : resolve(stream),
      )
    })
  })
}

/** A whole entry into memory, under `maxBytes` (checked before inflating, and again while streaming). */
export async function readZipEntry(ix: ZipIndex, rel: string, e: ZipEntry, maxBytes: number): Promise<Buffer> {
  if (e.uncompressedSize > maxBytes) throw new SecurityError('SEC_FILE_TOO_LARGE', `Media is ${e.uncompressedSize} bytes, over the ${maxBytes}-byte cap.`)
  let stream: Readable
  try {
    stream = await openZipEntry(ix, e)
  } catch {
    throw new MediaError('MEDIA_READ_FAILED', `Could not read ${rel} from the backup.`)
  }
  const chunks: Buffer[] = []
  let n = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      n += chunk.length
      if (n > maxBytes) throw new SecurityError('SEC_FILE_TOO_LARGE', `Media is over the ${maxBytes}-byte cap.`)
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof SecurityError) throw error
    throw new MediaError('MEDIA_READ_FAILED', `Could not read ${rel} from the backup (it is damaged).`)
  } finally {
    stream.destroy()
  }
  return Buffer.concat(chunks, n)
}
