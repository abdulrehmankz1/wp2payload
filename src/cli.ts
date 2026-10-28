#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Command } from 'commander'
import { runDoctor } from './commands/doctor.js'

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
  .command('doctor')
  .description('Check Node, the Payload project and the WordPress source, without writing anything')
  .option('--config <path>', 'config file location (default: wp2payload.config.ts)')
  .action(async (opts: { config?: string }) => {
    process.exitCode = await runDoctor(opts.config ? { configPath: opts.config } : {})
  })

await program.parseAsync()
