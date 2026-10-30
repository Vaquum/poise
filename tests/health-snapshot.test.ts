import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BehaviorLedgerSnapshot } from '../server/behavior-ledger'
import type { LedgerHealth } from '../server/behavior-ledger-contract'
import type { DatastoreFreshnessEntry } from '../server/behaviors'
import type { GithubQuotaSnapshot } from '../server/github-quota'
import type { CollectionSnapshot, Dependencies } from '../server/health'

let root = ''
let health: typeof import('../server/health')
let behaviors: typeof import('../server/behaviors')
let database: typeof import('../server/db')
let ledgerModule: typeof import('../server/behavior-ledger')
let quotaModule: typeof import('../server/github-quota')

const T0 = Date.parse('2026-10-24T08:00:00Z')

function ledgerHealth(over: Partial<LedgerHealth> = {}): LedgerHealth {
  return {
    status: 'ok', unavailableReason: null, coverageStart: null, observedAt: null, callerObservedAt: null,
    pending: 0, dropped: 0, gaps: [], detailFloor: null, generation: 'test-generation', retainedFrom: null,
    changeLowerBound: null, lastSequence: null, instances: null, changes: null, ...over,
  }
}

function snapshot(over: Partial<BehaviorLedgerSnapshot> = {}): BehaviorLedgerSnapshot {
  return { ready: true, failed: false, stopping: false, queueAgeMs: null, pending: 0, unreportedLoss: 0, stallBudgetMs: 10_000, health: ledgerHealth(), ...over }
}

function freshness(over: Partial<DatastoreFreshnessEntry> = {}): DatastoreFreshnessEntry {
  return { org: 'octocat', status: 'healthy', checkedAt: new Date(T0).toISOString(), observationAgeMs: 1_000, lastSuccessAt: new Date(T0 - 5_000).toISOString(), ageSeconds: 5, error: null, ...over }
}

function quota(over: Partial<GithubQuotaSnapshot> = {}): GithubQuotaSnapshot {
  return { login: 'octocat', roles: ['user'], checkedAt: new Date(T0).toISOString(), observationAgeMs: 1_000, exhausted: [], error: null, ...over }
}

function collection(over: Partial<CollectionSnapshot> = {}): CollectionSnapshot {
  return { sinkError: null, sinkSince: null, lossActive: false, queued: 0, queuedBytes: 0, dropped: 0, droppedSince: null, coverageError: null, journalError: null, reportError: null, lastSuccessfulWriteAt: null, ...over }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-health-snapshot-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.resetModules()
  health = await import('../server/health')
  behaviors = await import('../server/behaviors')
  database = await import('../server/db')
  ledgerModule = await import('../server/behavior-ledger')
  quotaModule = await import('../server/github-quota')
})

