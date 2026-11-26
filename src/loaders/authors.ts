import { randomBytes } from 'node:crypto'
import type { CollectionSlug, Payload } from 'payload'
import type { IRAuthor } from '../ir/types.js'
import { redactEmails } from '../report/pii.js'
import { ACCOUNT_CREATED } from '../report/summary.js'
import { withRetry, type RetryOptions } from '../state/retry.js'
import { resolve } from '../state/store.js'
import type { LoaderContext } from './types.js'
import { findByWpMeta, upsertByWpMeta, type PayloadId, type UpsertResult } from './wpmeta.js'

const PHASE = 'authors'

export interface LoadAuthorsOptions {
  include?: Set<number>
  retry?: RetryOptions
  shouldStop?: () => boolean
  /** `--invite-users`: send Payload's forgot-password email to each user created in this run (auth collections only). */
  invite?: boolean
  /** `--include-pii`: author emails may appear in report details. */
  includePii?: boolean
}

export interface LoadAuthorsResult {
  /** The target is an auth collection (doc 2.6). */
  auth: boolean
  /** With `invite`: emails sent (a dry run counts the ones it would send) and sends that failed. */
  invitations?: { sent: number; failed: number }
}

/** Auth settings the loader needs, read from the collection config; undefined when it is not an auth collection. */
export function authOf(payload: Payload, collection: CollectionSlug): { loginWithUsername: boolean } | undefined {
  const auth = (payload.collections[collection]?.config as { auth?: unknown } | undefined)?.auth
  if (!auth) return undefined
  return { loginWithUsername: typeof auth === 'object' && Boolean((auth as { loginWithUsername?: unknown }).loginWithUsername) }
}

/**
 * Load authors. With `include`, only those wpIds are migrated (doc 12.9); the rest are reported as
 * AUTHOR_NOT_MIGRATED (no personal data in the detail). Passwords are never read from WordPress, and
 * roles and capabilities are never migrated.
 *
 * Non-auth collection (the blog preset): `{ name, slug }` only; email is never written.
 *
 * Auth collection (opt-in, doc 2.6), detected from the Payload collection config: a new user also gets
 * the email from the source and a random 32-byte password that is never logged, reported or stored.
 * With `invite`, a real run then sends Payload's forgot-password email so the user sets their own.
 * Only users created in this run are invited, so re-runs (which update) never send again. Each created
 * account is reported as AUTHOR_ACCOUNT_CREATED (wpId and slug; email only with `includePii`). An existing
 * Payload account with the same email is never linked or changed (AUTHOR_EMAIL_IN_USE).
 */
export async function loadAuthors(
  ctx: LoaderContext,
  authors: AsyncIterable<IRAuthor> | Iterable<IRAuthor>,
  opts: LoadAuthorsOptions = {},
): Promise<LoadAuthorsResult> {
  const collection = ctx.collections.author
  if (collection === undefined) return { auth: false }
  const auth = authOf(ctx.payload, collection)
  const invitations = auth && opts.invite ? { sent: 0, failed: 0 } : undefined
  const pii = (email: string) => (opts.includePii ? ` (${email})` : '')
  const safe = (text: string) => (opts.includePii ? text : redactEmails(text))

  for await (const a of authors) {
    if (opts.shouldStop?.()) break
    if (opts.include && !opts.include.has(a.wpId)) {
      ctx.report.count(PHASE, 'skipped')
      ctx.report.warning({ code: 'AUTHOR_NOT_MIGRATED', detail: `User ${a.wpId} is not in the include list and was not migrated`, doc: `author:${a.wpId}` })
      continue
    }
    const email = auth ? normaliseEmail(a.email) : undefined
    if (auth && email === undefined) {
      ctx.report.count(PHASE, 'skipped')
      ctx.report.warning({
        code: 'AUTHOR_NO_EMAIL',
        detail: `User ${a.wpId} has no email in the source, so no account was created in the auth collection ${collection}`,
        doc: `author:${a.wpId}`,
      })
      continue
    }
    let password: string | undefined
    try {
      let res: UpsertResult | 'email-in-use'
      if (ctx.dryRun) {
        // Same decisions as a real run, nothing written.
        const existing = await resolve(ctx, 'author', collection, a.wpId)
        if (existing !== undefined) res = { id: existing, action: 'updated' }
        else if (email !== undefined && (await emailInUse(ctx.payload, collection, email))) res = 'email-in-use'
        else res = { id: '', action: 'created' }
      } else if (auth && email !== undefined) {
        // Generated per attempt and dropped after the write: Payload stores only its hash.
        res = await withRetry(() => {
          password = randomBytes(32).toString('base64url')
          return upsertUser(ctx, collection, a, email, password, auth.loginWithUsername)
        }, opts.retry)
        password = undefined
      } else {
        res = await withRetry(
          () => upsertByWpMeta(ctx.payload, { collection, meta: { site: ctx.site, wpId: a.wpId }, data: { name: a.displayName, slug: a.slug } }),
          opts.retry,
        )
      }
      if (res === 'email-in-use') {
        ctx.report.count(PHASE, 'skipped')
        ctx.report.warning({
          code: 'AUTHOR_EMAIL_IN_USE',
          detail: `User ${a.wpId}${pii(email!)}: an account in ${collection} already has this email; it was left unchanged and not linked`,
          doc: `author:${a.wpId}`,
        })
        continue
      }
      if (!ctx.dryRun) ctx.ids.set('author', a.wpId, res.id)
      ctx.report.count(PHASE, res.action)
      // On a hacked site the attacker's own user wrote the spam, so it has content and gets an
      // account like everyone else. Every account this run creates is listed for review.
      if (auth && res.action === 'created') {
        ctx.report.warning({
          code: ACCOUNT_CREATED,
          detail: `User ${a.wpId} (slug ${JSON.stringify(safe(a.slug).slice(0, 100))})${pii(email!)} ${ctx.dryRun ? 'would get' : 'got'} a login account in ${collection}. Check it is a real person before go-live`,
          doc: `author:${a.wpId}`,
        })
      }
      if (invitations && res.action === 'created') {
        if (ctx.dryRun) invitations.sent++
        else await invite(ctx, collection, a.wpId, email!, invitations, pii, safe)
      }
    } catch (error) {
      ctx.report.count(PHASE, 'errors')
      ctx.report.error({ code: 'AUTHOR_WRITE_FAILED', detail: `author ${a.wpId}: ${safe(errorText(error, password))}`, doc: `author:${a.wpId}` })
    }
  }
  return { auth: auth !== undefined, ...(invitations ? { invitations } : {}) }
}

