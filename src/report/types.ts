// Report contract (doc 4.9). Codes are stable strings, documented in docs/reference/codes.md.

export type Severity = 'high' | 'medium' | 'low'

export interface SecurityFinding {
  code: `SEC_${string}`
  severity: Severity
  action: 'removed' | 'rejected' | 'quarantined' | 'flagged' | 'not migrated' | 'allowed'
  doc?: string // e.g. "post:981"
  media?: number
  file?: string
  user?: number
  detail?: string
  quarantine?: string // path relative to .wp2payload/quarantine
}

export interface Issue {
  code: string // e.g. MEDIA_404, UNKNOWN_BLOCK
  detail: string
  doc?: string
  media?: number
}

export type CountAction = 'created' | 'updated' | 'reused' | 'skipped' | 'rejected' | 'errors'

/** Where loaders send what happened. The report command renders it (CLI, JSON, HTML). */
export interface ReportSink {
  count(phase: string, action: CountAction): void
  warning(issue: Issue): void
  error(issue: Issue): void
  finding(finding: SecurityFinding): void
}

/** In-memory sink for tests and for building report.json. */
export class MemoryReport implements ReportSink {
  readonly summary: Record<string, Partial<Record<CountAction, number>>> = {}
  readonly warnings: Issue[] = []
  readonly errors: Issue[] = []
  readonly findings: SecurityFinding[] = []

  count(phase: string, action: CountAction): void {
    const p = (this.summary[phase] ??= {})
    p[action] = (p[action] ?? 0) + 1
  }
  warning(issue: Issue): void {
    this.warnings.push(issue)
  }
  error(issue: Issue): void {
    this.errors.push(issue)
  }
  finding(finding: SecurityFinding): void {
    this.findings.push(finding)
  }
}
