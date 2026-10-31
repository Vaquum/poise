import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeBehaviorMetrics, discardDirectBehaviorRun, finishDirectBehaviorRun, readBehaviorMetrics, reapAbandonedDirectBehaviorRuns, startDirectBehaviorRun } from '../server/behavior-metrics'
import { db } from '../server/db'
import type { LogEntry } from '../server/agent'
import type { QuarantinedAgentLog } from '../server/agent-log-parse'

const window = { since: '2026-10-17T00:00:00Z', until: '2026-10-18T00:00:00Z' }
const run = (status: string, startedAt = '2026-10-17T10:00:00Z', completedAt: string | null = '2026-10-17T10:02:00Z') =>
  ({ behavior: 'review-new-prs' as const, status, startedAt, completedAt })
const log = (extra: Partial<LogEntry> = {}): LogEntry => ({
  id: 'a'.repeat(32), repo: 'acme/api', pr_id: '1', actor: 'review-bot', model: 'model',
  behavior: 'pr_review', source: 'poise:review-new-prs', session_id: null, prompt: '',
  started_at: '2026-10-17T10:00:00Z', completed_at: '2026-10-17T10:02:00Z',
  time_elapsed: '2m', status: 'completed', outcome: 'clean', head_sha: null,
  expected_head: null, correlation_id: null, action: 'reviewed_clean', response: null, error: '', ...extra,
})
const quarantine = (extra: Partial<QuarantinedAgentLog> = {}): QuarantinedAgentLog => ({
  index: 0, id: 'e'.repeat(32), correlationId: 'bad-call', repo: 'acme/api', prId: '2',
  behavior: 'pr_review', sessionId: null, source: 'poise:review-new-prs', startedAt: '2026-10-17T11:00:00Z',
  error: 'Unreadable diagnostic', ...extra,
})

