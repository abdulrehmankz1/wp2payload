import type { Payload } from 'payload'

interface MongooseLike {
  connection?: { models?: Record<string, { init?: () => Promise<unknown> }> }
}

/**
 * Wait until the database is ready for concurrent writes.
 *
 * MongoDB adapter: mongoose creates each collection and its indexes in the background after
 * connecting. On a fresh database (the usual migration target) the loaders' first writes run
 * inside transactions and race that work, failing with "Collection namespace ... is already in
 * use" or "Unable to acquire IX lock". Awaiting every model's init() removes the race.
 * Index build errors stay mongoose's to report: this only waits, it never fails the boot.
 * Other adapters have no such models and return at once.
 */
export async function waitForDatabase(payload: Payload): Promise<void> {
  const models = (payload.db as MongooseLike | undefined)?.connection?.models
  if (!models) return
  await Promise.allSettled(Object.values(models).map((model) => model.init?.()))
}
