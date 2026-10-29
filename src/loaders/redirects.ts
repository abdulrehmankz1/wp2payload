import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CollectionSlug, FlattenedField } from 'payload'
import { withRetry, type RetryOptions } from '../state/retry.js'
import { renameWithFallback, STATE_DIR } from '../state/store.js'
import type { LoaderContext, RedirectSource, RedirectsResult } from './types.js'

// Old WordPress permalinks → migrated documents (doc 2.7, spec 06 AC-B1..B4).
//
// Decisions:
// - Old paths drop the trailing slash (root stays `/`). Next.js (trailingSlash: false, the
//   default) redirects `/hello/` to `/hello` before custom redirects run, and the Payload website
//   template looks redirects up by `/<slug>`, so the slash-less form is what matches. File mode
//   also appends `{/}?` so the source matches with or without the slash.
// - File mode keeps the path percent-encoded as WordPress emitted it (Next.js matches the encoded
//   path). Plugin mode stores `from` decoded per segment and NFC-normalised, because the website
//   template compares `redirect.from === '/' + decodedSlug`.
// - Plain permalinks (`/?p=123`): plugin mode stores `from: '/?p=123'`; file mode emits
//   `source: '/'` with `has: [{ type: 'query', key: 'p', value: '123' }]` (Next.js `source`
//   never matches the query string).
// - Never redirected: the front page (`/` or the siteUrl subdirectory, without a query), framework
//   and well-known paths (RESERVED_PREFIXES, RESERVED_EXACT, opts.reserved) on either side, and
//   old paths equal to routes derived from redirects.paths (isPatternReserved).
// - Slugs with a segment decoding to `.` or `..` are skipped (browsers resolve `%2E%2E` too), and
//   every destination must survive URL normalisation unchanged.
// - Paths are compared decoded (per segment, NFC), lower-cased (Next.js sources are
//   case-insensitive) and without the trailing slash. An old path equal to
//   any document's new path would shadow that document, so it is a conflict. Every destination is
//   a document's new path and no old path may equal one, so planned redirects cannot chain or
//   loop. Two documents with the same new path are a conflict in both modes.
// - Conflicts count as `rejected` (not `errors`, so they never trip the error-rate guard) and are
//   reported as REDIRECT_CONFLICT errors. An existing plugin redirect with the right target is
//   left alone and counted `skipped`; one whose reference points at a deleted document is
//   repointed and counted `updated`.
// - redirectTypes: `type` is set to '301', else '308', else the first option offered.

const PHASE = 'redirects'
export const REDIRECTS_FILE = `${STATE_DIR}/redirects.json`

/** Old or new paths under these prefixes (segment-wise, case-insensitive) are never redirected. */
export const RESERVED_PREFIXES: readonly string[] = ['/admin', '/api', '/_next', '/next']
export const RESERVED_EXACT: readonly string[] = ['/favicon.ico', '/robots.txt', '/sitemap.xml']

export interface RedirectsOptions {
  /** Configured source URL (may include a subdirectory, e.g. https://x.test/blog). */
  siteUrl: string
  /** IR type → new path pattern containing `:slug`. */
  paths: Record<string, string>
  /** Redirects collection slug: plugin mode when it exists in the Payload config. */
  collection: CollectionSlug
  /** Project root; file mode writes `<root>/.wp2payload/redirects.json`. */
  root: string
  /** Extra reserved path prefixes, e.g. Payload's `routes.admin` and `routes.api`. */
  reserved?: readonly string[]
  retry?: RetryOptions
  shouldStop?: () => boolean
}

/** One entry of Next.js `redirects()`. */
export interface NextRedirect {
  source: string
  destination: string
  permanent: true
  has?: { type: 'query'; key: string; value: string }[]
}

export interface OldPath {
  /** Pathname as WordPress emitted it (percent-encoded), trailing slash removed. */
  pathname: string
  /** Raw search including `?`, or '' (plain permalinks). */
  search: string
}

const hostKey = (u: URL): string => u.hostname.toLowerCase().replace(/^www\./, '') + (u.port ? `:${u.port}` : '')

function stripSlash(p: string): string {
  let end = p.length
  while (end > 1 && p.charCodeAt(end - 1) === 47) end--
  return p.slice(0, end)
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s).normalize('NFC')
  } catch {
    return s // malformed escape: keep the original
  }
}

