import { describe, it, expect } from 'vitest'
import {
  createHostVerifier,
  createInMemoryKnownHostsStore,
  sha256Fingerprint,
  type HostVerifierEvent
} from './host-key-verifier'

const keyA = new TextEncoder().encode('ssh-ed25519 AAAA...serverA')
const keyB = new TextEncoder().encode('ssh-ed25519 AAAA...serverB')

describe('sha256Fingerprint', () => {
  it('is OpenSSH-style and stable per key', () => {
    expect(sha256Fingerprint(keyA)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(sha256Fingerprint(keyA)).toBe(sha256Fingerprint(keyA))
    expect(sha256Fingerprint(keyA)).not.toBe(sha256Fingerprint(keyB))
  })
})

describe('createHostVerifier (tofu)', () => {
  it('learns and pins an unseen host', () => {
    const events: HostVerifierEvent[] = []
    const store = createInMemoryKnownHostsStore()
    const verify = createHostVerifier({ hostId: 'box:22', store, onEvent: (e) => events.push(e) })
    expect(verify(keyA)).toBe(true)
    expect(events[0]?.outcome).toBe('learned')
    expect(store.get('box:22')).toBe(sha256Fingerprint(keyA))
  })

  it('accepts the same key on reconnect', () => {
    const store = createInMemoryKnownHostsStore({ 'box:22': sha256Fingerprint(keyA) })
    expect(createHostVerifier({ hostId: 'box:22', store })(keyA)).toBe(true)
  })

  it('rejects a changed key and never re-pins it', () => {
    const events: HostVerifierEvent[] = []
    const store = createInMemoryKnownHostsStore({ 'box:22': sha256Fingerprint(keyA) })
    const verify = createHostVerifier({ hostId: 'box:22', store, onEvent: (e) => events.push(e) })
    expect(verify(keyB)).toBe(false)
    expect(events[0]?.outcome).toBe('mismatch')
    expect(store.get('box:22')).toBe(sha256Fingerprint(keyA))
  })
})

describe('createHostVerifier (strict)', () => {
  it('rejects any unpinned host', () => {
    const store = createInMemoryKnownHostsStore()
    expect(createHostVerifier({ hostId: 'box:22', store, policy: 'strict' })(keyA)).toBe(false)
    expect(store.get('box:22')).toBeUndefined()
  })
})
