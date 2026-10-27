import { randomUUID } from 'node:crypto'
import { BEHAVIOR_KEYS, type BehaviorKey } from '../src/behavior-types'
import type { BehaviorMetrics, BehaviorMetricsReport } from '../src/behavior-metrics'
import type { LogEntry } from './agent'
import type { LedgerOutcome } from './behavior-ledger-contract'
import { recordHandling } from './alerts/handling'
import type { AnalyticsWindow } from './analytics'
import { db } from './db'

type DirectBehavior = 'resolve-unblocking' | 'merge-prs' | 'rerun-grey-ci'
interface Run {
  behavior: BehaviorKey
  startedAt: string
  completedAt: string | null
  status: string
}
const activeDirectRuns = new Set<string>()

export function startDirectBehaviorRun(behavior: DirectBehavior): string {
  const id = randomUUID()
  db.prepare('INSERT INTO behavior_runs(id, behavior, started_at) VALUES (?, ?, ?)')
    .run(id, behavior, new Date().toISOString())
  activeDirectRuns.add(id)
  return id
}

export function finishDirectBehaviorRun(id: string, success: boolean, outcome: LedgerOutcome | null = null, note?: string): void {
  const at = new Date().toISOString()
  const row = db.prepare('SELECT behavior, started_at FROM behavior_runs WHERE id = ?').get(id) as { behavior: string, started_at: string } | undefined
  db.prepare('UPDATE behavior_runs SET completed_at = ?, status = ?, outcome = ?, note = ? WHERE id = ?')
    .run(at, success ? 'completed' : 'failed', outcome, note ?? null, id)
  activeDirectRuns.delete(id)
  if (row) {
    recordHandling({ kind: 'behavior-firing', source: row.behavior, title: row.behavior,
      startedAt: row.started_at, finishedAt: at, outcome: success ? 'completed' : 'failed',
      actor: 'behaviors', ref: `direct-run:${id}` }, at)
  }
}

export function discardDirectBehaviorRun(id: string): void {
  db.prepare('DELETE FROM behavior_runs WHERE id = ?').run(id)
  activeDirectRuns.delete(id)
}

// A direct run finishes inside its own tick, bounded by the 65 s PR
// operation lease. Past an hour it cannot still be alive: its owner died
// without reaching its finally. Only rows this process does not own are
// touched, so a live run is never closed; a concurrent finish wins over
// the reap, since it no longer matches `running`.
export const DIRECT_RUN_ABANDONED_AFTER_MS = 60 * 60_000

export function reapAbandonedDirectBehaviorRuns(nowMs = Date.now()): string[] {
  const cutoff = (nowMs - DIRECT_RUN_ABANDONED_AFTER_MS) / 1000
  const stale = db.prepare(`
    SELECT id, started_at FROM behavior_runs
    WHERE status = 'running' AND unixepoch(started_at, 'subsec') < ?
  `).all(cutoff) as Array<{ id: string, started_at: string }>
  const close = db.prepare(`
    UPDATE behavior_runs SET status = 'interrupted', note = ?
    WHERE id = ? AND status = 'running'
  `)
  const reaped: string[] = []
  db.transaction(() => {
    for (const row of stale) {
      if (activeDirectRuns.has(row.id)) continue
      // The actual completion is unknown, so completed_at stays null and
      // the duration with it: an October run reaped today must not look
      // like a four-day run. `interrupted` belongs to neither the success
      // nor the failure set, so the success rate skips it too.
      close.run(`abandoned: started ${row.started_at}, older than the 1 h bound, no live owner in this process`, row.id)
      reaped.push(row.id)
    }
  })()
  return reaped
}

const AGENT_BEHAVIORS = {
  'review-new-prs': 'pr_review', 'approve-prs': 'pr_approve', 'review-new-issues': 'issue_review',
} as const
const FAILURE = new Set(['invalid', 'failed', 'error', 'cancelled', 'canceled', 'timed_out', 'timeout'])
const SUCCESS = new Set(['completed', 'superseded'])

interface DirectSummary {
  behavior: BehaviorKey
  totalRuns: number
  durationMs: number
  unknownDurations: number
  finished: number
  failed: number
}
interface DirectWindow {
  summaries: DirectSummary[]
  running: (Run & { id: string })[]
}
let directRevision: number | null = null
const directWindows = new Map<string, DirectWindow>()

