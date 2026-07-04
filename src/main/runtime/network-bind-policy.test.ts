import { describe, it, expect } from 'vitest'
import {
  resolveBindHost,
  resolveBindHostFromEnv,
  isLoopbackHost,
  LOOPBACK_HOST,
  ALL_INTERFACES_HOST
} from './network-bind-policy'

describe('resolveBindHost', () => {
  it('defaults to loopback', () => {
    expect(resolveBindHost()).toEqual({ host: LOOPBACK_HOST, exposure: 'loopback' })
  })

  it('downgrades "all" without opt-in and warns', () => {
    const r = resolveBindHost({ exposure: 'all' })
    expect(r.host).toBe(LOOPBACK_HOST)
    expect(r.warning).toMatch(/downgraded to loopback/)
  })

  it('binds all interfaces with explicit opt-in', () => {
    const r = resolveBindHost({ exposure: 'all', explicitOptIn: true })
    expect(r.host).toBe(ALL_INTERFACES_HOST)
    expect(r.warning).toMatch(/all interfaces/)
  })
})

describe('resolveBindHostFromEnv', () => {
  it('is loopback when the env var is unset', () => {
    expect(resolveBindHostFromEnv({}).host).toBe(LOOPBACK_HOST)
  })

  it('binds all interfaces when explicitly enabled', () => {
    expect(resolveBindHostFromEnv({ ORCA_MOBILE_NETWORK_EXPOSURE: 'all' }).host).toBe(
      ALL_INTERFACES_HOST
    )
    expect(resolveBindHostFromEnv({ ORCA_MOBILE_NETWORK_EXPOSURE: 'lan' }).host).toBe(
      ALL_INTERFACES_HOST
    )
  })
})

describe('isLoopbackHost', () => {
  it('recognizes loopback forms', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
  })
})
