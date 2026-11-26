import path from 'node:path'
import { clean } from '../../report/summary.js'
import { DumpError } from '../sql/dump.js'

// Zip and tar backups (doc 12.7, T11). An archive comes from wherever the site was hosted, and a
// hacked site's backup is the reason this source exists, so every entry is checked before anything
// is read from it: names must stay inside the archive root, links and device files are refused, and
// size, file count and compression ratio are capped (zip bombs). A refused archive is not read at
// all; the error names the entry and carries a stable SEC_ARCHIVE_* code (docs/reference/codes.md).

export type ArchiveCode =
  | 'SEC_ARCHIVE_PATH_TRAVERSAL'
  | 'SEC_ARCHIVE_LINK'
  | 'SEC_ARCHIVE_SPECIAL_FILE'
  | 'SEC_ARCHIVE_TOO_LARGE'
  | 'SEC_ARCHIVE_TOO_MANY_FILES'
  | 'SEC_ARCHIVE_RATIO'

const NEXT: Record<ArchiveCode, string> = {
  SEC_ARCHIVE_PATH_TRAVERSAL: 'Backup plugins never write such names; the archive may have been tampered with. Use a backup you trust.',
  SEC_ARCHIVE_LINK: 'Links are refused in backups. Repack the database and wp-content/uploads without links.',
  SEC_ARCHIVE_SPECIAL_FILE: 'Only regular files and folders are read. Repack the database and wp-content/uploads only.',
  SEC_ARCHIVE_TOO_LARGE: 'Repack only the database and wp-content/uploads, or split the uploads into several archives.',
  SEC_ARCHIVE_TOO_MANY_FILES: 'Repack only the database and wp-content/uploads, or split the uploads into several archives.',
  SEC_ARCHIVE_RATIO: 'Real backups do not compress this well; the archive may be a zip bomb. Use a backup you trust.',
}

/** A backup archive refused by a security rule. A DumpError, so every command reports it as a failed source. */
export class ArchiveError extends DumpError {
  declare readonly code: ArchiveCode
  constructor(code: ArchiveCode, archive: string, problem: string) {
    super(code, `Refused the backup ${clean(path.basename(archive))}: ${problem}\n${NEXT[code]} (${code})`)
    this.name = 'ArchiveError'
  }
}

export interface ArchiveLimits {
  /** Entries of any kind in one archive. */
  maxFiles: number
  /** Bytes unpacked from one archive: for zip the entries read, for tar.gz the whole stream. */
  maxTotalBytes: number
  /** Unpacked size over packed size, per zip entry and over a whole tar.gz stream. */
  maxRatio: number
  /** The ratio is only judged past this many unpacked bytes: tiny files compress oddly. */
  ratioGraceBytes: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxFiles: 1_000_000,
  maxTotalBytes: 64 * 1024 ** 3,
  maxRatio: 100,
  ratioGraceBytes: 1024 ** 2,
}

/** An entry name as it reads in messages: quoted, shortened, control and bidi characters replaced. */
export const shown = (name: string) => clean(JSON.stringify(name.length > 200 ? `${name.slice(0, 200)}...` : name))

/**
 * The checked, normalised path of an entry: forward slashes, no `.` or empty segments, no trailing
 * slash. Refused (whole archive): NUL, absolute paths (`/x`, `//host/x`), drive letters anywhere
 * (`C:x`, `a/C:/x`), and `..` segments, after backslashes are read as separators so `..\x` and
 * `C:\x` are caught on every platform. Returns '' for the root itself.
 */
export function entryPath(archive: string, raw: string): string {
  const refuse = (why: string) => new ArchiveError('SEC_ARCHIVE_PATH_TRAVERSAL', archive, `the entry ${shown(raw)} ${why}.`)
  if (raw.includes('\0')) throw refuse('has a NUL character in its name')
  const name = raw.replace(/\\/g, '/')
  if (name.startsWith('/')) throw refuse('is an absolute path')
  const parts: string[] = []
  for (const part of name.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') throw refuse('leaves the archive folder (..)')
    // A colon is a drive letter or an NTFS stream on Windows; WordPress never puts one in a file name.
    if (part.includes(':')) throw refuse('names a drive or a stream (:)')
    parts.push(part)
  }
  return parts.join('/')
}

// Device names Windows opens as devices whatever the folder or extension; and names it silently
// trims. Only checked for files written to disk (tar extraction), where they could misbehave.
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/** The absolute path of a checked entry inside `root`; throws if it would not stay inside. */
export function insideRoot(archive: string, root: string, rel: string): string {
  for (const part of rel.split('/')) {
    if (RESERVED.test(part) || /[. ]$/.test(part)) {
      throw new ArchiveError('SEC_ARCHIVE_PATH_TRAVERSAL', archive, `the entry ${shown(rel)} has a file name Windows reserves or trims.`)
    }
  }
  const target = path.resolve(root, ...rel.split('/'))
  if (!target.startsWith(root + path.sep)) throw new ArchiveError('SEC_ARCHIVE_PATH_TRAVERSAL', archive, `the entry ${shown(rel)} leaves the archive folder.`)
  return target
}