/** Pathname decoded per segment and NFC-normalised (a decoded `/` stays inside its segment). */
export function decodePath(p: string): string {
  return p.split('/').map(decodeSegment).join('/')
}

/** Comparison key for a pathname: decoded, NFC, no trailing slash. */
export function pathKey(p: string): string {
  return stripSlash(decodePath(p))
}

/**
 * Key for conflict checks: pathKey lower-cased, because Next.js compiles redirect sources
 * case-insensitively (`sensitive: false`). Used in both modes, which is the conservative choice.
 */
export function matchKey(p: string): string {
  return pathKey(p).toLowerCase()
}

/** True when a slug segment decodes to `.` or `..`: browsers resolve `%2E%2E` as a dot segment too. */
export function hasDotSegment(slug: string): boolean {
  return slug.split('/').some((seg) => {
    const raw = decodeSegment(seg)
    return raw === '.' || raw === '..'
  })
}

/** True when `p` is already a normalised URL path (no dot segments, nothing a URL parser rewrites). */
export function isNormalisedPath(p: string): boolean {
  try {
    return new URL(p, 'http://x').pathname === p
  } catch {
    return false
  }
}

/**
 * Old paths that would shadow routes the new site derives from `redirects.paths`: the static
 * prefix before `:slug` (`/posts` for `/posts/:slug`; nothing for `/:slug`) exactly, its
 * pagination `<prefix>/page` and anything under it, and `/search`. Case-insensitive.
 */
export function isPatternReserved(p: string, paths: Record<string, string>): boolean {
  const key = matchKey(p)
  if (key === '/search') return true
  return Object.values(paths).some((pattern) => {
    const i = pattern.indexOf(':slug')
    const prefix = matchKey(i === -1 ? pattern : pattern.slice(0, i) || '/')
    if (prefix === '/') return false
    const page = `${prefix}/page`
    return key === prefix || key === page || key.startsWith(`${page}/`)
  })
}

