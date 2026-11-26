import type { ResolvedConfig } from '../config/index.js'
import type { CheckResult } from '../doctor/checks.js'

// SEC-01, doc 2.6 and 12.2 principle 6: WordPress users become Payload login accounts only with an
// explicit opt-in, `authors: { createAccounts: true }` in wp2payload.config.ts. On an SEO-spam-hacked
// site the attacker's own user wrote the spam posts, so it passes the "has content" filter; without
// the opt-in, mapping authors into an auth collection stops migrate before anything is written.

/** The config key; named in messages and recorded in the report when it is on. */
export const CREATE_ACCOUNTS = 'authors.createAccounts'

const OPT_IN = 'set authors: { createAccounts: true } in wp2payload.config.ts'

/** A check with the exit code it ends the run with: 2 for the missing opt-in (a config decision), 1 for the rest. */
export type AccountsCheck = CheckResult & { exitCode?: 1 | 2 }

/** `--invite-users` without the opt-in: a usage error found before anything connects. */
export function inviteWithoutOptIn(config: ResolvedConfig, inviteUsers: boolean): AccountsCheck | undefined {
  if (!inviteUsers || config.authors.createAccounts) return undefined
  return {
    status: 'fail',
    title: '--invite-users needs authors.createAccounts',
    detail: `--invite-users emails the login accounts wp2payload creates, and it creates none unless you ${OPT_IN}. Nothing was written.`,
    exitCode: 2,
  }
}

/** The auth collection authors map into, or undefined. `isAuth` reads the Payload collection config. */
export function authorAuthTarget(config: ResolvedConfig, isAuth: (slug: string) => boolean): string | undefined {
  const to = config.collections['author']?.to
  return to !== undefined && isAuth(to) ? to : undefined
}

/**
 * What the authors phase will do with accounts, for migrate's preflight and for doctor.
 * `email`: whether Payload has an email adapter; undefined when not known (doctor).
 */
export function accountsCheck(
  config: ResolvedConfig,
  isAuth: (slug: string) => boolean,
  opts: { inviteUsers: boolean; email?: boolean },
): AccountsCheck | undefined {
  const to = config.collections['author']?.to
  const target = authorAuthTarget(config, isAuth)
  const optIn = config.authors.createAccounts
  if (target === undefined) {
    const where = `Authors are not mapped into an auth collection${to ? ` (${to} has no auth)` : ''}, so no accounts are created.`
    if (opts.inviteUsers) return { status: 'warn', title: '--invite-users has no effect', detail: where }
    if (optIn) return { status: 'warn', title: 'authors.createAccounts has no effect', detail: where }
    return undefined
  }
  if (!optIn) {
    return {
      status: 'fail',
      title: `Authors map into ${target}, an auth collection, so each would get a login account`,
      detail: [
        'Every WordPress user with migrated content would become an account that can log in. On a hacked site that includes',
        "the attacker's own user, which wrote the spam posts. Nothing was written.",
        `To create the accounts, ${OPT_IN}; each one is then listed in the report as AUTHOR_ACCOUNT_CREATED.`,
        "Otherwise point collections.author.to at a collection without auth (the blog preset's authors).",
      ].join('\n'),
      exitCode: 2,
    }
  }
  // A warning, not ok: on a hacked site the attacker's user wrote the spam posts and gets an account too.
  const review = 'These accounts can log in. Every one created is listed in the report as AUTHOR_ACCOUNT_CREATED; check each is a real person before go-live.'
  if (!opts.inviteUsers) {
    return {
      status: 'warn',
      title: `Authors become login accounts in ${target} (${CREATE_ACCOUNTS})`,
      detail: `${review} Each new account gets a random password. Add --invite-users to email a password-set link, or users can use "Forgot password".`,
    }
  }
  if (opts.email === false) {
    return {
      status: 'fail',
      title: '--invite-users needs an email adapter in your Payload config',
      detail: 'Without one Payload only logs emails. Add email: nodemailerAdapter(...) or resendAdapter(...) to payload.config.ts, or run without --invite-users.',
      exitCode: 1,
    }
  }
  return {
    status: 'warn',
    title: `Authors become login accounts in ${target} (${CREATE_ACCOUNTS}), each emailed a password-set link`,
    detail: `${review} Only accounts created by this run are emailed; re-runs send nothing.`,
  }
}
