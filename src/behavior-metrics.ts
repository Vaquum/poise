import type { BehaviorKey } from './behavior-types'

export interface BehaviorMetrics {
  totalRuns: number
  /** The runs' time: live runs to now, finished runs to their end. Never null for a report since #1382. */
  durationMinutes: number | null
  /** Runs whose end is unknown (interrupted, or a negative span), left out of the time: absent when none. */
  untimedRuns?: number
  successRate: number | null
}

export interface BehaviorMetricsReport {
  behaviors: Record<BehaviorKey, BehaviorMetrics | null>
  error: string | null
}
