import type { Payload } from 'payload'
import type { ResolvedConfig } from '../config/index.js'
import type { CheckResult } from '../doctor/checks.js'

// Checks the user's Payload against the wp2payload config before anything is written
// (AC-C2). Pure: reads only payload.collections[slug].config.

interface FieldLike {
  name?: string
  type?: string
  fields?: FieldLike[]
  tabs?: { name?: string; fields?: FieldLike[] }[]
}

const WPMETA_FIX = [
  'Add the wpMeta field to the collection:',
  "  import { wpMetaField } from 'wp2payload'",
  '  fields: [/* your fields */, wpMetaField]',
].join('\n')

/** Fields whose data sits at the document's top level: rows, collapsibles and unnamed tabs are layout only. */
function topLevelFields(fields: readonly FieldLike[]): FieldLike[] {
  const out: FieldLike[] = []
  for (const field of fields) {
    if (field.type === 'row' || field.type === 'collapsible' || (field.type === 'group' && !field.name)) {
      out.push(...topLevelFields(field.fields ?? []))
    } else if (field.type === 'tabs') {
      for (const tab of field.tabs ?? []) {
        if (tab.name) out.push({ name: tab.name, type: 'group', fields: tab.fields ?? [] })
        else out.push(...topLevelFields(tab.fields ?? []))
      }
    } else {
      out.push(field)
    }
  }
  return out
}

/** Why the wpMeta group is unusable, or undefined when it is fine. */
function wpMetaProblem(fields: readonly FieldLike[]): string | undefined {
  const wpMeta = topLevelFields(fields).find((field) => field.name === 'wpMeta')
  if (!wpMeta) return 'has no wpMeta field'
  if (wpMeta.type !== 'group') return `has a wpMeta field of type ${wpMeta.type ?? 'unknown'}, not a group`
  const inner = topLevelFields(wpMeta.fields ?? [])
  const site = inner.find((field) => field.name === 'site')
  const wpId = inner.find((field) => field.name === 'wpId')
  const missing = [!site && 'site', !wpId && 'wpId'].filter(Boolean)
  if (missing.length) return `has a wpMeta group without ${missing.join(' and ')}`
  if (site?.type !== 'text') return `has wpMeta.site of type ${site?.type ?? 'unknown'}, expected text`
  if (wpId?.type !== 'number') return `has wpMeta.wpId of type ${wpId?.type ?? 'unknown'}, expected number`
  return undefined
}

export function preflight(payload: Payload, config: ResolvedConfig): CheckResult[] {
  const results: CheckResult[] = []
  const available = payload.collections as Record<string, { config: { fields: FieldLike[]; upload?: unknown } } | undefined>
  for (const [kind, { to }] of Object.entries(config.collections)) {
    const label = `Collection ${to} (WordPress ${kind})`
    const collection = available[to]
    if (!collection) {
      results.push({
        status: 'fail',
        title: `${label} does not exist in Payload`,
        detail: `Add a collection with slug ${to} or change collections.${kind}.to in wp2payload.config.ts.`,
      })
      continue
    }
    const problem = wpMetaProblem(collection.config.fields)
    if (problem) {
      results.push({ status: 'fail', title: `${label} ${problem}`, detail: WPMETA_FIX })
      continue
    }
    if (kind === 'media' && !collection.config.upload) {
      results.push({
        status: 'fail',
        title: `${label} is not an upload collection`,
        detail: `Media files need an upload collection. Add upload: { … } to the ${to} collection or point collections.media.to at your upload collection.`,
      })
      continue
    }
    results.push({ status: 'ok', title: label })
  }
  return results
}
