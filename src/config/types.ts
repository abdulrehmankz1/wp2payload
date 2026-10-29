// Minimal Gutenberg block shape for transformer hooks. Real parsing arrives with the transformer slice.
export interface Block {
  name: string
  attrs: Record<string, unknown>
  innerHTML: string
  innerBlocks: Block[]
}

export interface Transformer {
  name: string
  match: (block: Block) => boolean
  toHtml: (block: Block) => string
}

// Plain env record. Payload types pull in next, whose NodeJS.ProcessEnv requires NODE_ENV.
export type Env = Record<string, string | undefined>
