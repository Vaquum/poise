import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BehaviorLedgerSnapshot } from '../server/behavior-ledger'

// Read at call time: a test flips it mid-run without re-importing.
const failRaise = { value: false }

async function freshImports(): Promise<void> {
  // doMock (not the hoisted mock) so each test's store binds its own fresh
  // database instead of a closed one from an earlier test.
  vi.resetModules()
  vi.doMock('../server/alerts/store', async (importOriginal) => {
    const mod = await importOriginal<typeof import('../server/alerts/store')>()
    const raiseAlert = ((...args: Parameters<typeof mod.raiseAlert>) => {
      if (failRaise.value) throw new Error('alert store down')
      return mod.raiseAlert(...args)
    }) as typeof mod.raiseAlert
    return { ...mod, raiseAlert }
  })
  database = await import('../server/db')
  alerts = await import('../server/alerts/store')
  producers = await import('../server/alerts/producers')
}

let root: string
let database: typeof import('../server/db')
let alerts: typeof import('../server/alerts/store')
let producers: typeof import('../server/alerts/producers')
const T0 = Date.parse('2026-10-24T08:00:00Z')

function snapshot(over: Partial<BehaviorLedgerSnapshot> = {}, health: Record<string, unknown> = {}): BehaviorLedgerSnapshot {
  return {
    ready: true, failed: false, stopping: false, queueAgeMs: null, pending: 0, unreportedLoss: 0, stallBudgetMs: 10_000,
    health: {
      status: 'ok', unavailableReason: null, coverageStart: null, observedAt: null, callerObservedAt: null,
      pending: 0, dropped: 0, gaps: [], detailFloor: null, generation: 'generation-a', retainedFrom: null,
      changeLowerBound: null, lastSequence: null, instances: null, changes: null, ...health,
    },
    ...over,
  }
}

function open(kind?: 'ledger_queue_stalled' | 'ledger_capture_loss'): Array<{ kind: string, dedupeKey: string, title: string, body: string }> {
  return alerts.openAlerts(kind ? { kind } : {}).map((alert) => ({ kind: alert.kind, dedupeKey: alert.dedupeKey, title: alert.title, body: alert.body }))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-ledger-health-alerts-'))
  failRaise.value = false
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  await freshImports()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(async () => {
  producers.stopLedgerHealthRuntime()
  database.closeDatabase()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('queue stall alerts', () => {
  it('raises after two consecutive checks, refreshes details, resolves on drain, and re-arms', () => {
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 11_000, pending: 5 }), T0)
    expect(open('ledger_queue_stalled')).toEqual([])
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 71_000, pending: 9 }), T0 + 60_000)
    expect(open('ledger_queue_stalled')).toEqual([{
      kind: 'ledger_queue_stalled', dedupeKey: 'ledger:queue',
      title: 'Behavior ledger is not draining',
      body: expect.stringContaining('1 minute'),
    }])
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 131_000, pending: 12 }), T0 + 120_000)
    const standing = open('ledger_queue_stalled')
    expect(standing).toHaveLength(1)
    expect(standing[0].body).toContain('2 minutes')
    producers.ledgerHealthObserved(snapshot(), T0 + 180_000)
    expect(open('ledger_queue_stalled')).toEqual([])
    // One slow check after recovery does not re-alert on its own.
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 11_000, pending: 2 }), T0 + 240_000)
    expect(open('ledger_queue_stalled')).toEqual([])
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 71_000, pending: 2 }), T0 + 300_000)
    expect(open('ledger_queue_stalled')).toHaveLength(1)
  })

  it('ignores a stopping ledger', () => {
    producers.ledgerHealthObserved(snapshot({ stopping: true, queueAgeMs: 600_000, pending: 40 }), T0)
    producers.ledgerHealthObserved(snapshot({ stopping: true, queueAgeMs: 660_000, pending: 40 }), T0 + 60_000)
    expect(open('ledger_queue_stalled')).toEqual([])
  })
})

