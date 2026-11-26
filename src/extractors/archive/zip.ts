import type { Readable } from 'node:stream'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { MediaError, SecurityError } from '../../security/errors.js'
import { DumpError } from '../sql/dump.js'
import { ArchiveError, checkMode, entryPath, shown, type ArchiveLimits } from './rules.js'

// Zip backups (Duplicator, UpdraftPlus uploads, hand-made) are read in place with yauzl: the central
// directory is indexed once, and each entry is inflated only when it is read. Nothing is written to
// disk. Names are decoded here, not by yauzl, so a hostile name gets a SEC_ARCHIVE_* code instead of
// a generic parse error. yauzl checks every entry's real size against the declared one as it
// streams, so declared sizes can be trusted for the caps.

export interface ZipIndex {
  file: string
  zip: ZipFile
  /** Regular files by checked path; the first of duplicate names wins. */
  files: Map<string, Entry>
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

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
  const files = new Map<string, Entry>()
  try {
    // The count is in the end record: refuse before reading a single entry.
    if (zip.entryCount > limits.maxFiles) {
      throw new ArchiveError('SEC_ARCHIVE_TOO_MANY_FILES', file, `it has ${zip.entryCount} entries; the limit is ${limits.maxFiles}.`)
    }
    for await (const entry of zip.eachEntry()) {
      const raw = entryName(entry)
      const rel = entryPath(file, raw)
      checkMode(file, raw, entry.externalFileAttributes >>> 16)
      if (/[/\\]$/.test(raw) || !rel) continue
      if (!files.has(rel)) files.set(rel, entry)
    }
  } catch (error) {
    zip.close()
    if (error instanceof DumpError) throw error
    throw new DumpError('DUMP_INVALID', `${file} is a damaged zip archive.`)
  }
  return { file, zip, files }
}

/** An entry wp2payload will read: refused up front if it is encrypted or packed in a way yauzl cannot unpack. */
export function checkReadable(ix: ZipIndex, rel: string, e: Entry): void {
  if (e.isEncrypted()) throw new DumpError('DUMP_INVALID', `The entry ${shown(rel)} is encrypted; encrypted backups cannot be read.`)
  if (!e.canDecodeFileData()) throw new DumpError('DUMP_INVALID', `The entry ${shown(rel)} uses compression method ${e.compressionMethod}; only stored and deflated zip entries can be read.`)
}

export const openZipEntry = (ix: ZipIndex, e: Entry): Promise<Readable> => ix.zip.openReadStreamPromise(e)

/** A whole entry into memory, under `maxBytes` (checked before inflating, and again while streaming). */
export async function readZipEntry(ix: ZipIndex, rel: string, e: Entry, maxBytes: number): Promise<Buffer> {
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
