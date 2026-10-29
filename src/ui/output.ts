import type { Env } from '../config/types.js'

// Terminal output rules from the brand guide (Section 8.5): standard ANSI colours only,
// respect NO_COLOR, and no colour when the output is not a TTY (CI logs).

export type Status = 'ok' | 'warn' | 'fail'

const SYMBOLS: Record<Status, string> = { ok: '✔', warn: '!', fail: '✖' }
const COLORS: Record<Status, number> = { ok: 32, warn: 33, fail: 31 }

export function colorEnabled(
  stream: { isTTY?: boolean } = process.stdout,
  env: Env = process.env,
): boolean {
  // https://no-color.org: any non-empty value disables colour.
  if (env.NO_COLOR) return false
  return stream.isTTY === true
}

function paint(code: number, text: string, color: boolean): string {
  return color ? `\u001b[${code}m${text}\u001b[0m` : text
}

export function formatLine(status: Status, title: string, detail?: string, color = colorEnabled()): string {
  const head = `${paint(COLORS[status], SYMBOLS[status], color)} ${title}`
  if (!detail) return head
  const body = detail
    .split('\n')
    .map((line) => `  ${paint(2, line, color)}`)
    .join('\n')
  return `${head}\n${body}`
}
