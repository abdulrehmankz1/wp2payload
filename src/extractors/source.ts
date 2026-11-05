import path from 'node:path'
import type { ResolvedConfig } from '../config/index.js'
import type { Extractor, IRDocument } from '../ir/types.js'
import { readLocalMedia } from '../security/media/local.js'
import { RestError, RestExtractor } from './rest/index.js'
import { DumpError, SqlExtractor } from './sql/index.js'
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
}

/** A source problem the CLI reports as a failed check, not a crash. */
export const isSourceError = (error: unknown): error is Error => error instanceof RestError || error instanceof WxrError || error instanceof DumpError

export async function openSource(config: ResolvedConfig, cwd: string): Promise<OpenedSource> {
  const { source } = config
  const common = { statuses: config.statuses, seoPlugin: config.seo.plugin }
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
      const uploads = path.resolve(cwd, source.uploadsDir)
      return {
        extractor: new SqlExtractor({ file: path.resolve(cwd, source.file), tablePrefix: source.tablePrefix, ...common }),
        readLocalMedia: (rel, max) => readLocalMedia(uploads, rel, max),
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
  }
}
