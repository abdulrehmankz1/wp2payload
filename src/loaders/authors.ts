import type { IRAuthor } from '../ir/types.js'
import { withRetry, type RetryOptions } from '../state/retry.js'
import { resolve } from '../state/store.js'
import type { LoaderContext } from './types.js'
import { upsertByWpMeta } from './wpmeta.js'

const PHASE = 'authors'

/**
 * Load authors as `{ name, slug }` only. Email is never written (the target is not an auth
 * collection yet) and passwords are never read. With `include`, only those wpIds are migrated
 * (doc 12.9); the rest are reported as AUTHOR_NOT_MIGRATED (no personal data in the detail).
 * SEC_SUSPICIOUS_USER stays reserved for the later role-aware check.
 */
export async function loadAuthors(
  ctx: LoaderContext,
  authors: AsyncIterable<IRAuthor> | Iterable<IRAuthor>,
  opts: { include?: Set<number>; retry?: RetryOptions; shouldStop?: () => boolean } = {},
): Promise<void> {
  const collection = ctx.collections.author
  if (collection === undefined) return
  for await (const a of authors) {
    if (opts.shouldStop?.()) return
    if (opts.include && !opts.include.has(a.wpId)) {
      ctx.report.count(PHASE, 'skipped')
      ctx.report.warning({ code: 'AUTHOR_NOT_MIGRATED', detail: `User ${a.wpId} is not in the include list and was not migrated`, doc: `author:${a.wpId}` })
      continue
    }
    try {
      if (ctx.dryRun) {
        const existing = await resolve(ctx, 'author', collection, a.wpId)
        ctx.report.count(PHASE, existing === undefined ? 'created' : 'updated')
        continue
      }
      const res = await withRetry(
        () => upsertByWpMeta(ctx.payload, { collection, meta: { site: ctx.site, wpId: a.wpId }, data: { name: a.displayName, slug: a.slug } }),
        opts.retry,
      )
      ctx.ids.set('author', a.wpId, res.id)
      ctx.report.count(PHASE, res.action)
    } catch (error) {
      ctx.report.count(PHASE, 'errors')
      ctx.report.error({ code: 'AUTHOR_WRITE_FAILED', detail: `author ${a.wpId}: ${error instanceof Error ? error.message : String(error)}`, doc: `author:${a.wpId}` })
    }
  }
}
