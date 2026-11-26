import { createInterface } from 'node:readline/promises'
import { clean } from '../report/summary.js'
import {
  approvable,
  decide,
  listQuarantine,
  readQuarantined,
  readReview,
  writeReview,
  type Decision,
  type QuarantineEntry,
} from '../review/store.js'
import { formatLine } from '../ui/output.js'

export interface ReviewOptions {
  cwd?: string
  /** Print every item with its status, then exit. */
  list?: boolean
  approve?: string[]
  reject?: string[]
  /** Go through items already decided as well. */
  all?: boolean
  log?: (line: string) => void
  isTTY?: boolean
  /** Asks one question; defaults to a readline prompt. Returns the trimmed answer. */
  prompt?: (question: string) => Promise<string>
}

const PREVIEW_CHARS = 800

/** `wp2payload review` (doc 12.10): go through quarantined items and approve or reject them. */
export async function runReview(opts: ReviewOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd()
  const log = opts.log ?? console.log
  const items = await listQuarantine(cwd)
  const review = await readReview(cwd)
  if (items.length === 0) {
    log('Nothing in quarantine. Run wp2payload migrate (or scan) first.')
    return 0
  }

  if (opts.approve?.length || opts.reject?.length) {
    const byId = new Map(items.map((i) => [i.id, i]))
    const wanted: [string, Decision][] = [...(opts.approve ?? []).map((id) => [id, 'approved'] as [string, Decision]), ...(opts.reject ?? []).map((id) => [id, 'rejected'] as [string, Decision])]
    for (const [id] of wanted) {
      if (!byId.has(id)) {
        log(formatLine('fail', `No quarantined item ${clean(id)}`, 'List them with wp2payload review --list.'))
        return 2
      }
    }
    for (const [id, decision] of wanted) {
      try {
        review.decisions[id] = decide(byId.get(id)!, decision)
      } catch (error) {
        log(formatLine('fail', clean((error as Error).message)))
        return 2
      }
      log(formatLine('ok', `${decision === 'approved' ? 'Approved' : 'Rejected'} ${clean(id)}`))
    }
    await writeReview(cwd, review)
    return 0
  }

  const status = (i: QuarantineEntry) => review.decisions[i.id]?.decision ?? 'pending'
  if (opts.list || !(opts.isTTY ?? process.stdin.isTTY)) {
    for (const i of items) log(`${status(i).padEnd(8)} ${i.finding.severity.padEnd(6)} ${clean(i.finding.code).padEnd(24)} ${clean(i.finding.doc ?? (i.finding.media !== undefined ? `media:${i.finding.media}` : ''))}  ${clean(i.id)}`)
    const pending = items.filter((i) => status(i) === 'pending').length
    log('')
    log(`${items.length} quarantined, ${pending} pending.${opts.list ? '' : ' Run this in a terminal to go through them, or use --approve <id> / --reject <id>.'}`)
    return 0
  }

  const queue = items.filter((i) => opts.all || status(i) === 'pending')
  if (queue.length === 0) {
    log('Every quarantined item has a decision. Use --all to go through them again.')
    return 0
  }
  const ask = opts.prompt ?? prompt
  let approved = 0
  let rejected = 0
  for (const [n, item] of queue.entries()) {
    const f = item.finding
    const can = approvable(f)
    log('')
    log(`[${n + 1}/${queue.length}] ${f.severity} ${clean(f.code)}${f.doc ? `  ${clean(f.doc)}` : ''}${f.media !== undefined ? `  media:${f.media}` : ''}`)
    if (f.detail) log(`  ${clean(f.detail)}`)
    log(`  ${await preview(cwd, item)}`)
    log(can.ok ? `  Approving will ${can.effect}.` : `  Cannot be approved: ${can.why}.`)
    const question = can.ok ? 'Approve, reject, skip or quit? [a/r/s/q] ' : 'Mark as rejected, skip or quit? [r/s/q] '
    let answer = ''
    for (;;) {
      answer = (await ask(question)).toLowerCase()
      if (['r', 's', 'q'].includes(answer) || (can.ok && answer === 'a')) break
    }
    if (answer === 'q') break
    if (answer === 's') continue
    review.decisions[item.id] = decide(item, answer === 'a' ? 'approved' : 'rejected')
    if (answer === 'a') approved++
    else rejected++
    // Saved after every answer, so quitting halfway keeps what was decided.
    await writeReview(cwd, review)
  }
  log('')
  log(`${approved} approved, ${rejected} rejected.${approved ? ' Run wp2payload migrate again to apply the approvals.' : ''}`)
  return 0
}

/** A short, inert view of the item: text for fragments, size and hash for files. */
async function preview(cwd: string, item: QuarantineEntry): Promise<string> {
  if (item.kind === 'files') return `File, ${item.bytes} bytes, sha256 ${item.sha256.slice(0, 16)}...`
  const text = (await readQuarantined(cwd, item)).toString('utf8').replace(/\s+/g, ' ').trim()
  return clean(text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}...` : text)
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const abort = new AbortController()
  rl.once('SIGINT', () => abort.abort())
  try {
    return (await rl.question(question, { signal: abort.signal })).trim()
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') return 'q'
    throw error
  } finally {
    rl.close()
  }
}
