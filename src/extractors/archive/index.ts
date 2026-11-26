import { constants, rmSync } from 'node:fs'
import { mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { MediaError, SecurityError } from '../../security/errors.js'
import { readLocalMedia } from '../../security/media/local.js'
import { DumpError, type DumpInput } from '../sql/dump.js'
import {
  ArchiveError,
  DEFAULT_ARCHIVE_LIMITS,
  insideRoot,
  isDumpCandidate,
  overRatio,
  pickDump,
  pickUploadsPrefix,
  shown,
  tooLarge,
  uploadsPart,
  type ArchiveLimits,
} from './rules.js'
import { readTar, type TarSink } from './tar.js'
import { checkReadable, indexZip, openZipEntry, readZipEntry } from './zip.js'

export { ArchiveError, DEFAULT_ARCHIVE_LIMITS, type ArchiveCode, type ArchiveLimits } from './rules.js'

// Opens zip and tar backups as a source (doc 0.7, 12.7, roadmap v1.2):
// - Duplicator: one *_archive.zip with wp-content/uploads and dup-installer/dup-database__*.sql;
// - UpdraftPlus: a *-db.gz dump (a sql source) plus one or more *-uploads*.zip with uploads/ inside;
// - hand-made .zip, .tar.gz, .tgz or .tar with a .sql dump and wp-content/uploads.
// Zips are read in place. A tar.gz cannot be read at random, so the dump and the uploads (nothing
// else: no themes, plugins or PHP) are extracted once into a private temp folder that is removed
// when the source closes, when the process exits, and on Ctrl+C.

export interface OpenArchiveOptions {
  /** Look for the SQL dump inside (false for uploads-only archives). */
  database: boolean
  /** Extract the uploads of a tar archive. False when media is not read (doctor, scan --no-media). */
  media: boolean
  /** The media size cap: larger uploads are not extracted, and fail when read. */
  maxMediaBytes: number
  limits?: Partial<ArchiveLimits>
  /** Parent of the temp folder for tar extraction (tests); default the OS temp folder. */
  tempDir?: string
}

export interface OpenedArchive {
  /** The dump, read in place (zip) or extracted (tar); undefined when not asked for. */
  database?: string | DumpInput
  /** Files under the uploads folder. */
  uploads: number
  /** A media file by `_wp_attached_file` path; undefined for a tar opened without media. */
  readMedia?: (relPath: string, maxBytes: number) => Promise<Buffer>
  /** The temp folder, for a tar (tests check it is gone after close). */
  tempRoot?: string
  close(): Promise<void>
}

type Kind = 'zip' | 'tar' | 'tar.gz'

/** By content, not by name: gzip magic, ustar magic at 257, else zip (yauzl finds the end record). */
async function sniff(file: string): Promise<Kind> {
  let fh
  try {
    fh = await open(file, 'r')
  } catch {
    throw new DumpError('DUMP_NOT_FOUND', `Backup not found: ${file}`)
  }
  try {
    if (!(await fh.stat()).isFile()) throw new DumpError('DUMP_NOT_FOUND', `${file} is not a file.`)
    const head = Buffer.alloc(263)
    const { bytesRead } = await fh.read(head, 0, head.length, 0)
    if (bytesRead >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz'
    if (bytesRead >= 262 && head.toString('latin1', 257, 262) === 'ustar') return 'tar'
    return 'zip'
  } finally {
    await fh.close()
  }
}

/** A media path named by the dump (untrusted, doc T10): refused if it could leave the uploads folder. */
function mediaPath(relPath: string): string {
  const rel = relPath.replace(/\\/g, '/')
  if (!rel || rel.includes('\0') || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').includes('..')) {
    throw new SecurityError('SEC_PATH_TRAVERSAL', `Refused media path ${JSON.stringify(relPath.slice(0, 200))}: it leaves the uploads folder.`)
  }
  return rel
}

const missing = (rel: string) => new MediaError('MEDIA_404', `Not in the backup's uploads: ${rel}`, 404)

export async function openArchive(file: string, o: OpenArchiveOptions): Promise<OpenedArchive> {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...o.limits }
  const kind = await sniff(file)
  return kind === 'zip' ? openZip(file, o, limits) : openTar(file, kind === 'tar.gz', o, limits)
}

async function openZip(file: string, o: OpenArchiveOptions, limits: ArchiveLimits): Promise<OpenedArchive> {
  const ix = await indexZip(file, limits)
  try {
    const prefixes = new Set<string>()
    const candidates: string[] = []
    for (const rel of ix.files.keys()) {
      const u = uploadsPart(rel)
      if (u) prefixes.add(u.prefix)
      if (o.database && isDumpCandidate(rel)) candidates.push(rel)
    }
    const dbRel = o.database ? pickDump(file, candidates) : undefined
    const prefix = pickUploadsPrefix(prefixes)
    const uploads = new Map<string, NonNullable<ReturnType<typeof ix.files.get>>>()
    if (prefix) for (const [rel, e] of ix.files) if (rel.startsWith(prefix) && rel.length > prefix.length) uploads.set(rel.slice(prefix.length), e)

    // The caps cover what wp2payload reads: the dump and the uploads. Other entries are never inflated.
    let total = 0
    const check = (rel: string, e: NonNullable<ReturnType<typeof ix.files.get>>) => {
      checkReadable(ix, rel, e)
      if (overRatio(e.uncompressedSize, e.compressedSize, limits)) {
        throw new ArchiveError('SEC_ARCHIVE_RATIO', file, `the entry ${shown(rel)} unpacks to over ${limits.maxRatio} times its packed size.`)
      }
      total += e.uncompressedSize
      if (total > limits.maxTotalBytes) throw tooLarge(file, limits)
    }
    let database: DumpInput | undefined
    if (dbRel !== undefined) {
      const e = ix.files.get(dbRel)
      if (!e) throw new DumpError('DUMP_INVALID', `${file} is a damaged zip archive.`)
      check(dbRel, e)
      database = { name: dbRel, size: e.uncompressedSize, open: () => openZipEntry(ix, e) }
    }
    for (const [rel, e] of uploads) check(`${prefix}${rel}`, e)

    return {
      ...(database ? { database } : {}),
      uploads: uploads.size,
      readMedia: async (relPath, maxBytes) => {
        const rel = mediaPath(relPath)
        const e = uploads.get(rel)
        if (!e) throw missing(rel)
        return readZipEntry(ix, rel, e, maxBytes)
      },
      close: async () => ix.zip.close(),
    }
  } catch (error) {
    ix.zip.close()
    throw error
  }
}

async function openTar(file: string, gzip: boolean, o: OpenArchiveOptions, limits: ArchiveLimits): Promise<OpenedArchive> {
  const root = await tempRoot(o.tempDir)
  try {
    const candidates: string[] = []
    const prefixes = new Set<string>()
    const kept = new Set<string>()
    /** Uploads too large to keep, by full path: reading them fails with the size. */
    const oversized = new Map<string, number>()
    let uploadFiles = new Map<string, number>()
    await readTar(file, gzip, limits, async (rel, size) => {
      let keep = false
      if (o.database && isDumpCandidate(rel)) {
        candidates.push(rel)
        keep = true
      }
      const u = uploadsPart(rel)
      if (u) {
        prefixes.add(u.prefix)
        uploadFiles.set(rel, size)
        if (o.media) {
          if (size > o.maxMediaBytes) oversized.set(rel, size)
          else keep = true
        }
      }
      // The first of duplicate names wins, as for zip.
      if (!keep || kept.has(rel)) return undefined
      kept.add(rel)
      return fileSink(file, root, rel)
    })
    const dbRel = o.database ? pickDump(file, candidates) : undefined
    const prefix = pickUploadsPrefix(prefixes)
    uploadFiles = new Map([...uploadFiles].filter(([rel]) => prefix !== undefined && rel.startsWith(prefix)))
    const uploadsDir = prefix ? insideRoot(file, root, prefix.slice(0, -1)) : undefined

    const close = () => removeRoot(root)
    return {
      ...(dbRel !== undefined ? { database: insideRoot(file, root, dbRel) } : {}),
      uploads: uploadFiles.size,
      ...(o.media
        ? {
            readMedia: async (relPath: string, maxBytes: number) => {
              const rel = mediaPath(relPath)
              if (!uploadsDir || !uploadFiles.has(`${prefix}${rel}`)) throw missing(rel)
              const big = oversized.get(`${prefix}${rel}`)
              if (big !== undefined) throw new SecurityError('SEC_FILE_TOO_LARGE', `Media is ${big} bytes, over the ${maxBytes}-byte cap.`)
              return readLocalMedia(uploadsDir, rel, maxBytes)
            },
          }
        : {}),
      tempRoot: root,
      close,
    }
  } catch (error) {
    await removeRoot(root)
    throw error
  }
}

/** Writes one entry inside the temp root: a new file, never through a link (none can exist there). */
async function fileSink(archive: string, root: string, rel: string): Promise<TarSink> {
  const target = insideRoot(archive, root, rel)
  let fh
  try {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    fh = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOSPC') throw new DumpError('DUMP_INVALID', `No disk space left to unpack the backup into ${os.tmpdir()}. Free space, or set TMPDIR to a larger disk.`)
    // A file and a folder with the same name, or names that collide on this file system.
    throw new DumpError('DUMP_INVALID', `The backup ${path.basename(archive)} has an entry ${shown(rel)} that cannot be unpacked (${code ?? 'error'}).`)
  }
  const handle = fh
  return {
    write: async (chunk) => {
      try {
        await handle.write(chunk)
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOSPC') throw new DumpError('DUMP_INVALID', `No disk space left to unpack the backup into ${os.tmpdir()}. Free space, or set TMPDIR to a larger disk.`)
        throw error
      }
    },
    close: () => handle.close(),
  }
}

// Temp folders of open tar backups. Removed by close(); the hooks below cover a run that ends
// without it (an uncaught error, process.exit, Ctrl+C in a command with no handler of its own).
const live = new Set<string>()

function removeAllSync(): void {
  for (const dir of live) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  live.clear()
}

function onSignal(signal: NodeJS.Signals): void {
  // migrate handles Ctrl+C itself (finish the item, then close the source): leave it to that.
  if (process.listenerCount(signal) > 1) return
  removeAllSync()
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

async function tempRoot(parent: string | undefined): Promise<string> {
  // mkdtemp makes the folder 0700: private to this user.
  const dir = await realpath(await mkdtemp(path.join(parent ?? os.tmpdir(), 'wp2payload-backup-')))
  if (live.size === 0) {
    process.on('exit', removeAllSync)
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  }
  live.add(dir)
  return dir
}

async function removeRoot(dir: string): Promise<void> {
  if (!live.delete(dir)) return
  await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  if (live.size === 0) {
    process.off('exit', removeAllSync)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

/** Uploads from one or more archives (UpdraftPlus splits them), searched in order. */
export async function openUploadsArchives(files: string[], o: Omit<OpenArchiveOptions, 'database'>): Promise<OpenedArchive> {
  const opened: OpenedArchive[] = []
  const close = async () => {
    for (const a of opened.splice(0)) await a.close()
  }
  try {
    for (const file of files) {
      const a = await openArchive(file, { ...o, database: false })
      opened.push(a)
      if (a.uploads === 0) throw new DumpError('DUMP_INVALID', `${file} has no uploads folder (uploads/ or wp-content/uploads/ inside).`)
    }
  } catch (error) {
    await close()
    throw error
  }
  const parts = [...opened]
  return {
    uploads: parts.reduce((n, a) => n + a.uploads, 0),
    ...(o.media
      ? {
          readMedia: async (relPath: string, maxBytes: number) => {
            for (const [i, a] of parts.entries()) {
              try {
                return await (a.readMedia as NonNullable<OpenedArchive['readMedia']>)(relPath, maxBytes)
              } catch (error) {
                // Not in this one: try the next archive; anything else (refused, too large) stands.
                if (!(error instanceof MediaError && error.code === 'MEDIA_404') || i === parts.length - 1) throw error
              }
            }
            throw missing(relPath)
          },
        }
      : {}),
    close,
  }
}
