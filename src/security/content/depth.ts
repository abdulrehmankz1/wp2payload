import { Tokenizer } from 'htmlparser2'

// Parser cost guard (spec 04 review S04-05, R-02, A-02).
//
// htmlparser2's Parser keeps its open-element stack with `unshift`/`shift` and looks up end tags
// with `indexOf`, so every tag costs time proportional to the current depth. Deep nesting, or many
// stray end tags under deep nesting, makes parsing quadratic. Before any real parse, this replays
// the Parser's stack rules over htmlparser2's own Tokenizer (linear, and it sees attribute values,
// comments and raw text exactly as the Parser does) with an O(1) stack, and measures:
// - `depth`: the deepest the Parser's stack gets;
// - `work`: the sum of the stack depth at every tag, i.e. the Parser's own cost. This is the
//   backstop: even if the replay drifts from the Parser, the input is refused once the work it
//   would plausibly cost passes the budget.

/** Inputs nested deeper than this are not parsed (fail closed). Real posts stay far below. */
export const MAX_NESTING = 4096
/** Parser work budget (sum of stack depths over all tags). Measured ~1 ns per step: ~0.2 s per parse. */
export const MAX_PARSE_WORK = 200_000_000

// Copied from htmlparser2 12 Parser.js (openImpliesClose, voidElements, foreign contexts).
const P = new Set(['p'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'])
const FORM = new Set(['input', 'option', 'optgroup', 'select', 'button', 'datalist', 'textarea'])
const IMPLIES_CLOSE = new Map<string, ReadonlySet<string>>([
  ['tr', new Set(['tr', 'th', 'td'])], ['th', new Set(['th'])], ['td', new Set(['thead', 'th', 'td'])],
  ['body', new Set(['head', 'link', 'script'])], ['a', new Set(['a'])], ['li', new Set(['li'])], ['p', P],
  ['h1', HEADINGS], ['h2', HEADINGS], ['h3', HEADINGS], ['h4', HEADINGS], ['h5', HEADINGS], ['h6', HEADINGS],
  ['select', FORM], ['input', FORM], ['output', FORM], ['button', FORM], ['datalist', FORM], ['textarea', FORM],
  ['option', new Set(['option'])], ['optgroup', new Set(['optgroup', 'option'])],
  ['dd', new Set(['dd', 'dt'])], ['dt', new Set(['dd', 'dt'])],
  ...['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
    'footer', 'form', 'header', 'hr', 'main', 'nav', 'ol', 'pre', 'section', 'table', 'ul'].map((t) => [t, P] as [string, ReadonlySet<string>]),
  ['rt', new Set(['rt', 'rp'])], ['rp', new Set(['rt', 'rp'])],
  ['tbody', new Set(['thead', 'tbody'])], ['tfoot', new Set(['thead', 'tbody'])],
])
const VOID = new Set([
  'area', 'base', 'basefont', 'br', 'col', 'command', 'embed', 'frame', 'hr', 'img', 'input', 'isindex',
  'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr',
])
// Lowercased; the Parser compares SVG-adjusted names (`foreignObject`), equivalent here.
const INTEGRATION = new Set(['mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml', 'foreignobject', 'desc', 'title'])

export interface MarkupCost {
  depth: number
  work: number
}

/** Replays htmlparser2's open-element stack over its Tokenizer. Linear in input length. */
export function markupCost(html: string): MarkupCost {
  const stack: string[] = [] // top at the end
  const open = new Map<string, number>() // name -> count on the stack
  const foreign: boolean[] = [false] // true = svg/math context; top at the end
  let current = '' // tag being opened ('' = ignored, like a second <form>)
  let depth = 0
  let work = 0

  const push = (name: string) => {
    stack.push(name)
    open.set(name, (open.get(name) ?? 0) + 1)
    if (name === 'svg' || name === 'math') foreign.push(true)
    else if (INTEGRATION.has(name)) foreign.push(false)
    if (stack.length > depth) depth = stack.length
  }
  const pop = () => {
    const name = stack.pop()!
    open.set(name, open.get(name)! - 1)
    if ((name === 'svg' || name === 'math' || INTEGRATION.has(name)) && foreign.length > 1) foreign.pop()
  }
  const inForeign = () => foreign[foreign.length - 1] === true

  const tokenizer = new Tokenizer({ decodeEntities: true }, {
    isInForeignContext: inForeign,
    onopentagname(start, end) {
      let name = html.slice(start, end).toLowerCase()
      if (!inForeign() && name === 'image') name = 'img'
      work += stack.length + 1
      if (name === 'form' && (open.get('form') ?? 0) > 0) {
        current = ''
        return
      }
      current = name
      const implies = IMPLIES_CLOSE.get(name)
      if (implies) while (stack.length && implies.has(stack[stack.length - 1]!)) pop()
      if (!VOID.has(name)) push(name)
    },
    onclosetag(start, end) {
      const name = html.slice(start, end).toLowerCase()
      work += stack.length + 1 // the Parser's indexOf scans the whole stack on a miss
      if (VOID.has(name) || !(open.get(name) ?? 0)) return
      while (stack.length && stack[stack.length - 1] !== name) pop()
      pop()
    },
    onselfclosingtag() {
      if (inForeign() && current && stack[stack.length - 1] === current) pop()
      current = ''
    },
    onopentagend() {
      current = ''
    },
    onattribdata() {}, onattribentity() {}, onattribend() {}, onattribname() {}, oncdata() {}, oncomment() {},
    ondeclaration() {}, onend() {}, onprocessinginstruction() {}, ontext() {}, ontextentity() {},
  })
  tokenizer.write(html)
  tokenizer.end()
  return { depth, work }
}

/** Why `html` is too costly to parse, as a finding code and detail, if it is. */
export function markupLimit(html: string): { code: 'SEC_NESTING_LIMIT' | 'SEC_MARKUP_LIMIT'; detail: string } | undefined {
  const { depth, work } = markupCost(html)
  if (depth > MAX_NESTING) return { code: 'SEC_NESTING_LIMIT', detail: `markup nested ${depth} deep (limit ${MAX_NESTING})` }
  if (work > MAX_PARSE_WORK) return { code: 'SEC_MARKUP_LIMIT', detail: `markup would cost the parser ${work} steps (limit ${MAX_PARSE_WORK})` }
  return undefined
}
