export type PayloadBootErrorCode =
  | 'PAYLOAD_NOT_INSTALLED'
  | 'PAYLOAD_VERSION_UNSUPPORTED'
  | 'PAYLOAD_CONFIG_NOT_FOUND'
  | 'PAYLOAD_BOOT_FAILED'

/** wp2payload could not start the user's Payload. `message` says what happened and the fix. */
export class PayloadBootError extends Error {
  readonly code: PayloadBootErrorCode
  readonly exitCode = 1 as const

  constructor(code: PayloadBootErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PayloadBootError'
    this.code = code
  }
}
