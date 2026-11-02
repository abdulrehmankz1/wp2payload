import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Parser } from 'htmlparser2'

// Streaming reader for WordPress export files (WXR, doc 12.7). htmlparser2 in XML mode never
// loads a DTD or expands entities beyond the five XML ones and numeric references; a DOCTYPE is
// rejected outright, so XXE and entity expansion ("billion laughs", T12) cannot happen.

export class WxrError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WxrError'
    this.code = code
  }
}

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  text: string
  kids: XmlNode[]
}

/** A direct child of `<channel>`: `item`, `wp:author`, `wp:category`, `wp:base_site_url`... */
export interface WxrRecord {
  name: string
  node: XmlNode
}

/** Doc 12.7: 2 GB by default. */
export const MAX_WXR_BYTES = 2 * 1024 ** 3
/** One item (post content, meta) is never bigger than this. */
export const MAX_RECORD_CHARS = 64 * 1024 * 1024
const MAX_DEPTH = 32
const MAX_RECORD_NODES = 100_000

export async function* readWxr(file: string, opts: { maxBytes?: number } = {}): AsyncIterable<WxrRecord> {
  const max = opts.maxBytes ?? MAX_WXR_BYTES
  let size: number
  try {
    const s = await stat(file)
    if (!s.isFile()) throw new WxrError('WXR_NOT_FOUND', `${file} is not a file.`)
    size = s.size
  } catch (error) {
    if (error instanceof WxrError) throw error
    throw new WxrError('WXR_NOT_FOUND', `Export file not found: ${file}`)
  }
  if (size > max) {
    throw new WxrError('WXR_TOO_LARGE', `The export file is ${Math.ceil(size / 1024 ** 2)} MB; the limit is ${Math.floor(max / 1024 ** 2)} MB.`)
  }

  const out: WxrRecord[] = []
  const stack: XmlNode[] = []
  let failure: WxrError | undefined
  let seenRss = false
  let seenChannel = false
  let chars = 0
  let nodes = 0
  const fail = (code: string, message: string) => {
    failure ??= new WxrError(code, message)
    parser.pause()
  }

  const parser = new Parser(
    {
      onprocessinginstruction(name) {
        if (name.toLowerCase().startsWith('!doctype')) fail('WXR_DOCTYPE', 'The export file declares a DOCTYPE; WordPress exports never do, so it was refused (XML entity attacks).')
      },
      onopentag(name, attrs) {
        if (failure) return
        if (stack.length === 0) {
          if (name !== 'rss' || seenRss) return fail('WXR_INVALID', 'Not a WordPress export: the root element is not <rss>.')
          seenRss = true
        } else if (stack.length === 1 && name === 'channel') {
          seenChannel = true
        }
        if (stack.length >= MAX_DEPTH) return fail('WXR_INVALID', `Elements are nested deeper than ${MAX_DEPTH}.`)
        if (stack.length >= 3 && ++nodes > MAX_RECORD_NODES) return fail('WXR_TOO_LARGE', `One item in the export has over ${MAX_RECORD_NODES} elements.`)
        const node: XmlNode = { name, attrs: { ...attrs }, text: '', kids: [] }
        stack.at(-1)?.kids.push(node)
        stack.push(node)
        if (stack.length === 3) chars = nodes = 0
      },
      ontext(text) {
        if (failure) return
        const node = stack.at(-1)
        if (!node || stack.length < 3) return
        chars += text.length
        if (chars > MAX_RECORD_CHARS) return fail('WXR_TOO_LARGE', `One item in the export is over ${MAX_RECORD_CHARS / 1024 ** 2} M characters.`)
        node.text += text
      },
      onclosetag() {
        if (failure) return
        const node = stack.pop()
        if (!node) return
        // Records are the channel's children; drop them from the tree once emitted.
        if (stack.length === 2 && stack[1]?.name === 'channel') {
          out.push({ name: node.name, node })
          stack[1].kids.length = 0
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  )

  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 256 * 1024 })
  try {
    for await (const chunk of stream) {
      parser.write(chunk as string)
      if (failure) throw failure
      yield* out.splice(0)
    }
    parser.end()
    if (failure) throw failure
    yield* out.splice(0)
  } finally {
    stream.destroy()
  }
  if (!seenChannel) throw new WxrError('WXR_INVALID', 'Not a WordPress export: no <channel> element.')
}

/** The first direct child named `name`. */
export const child = (node: XmlNode, name: string): XmlNode | undefined => node.kids.find((k) => k.name === name)
/** Text of the first direct child named `name`, or undefined when there is none. */
export const text = (node: XmlNode, name: string): string | undefined => child(node, name)?.text