/** Unix file type bits, as zip external attributes and tar modes carry them. */
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

/** Refuses a zip entry whose Unix mode says link, device, FIFO or socket. Mode 0 is a plain DOS entry. */
export function checkMode(archive: string, name: string, mode: number): void {
  const type = mode & S_IFMT
  if (type === 0 || type === S_IFREG || type === S_IFDIR) return
  if (type === S_IFLNK) throw new ArchiveError('SEC_ARCHIVE_LINK', archive, `the entry ${shown(name)} is a symbolic link.`)
  throw new ArchiveError('SEC_ARCHIVE_SPECIAL_FILE', archive, `the entry ${shown(name)} is a device, FIFO or socket, not a file.`)
}

/** Over the ratio cap: judged only past the grace size; nothing packed into nothing counts as infinite. */
export const overRatio = (unpacked: number, packed: number, limits: ArchiveLimits) =>
  unpacked > limits.ratioGraceBytes && unpacked > packed * limits.maxRatio

export const tooLarge = (archive: string, limits: ArchiveLimits) =>
  new ArchiveError('SEC_ARCHIVE_TOO_LARGE', archive, `it unpacks to over ${Math.floor(limits.maxTotalBytes / 1024 ** 2)} MB.`)

export const tooMany = (archive: string, limits: ArchiveLimits) =>
  new ArchiveError('SEC_ARCHIVE_TOO_MANY_FILES', archive, `it has over ${limits.maxFiles} entries.`)

// Where the parts of a WordPress backup sit inside an archive.

/** Duplicator names its dump like this (older versions: database.sql at the root). */
const DUPLICATOR_DB = /^(?:.+\/)?dup-installer\/dup-database__[^/]+\.sql$/i

/** A file that may be the site's SQL dump: .sql or .sql.gz, not inside wp-content (plugins ship .sql files). */
export const isDumpCandidate = (rel: string) => /\.sql(\.gz)?$/i.test(rel) && !rel.split('/').includes('wp-content')

/**
 * The path below the uploads folder, or undefined when `rel` is not under one. The uploads folder is
 * `wp-content/uploads/` at any depth (Duplicator, hosting and hand-made archives), or `uploads/` at
 * the root (UpdraftPlus uploads archives). Returns the folder prefix too, so the shallowest one wins.
 */
export function uploadsPart(rel: string): { prefix: string; rel: string } | undefined {
  const mark = 'wp-content/uploads/'
  let prefix: string | undefined
  if (rel.startsWith(mark)) prefix = mark
  else if (rel.includes(`/${mark}`)) prefix = rel.slice(0, rel.indexOf(`/${mark}`) + 1 + mark.length)
  else if (rel.startsWith('uploads/')) prefix = 'uploads/'
  return prefix !== undefined && rel.length > prefix.length ? { prefix, rel: rel.slice(prefix.length) } : undefined
}

/** Picks the dump among candidate paths: Duplicator's name, then database.sql at the root, then a single shallowest .sql. */
export function pickDump(archive: string, candidates: string[]): string {
  const dup = candidates.filter((c) => DUPLICATOR_DB.test(c))
  if (dup.length === 1) return dup[0] as string
  const pool = dup.length > 1 ? dup : candidates.includes('database.sql') ? ['database.sql'] : candidates
  if (pool.length === 0) {
    throw new DumpError('DUMP_NO_WORDPRESS', `The backup ${clean(path.basename(archive))} has no SQL dump (.sql or .sql.gz) outside wp-content. An encrypted or files-only backup cannot be read.`)
  }
  const depth = (p: string) => p.split('/').length
  const min = Math.min(...pool.map(depth))
  const top = pool.filter((p) => depth(p) === min)
  if (top.length > 1) {
    throw new DumpError(
      'DUMP_INVALID',
      `The backup ${clean(path.basename(archive))} has several SQL dumps: ${top.slice(0, 5).map(shown).join(', ')}.\nExtract the right one and use a sql source with source.uploads pointing at the archive.`,
    )
  }
  return top[0] as string
}

/** The shallowest uploads folder among the files; deeper ones (a backup inside the backup) are ignored. */
export function pickUploadsPrefix(prefixes: Iterable<string>): string | undefined {
  let best: string | undefined
  for (const p of prefixes) if (best === undefined || p.split('/').length < best.split('/').length) best = p
  return best
}
