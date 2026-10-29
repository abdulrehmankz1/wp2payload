import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { IRDocument } from '../../src/ir/types.js'
import { errorRateExceeded, flagLinkHeavy, median } from '../../src/migrate/guards.js'
import { OnlyError, selectPhases } from '../../src/migrate/run.js'
import { DocumentSpill } from '../../src/migrate/spill.js'
import { MemoryReport } from '../../src/report/types.js'

describe('selectPhases', () => {
  it('runs everything by default', () => {
    expect([...selectPhases(undefined, ['post']).phases]).toEqual(['media', 'terms', 'authors', 'documents'])
  })
  it('accepts phases and plural document types', () => {
    const { phases, types } = selectPhases(['media', 'Posts'], ['post', 'page'])
    expect([...phases]).toEqual(['media', 'documents'])
    expect([...(types ?? [])]).toEqual(['post'])
  })
  it('rejects unknown names with the valid list', () => {
    expect(() => selectPhases(['comments'], ['post'])).toThrow(OnlyError)
    expect(() => selectPhases(['comments'], ['post'])).toThrow(/media, terms, authors, documents, posts/)
  })
})

describe('guards', () => {
  it('error rate needs at least 20 items and more than 10%', () => {
    expect(errorRateExceeded({ errors: 5, created: 5 })).toBe(false)
    expect(errorRateExceeded({ errors: 2, created: 18 })).toBe(false)
    expect(errorRateExceeded({ errors: 3, created: 17 })).toBe(true)
    expect(errorRateExceeded(undefined)).toBe(false)
    // Skipped, reused and rejected items are not attempted writes.
    expect(errorRateExceeded({ errors: 3, created: 17, skipped: 500, reused: 100 })).toBe(true)
  })
  it('median', () => {
    expect(median([])).toBe(0)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
  it('flags documents far above the site median', () => {
    const report = new MemoryReport()
    const counts = new Map<string, number>([...Array.from({ length: 9 }, (_, i) => [`post:${i}`, 2] as [string, number]), ['post:99', 80]])
    flagLinkHeavy(report, counts)
    expect(report.findings.map((f) => f.doc)).toEqual(['post:99'])
    expect(report.findings[0]?.code).toBe('SEC_LINK_HEAVY')
  })
})

describe('DocumentSpill', () => {
  it('round-trips documents, stops when asked and collects authors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wp2p-spill-'))
    try {
      const docs = [1, 2, 3].map(
        (wpId): IRDocument => ({
          wpId, type: 'post', status: 'publish', slug: `s${wpId}`, title: `T\n${wpId}`, html: '<p>a\nb</p>',
          link: `https://x.test/s${wpId}/`, publishedAt: '', modifiedAt: '', termWpIds: [], authorWpId: wpId * 10, meta: {},
        }),
      )
      async function* src() {
        yield* docs
      }
      let n = 0
      const spill = await DocumentSpill.write(root, src(), () => ++n > 2)
      expect(spill.entries).toEqual([
        { wpId: 1, type: 'post', link: 'https://x.test/s1/' },
        { wpId: 2, type: 'post', link: 'https://x.test/s2/' },
      ])
      expect([...spill.authors]).toEqual([10, 20])
      const back: IRDocument[] = []
      for await (const d of spill.read()) back.push(d)
      expect(back).toEqual(docs.slice(0, 2))
      await spill.remove()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
