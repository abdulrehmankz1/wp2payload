#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Command, InvalidArgumentError, Option } from 'commander'
import { runDoctor } from './commands/doctor.js'
import { runReport } from './commands/report.js'
import { runReset } from './commands/reset.js'

// package.json sits one level above both src/ and dist/, and is always published.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

// Payload projects keep PAYLOAD_SECRET, DATABASE_URI and the WP_* variables in .env.
// Variables already set in the shell win, matching dotenv's behaviour.
if (existsSync('.env')) process.loadEnvFile('.env')

const program = new Command()
  .name('wp2payload')
  .description('Migrate a WordPress site into Payload CMS 3.')
  .version(version, '-v, --version')

program
  .command('init')
  .description('Write wp2payload.config.ts and update .gitignore; --scaffold adds the blog preset collections')
  .option('--url <url>', 'WordPress site URL (written to .env as WP_URL)')
  .option('--scaffold', 'write the blog preset collections as new files')
  .option('--force', 'replace an existing wp2payload.config.ts (collection files are never overwritten)')
  .option('--yes', 'do not ask questions; use the flags')
  .action(async (opts: { url?: string; scaffold?: boolean; force?: boolean; yes?: boolean }) => {
    const { runInit } = await import('./commands/init.js')
    process.exitCode = await runInit({
      ...(opts.url ? { url: opts.url } : {}),
      scaffold: opts.scaffold === true,
      force: opts.force === true,
      yes: opts.yes === true,
    })
  })

program
  .command('doctor')
  .description('Check Node, the Payload project and the WordPress source, without writing anything')
  .option('--config <path>', 'config file location (default: wp2payload.config.ts)')
  .action(async (opts: { config?: string }) => {
    process.exitCode = await runDoctor(opts.config ? { configPath: opts.config } : {})
  })

const list = (value: string, prev: string[] = []) => [...prev, ...value.split(',').map((s) => s.trim()).filter(Boolean)]
const positiveInt = (flag: string) => (value: string) => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError(`${flag} expects a whole number of 1 or more`)
  return n
}

program
  .command('migrate')
  .description('Run the migration. Resumes automatically from existing state')
  .option('--config <path>', 'config file location (default: wp2payload.config.ts)')
  .option('--dry-run', 'extract and transform, write nothing')
  .option('--only <list>', 'limit phases or types, e.g. media,posts', list)
  .option('--limit <n>', 'write only the first n documents (all are still read, for links)', positiveInt('--limit'))
  .option('--concurrency <n>', 'parallel media downloads (default 4)', positiveInt('--concurrency'))
  .option('--fresh', 'ignore local state; still upserts, so no duplicates')
  .option('--strict', 'exit with code 3 if there are any warnings')
  .addOption(new Option('--fail-on-security <level>', 'exit with code 4 if findings at or above this level exist').choices(['low', 'medium', 'high']))
  .option('--allow-svg', 'accept SVG uploads after a strict check')
  .option('--allow-embed-host <host>', 'add a trusted iframe host (repeatable)', list)
  .option('--yes', 'skip the first-run confirmation (for CI)')
  .option('--verbose', 'per-item logging')
  .action(async (opts: MigrateCliOptions) => {
    // Loaded on demand: the pipeline pulls in sharp and the sanitizer, which doctor never needs.
    const { runMigrate } = await import('./commands/migrate.js')
    process.exitCode = await runMigrate({
      ...(opts.config ? { configPath: opts.config } : {}),
      dryRun: opts.dryRun === true,
      ...(opts.only ? { only: opts.only } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      fresh: opts.fresh === true,
      strict: opts.strict === true,
      ...(opts.failOnSecurity ? { failOnSecurity: opts.failOnSecurity } : {}),
      allowSvg: opts.allowSvg === true,
      allowEmbedHosts: opts.allowEmbedHost ?? [],
      yes: opts.yes === true,
      verbose: opts.verbose === true,
    })
  })

program
  .command('report')
  .description('Print the last migration report again')
  .option('--json', 'print report.json instead of the summary')
  .option('--verbose', 'list every warning and error')
  .action(async (opts: { json?: boolean; verbose?: boolean }) => {
    process.exitCode = await runReport({ json: opts.json === true, verbose: opts.verbose === true })
  })

program
  .command('reset')
  .description('Delete local state. Does not delete any Payload data')
  .action(async () => {
    process.exitCode = await runReset({})
  })

interface MigrateCliOptions {
  config?: string
  dryRun?: boolean
  only?: string[]
  limit?: number
  concurrency?: number
  fresh?: boolean
  strict?: boolean
  failOnSecurity?: 'low' | 'medium' | 'high'
  allowSvg?: boolean
  allowEmbedHost?: string[]
  yes?: boolean
  verbose?: boolean
}

await program.parseAsync()
