import { describe, it, expect } from 'vitest'
import { scoreCandidates, pickWinner, type CandidateMetrics } from './fanout-scoring'

const base: CandidateMetrics[] = [
  { id: 'a', testsPassed: 10, testsTotal: 10, lintErrors: 0, diffLines: 40, durationMs: 1000 },
  { id: 'b', testsPassed: 7, testsTotal: 10, lintErrors: 3, diffLines: 120, durationMs: 3000 },
  { id: 'c', testsPassed: 10, testsTotal: 10, lintErrors: 5, diffLines: 200, durationMs: 5000 }
]

describe('scoreCandidates', () => {
  it('ranks the all-green, smallest-diff, fastest candidate first', () => {
    const ranked = scoreCandidates(base)
    expect(ranked[0]?.id).toBe('a')
    // With the tests-heavy default weighting, c (10/10) outranks b (7/10).
    expect(ranked[1]?.id).toBe('c')
    expect(ranked[2]?.id).toBe('b')
  })

  it('keeps scores within 0..1', () => {
    for (const c of scoreCandidates(base)) {
      expect(c.score).toBeGreaterThanOrEqual(0)
      expect(c.score).toBeLessThanOrEqual(1)
    }
  })

  it('gives no-test candidates a neutral 0.5 test component', () => {
    const ranked = scoreCandidates([
      { id: 'n', testsPassed: 0, testsTotal: 0, lintErrors: 0, diffLines: 0 }
    ])
    expect(ranked[0]?.breakdown.tests).toBe(0.5)
  })
})

describe('pickWinner', () => {
  it('disqualifies failed candidates and never returns them', () => {
    const cands: CandidateMetrics[] = [
      { id: 'x', testsPassed: 10, testsTotal: 10, lintErrors: 0, diffLines: 10, failedToComplete: true },
      { id: 'y', testsPassed: 5, testsTotal: 10, lintErrors: 1, diffLines: 50 }
    ]
    expect(pickWinner(cands)?.id).toBe('y')
  })

  it('returns undefined when every candidate is disqualified', () => {
    expect(
      pickWinner([
        { id: 'a', testsPassed: 1, testsTotal: 1, lintErrors: 0, diffLines: 1, failedToComplete: true }
      ])
    ).toBeUndefined()
  })
})