/** The old path of `link`, or the reason it cannot be redirected. Reasons never contain the link. */
export function oldPathOf(link: string, siteUrl: string): OldPath | { skip: string } {
  if (!link) return { skip: 'no permalink' }
  let u: URL
  let site: URL
  try {
    site = new URL(siteUrl)
    u = new URL(link, site)
  } catch {
    return { skip: 'invalid permalink' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { skip: 'permalink is not http(s)' }
  if (hostKey(u) !== hostKey(site)) return { skip: 'permalink is not on the source site' }
  return { pathname: stripSlash(u.pathname), search: u.search }
}

/** File-mode / display form: encoded path plus query, e.g. `/2024/01/hello` or `/?p=123`. */
export function fromOf(p: OldPath): string {
  return p.pathname + p.search
}

/** Plugin-mode `from`: decoded path plus the raw query. */
export function pluginFromOf(p: OldPath): string {
  return decodePath(p.pathname) + p.search
}

function encodeSegment(s: string): string {
  const raw = decodeSegment(s) // WordPress slugs of non-ASCII titles arrive percent-encoded
  return encodeURIComponent(raw).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** `pattern` with every `:slug` replaced by the slug, percent-encoded per segment. */
export function newPathOf(pattern: string, slug: string): string {
  const encoded = slug.split('/').filter(Boolean).map(encodeSegment).join('/')
  return pattern.split(':slug').join(encoded)
}

/** Escapes path-to-regexp syntax so a literal path is matched literally by Next.js `source`. */
export function escapeSource(p: string): string {
  return p.replace(/[\\:(){}*+?]/g, (c) => `\\${c}`)
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Next.js redirect for a literal old path. */
export function nextRedirect(old: OldPath, destination: string): NextRedirect {
  const source = old.pathname === '/' ? '/' : `${escapeSource(old.pathname)}{/}?`
  const entry: NextRedirect = { source, destination, permanent: true }
  if (old.search) {
    entry.has = [...new URLSearchParams(old.search)].map(([key, value]) => ({ type: 'query', key, value: escapeRegExp(value) }))
  }
  return entry
}

/** True when `p` (any form) is a framework or well-known path that must never be redirected. */
export function isReserved(p: string, extra: readonly string[] = []): boolean {
  const key = pathKey(p).toLowerCase()
  if (RESERVED_EXACT.includes(key)) return true
  return [...RESERVED_PREFIXES, ...extra].some((raw) => {
    const prefix = pathKey(raw.startsWith('/') ? raw : `/${raw}`).toLowerCase()
    if (prefix === '/') return false // a route mounted at the root reserves nothing specific
    return key === prefix || key.startsWith(`${prefix}/`)
  })
}

interface PluginShape {
  /** `to.reference` relationTo; undefined when the group has no reference field. */
  relationTo?: string | string[]
  /** Value for the top-level `type` select (redirectTypes): 301, else 308, else the first option. */
  redirectType?: string
}

function fieldNamed(fields: readonly FlattenedField[], name: string): FlattenedField | undefined {
  return fields.find((f) => 'name' in f && f.name === name)
}

/** Plugin shape of the redirects collection, or undefined when it is not usable (file mode). */
function pluginShape(ctx: LoaderContext, slug: CollectionSlug): PluginShape | undefined {
  const col = ctx.payload.collections[slug]
  if (!col) return undefined
  const fields = col.config.flattenedFields
  const from = fieldNamed(fields, 'from')
  const to = fieldNamed(fields, 'to')
  if (!from || from.type !== 'text' || !to || to.type !== 'group') {
    ctx.report.warning({ code: 'REDIRECT_COLLECTION_UNSUPPORTED', detail: `Collection "${slug}" lacks the @payloadcms/plugin-redirects shape (from text, to group); writing ${REDIRECTS_FILE} instead` })
    return undefined
  }
  const shape: PluginShape = {}
  const ref = fieldNamed(to.flattenedFields, 'reference')
  if (ref && ref.type === 'relationship') shape.relationTo = ref.relationTo as string | string[]
  const type = fieldNamed(fields, 'type')
  if (type && type.type === 'select') {
    const values = type.options.map((o) => (typeof o === 'string' ? o : o.value))
    const pick = ['301', '308'].find((v) => values.includes(v)) ?? values[0]
    if (pick !== undefined) shape.redirectType = pick
  }
  return shape
}

type Target = { type: 'reference'; reference: unknown } | { type: 'custom'; url: string }

interface ExistingRedirect {
  id: string | number
  to?: { type?: string; reference?: unknown; url?: string | null }
}

const idOf = (v: unknown): string => (v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : String(v))

/** The document an existing reference points at, or undefined when it holds none. */
function referenced(ref: unknown, relationTo: string | string[] | undefined): { collection: string; id: string } | undefined {
  if (ref === null || ref === undefined) return undefined
  if (typeof ref === 'object' && 'relationTo' in ref) {
    const r = ref as { relationTo: unknown; value?: unknown }
    if (r.value === null || r.value === undefined) return undefined
    return { collection: String(r.relationTo), id: idOf(r.value) }
  }
  return typeof relationTo === 'string' ? { collection: relationTo, id: idOf(ref) } : undefined
}

function sameTarget(existing: ExistingRedirect, want: Target): boolean {
  const to = existing.to
  if (!to || to.type !== want.type) return false
  if (want.type === 'custom') return to.url === want.url
  const a = to.reference
  const b = want.reference
  if (b && typeof b === 'object') {
    if (!a || typeof a !== 'object') return false
    const ra = a as { relationTo?: unknown; value?: unknown }
    const rb = b as { relationTo: string; value: unknown }
    return ra.relationTo === rb.relationTo && idOf(ra.value) === idOf(rb.value)
  }
  return idOf(a) === idOf(b)
}

function describeTarget(t: Target | ExistingRedirect['to']): string {
  if (!t) return 'nothing'
  if (t.type === 'custom') return `URL ${String(t.url)}`
  const r = 'reference' in t ? t.reference : undefined
  if (r && typeof r === 'object' && 'relationTo' in r) {
    return `${String((r as { relationTo: unknown }).relationTo)}:${idOf((r as { value?: unknown }).value)}`
  }
  return `document ${idOf(r)}`
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(tmp, content, 'utf8')
    await renameWithFallback(tmp, file)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

const sameDoc = (a: RedirectSource, b: RedirectSource): boolean => a.collection === b.collection && String(a.id) === String(b.id)

/**
 * Write redirects from old permalinks to migrated documents: into the redirects collection when
 * the Payload config has it (plugin mode), else into `.wp2payload/redirects.json` in Next.js
 * `redirects()` format (file mode). Conflicts are reported, never overwritten.
 *
 * `sources` must be every migrated document of the site: new paths of all of them are needed to
 * detect shadowing, so the set is buffered (one small record per document).
 */
export async function loadRedirects(
  ctx: LoaderContext,
  sources: Iterable<RedirectSource> | AsyncIterable<RedirectSource>,
  opts: RedirectsOptions,
): Promise<RedirectsResult> {
  const all: RedirectSource[] = []
  for await (const s of sources) all.push(s)

  const plugin = pluginShape(ctx, opts.collection)
  const reserved = opts.reserved ?? []
  let siteKeyPath = '/'
  try {
    siteKeyPath = matchKey(new URL(opts.siteUrl).pathname)
  } catch {
    // Invalid siteUrl: every link is skipped by oldPathOf below.
  }

  // ASSUMPTION: the documents' own new paths are trusted for ownership even when one is later
  // skipped as not normalised or reserved: claiming more paths only makes the checks stricter.
  // Pass 1: every document's new path, first owner wins.
  const newPathOfDoc = new Map<RedirectSource, string>()
  const owner = new Map<string, RedirectSource>() // matchKey(new path) → document
  for (const s of all) {
    const pattern = opts.paths[s.type]
    if (pattern === undefined || s.slug.split('/').filter(Boolean).length === 0 || hasDotSegment(s.slug)) continue
    const np = newPathOf(pattern, s.slug)
    newPathOfDoc.set(s, np)
    const key = matchKey(np)
    if (!owner.has(key)) owner.set(key, s)
  }

  let count = 0
  let conflicts = 0
  const byFrom = new Map<string, { s: RedirectSource; from: string }>() // old key → first claimant
  const entries: NextRedirect[] = []
  const warnedTypes = new Set<string>()
  const docRef = (s: RedirectSource): string => `${s.type}:${s.wpId}`

  const skip = (s: RedirectSource, detail: string): void => {
    ctx.report.count(PHASE, 'skipped')
    ctx.report.warning({ code: 'REDIRECT_SKIPPED', detail: `${docRef(s)}: ${detail}`, doc: docRef(s) })
  }
  const conflict = (s: RedirectSource, detail: string): void => {
    conflicts++
    ctx.report.count(PHASE, 'rejected')
    ctx.report.error({ code: 'REDIRECT_CONFLICT', detail, doc: docRef(s) })
  }
  const noPattern = (s: RedirectSource): void => {
    ctx.report.count(PHASE, 'skipped')
    if (warnedTypes.has(s.type)) return
    warnedTypes.add(s.type)
    ctx.report.warning({ code: 'REDIRECT_SKIPPED', detail: `No redirects.paths pattern for type "${s.type}"; its redirects are skipped` })
  }

  for (const s of all) {
    if (opts.shouldStop?.()) break
    const old = oldPathOf(s.link, opts.siteUrl)
    if ('skip' in old) {
      skip(s, old.skip)
      continue
    }
    const shown = fromOf(old) // parsed path: no userinfo, no host
    const label = `${docRef(s)} (${shown})`
    const oldKey = matchKey(old.pathname)
    if (!old.search && (oldKey === '/' || oldKey === siteKeyPath)) {
      skip(s, `${shown} is the front page`)
      continue
    }
    if (isReserved(old.pathname, reserved) || isPatternReserved(old.pathname, opts.paths)) {
      skip(s, `${shown} is a reserved path`)
      continue
    }
    if (s.slug.split('/').filter(Boolean).length === 0) {
      skip(s, 'empty slug')
      continue
    }
    if (hasDotSegment(s.slug)) {
      skip(s, 'slug has a dot segment')
      continue
    }
    const np = newPathOfDoc.get(s)
    if (np !== undefined && !isNormalisedPath(np)) {
      skip(s, `new path ${np} is not a normalised path`)
      continue
    }
    if (np !== undefined && isReserved(np, reserved)) {
      skip(s, `new path ${np} is a reserved path`)
      continue
    }
    if (np === undefined && !plugin) {
      noPattern(s)
      continue
    }
    if (np !== undefined && !old.search && matchKey(np) === oldKey) {
      ctx.report.count(PHASE, 'skipped') // the URL did not change: nothing to redirect
      continue
    }
    if (np !== undefined) {
      const first = owner.get(matchKey(np))
      if (first && !sameDoc(first, s)) {
        conflict(s, `New path ${np} is claimed by both ${docRef(first)} and ${label}`)
        continue
      }
    }
    const fromKey = oldKey + old.search
    const claimed = byFrom.get(fromKey)
    if (claimed) {
      conflict(s, `Old path ${shown} is claimed by both ${docRef(claimed.s)} (${claimed.from}) and ${label}; kept the first`)
      continue
    }
    const shadowed = old.search ? undefined : owner.get(oldKey)
    if (shadowed && !sameDoc(shadowed, s)) {
      conflict(s, `Old path ${shown} of ${label} is the new path of ${docRef(shadowed)}; redirecting it would make that document unreachable`)
      continue
    }
    byFrom.set(fromKey, { s, from: shown })

    if (!plugin) {
      entries.push(nextRedirect(old, np as string))
      ctx.report.count(PHASE, 'created')
      count++
      continue
    }

    const from = pluginFromOf(old)
    const rel = plugin.relationTo
    let target: Target
    if (Array.isArray(rel) ? rel.includes(s.collection) : rel === s.collection) {
      target = { type: 'reference', reference: Array.isArray(rel) ? { relationTo: s.collection, value: s.id } : s.id }
    } else if (np !== undefined) {
      target = { type: 'custom', url: np }
    } else {
      noPattern(s)
      continue
    }
    const data: Record<string, unknown> = { from, to: target }
    if (plugin.redirectType !== undefined) data['type'] = plugin.redirectType
    try {
      const found = await withRetry(
        () => ctx.payload.find({ collection: opts.collection, where: { from: { equals: from } }, limit: 1, depth: 0, overrideAccess: true, pagination: false }),
        opts.retry,
      )
      const existing = found.docs[0] as ExistingRedirect | undefined
      if (existing) {
        if (sameTarget(existing, target)) {
          ctx.report.count(PHASE, 'skipped')
          continue
        }
        if (!(await dangling(ctx, existing, rel, opts.retry))) {
          conflict(s, `Existing redirect ${from} points to ${describeTarget(existing.to)}, not ${describeTarget(target)} for ${label}; left unchanged`)
          continue
        }
        if (!ctx.dryRun) {
          await withRetry(() => ctx.payload.update({ collection: opts.collection, id: existing.id, data: data as never, depth: 0, overrideAccess: true }), opts.retry)
        }
        ctx.report.count(PHASE, 'updated')
        count++
        continue
      }
      if (!ctx.dryRun) {
        await withRetry(() => ctx.payload.create({ collection: opts.collection, data: data as never, depth: 0, overrideAccess: true }), opts.retry)
      }
      ctx.report.count(PHASE, 'created')
      count++
    } catch (error) {
      ctx.report.count(PHASE, 'errors')
      ctx.report.error({ code: 'REDIRECT_WRITE_FAILED', detail: `${from} → ${describeTarget(target)} for ${label}: ${message(error)}`, doc: docRef(s) })
    }
  }

  if (plugin || ctx.dryRun || opts.shouldStop?.()) return { count, conflicts }

  entries.sort((a, b) => cmp(a.source, b.source) || cmp(JSON.stringify(a.has ?? []), JSON.stringify(b.has ?? [])))
  try {
    await writeAtomic(path.join(opts.root, REDIRECTS_FILE), `${JSON.stringify(entries, null, 2)}\n`)
  } catch (error) {
    ctx.report.error({ code: 'REDIRECT_WRITE_FAILED', detail: `Could not write ${REDIRECTS_FILE}: ${message(error)}` })
    return { count: 0, conflicts }
  }
  return { count, conflicts, file: REDIRECTS_FILE }
}

/** An existing reference redirect whose document is gone (deleted, or the reference was nulled). */
async function dangling(ctx: LoaderContext, existing: ExistingRedirect, relationTo: string | string[] | undefined, retry?: RetryOptions): Promise<boolean> {
  const to = existing.to
  if (!to || to.type !== 'reference') return false
  const ref = referenced(to.reference, relationTo)
  if (!ref) return true
  if (!ctx.payload.collections[ref.collection as CollectionSlug]) return false // unknown: leave it to the user
  const doc = await withRetry(
    () => ctx.payload.findByID({ collection: ref.collection as CollectionSlug, id: ref.id, depth: 0, disableErrors: true, overrideAccess: true }),
    retry,
  )
  return doc == null
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
