import { SEVERITY_RANK } from './build.js'
import type { ReportJson, Severity } from './types.js'

export type ExitCode = 0 | 1 | 2 | 3 | 4

export interface ExitInput {
  configInvalid?: boolean
  fatal?: boolean
  report?: ReportJson
  strict?: boolean
  failOnSecurity?: Severity
}

/**
 * Exit codes (doc 4.3): 2 invalid config, 1 fatal or stopped, 4 a security finding at or above
 * `--fail-on-security`, 3 warnings or errors with `--strict`, else 0. Checked in that order.
 */
export function exitCode(input: ExitInput): ExitCode {
  if (input.configInvalid) return 2
  const r = input.report
  if (input.fatal || r?.stopped) return 1
  if (r && input.failOnSecurity) {
    const min = SEVERITY_RANK[input.failOnSecurity]
    if (r.security.findings.some((f) => SEVERITY_RANK[f.severity] >= min)) return 4
  }
  if (r && input.strict && (r.warnings.length > 0 || r.errors.length > 0)) return 3
  return 0
}
