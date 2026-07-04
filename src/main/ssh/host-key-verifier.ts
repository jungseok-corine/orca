// Why: ssh2's ConnectConfig accepts a `hostVerifier`; when it is absent ssh2
// trusts whatever key the server presents, which is weaker than TOFU and leaves
// the native SSH lane open to an on-path (MITM) attacker. This implements
// trust-on-first-use pinning against a pluggable store so `buildConnectConfig`
// can attach a verifier without embedding persistence.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { writeSecureJsonFile } from '../../shared/secure-file'

export type HostKeyPolicy =
  // Reject any host whose key is not already pinned. Safest; needs prior enrollment.
  | 'strict'
  // Trust-on-first-use: pin an unseen host's key, then require it to match on
  // every later connection. A changed key is always rejected (never re-pinned).
  | 'tofu'

export type HostVerifierOutcome = 'match' | 'learned' | 'mismatch' | 'rejected'

export type HostVerifierEvent = {
  hostId: string
  outcome: HostVerifierOutcome
  fingerprint: string
  // Present only on 'mismatch': the fingerprint we had pinned.
  pinnedFingerprint?: string
}

export type KnownHostsStore = {
  get(hostId: string): string | undefined
  set(hostId: string, fingerprint: string): void
}

export type CreateHostVerifierOptions = {
  hostId: string
  store: KnownHostsStore
  policy?: HostKeyPolicy
  onEvent?: (event: HostVerifierEvent) => void
}

// OpenSSH-style fingerprint: "SHA256:<base64 without padding>".
export function sha256Fingerprint(key: Uint8Array): string {
  const digest = createHash('sha256').update(key).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

export function createInMemoryKnownHostsStore(seed?: Record<string, string>): KnownHostsStore {
  const map = new Map<string, string>(seed ? Object.entries(seed) : [])
  return {
    get: (hostId) => map.get(hostId),
    set: (hostId, fingerprint) => {
      map.set(hostId, fingerprint)
    }
  }
}

export function createFileKnownHostsStore(filePath: string): KnownHostsStore {
  const load = (): Record<string, string> => {
    if (!existsSync(filePath)) {
      return {}
    }
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, string>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  let cache: Record<string, string> | null = null
  const ensure = (): Record<string, string> => {
    if (cache === null) {
      cache = load()
    }
    return cache
  }
  return {
    get: (hostId) => ensure()[hostId],
    set: (hostId, fingerprint) => {
      const next = ensure()
      next[hostId] = fingerprint
      mkdirSync(dirname(filePath), { recursive: true })
      writeSecureJsonFile(filePath, next)
    }
  }
}

// Memoize one file store per path so pins written by one connection are visible
// to the next without re-reading disk on every handshake.
const sharedStores = new Map<string, KnownHostsStore>()

export function resolveDefaultKnownHostsPath(): string {
  return join(homedir(), '.orca', 'known_hosts.json')
}

export function getSharedKnownHostsStore(
  filePath: string = resolveDefaultKnownHostsPath()
): KnownHostsStore {
  let store = sharedStores.get(filePath)
  if (!store) {
    store = createFileKnownHostsStore(filePath)
    sharedStores.set(filePath, store)
  }
  return store
}

// Returns an ssh2-compatible synchronous host verifier: `(key) => boolean`.
// A `false` return aborts the handshake before authentication, so a spoofed
// server never receives credentials or forwarded agents.
export function createHostVerifier(
  options: CreateHostVerifierOptions
): (key: Uint8Array) => boolean {
  const policy: HostKeyPolicy = options.policy ?? 'tofu'
  const emit = (event: HostVerifierEvent): void => options.onEvent?.(event)

  return (key: Uint8Array): boolean => {
    const fingerprint = sha256Fingerprint(key)
    const pinned = options.store.get(options.hostId)

    if (pinned === undefined) {
      if (policy === 'strict') {
        emit({ hostId: options.hostId, outcome: 'rejected', fingerprint })
        return false
      }
      options.store.set(options.hostId, fingerprint)
      emit({ hostId: options.hostId, outcome: 'learned', fingerprint })
      return true
    }

    if (pinned === fingerprint) {
      emit({ hostId: options.hostId, outcome: 'match', fingerprint })
      return true
    }

    // Key changed from what we pinned — the MITM signal. Never silently re-pin;
    // force the caller to resolve it explicitly.
    emit({ hostId: options.hostId, outcome: 'mismatch', fingerprint, pinnedFingerprint: pinned })
    return false
  }
}
