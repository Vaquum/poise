// Health, split three ways: liveness answers whenever the process does,
// readiness says whether interactive work can trust its dependencies, and
// history keeps cumulative loss where it can never affect either.
//
// Liveness performs no I/O at all: no SQLite, filesystem, subprocess or
// ledger-worker round trip. Readiness projects only observations other
// runtimes already refreshed (the ledger observer's memory, the datastore
// freshness gate, the quota monitor's cache, the logging runtime), so a
// wedged dependency cannot slow the reader down. Unknown — never observed —
// is reported but never degrades readiness.

import { DATASTORE_MAX_AGE_SECONDS, DATASTORE_OBSERVATION_STALE_MS, datastoreFreshnessEntries, type DatastoreFreshnessEntry } from './behaviors'
import { behaviorLedgerSnapshot, type BehaviorLedgerSnapshot } from './behavior-ledger'
import { buildIdentity } from './build-identity'
import { QUOTA_OBSERVATION_STALE_MS, githubQuotaSnapshots, type GithubQuotaSnapshot } from './github-quota'
import { loggingCollectionSnapshot } from './logging'
import type { DiagnosticRuntime } from '../gateway/src/diagnostics/runtime'
import { isServiceMode } from './service/config'

export type DependencyStatus = 'ok' | 'degraded' | 'unavailable' | 'unknown'

export interface DependencyEntry {
  status: DependencyStatus
  /** Machine-readable reason; null when ok. */
  reason: string | null
  /** When the current condition began, when known. */
  since: string | null
}

export interface LedgerDependency extends DependencyEntry {
  queueAgeMs: number | null
  pending: number
  stallBudgetMs: number | null
}

/** Current ledger drain state only. Cumulative dropped counts and retained
 *  gaps belong to history: a ledger that once lost a capture must not read
 *  degraded forever. A store outage the worker reported (an unopenable
 *  database, an unwritable journal) reads unavailable even while the queue
 *  is drained; an idle store's `stale` never does. */
export function ledgerDependency(snapshot: BehaviorLedgerSnapshot | null, now = Date.now()): LedgerDependency {
  if (!snapshot) return { status: 'unknown', reason: 'not_started', since: null, queueAgeMs: null, pending: 0, stallBudgetMs: null }
  const base = { queueAgeMs: snapshot.queueAgeMs, pending: snapshot.pending, stallBudgetMs: snapshot.stallBudgetMs }
  if (snapshot.stopping) return { ...base, status: 'unknown', reason: 'stopping', since: null }
  if (snapshot.failed) return { ...base, status: 'unavailable', reason: 'worker_unavailable', since: null }
  // Only once the worker has spoken: before readiness its health is still
  // the initial unavailable placeholder, not a report.
  if (snapshot.ready && snapshot.health.status === 'unavailable') {
    return { ...base, status: 'unavailable', reason: snapshot.health.unavailableReason ?? 'unavailable', since: null }
  }
  if (snapshot.queueAgeMs !== null && snapshot.queueAgeMs > snapshot.stallBudgetMs) {
    return { ...base, status: 'degraded', reason: 'queue_stalled', since: new Date(now - snapshot.queueAgeMs).toISOString() }
  }
  if (snapshot.unreportedLoss > 0) return { ...base, status: 'degraded', reason: 'capture_loss', since: null }
  return { ...base, status: 'ok', reason: null, since: null }
}

export interface DatastoreDependency extends DependencyEntry {
  org: string | null
  checkedAt: string
  lastSuccessAt: string | null
  ageSeconds: number | null
  error: string | null
}

/** One entry per organization: a healthy observation for one account must
 *  not hide another's stale or unread one. A last success older than the
 *  freshness gate accepts reads degraded even while the observation itself
 *  is fresh: the gate would reject that data until a newer success is seen. */
export function datastoreDependencies(entries: DatastoreFreshnessEntry[]): DatastoreDependency[] {
  return entries.map((entry) => {
    const base = { org: entry.org, checkedAt: entry.checkedAt, lastSuccessAt: entry.lastSuccessAt, ageSeconds: entry.ageSeconds, error: entry.error }
    if (entry.status === 'unchecked') return { ...base, status: 'unknown' as const, reason: 'no_observation', since: null }
    if (entry.observationAgeMs > DATASTORE_OBSERVATION_STALE_MS) {
      return { ...base, status: 'degraded' as const, reason: 'observation_stale', since: entry.checkedAt }
    }
    if (entry.status === 'unavailable') return { ...base, status: 'unavailable' as const, reason: 'sync_failing', since: entry.checkedAt }
    if (entry.ageSeconds !== null && entry.ageSeconds > DATASTORE_MAX_AGE_SECONDS && entry.lastSuccessAt !== null) {
      const crossedAt = new Date(Date.parse(entry.lastSuccessAt) + DATASTORE_MAX_AGE_SECONDS * 1000).toISOString()
      return { ...base, status: 'degraded' as const, reason: 'sync_stale', since: crossedAt }
    }
    return { ...base, status: 'ok' as const, reason: null, since: null }
  })
}

export interface QuotaDependency extends DependencyEntry {
  login: string
  roles: string[]
  checkedAt: string | null
  exhausted: string[]
  error: string | null
}

