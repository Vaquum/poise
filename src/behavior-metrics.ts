import type { BehaviorKey } from './behavior-types'

export interface BehaviorMetrics {
  totalRuns: number
  durationMinutes: number | null
  successRate: number | null
}

export interface BehaviorMetricsReport {
  behaviors: Record<BehaviorKey, BehaviorMetrics | null>
  error: string | null
}