describe('behavior run metrics', () => {
  it('attributes real chain calls to implementation, repair and review rows without counting manual work', () => {
    const rows = [log({ behavior: 'implement_issue', source: 'poise:behavior-chain' }),
      log({ behavior: 'repair_pr', source: 'poise:behavior-chain' }), log({ source: 'poise:behavior-chain' }),
      log({ behavior: 'repair_pr', source: 'manual' })]
    const report = readBehaviorMetrics(rows, window, null)
    expect(report.behaviors['implement-issues']?.totalRuns).toBe(1)
    expect(report.behaviors['repair-prs']?.totalRuns).toBe(1)
    expect(report.behaviors['review-new-prs']?.totalRuns).toBe(1)
  })
  beforeEach(() => { db.prepare('DELETE FROM behavior_runs').run() })
  afterEach(() => { vi.useRealTimers() })

  it('filters all metrics by inclusive start and exclusive end', () => {
    expect(computeBehaviorMetrics([
      run('completed'), run('failed'), run('completed', window.until),
      run('failed', '2026-10-16T23:59:59Z'), run('superseded', window.since, '2026-10-17T00:01:00Z'),
    ], window)).toEqual({ totalRuns: 3, durationMinutes: 5, successRate: 2 / 3 * 100 })
  })

  it('adds live elapsed time while excluding unfinished runs from the success rate', () => {
    const now = Date.parse('2026-10-17T10:03:00Z')
    expect(computeBehaviorMetrics([run('completed'), run('failed'), run('running', undefined, null)], window, now))
      .toEqual({ totalRuns: 3, durationMinutes: 7, successRate: 50 })
    expect(computeBehaviorMetrics([run('running', undefined, null)], window, now).successRate).toBeNull()
    expect(computeBehaviorMetrics([], window)).toEqual({ totalRuns: 0, durationMinutes: 0, successRate: null })
  })

  it('does not invent missing or negative terminal durations', () => {
    expect(computeBehaviorMetrics([run('failed', undefined, null)], window).durationMinutes).toBeNull()
    expect(computeBehaviorMetrics([run('completed', undefined, '2026-10-17T09:00:00Z')], window).durationMinutes).toBeNull()
  })

  it('requires the exact automatic source and behavior, excluding manual reviews and sibling behaviors', () => {
    const report = readBehaviorMetrics([log(), log({ source: 'manual' }), log({ behavior: 'issue_review' }),
      log({ source: 'poise:approve-prs' })], window, null)
    expect(report.behaviors['review-new-prs']).toEqual({ totalRuns: 1, durationMinutes: 2, successRate: 100 })
    expect(report.behaviors['approve-prs']?.totalRuns).toBe(0)
  })

  it('persists direct successes and failures independently of agent log availability', () => {
    const success = startDirectBehaviorRun('merge-prs')
    finishDirectBehaviorRun(success, true)
    const failure = startDirectBehaviorRun('merge-prs')
    finishDirectBehaviorRun(failure, false)
    const report = readBehaviorMetrics([], { since: null, until: null }, 'Logs unavailable')
    expect(report.error).toBe('Logs unavailable')
    expect(report.behaviors['review-new-prs']).toBeNull()
    expect(report.behaviors['merge-prs']).toMatchObject({ totalRuns: 2, successRate: 50 })
  })

  it('contains unreadable history to the behavior whose metrics could include it', () => {
    const report = readBehaviorMetrics([log(), log({ behavior: 'pr_approve', source: 'poise:approve-prs' })],
      window, null, [quarantine()])
    expect(report.behaviors['review-new-prs']).toBeNull()
    expect(report.behaviors['approve-prs']).toEqual({ totalRuns: 1, durationMinutes: 2, successRate: 100 })
    expect(report.behaviors['review-new-issues']?.totalRuns).toBe(0)
    expect(report.error).toContain('unreadable')
  })

  it.each([
    { startedAt: '2026-10-16T23:59:59Z' }, { startedAt: window.until }, { source: 'manual' }, { behavior: 'chat' },
  ])('does not withhold metrics for an excluded quarantine %j', (extra) => {
    const report = readBehaviorMetrics([log()], window, null, [quarantine(extra)])
    expect(report.behaviors['review-new-prs']).toEqual({ totalRuns: 1, durationMinutes: 2, successRate: 100 })
  })

  it('keeps unknown provenance conservative and refuses contradictory duplicate identities', () => {
    const unknown = quarantine({ source: undefined, behavior: null, startedAt: undefined })
    const report = readBehaviorMetrics([log()], window, null, [unknown])
    expect(report.behaviors['review-new-prs']).toBeNull()
    expect(report.behaviors['approve-prs']).toBeNull()
    for (const duplicate of [{ id: log().id }, { correlationId: 'same-call' }]) {
      const conflict = quarantine({ ...duplicate, source: 'manual', behavior: 'chat', startedAt: '2026-10-01T00:00:00Z' })
      expect(readBehaviorMetrics([log({ correlation_id: 'same-call' })], window, null, [conflict])
        .behaviors['review-new-prs']).toBeNull()
    }
  })

  it('retains valid metrics through a large unrelated fault feed', () => {
    const logs = Array.from({ length: 3000 }, (_, i) => log({ id: i.toString(16).padStart(32, '0') }))
    const faults = Array.from({ length: 1500 }, (_, i) => quarantine({
      id: (10000 + i).toString(16).padStart(32, '0'), source: 'manual',
    }))
    expect(readBehaviorMetrics(logs, window, null, faults).behaviors['review-new-prs'])
      .toEqual({ totalRuns: 3000, durationMinutes: 6000, successRate: 100 })
  })

  it('keeps interrupted direct attempts unknown instead of extending their duration forever', () => {
    db.prepare('INSERT INTO behavior_runs(id, behavior, started_at) VALUES (?, ?, ?)')
      .run('previous-process', 'merge-prs', '2026-10-17T10:00:00Z')
    expect(readBehaviorMetrics([], window, null).behaviors['merge-prs'])
      .toEqual({ totalRuns: 1, durationMinutes: null, successRate: null })
  })

  it('reaps abandoned direct runs as interrupted with the evidence recorded, never deleted', () => {
    const insert = db.prepare('INSERT INTO behavior_runs(id, behavior, started_at) VALUES (?, ?, ?)')
    insert.run('oct-18-a', 'resolve-unblocking', '2026-10-18T20:24:33Z')
    insert.run('oct-18-b', 'resolve-unblocking', '2026-10-18T22:47:10Z')
    insert.run('fresh', 'resolve-unblocking', '2026-10-22T12:00:00Z')
    const owned = startDirectBehaviorRun('merge-prs')
    db.prepare('UPDATE behavior_runs SET started_at = ? WHERE id = ?')
      .run('2026-10-18T20:24:33Z', owned)

    expect(reapAbandonedDirectBehaviorRuns(Date.parse('2026-10-22T12:00:01Z')).sort())
      .toEqual(['oct-18-a', 'oct-18-b'])
    expect(db.prepare('SELECT count(*) FROM behavior_runs').pluck().get()).toBe(4)
    const state = (id: string) => db.prepare(
      'SELECT status, completed_at, note FROM behavior_runs WHERE id = ?').get(id)
    expect(state('oct-18-a')).toEqual({
      status: 'interrupted', completed_at: null, note: expect.stringContaining('2026-10-18T20:24:33Z'),
    })
    expect(state('oct-18-b')).toEqual({
      status: 'interrupted', completed_at: null, note: expect.stringContaining('2026-10-18T22:47:10Z'),
    })
    expect(state('fresh')).toEqual({ status: 'running', completed_at: null, note: null })
    expect(state(owned)).toEqual({ status: 'running', completed_at: null, note: null })
    // A second pass is quiet: reaping is idempotent.
    expect(reapAbandonedDirectBehaviorRuns(Date.parse('2026-10-22T12:00:01Z'))).toEqual([])
    finishDirectBehaviorRun(owned, true)
  })

  it('excludes interrupted runs from the success rate with unknown duration in both calculators', () => {
    const runs = [run('completed'), run('interrupted', undefined, null)]
    expect(computeBehaviorMetrics(runs, window))
      .toEqual({ totalRuns: 2, durationMinutes: null, successRate: 100 })
    const insert = db.prepare('INSERT INTO behavior_runs(id, behavior, started_at, completed_at, status) VALUES (?, ?, ?, ?, ?)')
    insert.run('done', 'merge-prs', '2026-10-17T10:00:00Z', '2026-10-17T10:02:00Z', 'completed')
    insert.run('cut', 'merge-prs', '2026-10-17T10:00:00Z', null, 'interrupted')
    expect(readBehaviorMetrics([], window, null).behaviors['merge-prs'])
      .toEqual(computeBehaviorMetrics(runs, window))
  })

  it('aggregates indexed windows with the same boundaries, durations and outcomes as agent runs', () => {
    const runs = [run('completed'), run('failed'), run('completed', window.until),
      run('failed', '2026-10-16T23:59:59Z'), run('superseded', window.since, '2026-10-17T00:01:00Z')]
    const insert = db.prepare('INSERT INTO behavior_runs(id, behavior, started_at, completed_at, status) VALUES (?, ?, ?, ?, ?)')
    for (const [id, entry] of runs.entries()) insert.run(String(id), 'merge-prs', entry.startedAt, entry.completedAt, entry.status)

    expect(readBehaviorMetrics([], window, null).behaviors['merge-prs']).toEqual(computeBehaviorMetrics(runs, window))
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT count(*) FROM behavior_runs WHERE unixepoch(started_at, 'subsec') >= ? AND unixepoch(started_at, 'subsec') < ?")
      .all(Date.parse(window.since) / 1000, Date.parse(window.until) / 1000) as { detail: string }[]
    expect(plan.some(({ detail }) => detail.includes('SEARCH behavior_runs USING') && detail.includes('behavior_runs_started'))).toBe(true)
  })

  it('uses timestamp values rather than text ordering for offsets and millisecond boundaries', () => {
    db.prepare('INSERT INTO behavior_runs(id, behavior, started_at, completed_at, status) VALUES (?, ?, ?, ?, ?)')
      .run('offset', 'merge-prs', '2026-10-17T12:00:00+02:00', '2026-10-17T10:00:00.123Z', 'completed')
    const selected = { since: '2026-10-17T10:00:00.000Z', until: '2026-10-17T10:00:00.001Z' }
    expect(readBehaviorMetrics([], selected, null).behaviors['merge-prs'])
      .toEqual({ totalRuns: 1, durationMinutes: 123 / 60_000, successRate: 100 })
    expect(readBehaviorMetrics([], { ...selected, since: selected.until, until: null }, null).behaviors['merge-prs']?.totalRuns).toBe(0)
  })

  it('records the firing disposition on direct runs for lineage after ledger eviction', () => {
    const id = startDirectBehaviorRun('merge-prs')
    finishDirectBehaviorRun(id, true, 'not_ready')
    expect(db.prepare('SELECT status, outcome, completed_at FROM behavior_runs WHERE id = ?').get(id))
      .toEqual({ status: 'completed', outcome: 'not_ready', completed_at: expect.any(String) })
    // Rows finished before dispositions existed keep a null outcome and
    // their legacy status-only classification.
    const legacy = startDirectBehaviorRun('merge-prs')
    finishDirectBehaviorRun(legacy, true)
    expect(db.prepare('SELECT status, outcome FROM behavior_runs WHERE id = ?').get(legacy))
      .toEqual({ status: 'completed', outcome: null })
  })

  it('counts change-request verdicts as successful deliveries and supersession as a non-failure', () => {
    const report = readBehaviorMetrics([
      log({ outcome: 'changes_requested', action: 'requested_changes' }),
      log({ id: 'b'.repeat(32), status: 'superseded', outcome: 'superseded', action: null }),
    ], window, null)
    expect(report.behaviors['review-new-prs']).toEqual({ totalRuns: 2, durationMinutes: 4, successRate: 100 })
  })

  it('leaves the run ledger untouched while reporting metrics', () => {
    const id = startDirectBehaviorRun('merge-prs')
    finishDirectBehaviorRun(id, true, 'merged')
    const revision = (db.prepare('SELECT revision FROM behavior_runs_revision WHERE id = 1').get() as { revision: number }).revision
    readBehaviorMetrics([], { since: null, until: null }, null)
    expect((db.prepare('SELECT revision FROM behavior_runs_revision WHERE id = 1').get() as { revision: number }).revision).toBe(revision)
  })

  it('reuses unchanged aggregates, updates live duration and invalidates every ledger mutation', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-17T10:00:00Z'))
    const id = startDirectBehaviorRun('merge-prs')
    const prepare = vi.spyOn(db, 'prepare')
    const read = () => readBehaviorMetrics([], window, null).behaviors['merge-prs']
    expect(read()).toEqual({ totalRuns: 1, durationMinutes: 0, successRate: null })
    vi.setSystemTime(new Date('2026-10-17T10:02:00Z'))
    expect(read()).toEqual({ totalRuns: 1, durationMinutes: 2, successRate: null })
    expect(prepare.mock.calls.filter(([sql]) => String(sql).includes('GROUP BY behavior'))).toHaveLength(1)
    finishDirectBehaviorRun(id, false)
    expect(read()).toEqual({ totalRuns: 1, durationMinutes: 2, successRate: 0 })
    // Database writes outside the metrics helpers also invalidate the cache.
    db.prepare('UPDATE behavior_runs SET status = ? WHERE id = ?').run('completed', id)
    expect(read()?.successRate).toBe(100)
    discardDirectBehaviorRun(id)
    expect(read()).toEqual({ totalRuns: 0, durationMinutes: 0, successRate: null })
  })

  it('settles a direct run once and never downgrades a proven result', () => {
    const id = startDirectBehaviorRun('merge-prs')
    finishDirectBehaviorRun(id, true, 'merged', 'target=acme/app#7 head=a outcome=merged merge_sha=b')
    const settled = db.prepare('SELECT status, outcome, completed_at, note FROM behavior_runs WHERE id = ?').get(id)
    expect(settled).toMatchObject({ status: 'completed', outcome: 'merged' })
    // A delayed failure callback must not overwrite the proven settlement.
    finishDirectBehaviorRun(id, false)
    expect(db.prepare('SELECT status, outcome, completed_at, note FROM behavior_runs WHERE id = ?').get(id)).toEqual(settled)
    // Handling records the firing once; the downgrade attempt adds no duplicate.
    const handled = db.prepare("SELECT count(*) AS n FROM handling_log WHERE ref = ?").get(`direct-run:${id}`) as { n: number }
    expect(handled.n).toBe(1)
  })

  it('never truncates a structured settlement receipt', () => {
    const receipt = JSON.stringify({ nativeId: 'resolve-1', disposition: 'failed',
      lateFailure: { error: 'x'.repeat(2000), sideEffects: 'uncertain' } })
    expect(receipt.length).toBeGreaterThan(1000)
    const id = startDirectBehaviorRun('resolve-unblocking')
    finishDirectBehaviorRun(id, false, null, receipt)
    expect(db.prepare('SELECT note FROM behavior_runs WHERE id = ?').get(id)).toEqual({ note: receipt })
    expect(() => JSON.parse((db.prepare('SELECT note FROM behavior_runs WHERE id = ?').get(id) as { note: string }).note)).not.toThrow()
  })

  it('keeps the canonical run when its handling view is unavailable', () => {
    db.exec(`CREATE TRIGGER fail_completed_handling BEFORE INSERT ON handling_log
      WHEN NEW.kind = 'behavior-firing' AND NEW.outcome = 'completed'
      BEGIN SELECT RAISE(ABORT, 'handling log unavailable'); END;`)
    try {
      const id = startDirectBehaviorRun('merge-prs')
      expect(() => finishDirectBehaviorRun(id, true, 'merged', 'target=acme/app#7')).not.toThrow()
      expect(db.prepare('SELECT status, outcome FROM behavior_runs WHERE id = ?').get(id))
        .toEqual({ status: 'completed', outcome: 'merged' })
    } finally {
      db.exec('DROP TRIGGER fail_completed_handling')
    }
  })
})
