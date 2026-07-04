// Why: Orca fans one prompt across N agents, each in its own worktree. The
// final "compare and merge the winner" step is otherwise manual; this ranks
// candidates from objective signals so the UI can surface a suggested winner.

export type CandidateMetrics = {
  id: string
  testsPassed: number
  testsTotal: number
  lintErrors: number
  // Total changed lines (added + removed). Smaller is mildly preferred.
  diffLines: number
  durationMs?: number
  // A candidate that never produced a usable result is disqualified.
  failedToComplete?: boolean
}

export type ScoreWeights = {
  tests: number
  lint: number
  diffSize: number
  speed: number
}

export const DEFAULT_FANOUT_WEIGHTS: ScoreWeights = {
  tests: 0.6,
  lint: 0.2,
  diffSize: 0.1,
  speed: 0.1
}

export type ScoreBreakdown = {
  tests: number
  lint: number
  diffSize: number
  speed: number
}

export type ScoredCandidate = {
  id: string
  score: number
  disqualified: boolean
  breakdown: ScoreBreakdown
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) {
    return 0
  }
  return Math.max(0, Math.min(1, n))
}

function testRatio(passed: number, total: number): number {
  // No tests is neutral, not a win — it carries no evidence of correctness.
  if (total <= 0) {
    return 0.5
  }
  return clamp01(passed / total)
}

// "Lower is better" metrics are normalized against the worst candidate in the
// batch, so scoring is relative to the field rather than to absolute magnitudes.
function invertedRelative(value: number, max: number): number {
  if (max <= 0) {
    return 1
  }
  return clamp01(1 - value / max)
}

export function scoreCandidates(
  candidates: CandidateMetrics[],
  weights: ScoreWeights = DEFAULT_FANOUT_WEIGHTS
): ScoredCandidate[] {
  const maxLint = Math.max(0, ...candidates.map((c) => c.lintErrors))
  const maxDiff = Math.max(0, ...candidates.map((c) => c.diffLines))
  const maxDuration = Math.max(0, ...candidates.map((c) => c.durationMs ?? 0))
  const weightSum = weights.tests + weights.lint + weights.diffSize + weights.speed

  const scored = candidates.map((c, index) => {
    const breakdown: ScoreBreakdown = {
      tests: testRatio(c.testsPassed, c.testsTotal),
      lint: invertedRelative(c.lintErrors, maxLint),
      diffSize: invertedRelative(c.diffLines, maxDiff),
      speed: invertedRelative(c.durationMs ?? 0, maxDuration)
    }
    const raw =
      breakdown.tests * weights.tests +
      breakdown.lint * weights.lint +
      breakdown.diffSize * weights.diffSize +
      breakdown.speed * weights.speed
    const normalized = weightSum > 0 ? raw / weightSum : 0
    const disqualified = c.failedToComplete === true
    return { id: c.id, score: disqualified ? 0 : normalized, disqualified, breakdown, index }
  })

  // Sort by score desc; ties keep original (stable) order via the index.
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map(({ index: _index, ...rest }) => rest)
}

export function pickWinner(
  candidates: CandidateMetrics[],
  weights?: ScoreWeights
): ScoredCandidate | undefined {
  const top = scoreCandidates(candidates, weights)[0]
  if (!top || top.disqualified) {
    return undefined
  }
  return top
}