afterAll(async () => {
  database.closeDatabase()
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

describe('ledger dependency', () => {
  it('reads unknown before the ledger starts or while it stops', () => {
    expect(health.ledgerDependency(null, T0)).toMatchObject({ status: 'unknown', reason: 'not_started', pending: 0 })
    expect(health.ledgerDependency(snapshot({ stopping: true, queueAgeMs: 60_000 }), T0))
      .toMatchObject({ status: 'unknown', reason: 'stopping' })
  })

  it('reads unavailable when the worker has failed', () => {
    expect(health.ledgerDependency(snapshot({ failed: true }), T0))
      .toMatchObject({ status: 'unavailable', reason: 'worker_unavailable' })
  })

  it('reads a store outage the worker reported, even with the queue drained', () => {
    const idle = snapshot({ health: ledgerHealth({ status: 'unavailable', unavailableReason: 'journal_unavailable' }) })
    expect(health.ledgerDependency(idle, T0)).toMatchObject({ status: 'unavailable', reason: 'journal_unavailable' })
    const store = snapshot({ health: ledgerHealth({ status: 'unavailable', unavailableReason: 'store_unavailable' }) })
    expect(health.ledgerDependency(store, T0)).toMatchObject({ status: 'unavailable', reason: 'store_unavailable' })
    // The reported cause outranks the queue signal.
    const stalled = snapshot({ queueAgeMs: 60_000, pending: 40,
      health: ledgerHealth({ status: 'unavailable', unavailableReason: 'store_unavailable' }) })
    expect(health.ledgerDependency(stalled, T0)).toMatchObject({ status: 'unavailable', reason: 'store_unavailable' })
  })

  it('ignores an idle stale store the way it ignores history', () => {
    const stale = snapshot({ health: ledgerHealth({ status: 'stale' }) })
    expect(health.ledgerDependency(stale, T0)).toMatchObject({ status: 'ok', reason: null })
  })

  it('ignores the initial placeholder health before worker readiness', () => {
    const starting = snapshot({ ready: false,
      health: ledgerHealth({ status: 'unavailable', unavailableReason: null, generation: null }) })
    expect(health.ledgerDependency(starting, T0)).toMatchObject({ status: 'ok', reason: null })
  })

  it('reads degraded only once the queue outwaits the stall budget', () => {
    expect(health.ledgerDependency(snapshot({ queueAgeMs: 10_000, pending: 507 }), T0).status).toBe('ok')
    const stalled = health.ledgerDependency(snapshot({ queueAgeMs: 10_001, pending: 507 }), T0)
    expect(stalled).toMatchObject({ status: 'degraded', reason: 'queue_stalled', pending: 507, stallBudgetMs: 10_000 })
    expect(stalled.since).toBe(new Date(T0 - 10_001).toISOString())
  })

  it('reads degraded while capture loss is still unreported', () => {
    expect(health.ledgerDependency(snapshot({ unreportedLoss: 2 }), T0))
      .toMatchObject({ status: 'degraded', reason: 'capture_loss' })
  })

  it('ignores cumulative history: a recovered ledger reads ok', () => {
    const recovered = snapshot({ health: ledgerHealth({ status: 'incomplete', dropped: 3,
      gaps: [{ since: new Date(T0 - 3_600_000).toISOString(), until: null, reason: 'capture_loss' }] }) })
    expect(health.ledgerDependency(recovered, T0)).toMatchObject({ status: 'ok', reason: null })
  })
})

describe('datastore dependencies', () => {
  it('reads unknown when never sampled, even with an ancient epoch check', () => {
    const [entry] = health.datastoreDependencies([freshness({ status: 'unchecked', checkedAt: new Date(0).toISOString(), observationAgeMs: T0, lastSuccessAt: null, ageSeconds: null })])
    expect(entry).toMatchObject({ status: 'unknown', reason: 'no_observation' })
  })

  it('reads degraded once the observation outlives the sampler', () => {
    const stale = behaviors.DATASTORE_OBSERVATION_STALE_MS
    const [fresh] = health.datastoreDependencies([freshness({ observationAgeMs: stale })])
    expect(fresh.status).toBe('ok')
    const [entry] = health.datastoreDependencies([freshness({ observationAgeMs: stale + 1 })])
    expect(entry).toMatchObject({ status: 'degraded', reason: 'observation_stale' })
  })

  it('reads unavailable when the freshness gate says so', () => {
    const [entry] = health.datastoreDependencies([freshness({ status: 'unavailable', error: 'Datastore stale: last successful sync' })])
    expect(entry).toMatchObject({ status: 'unavailable', reason: 'sync_failing' })
  })

  it('reads degraded once the last success ages past what the gate accepts', () => {
    const limit = behaviors.DATASTORE_MAX_AGE_SECONDS
    const lastSuccessAt = new Date(T0 - (limit + 1) * 1000).toISOString()
    const [stale] = health.datastoreDependencies([freshness({ lastSuccessAt, ageSeconds: limit + 1, observationAgeMs: 1_000 })])
    expect(stale).toMatchObject({ status: 'degraded', reason: 'sync_stale' })
    expect(stale.since).toBe(new Date(T0 - 1_000).toISOString())
    const [edge] = health.datastoreDependencies([freshness({ lastSuccessAt: new Date(T0 - limit * 1000).toISOString(), ageSeconds: limit, observationAgeMs: 1_000 })])
    expect(edge.status).toBe('ok')
    // An observed gate failure still outranks the inferred age.
    const [failed] = health.datastoreDependencies([freshness({ status: 'unavailable', error: 'stale', lastSuccessAt, ageSeconds: limit + 1, observationAgeMs: 1_000 })])
    expect(failed).toMatchObject({ status: 'unavailable', reason: 'sync_failing' })
  })

  it('reports one entry per configured organization', () => {
    expect(behaviors.datastoreFreshnessEntries(T0)).toEqual([{
      org: null, status: 'unchecked', checkedAt: new Date(0).toISOString(), observationAgeMs: T0,
      lastSuccessAt: null, ageSeconds: null, error: null,
    }])
    database.db.prepare("INSERT INTO organizations(login, datastore_path, managed, status, stage) VALUES('octocat', NULL, 0, 'ready', 'ready'), ('hubot', NULL, 0, 'error', 'sync')").run()
    try {
      const entries = behaviors.datastoreFreshnessEntries(T0)
      expect(entries.map((entry) => entry.org)).toEqual(['octocat', 'hubot'])
      expect(entries.every((entry) => entry.status === 'unchecked')).toBe(true)
    } finally {
      database.db.prepare('DELETE FROM organizations').run()
    }
  })
})

describe('quota dependencies', () => {
  it('reads unknown when never observed, degraded when the monitor failed', () => {
    const [unseen] = health.quotaDependencies([quota({ checkedAt: null, observationAgeMs: null })])
    expect(unseen).toMatchObject({ status: 'unknown', reason: 'no_observation' })
    const [failed] = health.quotaDependencies([quota({ checkedAt: null, observationAgeMs: null, error: 'monitor failed' })])
    expect(failed).toMatchObject({ status: 'degraded', reason: 'observation_failed' })
  })

  it('reads stale observations degraded and exhausted budgets unavailable', () => {
    const [old] = health.quotaDependencies([quota({ observationAgeMs: quotaModule.QUOTA_OBSERVATION_STALE_MS + 1 })])
    expect(old).toMatchObject({ status: 'degraded', reason: 'observation_stale' })
    const [edge] = health.quotaDependencies([quota({ observationAgeMs: quotaModule.QUOTA_OBSERVATION_STALE_MS })])
    expect(edge.status).toBe('ok')
    const [exhausted] = health.quotaDependencies([quota({ exhausted: ['core'] })])
    expect(exhausted).toMatchObject({ status: 'unavailable', reason: 'budget_exhausted' })
    const [errored] = health.quotaDependencies([quota({ error: 'GitHub API quota could not be read' })])
    expect(errored).toMatchObject({ status: 'degraded', reason: 'observation_failed' })
  })
})

describe('collectors dependency', () => {
  it('reads unknown before logging starts', () => {
    expect(health.collectorsDependency(null)).toMatchObject({ status: 'unknown', reason: 'not_started' })
  })

  it('reads the sink, loss and collection errors distinctly', () => {
    expect(health.collectorsDependency(collection({ sinkError: 'disk full', sinkSince: new Date(T0).toISOString(), queued: 12 })))
      .toMatchObject({ status: 'unavailable', reason: 'sink_unavailable', queued: 12, error: 'disk full' })
    expect(health.collectorsDependency(collection({ lossActive: true })))
      .toMatchObject({ status: 'degraded', reason: 'collection_loss' })
    expect(health.collectorsDependency(collection({ journalError: 'journal corrupt' })))
      .toMatchObject({ status: 'degraded', reason: 'collection_degraded', error: 'journal corrupt' })
    expect(health.collectorsDependency(collection({ queued: 3, queuedBytes: 300 })))
      .toMatchObject({ status: 'ok', reason: null, queued: 3 })
  })
})

describe('readiness', () => {
  function dependencies(over: Partial<Dependencies> = {}): Dependencies {
    return {
      ledger: health.ledgerDependency(snapshot(), T0),
      datastore: health.datastoreDependencies([freshness()]),
      githubQuota: health.quotaDependencies([quota()]),
      collectors: health.collectorsDependency(collection()),
      ...over,
    }
  }

  it('degrades once, naming each degraded dependency', () => {
    expect(health.readinessOf(dependencies())).toEqual({ status: 'ok', degraded: [] })
    expect(health.readinessOf(dependencies({ ledger: health.ledgerDependency(snapshot({ failed: true }), T0) })))
      .toEqual({ status: 'degraded', degraded: ['ledger'] })
    expect(health.readinessOf(dependencies({
      datastore: health.datastoreDependencies([freshness(), freshness({ org: 'hubot', status: 'unavailable', error: 'stale' })]),
      githubQuota: health.quotaDependencies([quota({ exhausted: ['core'] })]),
      collectors: health.collectorsDependency(collection({ sinkError: 'down' })),
    }))).toEqual({ status: 'degraded', degraded: ['datastore', 'githubQuota', 'collectors'] })
  })

  it('never degrades on unknown alone', () => {
    expect(health.readinessOf(dependencies({
      ledger: health.ledgerDependency(null, T0),
      datastore: health.datastoreDependencies([freshness({ status: 'unchecked', checkedAt: new Date(0).toISOString(), observationAgeMs: T0, lastSuccessAt: null, ageSeconds: null })]),
      githubQuota: health.quotaDependencies([quota({ checkedAt: null, observationAgeMs: null })]),
      collectors: health.collectorsDependency(null),
    }))).toEqual({ status: 'ok', degraded: [] })
  })
})

describe('ledger history', () => {
  it('passes cumulative completeness through, zeros before start', () => {
    expect(health.ledgerHistory(null)).toEqual({ dropped: 0, gaps: [], detailFloor: null, coverageStart: null, retainedFrom: null, generation: null, observedAt: null, callerObservedAt: null })
    const gaps = [{ since: new Date(T0).toISOString(), until: null, reason: 'capture_loss' as const }]
    expect(health.ledgerHistory(snapshot({ health: ledgerHealth({ dropped: 4, gaps, coverageStart: '2026-10-01T00:00:00Z', retainedFrom: '2026-10-20T00:00:00Z' }) })))
      .toMatchObject({ dropped: 4, gaps, coverageStart: '2026-10-01T00:00:00Z', retainedFrom: '2026-10-20T00:00:00Z', generation: 'test-generation' })
  })
})

describe('ledger observer snapshot', () => {
  it('reads queue state synchronously without starting the worker', () => {
    const observer = new ledgerModule.BehaviorLedgerObserver()
    expect(observer.snapshot()).toMatchObject({ ready: false, failed: false, stopping: false, queueAgeMs: null, pending: 0, unreportedLoss: 0, stallBudgetMs: 10_000 })
    observer.capture({ type: 'heartbeat' })
    const queued = observer.snapshot()
    expect(queued.pending).toBe(1)
    expect(queued.queueAgeMs).toEqual(expect.any(Number))
    expect(queued.health.pending).toBe(1)
  })

  it('counts oversized captures as unreported loss, with a custom stall budget', () => {
    const observer = new ledgerModule.BehaviorLedgerObserver({ stallTimeoutMs: 50 })
    observer.capture({ type: 'admit', admissionKey: 'y'.repeat(5000), nativeId: 'oversized', behavior: 'merge-prs',
      source: 'poise:merge-prs', owner: null, actor: null, repository: 'example/project', number: 2, head: null })
    expect(observer.snapshot()).toMatchObject({ pending: 0, unreportedLoss: 1, stallBudgetMs: 50 })
  })
})

describe('liveness', () => {
  it('answers ok with the running build', () => {
    const live = health.livenessSnapshot()
    expect(live.status).toBe('ok')
    expect(live.mode).toBe('local')
    expect(live.build).toHaveProperty('sha')
    expect(live.uptimeMs).toEqual(expect.any(Number))
  })
})
