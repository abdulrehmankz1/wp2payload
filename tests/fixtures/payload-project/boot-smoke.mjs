// Boots the fixture project through src/payload/boot.ts in a plain `node` process: no vitest
// transform and no global tsx, so tsx and the Lexical loader are exercised exactly as the
// built CLI will use them. Run: node --experimental-transform-types boot-smoke.mjs <repoRoot>
// Node strips the types of wp2payload's own source; the only hook added here maps the
// NodeNext-style `./x.js` specifiers inside src/ to their `.ts` files.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(process.argv[2] ?? '')
const projectDir = path.dirname(fileURLToPath(import.meta.url))
const srcUrl = pathToFileURL(path.join(repoRoot, 'src')).href + '/'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL?.startsWith(srcUrl)) {
      const url = new URL(specifier, context.parentURL)
      if (!existsSync(fileURLToPath(url))) return nextResolve(url.href.replace(/\.js$/, '.ts'), context)
    }
    return nextResolve(specifier, context)
  },
})

const { bootPayload } = await import(pathToFileURL(path.join(repoRoot, 'src/payload/boot.ts')).href)
const booted = await bootPayload({ cwd: projectDir, configPath: 'src/payload.config.ts' })
const created = await booted.payload.create({
  collection: 'posts',
  data: { title: 'From a child process', wpMeta: { site: 'https://example.test', wpId: 7 } },
})
const found = await booted.payload.find({ collection: 'posts', where: { 'wpMeta.wpId': { equals: 7 } } })
await booted.close()
// No process.exit: the test asserts the process ends by itself once close() has run.
console.log(`RESULT ${JSON.stringify({ configPath: booted.configPath, created: created.id !== undefined, found: found.totalDocs })}`)
