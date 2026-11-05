import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'

// Streaming reader for MySQL dumps (mysqldump, phpMyAdmin, backup plugins). Nothing in the dump is
// ever executed (doc 12.7, T13): it is read as text, and only `CREATE TABLE` column lists and
// `INSERT` rows of the requested tables are kept. Triggers, procedures, users and every other
// statement are skipped unread.

export class DumpError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'DumpError'
    this.code = code
  }
}

/** A row value: text, or null for SQL NULL. Numbers stay as written. */
export type SqlValue = string | null

export type DumpEvent =
  | { kind: 'table'; table: string; columns: string[] }
  | { kind: 'row'; table: string; columns: string[] | undefined; values: SqlValue[] }

/** Doc 12.7: dumps are capped like exports. */
export const MAX_DUMP_BYTES = 8 * 1024 ** 3
/** A statement head (`INSERT INTO ... VALUES`, a whole `CREATE TABLE`) is never longer than this. */
const MAX_HEAD = 1024 * 1024
/** One value (post content) is never longer than this. */
export const MAX_VALUE_CHARS = 64 * 1024 * 1024

const ESCAPES: Record<string, string> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' }

/** `tables`: the table names to read rows of; `CREATE TABLE` columns are reported for every table. */
/** `range`: the dump is a slice of a larger file (a .wpress backup), from `start` for `length` bytes. */
export async function* readDump(
  file: string,
  opts: { tables: ReadonlySet<string>; maxBytes?: number; range?: { start: number; length: number } },
): AsyncIterable<DumpEvent> {
  let size: number
  try {
    const s = await stat(file)
    if (!s.isFile()) throw new DumpError('DUMP_NOT_FOUND', `${file} is not a file.`)
    size = opts.range ? opts.range.length : s.size
  } catch (error) {
    if (error instanceof DumpError) throw error
    throw new DumpError('DUMP_NOT_FOUND', `SQL dump not found: ${file}`)
  }
  const max = opts.maxBytes ?? MAX_DUMP_BYTES
  if (size > max) throw new DumpError('DUMP_TOO_LARGE', `The dump is ${Math.ceil(size / 1024 ** 2)} MB; the limit is ${Math.floor(max / 1024 ** 2)} MB.`)

  const head = Buffer.alloc(2)
  const fh = await open(file, 'r')
  try {
    await fh.read(head, 0, Math.min(2, size), opts.range?.start ?? 0)
  } finally {
    await fh.close()
  }
  const raw = createReadStream(file, {
    highWaterMark: 1024 * 1024,
    ...(opts.range ? { start: opts.range.start, end: opts.range.start + opts.range.length - 1 } : {}),
  })
  const gz = head[0] === 0x1f && head[1] === 0x8b
  const stream = gz ? raw.pipe(createGunzip()) : raw
  stream.setEncoding('utf8')

  const parser = new DumpParser(opts.tables)
  let inflated = 0
  try {
    for await (const chunk of stream) {
      // A small .gz can hold a huge dump: the cap applies to what it unpacks to.
      inflated += (chunk as string).length
      if (gz && inflated > max) throw new DumpError('DUMP_TOO_LARGE', `The dump unpacks to over ${Math.floor(max / 1024 ** 2)} MB.`)
      yield* parser.feed(chunk as string)
    }
    yield* parser.end()
  } catch (error) {
    if (error instanceof DumpError) throw error
    if ((error as { code?: string }).code?.startsWith('Z_')) throw new DumpError('DUMP_INVALID', 'The .gz file is damaged.')
    throw error
  } finally {
    raw.destroy()
  }
}

type Mode = 'head' | 'skip' | 'values'

/** Character-level state machine; state survives chunk boundaries. */
export class DumpParser {
  readonly #tables: ReadonlySet<string>
  readonly #columns = new Map<string, string[]>()
  /** Tables already reported with a table event. */
  readonly #seen = new Set<string>()
  #mode: Mode = 'head'
  #delimiter = ';'
  #head = ''
  /** Quote character while inside a quoted run (in head or skip mode). */
  #quote = ''
  #escape = false
  /** '' | '-' (after one dash) | 'line' | 'block' | 'block*' */
  #comment = ''
  // values mode
  #table = ''
  #insertColumns: string[] | undefined
  #depth = 0
  #row: SqlValue[] = []
  #value: string[] = []
  #valueLen = 0
  #quoted = false
  #hex = false
  #inString = false
  #pendingQuote = false
  #wanted = false

