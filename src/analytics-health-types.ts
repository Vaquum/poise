export interface HealthInterval { since: number, until: number, state: 'covered' | 'gap' | 'unknown' }
export interface HealthSource {
  name: string, scope: string, status: string, lastReadAt: string | null
  intervals: HealthInterval[] | null
}
export interface HealthEvidence { work: string, journal: string, summary: string }
export interface WorkError extends HealthEvidence { at: number, callId: string, incident: string, invocation: string }
export interface WorkRecovery extends HealthEvidence {
  failedCall: string, actionSequence: number, actionAt: number, progressAt: number
  origin: 'automatic' | 'operator', interventionAt: number | null
}
export interface AnalyticsHealth {
  readAt: number, window: { since: number, until: number }, scope: string, limits: string[]
  /** `perItem` is a lower bound while `unsettled` items still have a run being reconciled;
   *  `withheld` says in words why `perItem` is null. */
  rate: { completed: number, errors: number, perItem: number | null, unsettled: number, withheld: string | null, items: HealthEvidence[] }
  blocked: { count: number, oldestProgressAt: number | null, largestStage: string | null, items: HealthEvidence[] }
  recovery: { automatic: WorkRecovery[], intervention: WorkRecovery[], unknown: number }
  lastError: { error: WorkError | null, lastObserved: boolean, coveredSince: number | null, coveredUntil: number | null }
  coverage: HealthSource[]
}

