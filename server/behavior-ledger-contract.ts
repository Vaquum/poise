import type { BehaviorKey } from '../src/behavior-types'

export const LEDGER_VERSION = 1
export const LEDGER_RESPONSE_BYTES = 512 * 1024
export const LEDGER_STALE_MS = 125_000
export const LEDGER_STATES = ['pending', 'running', 'held', 'completed', 'failed', 'superseded', 'unknown'] as const
export type LedgerState = typeof LEDGER_STATES[number]
export type LedgerActivity = 'running' | 'settled' | 'unknown'
export type LedgerStateSource = 'native' | 'caller_observed'
export type LedgerSlot = 'primary' | 'secondary' | 'tertiary'
export type LedgerSource = `poise:${BehaviorKey}` | 'poise:manual-review' | 'poise:replay'
export type LedgerOutcome = 'clean' | 'changes_requested' | 'approved' | 'commented' | 'preflight_failed'
  | 'resolved' | 'waiting' | 'no_op' | 'merged' | 'already_merged' | 'updated' | 'not_ready' | 'superseded'
  | 'rerun_requested' | 'read_failed' | 'spawn_failed' | 'adopted' | 'enqueued'
export interface LedgerReference {
  kind: 'caller' | 'correlation' | 'review' | 'comment' | 'workflow' | 'intent' | 'logging' | 'queue'
  identity: string
  availability: 'available' | 'unavailable' | 'unknown'
}
export interface LedgerWorkflow { id: number; runId: number; attempt: number; event: string }
export interface LedgerAdmission {
  type: 'admit'
  admissionKey: string
  nativeId: string
  behavior: BehaviorKey
  source: LedgerSource
  owner: string | null
  actor: string | null
  repository: string
  number: number
  head: string | null
  slot?: LedgerSlot
  plannedSlots?: LedgerSlot[]
  workflow?: LedgerWorkflow
  startedAt?: string
}
export interface LedgerResult {
  type: 'result'
  nativeId: string
  state: LedgerState
  activity: LedgerActivity
  stateSource?: LedgerStateSource
  outcome?: LedgerOutcome | null
  callId?: string
  head?: string | null
  completedAt?: string | null
  refs?: LedgerReference[]
}
export interface LedgerCaller {
  type: 'caller'
  nativeId: string
  callId: string | null
  repository: string | null
  number: number | null
  actor: string | null
  source: string | null
  behavior: string | null
  expectedHead: string | null
  head: string | null
  status: string | null
  action: string | null
  outcome: string | null
  startedAt: string | null
  completedAt: string | null
  uncertain?: boolean
  mayRun?: boolean
  interrupted?: boolean
}
export type LedgerObservation = LedgerAdmission | LedgerResult | LedgerCaller
  | { type: 'heartbeat' }
  | { type: 'loss'; count: number }
export interface LedgerRecord {
  id: string
  kind: 'firing' | 'attempt'
  parentId: string | null
  behavior: BehaviorKey
  source: LedgerSource
  owner: string | null
  actor: string | null
  target: { repository: string; number: number; workflow?: LedgerWorkflow }
  head: string | null
  slot: LedgerSlot | null
  plannedSlots: LedgerSlot[]
  state: LedgerState
  stateSource: LedgerStateSource
  activity: LedgerActivity
  outcome: LedgerOutcome | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  observedAt: string
  revision: number
  refs: LedgerReference[]
  replayOf: string | null
  omittedAttempts: number
}
export interface LedgerGap { since: string; until: string | null; reason: 'capture_loss' | 'unclean_restart' | 'eviction' | 'unavailable' }
export type LedgerUnavailableReason = 'worker_unavailable' | 'store_unavailable' | 'journal_unavailable' | 'read_timeout'
export interface LedgerHealth {
  status: 'ok' | 'incomplete' | 'stale' | 'unavailable' | 'stopped'
  unavailableReason: LedgerUnavailableReason | null
  coverageStart: string | null
  observedAt: string | null
  callerObservedAt: string | null
  pending: number
  dropped: number
  gaps: LedgerGap[]
  generation: string | null
  retainedFrom: string | null
  changeLowerBound: number | null
  lastSequence: number | null
  instances: number | null
  changes: number | null
}
export interface LedgerPolicy {
  retentionMs: number
  maxInstances: number
  maxChanges: number
  maxBytes: number
  maxPagesBytes: number
  maxAttempts: number
}
export const DEFAULT_LEDGER_POLICY: Readonly<LedgerPolicy> = {
  retentionMs: 30 * 86_400_000, maxInstances: 10_000, maxChanges: 30_000,
  maxBytes: 32 * 1024 * 1024, maxPagesBytes: 64 * 1024 * 1024, maxAttempts: 32,
}
export type LedgerRead = { operation: 'list'; limit?: number; cursor?: string; parent?: string; repository?: string; number?: number }
  | { operation: 'get'; id: string }
  | { operation: 'changes'; cursor: string; limit?: number }
  | { operation: 'health' }
export type LedgerChange = { sequence: number; op: 'upsert'; record: LedgerRecord }
  | { sequence: number; op: 'remove'; id: string; revision: number }
export interface LedgerReply {
  version: 1
  health: LedgerHealth
  records?: LedgerRecord[]
  record?: LedgerRecord
  changes?: LedgerChange[]
  nextCursor?: string | null
  watermark?: string
  hasMore?: boolean
  error?: string
}
export interface LedgerPending { nativeId: string; callId: string | null }
export interface LedgerWorkerTiming {
  totalMs: number
  readMs?: number
  pendingMs?: number
  encodeMs?: number
  budgetScanMs: number
}
export interface LedgerReadTiming {
  queueMs: number
  activeMs?: number
  timeout?: 'queued' | 'active'
  blocking?: { kind: LedgerObservation['type'] | LedgerWorkerRequest['operation']; elapsedMs: number }
  worker?: LedgerWorkerTiming
}
export interface LedgerReadReply { status: number; body: LedgerReply; timing?: LedgerReadTiming }
export interface LedgerWorkerRequest {
  id: number
  operation: 'capture' | 'read' | 'pending' | 'close'
  observation?: LedgerObservation
  request?: LedgerRead
}
export interface LedgerWorkerReply {
  id: number
  status: number
  body: LedgerReply
  pending: LedgerPending[]
  timing?: LedgerWorkerTiming
}
export interface LedgerWorkerData { path: string; workspace?: string; policy?: Partial<LedgerPolicy> }
export class LedgerError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
