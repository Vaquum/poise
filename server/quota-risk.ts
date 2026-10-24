// Quota-risk state shared between the monitor that writes it and the readers
// that shed load under it. A leaf module on purpose: readers like the /api/gh
// fan-out must not pull in the monitor's whole graph.
export function quotaRiskKey(login: string, resource: string): string {
  return `github-quota:risk:${login.toLowerCase()}:${resource}`
}

interface RiskWindow { resetAt: string, since: number | null, exhaustedSince?: number | null }

/** True when the monitor flagged this account resource for the live window:
 *  a sustained exhaustion warning, or no budget left until reset. Unknown,
 *  corrupt or expired state is not pressure: shedding load needs evidence. */
export function isRiskPressured(raw: string | null, now = Date.now()): boolean {
  if (!raw) return false
  let state: RiskWindow
  try {
    state = JSON.parse(raw)
  } catch {
    return false
  }
  if (!state || typeof state !== 'object') return false
  if (typeof state.resetAt !== 'string' || !Number.isFinite(Date.parse(state.resetAt)) || Date.parse(state.resetAt) <= now) return false
  return typeof state.since === 'number' || typeof state.exhaustedSince === 'number'
}
