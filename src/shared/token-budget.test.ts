import { describe, it, expect } from 'vitest'
import { TokenBudgetGuard } from './token-budget'

describe('TokenBudgetGuard', () => {
  it('treats an unlimited scope as always ok', () => {
    const g = new TokenBudgetGuard()
    expect(g.record('free', 1_000_000)).toBe('ok')
    expect(g.remaining('free')).toBe(Infinity)
    expect(g.isExceeded('free')).toBe(false)
  })

  it('flips ok -> warn -> exceeded across the threshold', () => {
    const g = new TokenBudgetGuard([{ scope: 'wt-1', limitTokens: 100 }])
    expect(g.record('wt-1', 50)).toBe('ok')
    expect(g.record('wt-1', 30)).toBe('warn') // 80/100 == warnRatio
    expect(g.record('wt-1', 25)).toBe('exceeded') // 105/100
    expect(g.remaining('wt-1')).toBe(0)
  })

  it('reports a snapshot', () => {
    const g = new TokenBudgetGuard([{ scope: 's', limitTokens: 200 }])
    g.record('s', 160)
    expect(g.snapshot('s')).toEqual({
      scope: 's',
      usedTokens: 160,
      limitTokens: 200,
      remainingTokens: 40,
      status: 'warn'
    })
  })

  it('honors a custom warn ratio', () => {
    const g = new TokenBudgetGuard([{ scope: 's', limitTokens: 100 }], 0.5)
    expect(g.record('s', 49)).toBe('ok')
    expect(g.record('s', 1)).toBe('warn')
  })

  it('rejects invalid inputs', () => {
    expect(() => new TokenBudgetGuard([], 0)).toThrow(RangeError)
    expect(() => new TokenBudgetGuard([], 1.5)).toThrow(RangeError)
    const g = new TokenBudgetGuard([{ scope: 's', limitTokens: 10 }])
    expect(() => g.record('s', -1)).toThrow(RangeError)
  })
})