function readDirectMetrics(window: AnalyticsWindow, now = Date.now()): Map<BehaviorKey, BehaviorMetrics> {
  // A durable revision catches writes from this connection and other processes.
  // Unchanged refreshes reuse aggregates; live elapsed time is added below.
  const { revision } = db.prepare('SELECT revision FROM behavior_runs_revision WHERE id = 1').get() as { revision: number }
  if (revision !== directRevision) {
    directWindows.clear()
    directRevision = revision
  }
  const key = JSON.stringify(window)
  let cached = directWindows.get(key)
  if (!cached) {
    const bounds = ["unixepoch(started_at, 'subsec') IS NOT NULL"]
    const params: number[] = []
    if (window.since) { bounds.push("unixepoch(started_at, 'subsec') >= ?"); params.push(Date.parse(window.since) / 1000) }
    if (window.until) { bounds.push("unixepoch(started_at, 'subsec') < ?"); params.push(Date.parse(window.until) / 1000) }
    const where = bounds.join(' AND ')
    const duration = "round((unixepoch(completed_at, 'subsec') - unixepoch(started_at, 'subsec')) * 1000)"
    const failures = [...FAILURE].map((status) => `'${status}'`).join(', ')
    const terminal = [...SUCCESS, ...FAILURE].map((status) => `'${status}'`).join(', ')
    cached = {
      summaries: db.prepare(`SELECT behavior, count(*) AS totalRuns,
        sum(CASE WHEN ${duration} >= 0 THEN ${duration} ELSE 0 END) AS durationMs,
        sum(CASE WHEN ${duration} >= 0 THEN 0 ELSE 1 END) AS unknownDurations,
        sum(status IN (${terminal})) AS finished, sum(status IN (${failures})) AS failed
        FROM behavior_runs WHERE ${where} GROUP BY behavior`).all(...params) as DirectSummary[],
      running: db.prepare(`SELECT id, behavior, started_at AS startedAt, completed_at AS completedAt, status
        FROM behavior_runs WHERE status = 'running' AND ${where}`).all(...params) as DirectWindow['running'],
    }
    // Arbitrary API windows must not retain an unbounded number of aggregates.
    if (directWindows.size >= 8) directWindows.delete(directWindows.keys().next().value!)
    directWindows.set(key, cached)
  }
  return new Map(cached.summaries.map((summary) => {
    let { durationMs, unknownDurations } = summary
    for (const run of cached.running) {
      if (run.behavior !== summary.behavior || run.completedAt || !activeDirectRuns.has(run.id)) continue
      const elapsed = now - Date.parse(run.startedAt)
      if (elapsed >= 0) { durationMs += elapsed; unknownDurations-- }
    }
    return [summary.behavior, {
      totalRuns: summary.totalRuns,
      durationMinutes: unknownDurations ? null : durationMs / 60_000,
      successRate: summary.finished ? (summary.finished - summary.failed) / summary.finished * 100 : null,
    }]
  }))
}

export function computeBehaviorMetrics(runs: Run[], window: AnalyticsWindow, now = Date.now()): BehaviorMetrics {
  const selected = runs.filter((run) => {
    const at = Date.parse(run.startedAt)
    return Number.isFinite(at) && (!window.since || at >= Date.parse(window.since))
      && (!window.until || at < Date.parse(window.until))
  })
  let durationMs = 0
  let durationKnown = true
  let finished = 0
  let failed = 0
  for (const run of selected) {
    const terminal = SUCCESS.has(run.status) || FAILURE.has(run.status)
    if (terminal) { finished++; if (FAILURE.has(run.status)) failed++ }
    const active = ['pending', 'queued', 'running', 'in_progress'].includes(run.status)
    const end = run.completedAt ? Date.parse(run.completedAt) : active ? now : NaN
    const duration = end - Date.parse(run.startedAt)
    if (!Number.isFinite(duration) || duration < 0) durationKnown = false
    else durationMs += duration
  }
  return {
    totalRuns: selected.length,
    durationMinutes: durationKnown ? durationMs / 60_000 : null,
    successRate: finished ? (finished - failed) / finished * 100 : null,
  }
}

export function readBehaviorMetrics(logs: LogEntry[], window: AnalyticsWindow, error: string | null): BehaviorMetricsReport {
  const direct = readDirectMetrics(window)
  const behaviors = Object.fromEntries(BEHAVIOR_KEYS.map((key) => {
    if (key in AGENT_BEHAVIORS) {
      if (error) return [key, null]
      const behavior = AGENT_BEHAVIORS[key as keyof typeof AGENT_BEHAVIORS]
      const runs = logs.filter((log) => log.behavior === behavior && log.source === `poise:${key}`)
        .map((log) => ({ behavior: key, startedAt: log.started_at_precise || log.started_at,
          completedAt: log.completed_at ?? null, status: log.status }))
      return [key, computeBehaviorMetrics(runs, window)]
    }
    return [key, direct.get(key) ?? { totalRuns: 0, durationMinutes: 0, successRate: null }]
  })) as BehaviorMetricsReport['behaviors']
  return { behaviors, error }
}
