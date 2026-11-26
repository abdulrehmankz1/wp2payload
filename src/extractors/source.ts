import path from 'node:path'
import type { ResolvedConfig } from '../config/index.js'
import type { Extractor, IRDocument } from '../ir/types.js'
import { readLocalMedia } from '../security/media/local.js'
import { openArchive, openUploadsArchives } from './archive/index.js'
import { RestError, RestExtractor } from './rest/index.js'
import { DumpError, SqlExtractor } from './sql/index.js'
import { wpConfigPrefix } from './sql/prefix.js'
import { WPRESS_TABLE_PREFIX, indexWpress, readWpressMedia } from './wpress.js'
import { WxrError, WxrExtractor } from './wxr/index.js'

/** The configured source, ready to read. */
export interface OpenedSource {
  extractor: Extractor
  /** Backup sources: media is read from the backup, never downloaded. */
  readLocalMedia?: (localPath: string, maxBytes: number) => Promise<Buffer>
  /** The site address the user configured, if any; otherwise the source names its own. */
  configuredUrl?: string
  /** Whether the site host gets the source-host exception (doc 12.6 item 3): only when the user named it. */
  trustSiteHost: boolean
  /** How the CLI introduces the source: "WordPress at", "Export of", "Backup of". */
  label: string
  /** Files under the uploads folder of a zip or tar backup (doctor shows it). */
  uploadFiles?: number
  /** Releases the source: closes archives and removes a tar backup's temp folder. Call it when done. */
  close?: () => Promise<void>
}

export interface OpenSourceOptions {
  /** False when no media will be read (doctor, scan --no-media): a tar backup's uploads are not unpacked. */
  media?: boolean
}

/** A source problem the CLI reports as a failed check, not a crash. */
export const isSourceError = (error: unknown): error is Error => error instanceof RestError || error instanceof WxrError || error instanceof DumpError

export async function openSource(config: ResolvedConfig, cwd: string, opts: OpenSourceOptions = {}): Promise<OpenedSource> {
  const { source } = config
  const common = { statuses: config.statuses, seoPlugin: config.seo.plugin }
  const archive = { media: opts.media !== false, maxMediaBytes: Math.floor(config.media.maxFileSizeMB * 1024 * 1024) }
  switch (source.type) {
    case 'rest':
      return {
        // The config schema accepts any status string; the extractor maps unknown ones to draft.
        extractor: new RestExtractor({ url: source.url, ...(source.auth ? { auth: source.auth } : {}), ...common, statuses: config.statuses as IRDocument['status'][] }),
        configuredUrl: source.url,
        trustSiteHost: true,
        label: 'WordPress at',
      }
    case 'wxr':
      return {
        extractor: new WxrExtractor({ file: path.resolve(cwd, source.file), ...common }),
        ...(source.url ? { configuredUrl: source.url } : {}),
        trustSiteHost: source.url !== undefined,
        label: 'Export of',
      }
    case 'sql': {
      const extractor = new SqlExtractor({ file: path.resolve(cwd, source.file), ...prefixOf(source), ...common })
      if (source.uploads !== undefined) {
        // UpdraftPlus: the dump plus one or more uploads archives.
        const files = (Array.isArray(source.uploads) ? source.uploads : [source.uploads]).map((f) => path.resolve(cwd, f))
        const uploads = await openUploadsArchives(files, archive)
        return {
          extractor,
          ...(uploads.readMedia ? { readLocalMedia: uploads.readMedia } : {}),
          trustSiteHost: false,
          label: 'Backup of',
          uploadFiles: uploads.uploads,
          close: uploads.close,
        }
      }
      // The schema requires exactly one of uploads and uploadsDir.
      const dir = path.resolve(cwd, source.uploadsDir as string)
      return {
        extractor,
        readLocalMedia: (rel, max) => readLocalMedia(dir, rel, max),
        trustSiteHost: false,
        label: 'Backup of',
      }
    }
    case 'wpress': {
      const backup = await indexWpress(path.resolve(cwd, source.file))
      return {
        extractor: new SqlExtractor({
          file: backup.file,
          range: { start: backup.database.offset, length: backup.database.size },
          tablePrefix: WPRESS_TABLE_PREFIX,
          ...common,
        }),
        readLocalMedia: (rel, max) => readWpressMedia(backup, rel, max),
        trustSiteHost: false,
        label: 'Backup of',
      }
    }
    case 'archive': {
      const backup = await openArchive(path.resolve(cwd, source.file), { database: true, ...archive })
      if (backup.database === undefined) {
        await backup.close()
        throw new DumpError('DUMP_NO_WORDPRESS', 'The backup has no SQL dump.')
      }
      return {
        // An explicit tablePrefix wins; else wp-config.php's, if the dump has those tables; else the dump's.
        extractor: new SqlExtractor({
          file: backup.database,
          ...prefixOf(source),
          ...(source.tablePrefix === undefined && backup.wpConfig !== undefined ? { wpConfig: wpConfigPrefix(backup.wpConfig) } : {}),
          ...common,
        }),
        ...(backup.readMedia ? { readLocalMedia: backup.readMedia } : {}),
        trustSiteHost: false,
        label: 'Backup of',
        uploadFiles: backup.uploads,
        close: backup.close,
      }
    }
  }
}

/** The configured table prefix, if any: without one the extractor detects it. */
const prefixOf = (source: { tablePrefix?: string | undefined }) => (source.tablePrefix !== undefined ? { tablePrefix: source.tablePrefix } : {})
