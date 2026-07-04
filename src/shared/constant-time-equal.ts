import { createHash, timingSafeEqual } from 'node:crypto'

// Why: auth-token comparisons must not short-circuit on the first differing
// byte (or on length), which leaks information via timing. Both inputs are
// hashed to a fixed 32-byte digest first, so the compare is constant-time and
// independent of input length or content. Used for runtime RPC + per-device
// token validation.
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest()
  const db = createHash('sha256').update(b).digest()
  return timingSafeEqual(da, db)
}
