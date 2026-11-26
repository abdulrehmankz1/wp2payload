// Reports carry no email addresses unless `--include-pii` is given (doc 4.2). Author emails are kept
// out at the source; this is the backstop for addresses that arrive inside other text, such as a
// database error or content quoted in a warning.

export const EMAIL_PLACEHOLDER = '[email]'

// Bounded repeats (RFC 5321 limits) keep the scan linear on long text from WordPress.
const EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,8}([A-Za-z]{2,63})\b/g

// `logo@2x.png` is a retina image name, not an address. None of these is a top-level domain.
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'tif', 'tiff', 'ico', 'heic', 'pdf', 'mp3', 'mp4', 'webm', 'ogg', 'wav', 'm4a'])

export function redactEmails(text: string): string {
  return text.replace(EMAIL, (match, tld: string) => (FILE_EXTENSIONS.has(tld.toLowerCase()) ? match : EMAIL_PLACEHOLDER))
}

/** A copy of a JSON value with every email address in its strings replaced. */
export function withoutEmails<T>(value: T): T {
  return walk(value) as T
}

function walk(value: unknown): unknown {
  if (typeof value === 'string') return redactEmails(value)
  if (Array.isArray(value)) return value.map(walk)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = walk(v)
    return out
  }
  return value
}