/** Upsert into an auth collection: the email and password are set only when the account is created. */
async function upsertUser(
  ctx: LoaderContext,
  collection: CollectionSlug,
  a: IRAuthor,
  email: string,
  password: string,
  loginWithUsername: boolean,
): Promise<UpsertResult | 'email-in-use'> {
  const wpMeta = { site: ctx.site, wpId: a.wpId, importedAt: new Date().toISOString() }
  const profile = { name: a.displayName, slug: a.slug, wpMeta }
  const existing = await findByWpMeta(ctx.payload, collection, ctx.site, a.wpId)
  if (existing !== undefined) {
    // Never the email or password: the user may have changed them in Payload since.
    const updated = await ctx.payload.update({ collection, id: existing, data: profile as never, depth: 0, overrideAccess: true })
    return { id: (updated as { id: PayloadId }).id, action: 'updated' }
  }
  if (await emailInUse(ctx.payload, collection, email)) return 'email-in-use'
  const created = await ctx.payload.create({
    collection,
    data: { ...profile, email, password, ...(loginWithUsername ? { username: a.slug } : {}) } as never,
    depth: 0,
    overrideAccess: true,
    // Emails go out only with --invite-users, never from a collection's `verify` setting.
    disableVerificationEmail: true,
  })
  return { id: (created as { id: PayloadId }).id, action: 'created' }
}

async function emailInUse(payload: Payload, collection: CollectionSlug, email: string): Promise<boolean> {
  const { totalDocs } = await payload.count({ collection, where: { email: { equals: email } }, overrideAccess: true })
  return totalDocs > 0
}

/** One forgot-password email. A failure is a warning: the account exists and the user can ask for a reset later. */
async function invite(
  ctx: LoaderContext,
  collection: CollectionSlug,
  wpId: number,
  email: string,
  invitations: { sent: number; failed: number },
  pii: (email: string) => string,
  safe: (text: string) => string,
): Promise<void> {
  try {
    // The returned reset token is dropped unread; only the email carries it.
    await ctx.payload.forgotPassword({ collection, data: { email }, overrideAccess: true })
    invitations.sent++
  } catch (error) {
    invitations.failed++
    ctx.report.warning({
      code: 'AUTHOR_INVITE_FAILED',
      detail: `User ${wpId}${pii(email)}: the password-set email could not be sent (${safe(errorText(error))}). Use "Forgot password" on the Payload login page instead`,
      doc: `author:${wpId}`,
    })
  }
}

function normaliseEmail(email: string | undefined): string | undefined {
  const e = email?.trim().toLowerCase()
  return e ? e : undefined
}

/** First line only (database drivers append the query parameters below it), without the password if it slipped in. */
function errorText(error: unknown, password?: string): string {
  const first = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? ''
  return password ? first.split(password).join('[password]') : first
}
