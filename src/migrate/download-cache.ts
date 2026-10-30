import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { DownloadResult } from '../security/index.js'
import { STATE_DIR } from '../state/store.js'

type Download = (url: string) => Promise<DownloadResult>

/**
 * Downloads kept on disk for one command: the first-run preview fetches every media file to
 * inspect it, and the real run that follows reuses those bytes instead of fetching them again.
 * Only bytes that came through the guarded downloader are stored; the media loader inspects
 * them again either way. Files live under `.wp2payload/cache/media` and are removed by `dispose`.
 */
export class DownloadCache {
  readonly #dir: string
  readonly #entries = new Map<string, { file: string; result: Omit<DownloadResult, 'bytes'> }>()
  #seq = 0

  private constructor(dir: string) {
    this.#dir = dir
  }

  static async create(root: string): Promise<DownloadCache> {
    const dir = path.join(root, STATE_DIR, 'cache', 'media')
    // Left over from a run that was killed: never trust it.
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return new DownloadCache(dir)
  }

  wrap(download: Download): Download {
    return async (url) => {
      const hit = this.#entries.get(url)
      if (hit) {
        try {
          return { ...hit.result, bytes: await readFile(hit.file) }
        } catch {
          this.#entries.delete(url)
        }
      }
      const got = await download(url)
      const file = path.join(this.#dir, String(++this.#seq))
      try {
        await writeFile(file, got.bytes, { mode: 0o600, flag: 'wx' })
        const { bytes: _, ...result } = got
        this.#entries.set(url, { file, result })
      } catch {
        // A full disk only costs a second download.
      }
      return got
    }
  }

  async dispose(): Promise<void> {
    this.#entries.clear()
    await rm(this.#dir, { recursive: true, force: true })
  }
}
