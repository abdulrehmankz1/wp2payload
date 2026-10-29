// Serialized Lexical node shapes as written by lexical 0.50 and @payloadcms/richtext-lexical 3.92.1
// (`exportJSON()` of each node class). Only the nodes the sanitized tag set can produce.

export const FORMAT = {
  bold: 1,
  italic: 2,
  strikethrough: 4,
  underline: 8,
  code: 16,
  subscript: 32,
  superscript: 64,
} as const

export interface TextNode {
  detail: 0
  format: number
  mode: 'normal'
  style: ''
  text: string
  type: 'text'
  version: 1
}

export interface LineBreakNode {
  type: 'linebreak'
  version: 1
}

export type LinkFields =
  | { linkType: 'custom'; newTab: boolean; url: string; rel?: string }
  | { linkType: 'internal'; newTab: boolean; doc: { relationTo: string; value: string | number } }

interface ElementBase<T extends string> {
  children: LexicalNode[]
  direction: null
  format: ''
  indent: number
  type: T
  version: number
}

export interface LinkNode extends ElementBase<'link'> {
  fields: LinkFields
  version: 3
}
export interface ParagraphNode extends ElementBase<'paragraph'> {
  textFormat: number
  textStyle: ''
  version: 1
}
export interface HeadingNode extends ElementBase<'heading'> {
  tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  version: 1
}
export interface QuoteNode extends ElementBase<'quote'> {
  version: 1
}
export interface ListNode extends ElementBase<'list'> {
  listType: 'bullet' | 'number'
  start: number
  tag: 'ul' | 'ol'
  version: 1
}
export interface ListItemNode extends ElementBase<'listitem'> {
  value: number
  version: 1
}
export interface RootNode extends ElementBase<'root'> {
  version: 1
}

export interface HorizontalRuleNode {
  type: 'horizontalrule'
  version: 1
}
export interface UploadNode {
  type: 'upload'
  version: 3
  format: ''
  id: string
  fields: Record<string, never>
  relationTo: string
  value: string | number
}
export interface BlockNode {
  type: 'block'
  version: 2
  format: ''
  fields: { id: string; blockName: ''; blockType: string; [key: string]: unknown }
}

export type ElementNode = LinkNode | ParagraphNode | HeadingNode | QuoteNode | ListNode | ListItemNode | RootNode
export type DecoratorNode = HorizontalRuleNode | UploadNode | BlockNode
export type InlineNode = TextNode | LineBreakNode | LinkNode
export type LexicalNode = ElementNode | DecoratorNode | TextNode | LineBreakNode

const element = <T extends string>(type: T) => ({ children: [] as LexicalNode[], direction: null, format: '' as const, indent: 0, type })

export const text = (value: string, format: number): TextNode => ({
  detail: 0,
  format,
  mode: 'normal',
  style: '',
  text: value,
  type: 'text',
  version: 1,
})
export const linebreak = (): LineBreakNode => ({ type: 'linebreak', version: 1 })
export const paragraph = (): ParagraphNode => ({ ...element('paragraph'), textFormat: 0, textStyle: '', version: 1 })
export const heading = (tag: HeadingNode['tag']): HeadingNode => ({ ...element('heading'), tag, version: 1 })
export const quote = (): QuoteNode => ({ ...element('quote'), version: 1 })
export const list = (listType: ListNode['listType'], start = 1): ListNode => ({
  ...element('list'),
  listType,
  start,
  tag: listType === 'number' ? 'ol' : 'ul',
  version: 1,
})
export const listItem = (): ListItemNode => ({ ...element('listitem'), value: 1, version: 1 })
export const link = (fields: LinkFields): LinkNode => ({ ...element('link'), fields, version: 3 })
export const root = (): RootNode => ({ ...element('root'), version: 1 })
export const horizontalRule = (): HorizontalRuleNode => ({ type: 'horizontalrule', version: 1 })
export const upload = (id: string, relationTo: string, value: string | number): UploadNode => ({
  type: 'upload',
  version: 3,
  format: '',
  id,
  fields: {},
  relationTo,
  value,
})
export const block = (id: string, data: { blockType: string; [key: string]: unknown }): BlockNode => ({
  type: 'block',
  version: 2,
  format: '',
  fields: { ...data, id, blockName: '' },
})
