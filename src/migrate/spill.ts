import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { once } from 'node:events'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { IRDocument } from '../ir/types.js'
import { STATE_DIR } from '../state/store.js'
import { ensureWorkDir } from './workdir.js'

export const CACHE_DIR = 'cache'

export const spillPath = (root: string) => path.join(root, STATE_DIR, CACHE_DIR, 'documents.jsonl')

export interface SpillEntry {
  wpId: number
  type: string
  link: string
}

/**
 * Documents extracted once into `.wp2payload/cache/documents.jsonl` (spec 05). Loading needs the
 * full permalink map and the set of authors with content before the first write, and the
 * relationship pass reads the documents a second time; neither should hold every post in memory
 * or fetch the site twice.
 */
export class DocumentSpill {
  readonly entries: SpillEntry[] = []
  readonly authors = new Set<number>()

  private constructor(readonly file: string) {}

  static async write(root: string, docs: AsyncIterable<IRDocument>, stop?: () => boolean): Promise<DocumentSpill> {
    await ensureWorkDir(root)
    const spill = new DocumentSpill(spillPath(root))
    await mkdir(path.dirname(spill.file), { recursive: true })
    // Raw source HTML, possibly drafts and private posts: owner-only, and removed after every run.
    const out = createWriteStream(spill.file, { encoding: 'utf8', mode: 0o600 })
    const done = once(out, 'finish')
    try {
      for await (const doc of docs) {
        if (stop?.()) break
        if (!out.write(`${JSON.stringify(doc)}\n`)) await once(out, 'drain')
        spill.entries.push({ wpId: doc.wpId, type: doc.type, link: doc.link })
        if (doc.authorWpId !== undefined) spill.authors.add(doc.authorWpId)
      }
    } finally {
      // Also on a failed extraction: the file must be closed before the caller removes it.
      out.end()
      await done
    }
    return spill
  }

  async *read(): AsyncIterable<IRDocument> {
    const lines = createInterface({ input: createReadStream(this.file, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) if (line) yield JSON.parse(line) as IRDocument
  }

  async remove(): Promise<void> {
    await rm(this.file, { force: true })
  }
}
