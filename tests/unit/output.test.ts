import { describe, expect, it } from 'vitest'
import { colorEnabled, formatLine } from '../../src/ui/output.js'

describe('colorEnabled', () => {
  it('is on for a TTY', () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true)
  })

  it('is off when output is not a TTY (CI logs)', () => {
    expect(colorEnabled({ isTTY: false }, {})).toBe(false)
    expect(colorEnabled({}, {})).toBe(false)
  })

  it('respects NO_COLOR', () => {
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false)
  })

  it('ignores an empty NO_COLOR, per no-color.org', () => {
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '' })).toBe(true)
  })
})

describe('formatLine', () => {
  it('uses the brand symbols without colour', () => {
    expect(formatLine('ok', 'Node 24.21.0', undefined, false)).toBe('✔ Node 24.21.0')
    expect(formatLine('warn', 'Something odd', undefined, false)).toBe('! Something odd')
    expect(formatLine('fail', 'Broken', undefined, false)).toBe('✖ Broken')
  })

  it('indents every detail line', () => {
    expect(formatLine('fail', 'Broken', 'What happened.\nWhat to do.', false)).toBe(
      '✖ Broken\n  What happened.\n  What to do.',
    )
  })

  it('wraps the symbol in an ANSI colour when enabled', () => {
    expect(formatLine('ok', 'Fine', undefined, true)).toBe('\u001b[32m✔\u001b[0m Fine')
  })
})
