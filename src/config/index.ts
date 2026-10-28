import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createJiti } from 'jiti'
import { ConfigError } from './errors.js'
import { configSchema, type ResolvedConfig, type Wp2PayloadConfigInput } from './schema.js'

export { ConfigError } from './errors.js'
export type { ResolvedConfig, Wp2PayloadConfigInput } from './schema.js'
export type { Block, Transformer } from './types.js'

export const DEFAULT_CONFIG_FILE = 'wp2payload.config.ts'

/** Identity helper: gives editors types and completion, has no side effects. */
export function defineConfig(input: Wp2PayloadConfigInput): Wp2PayloadConfigInput {
  return input
}

function formatPath(path: PropertyKey[]): string {
  let out = ''
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`
    else out += out ? `.${String(part)}` : String(part)
  }
  return out
}

/** Validate an already-loaded config value. `env` is used only to tell env-sourced secrets from literals. */
export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const parsed = configSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${formatPath(issue.path) || '(config)'}: ${issue.message}`)
    throw new ConfigError(`Invalid configuration:\n${issues.map((line) => `  - ${line}`).join('\n')}`, issues)
  }
  const config = parsed.data as ResolvedConfig
  if (config.source.type === 'rest' && config.source.auth) {
    // Config is code, so a "literal" is any password that no environment variable holds.
    const secret = config.source.auth.appPassword
    if (!Object.values(env).includes(secret)) {
      const issue = 'source.auth.appPassword: expected a value read from the environment, not a literal secret'
      throw new ConfigError(
        `Invalid configuration:\n  - ${issue}\nUse process.env.WP_APP_PASSWORD in wp2payload.config.ts and set it in your shell or .env file.`,
        [issue],
      )
    }
  }
  return config
}

export async function loadConfig(
  path?: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConfig> {
  const file = resolve(cwd, path ?? DEFAULT_CONFIG_FILE)
  if (!existsSync(file)) {
    throw new ConfigError(`Config file not found: ${file}\nRun \`wp2payload init\` to create one, or pass --config <path>.`)
  }
  let raw: unknown
  try {
    const jiti = createJiti(import.meta.url, { moduleCache: false })
    raw = await jiti.import(file, { default: true })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ConfigError(`Could not load ${file}: ${reason}\nFix the error in the config file and retry.`)
  }
  return resolveConfig(raw, env)
}
