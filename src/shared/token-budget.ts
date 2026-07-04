// Why: Orca scans agent token usage but does not cap it. This adds a per-scope
// budget guard (a scope is a worktree, session, or fan-out group): record spend,
// surface a warn threshold, and signal a hard stop once the limit is crossed so
// the orchestrator can pause an agent before it burns past its allowance.

export type BudgetStatus = 'ok' | 'warn' | 'exceeded'

export type BudgetLimit = {
  scope: string
  limitTokens: number
}

export type BudgetSnapshot = {
  scope: string
  usedTokens: number
  limitTokens: number
  remainingTokens: number
  status: BudgetStatus
}

// Fraction of the limit at which status flips to 'warn'.
const DEFAULT_WARN_RATIO = 0.8

export class TokenBudgetGuard {
  private readonly limits = new Map<string, number>()
  private readonly used = new Map<string, number>()
  private readonly warnRatio: number

  constructor(limits: BudgetLimit[] = [], warnRatio = DEFAULT_WARN_RATIO) {
    if (warnRatio <= 0 || warnRatio > 1) {
      throw new RangeError('warnRatio must be in (0, 1]')
    }
    this.warnRatio = warnRatio
    for (const limit of limits) {
      this.setLimit(limit.scope, limit.limitTokens)
    }
  }

  setLimit(scope: string, limitTokens: number): void {
    if (limitTokens < 0) {
      throw new RangeError('limitTokens must be >= 0')
    }
    this.limits.set(scope, limitTokens)
  }

  // Add spend to a scope. Returns the resulting status so a caller can stop an
  // agent immediately when it flips to 'exceeded'.
  record(scope: string, tokens: number): BudgetStatus {
    if (tokens < 0) {
      throw new RangeError('tokens must be >= 0')
    }
    this.used.set(scope, this.usedTokens(scope) + tokens)
    return this.status(scope)
  }

  usedTokens(scope: string): number {
    return this.used.get(scope) ?? 0
  }

  remaining(scope: string): number {
    const limit = this.limits.get(scope)
    if (limit === undefined) {
      return Infinity
    }
    return Math.max(0, limit - this.usedTokens(scope))
  }

  status(scope: string): BudgetStatus {
    const limit = this.limits.get(scope)
    if (limit === undefined) {
      return 'ok'
    }
    const used = this.usedTokens(scope)
    if (used >= limit) {
      return 'exceeded'
    }
    if (used >= limit * this.warnRatio) {
      return 'warn'
    }
    return 'ok'
  }

  isExceeded(scope: string): boolean {
    return this.status(scope) === 'exceeded'
  }

  snapshot(scope: string): BudgetSnapshot {
    const limit = this.limits.get(scope) ?? Infinity
    return {
      scope,
      usedTokens: this.usedTokens(scope),
      limitTokens: limit,
      remainingTokens: this.remaining(scope),
      status: this.status(scope)
    }
  }
}
