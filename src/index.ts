export { defineConfig, ConfigError } from './config/index.js'
export type { Wp2PayloadConfigInput, ResolvedConfig, Block, Transformer } from './config/index.js'
// Users add this group to every target collection (doc 2.4); the blog preset adds it for them.
export { wpMetaField } from './loaders/wpmeta.js'
