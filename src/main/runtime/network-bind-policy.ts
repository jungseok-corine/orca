// Why: the runtime RPC WebSocket (which can spawn PTYs, write files, run git)
// was bound to 0.0.0.0 unconditionally, exposing the control plane on every
// network interface with only an app-layer token + E2EE in front of it. This
// makes the bind address a function of an explicit exposure policy so LAN
// exposure is opt-in, not the default.

export type NetworkExposure =
  // Localhost only — same-machine reachability (CLI, a local browser). Default.
  | 'loopback'
  // Reachable from other hosts on the network (e.g. the mobile companion over
  // LAN). Must be explicitly opted into.
  | 'all'

export const LOOPBACK_HOST = '127.0.0.1'
export const ALL_INTERFACES_HOST = '0.0.0.0'

export type ResolvedBind = {
  host: string
  exposure: NetworkExposure
  // Set when the requested exposure was downgraded, or when binding wide.
  warning?: string
}

export function isLoopbackHost(host: string): boolean {
  return host === LOOPBACK_HOST || host === '::1' || host === 'localhost'
}

// Resolve an exposure request (typically from a setting or ORCA_MOBILE_NETWORK_EXPOSURE
// env var) into a concrete bind host. A non-loopback exposure only takes effect
// when explicitly opted into; otherwise we fall back to loopback and warn.
export function resolveBindHost(input: {
  exposure?: NetworkExposure
  explicitOptIn?: boolean
} = {}): ResolvedBind {
  const exposure: NetworkExposure = input.exposure ?? 'loopback'

  if (exposure === 'loopback') {
    return { host: LOOPBACK_HOST, exposure: 'loopback' }
  }

  if (!input.explicitOptIn) {
    return {
      host: LOOPBACK_HOST,
      exposure: 'loopback',
      warning:
        'Network exposure "all" requested without explicit opt-in; downgraded to loopback.'
    }
  }

  return {
    host: ALL_INTERFACES_HOST,
    exposure: 'all',
    warning:
      'RPC WebSocket bound to all interfaces (0.0.0.0). It is reachable from the ' +
      'network and protected only by per-device tokens + E2EE — prefer a private ' +
      'overlay (e.g. Tailscale) over an untrusted LAN.'
  }
}

// Read the desired exposure from the environment. `all` (or `lan`) requires the
// value to be set explicitly, which counts as the opt-in.
export function resolveBindHostFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedBind {
  const raw = env.ORCA_MOBILE_NETWORK_EXPOSURE?.trim().toLowerCase()
  if (raw === 'all' || raw === 'lan') {
    return resolveBindHost({ exposure: 'all', explicitOptIn: true })
  }
  return resolveBindHost({ exposure: 'loopback' })
}
