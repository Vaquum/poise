// Turn estimates for running behavior runs: how long similar runs took,
// so a running one can say how long it likely has left. The first release
// covers agent behavior runs only: direct runs have no model and finish
// inside their tick, and chat turns come later — their clock starts at
// reservation, before they wait for a slot, and an adopted turn resets it.

import type { LogEntry } from './agent'

/** Agent behaviors launched by the scheduler, by their log behavior name. */
export const AGENT_BEHAVIORS = ['pr_review', 'pr_approve', 'issue_review', 'implement_issue', 'repair_pr'] as const

/** Similar runs: the same behavior and model, completed in the last 30 days. */
export const ESTIMATE_WINDOW_MS = 30 * 24 * 60 * 60_000
/** Fewer similar runs than this is no estimate. */
export const ESTIMATE_MIN_SAMPLES = 5

export interface BehaviorEstimateBasis {
  /** The median execution time of similar runs. */
  medianMs: number
  /** Past this elapsed time the estimate becomes an overrun. */
  p90Ms: number
}

export type BehaviorEstimate =
  | { remainingMs: number, basis: BehaviorEstimateBasis, samples: number }
  | { overrun: true, basis: BehaviorEstimateBasis }

export interface BehaviorRunEstimate {
  id: string
  behavior: string
  model: string
  startedAt: string
  estimate: BehaviorEstimate | null
}

function startedAtMs(entry: Pick<LogEntry, 'started_at' | 'started_at_precise'>): number {
  return Date.parse(entry.started_at_precise || entry.started_at)
}

// Launch to completion: the launch is the agent call's start, so queue
// and preparation time, which happen before the claim, are never in the
// sample. Behavior runs wait on no person. Failed runs, superseded runs
// (restarted: their duration is partial work) and unreadable rows are
// left out.
function sampleDurationMs(entry: LogEntry): number | null {
  if (entry.status !== 'completed' || !entry.completed_at) return null
  const duration = Date.parse(entry.completed_at) - startedAtMs(entry)
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

function percentile(sortedMs: readonly number[], rank: number): number {
  return sortedMs[Math.min(sortedMs.length - 1, Math.max(0, Math.ceil(rank * sortedMs.length) - 1))]
}

/** The estimate for one running behavior run from the history snapshot. */
export function estimateBehaviorRun(
  history: readonly LogEntry[],
  running: LogEntry,
  now = Date.now(),
): BehaviorEstimate | null {
  const elapsed = now - startedAtMs(running)
  if (!Number.isFinite(elapsed) || elapsed < 0) return null
  const samples = history
    .filter((entry) => entry.behavior === running.behavior
      && entry.model === running.model
      && typeof entry.completed_at === 'string'
      && Date.parse(entry.completed_at) >= now - ESTIMATE_WINDOW_MS)
    .map(sampleDurationMs)
    .filter((duration): duration is number => duration !== null)
    .sort((a, b) => a - b)
  if (samples.length < ESTIMATE_MIN_SAMPLES) return null
  const basis = { medianMs: percentile(samples, 0.5), p90Ms: percentile(samples, 0.9) }
  if (elapsed >= basis.p90Ms) return { overrun: true, basis }
  return { remainingMs: Math.max(0, basis.medianMs - elapsed), basis, samples: samples.length }
}

/** Every running behavior run with its estimate, oldest first. */
export function readBehaviorEstimates(
  history: readonly LogEntry[],
  running: readonly LogEntry[],
  now = Date.now(),
): BehaviorRunEstimate[] {
  return running
    .filter((entry) => entry.status === 'running'
      && (AGENT_BEHAVIORS as readonly string[]).includes(entry.behavior ?? ''))
    .map((entry) => ({
      id: entry.id,
      behavior: entry.behavior as string,
      model: entry.model,
      startedAt: entry.started_at_precise || entry.started_at,
      estimate: estimateBehaviorRun(history, entry, now),
    }))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
}
