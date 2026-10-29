import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CollectionSlug } from 'payload'
import type { IdKind, IdMap, LoaderContext } from '../loaders/types.js'
import { findByWpMeta, type PayloadId } from '../loaders/wpmeta.js'

// State file (doc 4.8). It is only a cache and a progress marker: the database is the
// source of truth (ADR-0004), so deleting it loses nothing.

export type PhaseStatus = 'pending' | 'in_progress' | 'done'

export interface PhaseState {
  status: PhaseStatus
  processed: number
  total?: number
  cursor?: string | number
}

export interface StateFile {
  version: 1
  site: string
  startedAt: string
  phases: Record<string, PhaseState>
  idMap: Record<string, Record<string, PayloadId>>
}

export const STATE_VERSION = 1
export const STATE_DIR = '.wp2payload'
export const STATE_FILE = 'state.json'

export class StateCorruptError extends Error {
  constructor(
    readonly file: string,
    cause: unknown,
  ) {
    super(
      `State file ${file} is not valid JSON or has the wrong shape (${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Next step: delete it and re-run. Nothing is lost, because the database is the source of truth and ids are re-resolved from it.`,
    )
    this.name = 'StateCorruptError'
  }
}

export type ResetReason = 'version_mismatch' | 'site_mismatch'

function isStateShape(v: unknown): v is StateFile {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['version'] === 'number' &&
    typeof o['site'] === 'string' &&
    typeof o['startedAt'] === 'string' &&
    typeof o['phases'] === 'object' &&
    o['phases'] !== null &&
    typeof o['idMap'] === 'object' &&
    o['idMap'] !== null
  )
}

export class StateStore implements IdMap {
  /** Set when an existing file was discarded because it belonged to another site or version. */
  resetReason: ResetReason | undefined
  private dirty = false
  private lastFlush = 0
  private saving: Promise<void> = Promise.resolve()

  private constructor(
    readonly file: string,
    private data: StateFile,
  ) {}

  /** Load `<cwd>/.wp2payload/state.json`, or start fresh. Throws StateCorruptError on bad JSON. */
  static async open(cwd: string, site: string): Promise<StateStore> {
    const file = path.join(cwd, STATE_DIR, STATE_FILE)
    const fresh = (): StateFile => ({ version: 1, site, startedAt: new Date().toISOString(), phases: {}, idMap: {} })
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new StateStore(file, fresh())
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new StateCorruptError(file, error)
    }
    if (!isStateShape(parsed)) throw new StateCorruptError(file, new Error('missing required fields'))
    if (parsed.version !== STATE_VERSION || parsed.site !== site) {
      const store = new StateStore(file, fresh())
      store.resetReason = parsed.version !== STATE_VERSION ? 'version_mismatch' : 'site_mismatch'
      store.dirty = true
      return store
    }
    return new StateStore(file, parsed)
  }

  get site(): string {
    return this.data.site
  }
  get startedAt(): string {
    return this.data.startedAt
  }
  snapshot(): StateFile {
    return structuredClone(this.data)
  }

  // IdMap
  get(kind: IdKind, wpId: number): PayloadId | undefined {
    return this.data.idMap[kind]?.[String(wpId)]
  }
  set(kind: IdKind, wpId: number, id: PayloadId): void {
    const bucket = (this.data.idMap[kind] ??= {})
    if (bucket[String(wpId)] === id) return
    bucket[String(wpId)] = id
    this.dirty = true
  }

  /** Forget cached IDs and progress, e.g. when the database no longer holds what the cache says. */
  clear(): void {
    this.data.idMap = {}
    this.data.phases = {}
    this.dirty = true
  }

  // Phases
  phase(name: string): PhaseState {
    return this.data.phases[name] ?? { status: 'pending', processed: 0 }
  }
  updatePhase(name: string, patch: Partial<PhaseState>): PhaseState {
    const next = { ...this.phase(name), ...patch } as PhaseState
    this.data.phases[name] = next
    this.dirty = true
    return next
  }

  /** Write at most once per `intervalMs`; call from hot loops. */
  async flushIfDue(intervalMs = 2000): Promise<void> {
    if (this.dirty && Date.now() - this.lastFlush >= intervalMs) await this.flush()
  }

  /** Atomic save: temp file in the same directory, then rename. Serialised. */
  flush(): Promise<void> {
    this.saving = this.saving.then(() => this.write())
    return this.saving
  }

  private async write(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    try {
      await renameWithFallback(tmp, this.file)
    } catch (error) {
      await unlink(tmp).catch(() => {})
      throw error
    }
    this.dirty = false
    this.lastFlush = Date.now()
  }
}

export async function renameWithFallback(from: string, to: string): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      last = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EBUSY' && code !== 'EACCES') throw error
      // Windows can refuse to replace an existing file: remove the target, then retry.
      await unlink(to).catch(() => {})
      await new Promise((r) => setTimeout(r, 20 * (attempt + 1)))
    }
  }
  throw last
}

/** Cache first, then the database (source of truth); fills the cache on a DB hit. */
export async function resolve(
  ctx: Pick<LoaderContext, 'payload' | 'site' | 'ids'>,
  kind: IdKind,
  collection: CollectionSlug,
  wpId: number,
): Promise<PayloadId | undefined> {
  const cached = ctx.ids.get(kind, wpId)
  if (cached !== undefined) return cached
  const found = await findByWpMeta(ctx.payload, collection, ctx.site, wpId)
  if (found !== undefined) ctx.ids.set(kind, wpId, found)
  return found
}
