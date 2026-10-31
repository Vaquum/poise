export interface BehaviorCutoverState {
  sequence: number
  mode: 'v1' | 'draining' | 'v2'
  requestedAt: number | null
  legacyPulls: string[]
}
