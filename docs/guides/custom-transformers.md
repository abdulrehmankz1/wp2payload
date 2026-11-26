# Writing a custom transformer

wp2payload converts core Gutenberg blocks (paragraph, heading, list, image, quote, code, gallery,
embed, separator and others) on its own. A block it does not know, such as `acme/callout` from a
theme or plugin, is kept as sanitized HTML and reported as `UNKNOWN_BLOCK`. A custom transformer
tells wp2payload what HTML to produce for such a block, without forking the tool.

## A first transformer

Add it to `transformers` in `wp2payload.config.ts`:

```ts
import { defineConfig, type Block } from 'wp2payload'

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export default defineConfig({
  source: { type: 'rest', url: process.env.WP_URL! },
  transformers: [
    {
      name: 'acme-hero',
      match: (block: Block) => block.name === 'acme/hero',
      toHtml: (block: Block) => {
        const title = typeof block.attrs.title === 'string' ? block.attrs.title : ''
        return `<h2>${escape(title)}</h2>`
      },
    },
  ],
})
```

Then preview with `npx wp2payload migrate --dry-run`. The `UNKNOWN_BLOCK` warning for
`acme/hero` should be gone from the report.

## The block

`match` and `toHtml` receive one parsed block:

```ts
interface Block {
  name: string                    // 'acme/hero', 'core/paragraph'
  attrs: Record<string, unknown>  // the JSON in the block comment, {} if none
  innerHTML: string               // the block's own HTML, without its inner blocks
  innerBlocks: Block[]            // nested blocks
}
```

For this content:

```html
<!-- wp:acme/callout {"tone":"info"} -->
<div class="acme-callout"><!-- wp:paragraph -->
<p>Inside a custom block.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:acme/callout -->
```

`name` is `acme/callout`, `attrs` is `{ tone: 'info' }`, `innerHTML` is the
`<div class="acme-callout"></div>` wrapper (with the surrounding whitespace) and `innerBlocks`
holds the paragraph. As in WordPress's own
parser, `innerHTML` does not include the HTML of inner blocks. HTML outside any block comment
(classic editor content) arrives as a `core/freeform` block.

## How transformers run

1. For every block, at every level of nesting, the transformers are tried in the order of the
   array. The first one whose `match` returns true is used, and no built-in rule runs for that
   block.
2. When a transformer handles a block, its inner blocks are not visited. If you want them in the
   output, build their HTML yourself from `block.innerBlocks`.
3. When no transformer matches, the built-in rules run. Unknown blocks keep their HTML, and their
   inner blocks are still normalised, so a transformer for `core/paragraph` would also apply
   inside an unknown wrapper.
4. If `match` or `toHtml` throws, the error is reported as `TRANSFORMER_FAILED` with the
   transformer's name and the block name, and the next transformer or the built-in rule is used.
   The run continues.

Transformers run the same way in `wp2payload scan`.

## What happens to your HTML

Your output is not trusted more than the source. It goes through the same allowlist sanitizer as
every other block ([docs/security.md](../security.md)):

- Allowed tags: `p`, `h1` to `h6`, `ul`, `ol`, `li`, `a`, `strong`, `em`, `b`, `i`, `u`, `s`,
  `sub`, `sup`, `blockquote`, `code`, `pre`, `br`, `hr`, `img`, `figure`, `figcaption`, `table`,
  `thead`, `tbody`, `tr`, `th`, `td`. Other tags are removed and their text kept, so a `<div>`
  disappears but what is inside it stays.
- Allowed attributes: `href` and `title` on links; `src`, `alt`, `title`, `width` and `height`
  on images; `colspan` and `rowspan` on table cells. `class`, `style` and every `on*` attribute
  are removed.
- Allowed URL schemes: `http`, `https`, `mailto`, `tel`.
- An `<iframe>` from a host in `security.embedHosts` becomes an embed block. Other iframes are
  quarantined.
- Anything removed for security reasons is reported as a finding, the same as content from
  WordPress.

After sanitizing, the HTML is converted to Lexical. Images pointing at migrated media become
upload nodes, and links to migrated posts and pages become internal links.

## Tips

- **Escape attribute values.** `attrs` comes from the source site, so treat it as hostile. The
  sanitizer will still clean the result, but escaping keeps markup inside a title from becoming
  markup in your output.
- **Check types.** `attrs` is `Record<string, unknown>`: a value may be missing or of another
  type on an old post.
- **Emit plain structure.** Payload stores rich text, not layout. Map a callout to a
  `<blockquote>`, a hero to a heading and an image, a button to a link.
- **Do not write `<wp2p-embed>`.** wp2payload uses that tag internally for allowed iframes. In
  your output it is treated as forged and quarantined (`SEC_FORGED_EMBED`).
- **You need block markup.** Over the REST API, WordPress returns block comments only with an
  Application Password. Without one, content arrives as rendered HTML and your transformer never
  sees `acme/callout`. Export files and backups always have the block markup.
- **Helpers are fine.** The config is TypeScript loaded with `jiti`, so you can import functions
  from other files in your project.

## Example: a callout with its inner blocks

```ts
import { defineConfig, type Block } from 'wp2payload'

// Inner paragraphs keep their own HTML; nested callouts are handled recursively.
const render = (block: Block): string =>
  block.innerBlocks.length === 0 ? block.innerHTML : block.innerBlocks.map(render).join('')

export default defineConfig({
  source: { type: 'rest', url: process.env.WP_URL! },
  transformers: [
    {
      name: 'acme-callout',
      match: (block) => block.name === 'acme/callout',
      toHtml: (block) => `<blockquote>${block.innerBlocks.map(render).join('')}</blockquote>`,
    },
  ],
})
```

`render` uses each inner block's raw HTML. Core blocks inside a transformed block do not go
through the built-in rules, so keep this to simple content such as paragraphs and lists.