  constructor(tables: ReadonlySet<string>) {
    this.#tables = tables
  }

  *feed(chunk: string): Generator<DumpEvent> {
    for (let i = 0; i < chunk.length; i++) {
      if (this.#mode === 'values' && this.#inString && !this.#escape && !this.#pendingQuote) {
        // Plain text inside a string: take the run up to the next backslash or quote at once.
        const q = this.#quote.charCodeAt(0)
        let j = i
        while (j < chunk.length) {
          const code = chunk.charCodeAt(j)
          if (code === 92 || code === q) break
          j++
        }
        if (j > i) {
          this.#add(chunk.slice(i, j))
          i = j - 1
          continue
        }
      }
      const c = chunk[i]!
      if (this.#mode === 'values') {
        const ev = this.#valuesChar(c)
        if (ev) yield ev
        continue
      }
      if (this.#comment) {
        if (this.#comment === 'line') {
          if (c === '\n') this.#comment = ''
        } else if (this.#comment === 'block') {
          if (c === '*') this.#comment = 'block*'
        } else if (this.#comment === 'block*') {
          this.#comment = c === '/' ? '' : c === '*' ? 'block*' : 'block'
        }
        continue
      }
      if (this.#quote) {
        if (this.#escape) this.#escape = false
        else if (c === '\\' && this.#quote !== '`') this.#escape = true
        else if (c === this.#quote) this.#quote = ''
        if (this.#mode === 'head') this.#push(c)
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        this.#quote = c
        if (this.#mode === 'head') this.#push(c)
        continue
      }
      // Comments: `-- `, `#`, `/* */` (including mysqldump's `/*!40101 ... */`, never run here).
      if (c === '#' && this.#atLineStartOrSpace()) {
        this.#comment = 'line'
        continue
      }
      if (c === '-' && this.#lastHead() === '-' && this.#mode === 'head') {
        this.#head = this.#head.slice(0, -1)
        this.#comment = 'line'
        continue
      }
      if (c === '*' && this.#lastHead() === '/' && this.#mode === 'head') {
        this.#head = this.#head.slice(0, -1)
        this.#comment = 'block'
        continue
      }
      if (this.#mode === 'skip') {
        if (this.#endsDelimiter(c)) this.#reset()
        continue
      }
      // head mode
      this.#push(c)
      if (this.#head.endsWith(this.#delimiter) && !/^\s*DELIMITER\s/i.test(this.#head)) {
        const ev = this.#statement(this.#head.slice(0, -this.#delimiter.length))
        if (ev) yield ev
        this.#reset()
        continue
      }
      if (c === '\n' && /^\s*DELIMITER\s+(\S+)\s*\n$/i.test(this.#head)) {
        this.#delimiter = /^\s*DELIMITER\s+(\S+)/i.exec(this.#head)![1]!
        this.#reset()
        continue
      }
      if (/^\s*(?:INSERT|REPLACE)\b/i.test(this.#head) && /\bVALUES\s*$/i.test(this.#head)) {
        this.#startValues(this.#head)
        // A table with no CREATE TABLE is still reported, with the columns the INSERT names (if any).
        if (this.#table && !this.#seen.has(this.#table)) {
          this.#seen.add(this.#table)
          yield { kind: 'table', table: this.#table, columns: this.#insertColumns ?? [] }
        }
        continue
      }
      if (this.#head.length > 64 && !/^\s*(?:INSERT|REPLACE|CREATE\s+TABLE)\b/i.test(this.#head)) this.#mode = 'skip'
    }
  }

  *end(): Generator<DumpEvent> {
    if (this.#mode === 'values' && this.#depth > 0) throw new DumpError('DUMP_INVALID', `The dump ends inside an INSERT into ${this.#table}.`)
  }

  #push(c: string) {
    this.#head += c
    if (this.#head.length > MAX_HEAD) {
      if (/^\s*CREATE\s+TABLE\b/i.test(this.#head)) throw new DumpError('DUMP_INVALID', 'A CREATE TABLE statement is over 1 MB.')
      this.#mode = 'skip'
      this.#head = ''
    }
  }

  #lastHead() {
    return this.#head.at(-1) ?? ''
  }

  #atLineStartOrSpace() {
    const last = this.#head.at(-1)
    return last === undefined || /\s/.test(last)
  }

  #endsDelimiter(c: string): boolean {
    if (this.#delimiter.length === 1) return c === this.#delimiter
    this.#head = (this.#head + c).slice(-this.#delimiter.length)
    return this.#head === this.#delimiter
  }

  #reset() {
    this.#mode = 'head'
    this.#head = ''
  }

  #statement(sql: string): DumpEvent | undefined {
    const m = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([^`\s(]+)`?\s*\(([\s\S]*)\)[^)]*$/i.exec(sql)
    if (!m) return undefined
    const columns: string[] = []
    for (const line of m[2]!.split(/,\s*\n/)) {
      const col = /^\s*`([^`]+)`\s+\w/.exec(line)
      if (col) columns.push(col[1]!)
    }
    this.#columns.set(m[1]!, columns)
    this.#seen.add(m[1]!)
    return { kind: 'table', table: m[1]!, columns }
  }

  #startValues(head: string) {
    const m = /^\s*(?:INSERT|REPLACE)\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+)?(?:IGNORE\s+)?(?:INTO\s+)?`?([^`\s(]+)`?\s*(?:\(([^)]*)\))?\s*VALUES\s*$/i.exec(head)
    this.#mode = 'values'
    this.#head = ''
    this.#table = m?.[1] ?? ''
    this.#wanted = m !== null && this.#tables.has(this.#table)
    this.#insertColumns = m?.[2] ? m[2].split(',').map((c) => c.trim().replace(/^`|`$/g, '')) : undefined
    this.#depth = 0
  }

  /** One character of `VALUES (...),(...);`. Returns a row when a tuple closes. */
  #valuesChar(c: string): DumpEvent | undefined {
    if (this.#inString) {
      if (this.#escape) {
        this.#escape = false
        this.#add(ESCAPES[c] ?? c)
      } else if (this.#pendingQuote) {
        this.#pendingQuote = false
        if (c === this.#quote) {
          this.#add(c) // '' inside a string is one quote
        } else {
          this.#inString = false
          this.#quote = ''
          return this.#valuesChar(c)
        }
      } else if (c === '\\') this.#escape = true
      else if (c === this.#quote) this.#pendingQuote = true
      else this.#add(c)
      return undefined
    }
    if (this.#depth === 0) {
      if (c === '(') {
        this.#depth = 1
        this.#row = []
        this.#startValue()
      } else if (c === this.#delimiter[0]) {
        this.#reset()
      } else if (c !== ',' && !/\s/.test(c)) {
        throw new DumpError('DUMP_INVALID', `Unexpected "${c}" between rows of ${this.#table}.`)
      }
      return undefined
    }
    if (c === "'" || c === '"') {
      this.#inString = true
      this.#quoted = true
      this.#quote = c
      // A charset prefix (_binary, _utf8mb4) is dropped; X'...' is hex.
      this.#hex = /^x$/i.test(this.#value.join(''))
      this.#value = []
      this.#valueLen = 0
      return undefined
    }
    if (c === '(') {
      this.#depth++
      this.#add(c)
      return undefined
    }
    if (c === ',' && this.#depth === 1) {
      this.#endValue()
      this.#startValue()
      return undefined
    }
    if (c === ')') {
      if (this.#depth > 1) {
        this.#depth--
        this.#add(c)
        return undefined
      }
      this.#depth = 0
      this.#endValue()
      if (!this.#wanted) return undefined
      return { kind: 'row', table: this.#table, columns: this.#insertColumns ?? this.#columns.get(this.#table), values: this.#row }
    }
    if (!/\s/.test(c)) this.#add(c)
    return undefined
  }

  #startValue() {
    this.#value = []
    this.#valueLen = 0
    this.#quoted = false
    this.#hex = false
  }

  #add(s: string) {
    if (!this.#wanted) return
    this.#valueLen += s.length
    if (this.#valueLen > MAX_VALUE_CHARS) throw new DumpError('DUMP_TOO_LARGE', `A value in ${this.#table} is over ${MAX_VALUE_CHARS / 1024 ** 2} M characters.`)
    this.#value.push(s)
  }

  #endValue() {
    if (!this.#wanted) return
    const v = this.#value.join('')
    this.#row.push(this.#quoted ? (this.#hex ? Buffer.from(v, 'hex').toString('utf8') : v) : /^null$/i.test(v) ? null : hexOrBare(v))
  }
}

/** `0x6869` hex literals become text; numbers and keywords stay as written. */
function hexOrBare(v: string): string {
  if (/^0x[0-9a-f]*$/i.test(v)) return Buffer.from(v.slice(2), 'hex').toString('utf8')
  return v
}
