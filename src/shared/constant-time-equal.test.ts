import { describe, it, expect } from 'vitest'
import { constantTimeEqual } from './constant-time-equal'

describe('constantTimeEqual', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('', '')).toBe(true)
  })

  it('returns false for different strings', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
  })

  it('does not throw and returns false for differing lengths', () => {
    expect(constantTimeEqual('abc', 'abcdef')).toBe(false)
  })
})