export function quotaDependencies(snapshots: GithubQuotaSnapshot[]): QuotaDependency[] {
  return snapshots.map((snapshot) => {
    const base = { login: snapshot.login, roles: snapshot.roles, checkedAt: snapshot.checkedAt, exhausted: snapshot.exhausted, error: snapshot.error }
    if (snapshot.checkedAt === null) {
      return snapshot.error
        ? { ...base, status: 'degraded' as const, reason: 'observation_failed', since: null }
        : { ...base, status: 'unknown' as const, reason: 'no_observation', since: null }
    }
    if (snapshot.observationAgeMs !== null && snapshot.observationAgeMs > QUOTA_OBSERVATION_STALE_MS) {
      return { ...base, status: 'degraded' as const, reason: 'observation_stale', since: snapshot.checkedAt }
    }
    if (snapshot.exhausted.length > 0) return { ...base, status: 'unavailable' as const, reason: 'budget_exhausted', since: snapshot.checkedAt }
    if (snapshot.error) return { ...base, status: 'degraded' as const, reason: 'observation_failed', since: snapshot.checkedAt }
    return { ...base, status: 'ok' as const, reason: null, since: null }
  })
}

export type CollectionSnapshot = ReturnType<DiagnosticRuntime['localSnapshot']>

export interface CollectorsDependency extends DependencyEntry {
  queued: number
  queuedBytes: number
  dropped: number
  lastSuccessfulWriteAt: string | null
  error: string | null
}

/** The workspace's own collection queue and sink. The gateway's collectors
 *  (Docker, kernel, external ingress) stay in gateway diagnostics: this
 *  process cannot observe them. */
export function collectorsDependency(snapshot: CollectionSnapshot | null): CollectorsDependency {
  if (!snapshot) return { status: 'unknown', reason: 'not_started', since: null, queued: 0, queuedBytes: 0, dropped: 0, lastSuccessfulWriteAt: null, error: null }
  const base = { queued: snapshot.queued, queuedBytes: snapshot.queuedBytes, dropped: snapshot.dropped, lastSuccessfulWriteAt: snapshot.lastSuccessfulWriteAt }
  if (snapshot.sinkError) {
    return { ...base, status: 'unavailable', reason: 'sink_unavailable', since: snapshot.sinkSince, error: snapshot.sinkError }
  }
  if (snapshot.lossActive) return { ...base, status: 'degraded', reason: 'collection_loss', since: null, error: null }
  const degraded = snapshot.coverageError ?? snapshot.journalError ?? snapshot.reportError
  if (degraded) return { ...base, status: 'degraded', reason: 'collection_degraded', since: null, error: degraded }
  return { ...base, status: 'ok', reason: null, since: null, error: null }
}

export interface LedgerHistory {
  dropped: number
  gaps: BehaviorLedgerSnapshot['health']['gaps']
  detailFloor: BehaviorLedgerSnapshot['health']['detailFloor']
  coverageStart: string | null
  retainedFrom: string | null
  generation: string | null
  observedAt: string | null
  callerObservedAt: string | null
}

/** Cumulative completeness: informative only, never an input to readiness. */
export function ledgerHistory(snapshot: BehaviorLedgerSnapshot | null): LedgerHistory {
  const health = snapshot?.health
  return {
    dropped: health?.dropped ?? 0,
    gaps: health?.gaps ?? [],
    detailFloor: health?.detailFloor ?? null,
    coverageStart: health?.coverageStart ?? null,
    retainedFrom: health?.retainedFrom ?? null,
    generation: health?.generation ?? null,
    observedAt: health?.observedAt ?? null,
    callerObservedAt: health?.callerObservedAt ?? null,
  }
}

export interface Dependencies {
  ledger: LedgerDependency
  datastore: DatastoreDependency[]
  githubQuota: QuotaDependency[]
  collectors: CollectorsDependency
}

export interface Readiness {
  status: 'ok' | 'degraded'
  /** Dependencies currently degraded or unavailable. */
  degraded: string[]
}

/** Whether interactive work can trust its dependencies. Unknown — never
 *  observed, as right after startup — is reported on the entry but never
 *  degrades readiness on its own. */
export function readinessOf(dependencies: Dependencies): Readiness {
  const degraded: string[] = []
  if (dependencies.ledger.status === 'degraded' || dependencies.ledger.status === 'unavailable') degraded.push('ledger')
  if (dependencies.datastore.some((entry) => entry.status === 'degraded' || entry.status === 'unavailable')) degraded.push('datastore')
  if (dependencies.githubQuota.some((entry) => entry.status === 'degraded' || entry.status === 'unavailable')) degraded.push('githubQuota')
  if (dependencies.collectors.status === 'degraded' || dependencies.collectors.status === 'unavailable') degraded.push('collectors')
  return { status: degraded.length ? 'degraded' : 'ok', degraded }
}

/** Liveness: 200 whenever the process answers. Memory and the compiled
 *  build identity only — no SQLite, filesystem, subprocess or worker. */
export function livenessSnapshot(): { status: 'ok', mode: 'service' | 'local', build: ReturnType<typeof buildIdentity>, uptimeMs: number } {
  return { status: 'ok', mode: isServiceMode() ? 'service' : 'local', build: buildIdentity(), uptimeMs: Math.max(0, Math.round(process.uptime() * 1000)) }
}

/** Readiness, dependencies and history for /api/health. Additive: it never
 *  changes the response's status code, `status`, or `scheduler.status`. */
export function dependencySnapshot(now = Date.now()): { readiness: Readiness, dependencies: Dependencies, history: { ledger: LedgerHistory } } {
  const ledgerSnapshot = behaviorLedgerSnapshot()
  const ledger = ledgerDependency(ledgerSnapshot, now)
  const datastore = datastoreDependencies(datastoreFreshnessEntries(now))
  const githubQuota = quotaDependencies(githubQuotaSnapshots(now))
  const collectors = collectorsDependency(loggingCollectionSnapshot())
  const dependencies = { ledger, datastore, githubQuota, collectors }
  return { readiness: readinessOf(dependencies), dependencies, history: { ledger: ledgerHistory(ledgerSnapshot) } }
}