describe('worker failure alerts', () => {
  it('raises at once and resolves on recovery', () => {
    producers.ledgerHealthObserved(snapshot({ failed: true }), T0)
    expect(open('ledger_queue_stalled')).toEqual([{
      kind: 'ledger_queue_stalled', dedupeKey: 'ledger:queue:worker',
      title: 'Behavior ledger worker stopped',
      body: expect.stringContaining('restarts'),
    }])
    producers.ledgerHealthObserved(snapshot({ failed: true }), T0 + 60_000)
    expect(open('ledger_queue_stalled')).toHaveLength(1)
    producers.ledgerHealthObserved(snapshot(), T0 + 120_000)
    expect(open('ledger_queue_stalled')).toEqual([])
  })

  it('replaces a standing queue alert when the worker dies', () => {
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 11_000, pending: 5 }), T0)
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 71_000, pending: 5 }), T0 + 60_000)
    expect(open('ledger_queue_stalled').map((alert) => alert.dedupeKey)).toEqual(['ledger:queue'])
    producers.ledgerHealthObserved(snapshot({ failed: true }), T0 + 120_000)
    expect(open('ledger_queue_stalled').map((alert) => alert.dedupeKey)).toEqual(['ledger:queue:worker'])
  })
})

describe('capture loss alerts', () => {
  it('baselines history silently and alerts only on increases', () => {
    producers.ledgerHealthObserved(snapshot({}, { dropped: 5 }), T0)
    expect(open('ledger_capture_loss')).toEqual([])
    producers.ledgerHealthObserved(snapshot({}, { dropped: 5 }), T0 + 60_000)
    expect(open('ledger_capture_loss')).toEqual([])
    producers.ledgerHealthObserved(snapshot({}, { dropped: 7 }), T0 + 120_000)
    expect(open('ledger_capture_loss')).toEqual([{
      kind: 'ledger_capture_loss', dedupeKey: 'ledger:loss:generation-a',
      title: 'Behavior ledger lost captures',
      body: expect.stringContaining('2 captures were lost'),
    }])
    // A later increase refreshes the standing alert instead of piling on.
    producers.ledgerHealthObserved(snapshot({}, { dropped: 8 }), T0 + 180_000)
    const standing = open('ledger_capture_loss')
    expect(standing).toHaveLength(1)
    expect(standing[0].body).toContain('1 capture was lost')
    expect(standing[0].body).toContain('8 total')
  })

  it('detects increases while already degraded', () => {
    producers.ledgerHealthObserved(snapshot({ failed: true }, { dropped: 5 }), T0)
    expect(open('ledger_capture_loss')).toEqual([])
    producers.ledgerHealthObserved(snapshot({ failed: true }, { dropped: 6 }), T0 + 60_000)
    expect(open('ledger_capture_loss')).toHaveLength(1)
  })

  it('never subtracts across stores: a new generation re-baselines and supersedes', () => {
    producers.ledgerHealthObserved(snapshot({}, { dropped: 5 }), T0)
    producers.ledgerHealthObserved(snapshot({}, { dropped: 7 }), T0 + 60_000)
    expect(open('ledger_capture_loss')).toHaveLength(1)
    producers.ledgerHealthObserved(snapshot({}, { dropped: 1, generation: 'generation-b' }), T0 + 120_000)
    expect(open('ledger_capture_loss')).toEqual([])
    producers.ledgerHealthObserved(snapshot({}, { dropped: 2, generation: 'generation-b' }), T0 + 180_000)
    expect(open('ledger_capture_loss')).toEqual([expect.objectContaining({ dedupeKey: 'ledger:loss:generation-b' })])
  })

  it('re-baselines a lowered counter silently instead of alerting on it', () => {
    producers.ledgerHealthObserved(snapshot({}, { dropped: 5 }), T0)
    producers.ledgerHealthObserved(snapshot({}, { dropped: 2 }), T0 + 60_000)
    expect(open('ledger_capture_loss')).toEqual([])
    producers.ledgerHealthObserved(snapshot({}, { dropped: 3 }), T0 + 120_000)
    expect(open('ledger_capture_loss')).toHaveLength(1)
  })
})

