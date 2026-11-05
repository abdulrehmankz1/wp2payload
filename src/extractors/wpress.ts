import { open, stat } from 'node:fs/promises'
import { MediaError, SecurityError } from '../security/errors.js'
import { DumpError } from './sql/dump.js'

// All-in-One WP Migration backups (.wpress, doc 12.7, T11). The archive is never unpacked: its
// headers are read once to find database.sql and the uploads, which are then read in place. Entry
// names are only lookup keys, so a path like ../../.env cannot write or read anything outside.
//
// Format: per entry a 4377-byte header (name[255], size[14], mtime[12], prefix[4096], NUL padded)
// followed by the content; an all-zero header ends the archive.

const HEADER = 4377
const MAX_ENTRIES = 1_000_000

export interface WpressEntry {
  offset: number
  size: number
}

export interface WpressIndex {
  file: string
  database: WpressEntry
  /** Keyed by the path below uploads/, with forward slashes. */
  uploads: Map<string, WpressEntry>
}

/** AI1WM replaces the table prefix with this placeholder in its dumps. */
export const WPRESS_TABLE_PREFIX = 'SERVMASK_PREFIX_'

const text = (b: Buffer, from: number, to: number) => b.subarray(from, to).toString('utf8').replace(/\0[\s\S]*$/, '')

export async function indexWpress(file: string): Promise<WpressIndex> {
  let size: number
  try {
    size = (await stat(file)).size
  } catch {
    throw new DumpError('DUMP_NOT_FOUND', `Backup not found: ${file}`)
  }
  const fh = await open(file, 'r')
  const uploads = new Map<string, WpressEntry>()
  let database: WpressEntry | undefined
  try {
    const h = Buffer.alloc(HEADER)
    let pos = 0
    for (let n = 0; ; n++) {
      if (n > MAX_ENTRIES) throw new DumpError('DUMP_INVALID', `The backup has over ${MAX_ENTRIES} files.`)
      const { bytesRead } = await fh.read(h, 0, HEADER, pos)
      if (bytesRead === 0 || (bytesRead === HEADER && h.every((x) => x === 0))) break
      if (bytesRead < HEADER) throw new DumpError('DUMP_INVALID', 'The .wpress backup is truncated.')
      // Newer versions end with a trailer that has no name (its size field holds the archive length).
      if (!text(h, 0, 255) && pos + HEADER === size) break
      const sizeText = text(h, 255, 269)
      if (!/^\d{1,14}$/.test(sizeText)) throw new DumpError('DUMP_INVALID', 'Not an All-in-One WP Migration backup, or it is damaged.')
      const entrySize = Number(sizeText)
      const offset = pos + HEADER
      if (offset + entrySize > size) throw new DumpError('DUMP_INVALID', 'The .wpress backup is truncated.')
      const prefix = text(h, 281, HEADER)
      const rel = (prefix && prefix !== '.' ? `${prefix}/${text(h, 0, 255)}` : text(h, 0, 255)).replace(/\\/g, '/').replace(/^\.\//, '')
      if (rel === 'database.sql') database = { offset, size: entrySize }
      else if (rel.startsWith('uploads/')) uploads.set(rel.slice('uploads/'.length), { offset, size: entrySize })
      pos = offset + entrySize
    }
  } finally {
    await fh.close()
  }
  if (!database) throw new DumpError('DUMP_NO_WORDPRESS', 'The backup has no database.sql (an encrypted or files-only backup cannot be read).')
  return { file, database, uploads }
}

/** A media file of the backup, by the `_wp_attached_file` path, under the same rules as an uploads folder. */
export async function readWpressMedia(ix: WpressIndex, relPath: string, maxBytes: number): Promise<Buffer> {
  const rel = relPath.replace(/\\/g, '/')
  if (!rel || rel.includes('\0') || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').includes('..')) {
    throw new SecurityError('SEC_PATH_TRAVERSAL', `Refused media path ${JSON.stringify(relPath.slice(0, 200))}: it leaves the uploads folder.`)
  }
  const entry = ix.uploads.get(rel)
  if (!entry) throw new MediaError('MEDIA_404', `Not in the backup's uploads: ${rel}`, 404)
  if (entry.size > maxBytes) throw new SecurityError('SEC_FILE_TOO_LARGE', `Media is ${entry.size} bytes, over the ${maxBytes}-byte cap.`)
  const fh = await open(ix.file, 'r')
  try {
    const buf = Buffer.alloc(entry.size)
    const { bytesRead } = await fh.read(buf, 0, entry.size, entry.offset)
    if (bytesRead !== entry.size) throw new MediaError('MEDIA_READ_FAILED', `Could not read ${rel} from the backup.`)
    return buf
  } finally {
    await fh.close()
  }
}
