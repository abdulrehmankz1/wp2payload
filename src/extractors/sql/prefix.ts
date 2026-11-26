// The WordPress table prefix of a backup, when the config does not set one. Two sources, both
// untrusted (doc 12.7): wp-config.php from an archive, read as text by the small PHP tokenizer
// below and never run, and the table names in the dump (see SqlExtractor). A value is used only
// if it matches TABLE_PREFIX, the characters WordPress itself allows.

/** Letters, digits and underscores, as WordPress requires (wp-settings.php), at most 64. */
export const TABLE_PREFIX = /^[A-Za-z0-9_]{1,64}$/

/** wp-config.php is a few KB; anything far larger is not read. */
export const MAX_WP_CONFIG_BYTES = 256 * 1024

/** What wp-config.php says about `$table_prefix`. */
export type WpConfigPrefix =
  | { status: 'found'; prefix: string }
  /** Set, but not to one plain valid value: never used, the dump decides. No value is quoted (it is untrusted). */
  | { status: 'invalid'; reason: string }
  | { status: 'none' }

type Token =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string; plain: boolean }
  | { kind: 'op'; text: string }
  | { kind: 'other' }

const OPERATOR = /[=.+\-*/%&|^<>!?:~@]/

/**
 * Tokens of a PHP file: variables, string literals, operator runs and `;`. Comments and text outside
 * `<?php ... ?>` are dropped. Returns undefined for constructs it does not read (heredoc), so a
 * value inside them can never be taken for code.
 */
function tokenize(src: string): Token[] | undefined {
  const out: Token[] = []
  let i = 0
  let php = false
  const n = src.length
  while (i < n) {
    if (!php) {
      const open = src.indexOf('<?', i)
      if (open === -1) break
      i = open + 2
      if (src.slice(i, i + 3).toLowerCase() === 'php') i += 3
      else if (src[i] === '=') i++
      php = true
      continue
    }
    const c = src[i]!
    if (c === '?' && src[i + 1] === '>') {
      php = false
      i += 2
      out.push({ kind: 'op', text: ';' })
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      // A line comment ends at the newline or at `?>`.
      while (i < n && src[i] !== '\n' && !(src[i] === '?' && src[i + 1] === '>')) i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end === -1) return out
      i = end + 2
      continue
    }
    if (c === "'") {
      let value = ''
      i++
      for (; i < n && src[i] !== "'"; i++) {
        if (src[i] === '\\' && (src[i + 1] === "'" || src[i + 1] === '\\')) i++
        value += src[i]
      }
      if (i >= n) return undefined
      i++
      out.push({ kind: 'string', value, plain: true })
      continue
    }
    if (c === '"' || c === '`') {
      // Double quotes interpolate and escape: such a value is never taken as plain text.
      let value = ''
      let plain = c === '"'
      i++
      for (; i < n && src[i] !== c; i++) {
        if (src[i] === '\\') {
          plain = false
          i++
        } else if (src[i] === '$' || src[i] === '{') plain = false
        value += src[i] ?? ''
      }
      if (i >= n) return undefined
      i++
      out.push({ kind: 'string', value, plain })
      continue
    }
    if (c === '<' && src.startsWith('<<<', i)) return undefined
    if (c === '$' && /[A-Za-z_\x80-￿]/.test(src[i + 1] ?? '')) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_\x80-￿]/.test(src[j]!)) j++
      out.push({ kind: 'var', name: src.slice(i + 1, j) })
      i = j
      continue
    }
    if (c === ';') {
      out.push({ kind: 'op', text: ';' })
      i++
      continue
    }
    if (OPERATOR.test(c)) {
      let j = i
      // A run ends before a comment and before `?>`, which leaves PHP mode (`$i++?>` is `++` then `?>`).
      while (j < n && OPERATOR.test(src[j]!) && !(src[j] === '/' && (src[j + 1] === '/' || src[j + 1] === '*')) && !(j > i && src[j] === '?' && src[j + 1] === '>')) j++
      out.push({ kind: 'op', text: src.slice(i, j) })
      i = j
      continue
    }
    out.push({ kind: 'other' })
    i++
  }
  return out
}

/**
 * An operator that assigns to the variable before it, not a comparison or `=>`: `=`, `.=`, `??=`...,
 * and runs that start with `=` and glue on what follows (`=&` by reference, `=@`, `=!`, `=-`, `=~`).
 */
const isAssignment = (op: string) =>
  (op.endsWith('=') && !['==', '===', '!=', '!==', '<=', '>=', '<>'].includes(op)) || (op.startsWith('=') && !['==', '===', '=>'].includes(op) && !op.startsWith('=='))

/**
 * `$table_prefix` from wp-config.php. Only the form WordPress writes counts: `$table_prefix = '...';`
 * with a single- or plain double-quoted value. Any other assignment to it (concatenation, a
 * function call, interpolation, different values in several places) makes the file unusable for
 * this, and so does a value WordPress would refuse. The file is never executed.
 */
export function wpConfigPrefix(src: string): WpConfigPrefix {
  const tokens = tokenize(src)
  if (!tokens) return { status: 'invalid', reason: 'the file uses PHP syntax wp2payload does not read (heredoc)' }
  const values = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.kind !== 'var' || t.name !== 'table_prefix') continue
    const op = tokens[i + 1]
    if (op?.kind !== 'op' || !isAssignment(op.text)) continue
    const value = tokens[i + 2]
    const end = tokens[i + 3]
    if (op.text !== '=' || value?.kind !== 'string' || !value.plain || end?.kind !== 'op' || end.text !== ';') {
      return { status: 'invalid', reason: '$table_prefix is not set to a plain quoted value' }
    }
    if (!TABLE_PREFIX.test(value.value)) return { status: 'invalid', reason: '$table_prefix is not a valid table prefix (letters, digits and underscores only)' }
    values.add(value.value)
  }
  if (values.size > 1) return { status: 'invalid', reason: '$table_prefix is set to different values' }
  const [prefix] = values
  return prefix === undefined ? { status: 'none' } : { status: 'found', prefix }
}

/**
 * Paths in an archive that may hold the site's wp-config.php: `wp-config.php` outside wp-content, and
 * the copies Duplicator keeps (`dup-installer/dup-wp-config-arc__*.txt`, `source_site_wpconfig`).
 * Lower rank wins: shallowest first, then wp-config.php before Duplicator's copies.
 */
export function wpConfigRank(rel: string): number | undefined {
  const parts = rel.split('/')
  if (parts.includes('wp-content')) return undefined
  const name = parts.at(-1)!.toLowerCase()
  if (name === 'wp-config.php') return parts.length * 2
  if (/^dup-wp-config-arc__[^/]*\.txt$/.test(name) || name === 'source_site_wpconfig') return parts.length * 2 + 1
  return undefined
}

/** The one best candidate among `rels`; undefined when there is none or several tie. */
export function pickWpConfig(rels: Iterable<string>): string | undefined {
  let best: string | undefined
  let bestRank = Infinity
  let tie = false
  for (const rel of rels) {
    const rank = wpConfigRank(rel)
    if (rank === undefined) continue
    if (rank < bestRank) {
      best = rel
      bestRank = rank
      tie = false
    } else if (rank === bestRank) tie = true
  }
  return tie ? undefined : best
}