describe('unstarted ledger', () => {
  it('raises nothing and clears standing ledger alerts', () => {
    producers.ledgerHealthObserved(snapshot({}, { dropped: 5 }), T0)
    producers.ledgerHealthObserved(snapshot({}, { dropped: 6 }), T0 + 60_000)
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 11_000 }, { dropped: 6 }), T0 + 120_000)
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 71_000 }, { dropped: 6 }), T0 + 180_000)
    expect(open()).toHaveLength(2)
    producers.ledgerHealthObserved(null, T0 + 240_000)
    expect(open()).toEqual([])
    producers.checkLedgerHealth(T0 + 300_000)
    expect(open()).toEqual([])
  })
})

describe('notification settings', () => {
  it('gates raising but not resolution, and holds the loss baseline while off', () => {
    database.setMeta('notification_settings', JSON.stringify({ enabled: false }))
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 11_000 }), T0)
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 71_000 }), T0 + 60_000)
    expect(open('ledger_queue_stalled')).toEqual([])
    database.setMeta('notification_settings', JSON.stringify({ enabled: true }))
    producers.ledgerHealthObserved(snapshot({ queueAgeMs: 131_000 }), T0 + 120_000)
    expect(open('ledger_queue_stalled')).toHaveLength(1)
    database.setMeta('notification_settings', JSON.stringify({ enabled: false }))
    producers.ledgerHealthObserved(snapshot(), T0 + 180_000)
    expect(open('ledger_queue_stalled')).toEqual([])

    // The baseline holds while off, so re-enabling surfaces everything lost
    // since the earlier baseline of 0 from this test's stall checks.
    producers.ledgerHealthObserved(snapshot({}, { dropped: 5 }), T0 + 240_000)
    producers.ledgerHealthObserved(snapshot({}, { dropped: 7 }), T0 + 300_000)
    expect(open('ledger_capture_loss')).toEqual([])
    database.setMeta('notification_settings', JSON.stringify({ enabled: true }))
    producers.ledgerHealthObserved(snapshot({}, { dropped: 7 }), T0 + 360_000)
    const surfaced = open('ledger_capture_loss')
    expect(surfaced).toHaveLength(1)
    expect(surfaced[0].body).toContain('7 captures were lost')
    producers.ledgerHealthObserved(snapshot({}, { dropped: 9 }), T0 + 420_000)
    const updated = open('ledger_capture_loss')
    expect(updated).toHaveLength(1)
    expect(updated[0].body).toContain('2 captures were lost')
  })
})

describe('failed alert writes', () => {
  it('retries the delta on the next check instead of consuming it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      producers.ledgerHealthObserved(snapshot({}, { dropped: 5 }), T0)
      failRaise.value = true
      producers.ledgerHealthObserved(snapshot({}, { dropped: 7 }), T0 + 60_000)
      expect(open('ledger_capture_loss')).toEqual([])
      failRaise.value = false
      producers.ledgerHealthObserved(snapshot({}, { dropped: 7 }), T0 + 120_000)
      const alert = open('ledger_capture_loss')
      expect(alert).toHaveLength(1)
      expect(alert[0].body).toContain('2 captures were lost')
    } finally {
      failRaise.value = false
      error.mockRestore()
    }
  })
})

describe('ledger health runtime', () => {
  it('starts and stops idempotently', () => {
    producers.startLedgerHealthRuntime()
    producers.startLedgerHealthRuntime()
    producers.stopLedgerHealthRuntime()
    producers.stopLedgerHealthRuntime()
  })
})
