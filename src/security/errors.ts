/** A security rule refused an operation. `code` is a stable SEC_* string (docs/reference/codes.md). */
export class SecurityError extends Error {
  readonly code: `SEC_${string}`
  constructor(code: `SEC_${string}`, message: string) {
    super(message)
    this.name = 'SecurityError'
    this.code = code
  }
}

/** A non-security media failure (404, timeout, network). Reported as an Issue, not a finding. */
export class MediaError extends Error {
  readonly code: string
  readonly status?: number
  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'MediaError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}
