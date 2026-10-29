import type { IRTerm } from '../ir/types.js'
import { withRetry, type RetryOptions } from '../state/retry.js'
import { resolve } from '../state/store.js'
import type { LoaderContext } from './types.js'
import { upsertByWpMeta, type PayloadId } from './wpmeta.js'

const PHASE = 'terms'

async function collect<T>(src: AsyncIterable<T> | Iterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of src) out.push(x)
  return out
}

/**
 * Order categories parents-first. Missing parents (not in the batch) become roots; cycles are
 * broken by dropping the parent link of the lowest wpId in the cycle. Never loops.
 */
export function orderCategories(cats: IRTerm[]): {
  ordered: IRTerm[]
  parentOf: Map<number, number | undefined>
  missing: IRTerm[]
  cycles: number[][]
} {
  const byId = new Map(cats.map((c) => [c.wpId, c]))
  const parentOf = new Map<number, number | undefined>()
  const missing: IRTerm[] = []
  for (const c of cats) {
    const p = c.parentWpId
    if (p === undefined || p === 0) parentOf.set(c.wpId, undefined)
    else if (byId.has(p)) parentOf.set(c.wpId, p)
    else {
      parentOf.set(c.wpId, undefined)
      missing.push(c)
    }
  }
  // Cycle detection on a functional graph (out-degree <= 1).
  const cycles: number[][] = []
  const state = new Map<number, 1 | 2>() // 1 = on current walk, 2 = finished
  for (const c of cats) {
    const walked: number[] = []
    let cur: number | undefined = c.wpId
    while (cur !== undefined && !state.has(cur)) {
      state.set(cur, 1)
      walked.push(cur)
      cur = parentOf.get(cur)
    }
    if (cur !== undefined && state.get(cur) === 1) {
      const cycle = walked.slice(walked.indexOf(cur))
      cycles.push(cycle)
      parentOf.set(Math.min(...cycle), undefined)
    }
    for (const id of walked) state.set(id, 2)
  }
  const ordered: IRTerm[] = []
  const done = new Set<number>()
  for (const c of cats) {
    const chain: number[] = []
    let cur: number | undefined = c.wpId
    while (cur !== undefined && !done.has(cur)) {
      chain.push(cur)
      cur = parentOf.get(cur)
    }
    for (const x of chain.reverse()) {
      done.add(x)
      ordered.push(byId.get(x) as IRTerm)
    }
  }
  return { ordered, parentOf, missing, cycles }
}

/**
 * Load categories and tags. ASSUMPTION: term counts are small (hundreds to low thousands), so
 * the whole set is buffered in memory for the parents-first sort.
 */
export async function loadTerms(
  ctx: LoaderContext,
  terms: AsyncIterable<IRTerm> | Iterable<IRTerm>,
  opts: { retry?: RetryOptions; shouldStop?: () => boolean } = {},
): Promise<void> {
  const all = await collect(terms)
  const cats = new Map<number, IRTerm>()
  const tags = new Map<number, IRTerm>()
  for (const t of all) {
    if (t.taxonomy === 'category') cats.set(t.wpId, t)
    else if (t.taxonomy === 'post_tag') tags.set(t.wpId, t)
    else {
      ctx.report.count(PHASE, 'skipped')
      ctx.report.warning({ code: 'TERM_TAXONOMY_UNSUPPORTED', detail: `Taxonomy "${t.taxonomy}" is not migrated yet (term ${t.wpId} "${t.slug}")` })
    }
  }

  const { ordered, parentOf, missing, cycles } = orderCategories([...cats.values()])
  for (const m of missing) {
    ctx.report.warning({ code: 'TERM_PARENT_MISSING', detail: `Category ${m.wpId} "${m.slug}" references missing parent ${m.parentWpId}; written without a parent`, doc: `category:${m.wpId}` })
  }
  for (const cycle of cycles) {
    ctx.report.warning({ code: 'TERM_PARENT_CYCLE', detail: `Category parent cycle ${cycle.join(' -> ')}; broke it at ${Math.min(...cycle)}` })
  }

  const write = async (kind: 'category' | 'post_tag', t: IRTerm, parentId?: PayloadId): Promise<void> => {
    const collection = ctx.collections[kind]
    if (collection === undefined) {
      ctx.report.count(PHASE, 'skipped')
      return
    }
    const data: Record<string, unknown> = { name: t.name, slug: t.slug }
    if (kind === 'category') {
      if (t.description !== undefined) data['description'] = t.description
      data['parent'] = parentId ?? null
    }
    try {
      if (ctx.dryRun) {
        const existing = await resolve(ctx, kind, collection, t.wpId)
        ctx.report.count(PHASE, existing === undefined ? 'created' : 'updated')
        return
      }
      const res = await withRetry(() => upsertByWpMeta(ctx.payload, { collection, meta: { site: ctx.site, wpId: t.wpId }, data }), opts.retry)
      ctx.ids.set(kind, t.wpId, res.id)
      ctx.report.count(PHASE, res.action)
    } catch (error) {
      ctx.report.count(PHASE, 'errors')
      ctx.report.error({ code: 'TERM_WRITE_FAILED', detail: `${kind} ${t.wpId} "${t.slug}": ${error instanceof Error ? error.message : String(error)}`, doc: `${kind}:${t.wpId}` })
    }
  }

  for (const t of ordered) {
    if (opts.shouldStop?.()) return
    const pw = parentOf.get(t.wpId)
    let parentId: PayloadId | undefined
    if (pw !== undefined) {
      parentId = ctx.ids.get('category', pw)
      if (parentId === undefined && !ctx.dryRun) {
        ctx.report.warning({ code: 'TERM_PARENT_MISSING', detail: `Category ${t.wpId} "${t.slug}": parent ${pw} failed to write; written without a parent`, doc: `category:${t.wpId}` })
      }
    }
    await write('category', t, parentId)
  }
  for (const t of tags.values()) {
    if (opts.shouldStop?.()) return
    await write('post_tag', t)
  }
}
