// Exit code 2 is the CLI's "bad configuration or usage" code.
export class ConfigError extends Error {
  readonly exitCode = 2 as const
  readonly issues: readonly string[]

  constructor(message: string, issues: readonly string[] = []) {
    super(message)
    this.name = 'ConfigError'
    this.issues = issues
  }
}
