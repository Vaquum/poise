/** The Manager's wake interval: how often Poise wakes the workspace Manager.
 *  Kept free of runtime imports beyond the clock and protocol types, so both
 *  the server and the browser views share it. */
import type { TimerSummary } from '../server/chat/protocol'
import { shortTime } from './clock'

/** The five wake intervals, in display order; 60 is the default. There is no
 *  off position: Hold on the Manager, or Hold all timers, stops the wake-up. */
export const WAKE_OPTIONS = [60, 30, 15, 10, 5] as const
export type WakeMinutes = typeof WAKE_OPTIONS[number]

export interface ManagerWake { everyMinutes: WakeMinutes, revision: number }

export interface ManagerWakeView extends ManagerWake {
  /** The one wake timer, or null when there is none. The wake-up never trips. */
  timer: { id: string, state: 'active' | 'held', reason?: string, nextAt: string,
    waitingFor?: NonNullable<TimerSummary['pending']>['waitingFor'] } | null
  /** Why there is no wake timer: no Manager yet, or O2 (`/manager` without
   *  text, or its file unreadable). Null when the timer exists. */
  pendingOn: 'manager' | 'charter' | null
  /** The latest failed wake turn, cleared by a success. */
  lastFailure: { at: string, error: string } | null
  /** Wake turns admitted in the last 24 hours, counted separately. */
  wakesLast24h: number
}

export function parseManagerWake(value: unknown): ManagerWake | null {
  if (!value || typeof value !== 'object') return null
  const data = value as ManagerWake
  return (WAKE_OPTIONS as readonly number[]).includes(data.everyMinutes)
    && Number.isSafeInteger(data.revision) && data.revision >= 0
    ? { everyMinutes: data.everyMinutes, revision: data.revision } : null
}

/** Wake turns a day at the interval: 24, 48, 96, 144 and 288. */
export function wakeTurnsPerDay(minutes: WakeMinutes): number {
  return 1440 / minutes
}

/** A #354 wait cause in the Timers pane's words. The wake-up never backs
 *  off, so `backoff` keeps the pane's fallback line. */
function wakeWaitLine(waitingFor: NonNullable<NonNullable<TimerSummary['pending']>['waitingFor']>,
  queuedBehind?: string | null): string {
  switch (waitingFor) {
    case 'starting': case 'running': case 'stopping': return `waiting: chat is ${waitingFor}`
    case 'queued': return `waiting: chat is queued${queuedBehind ? ` (${queuedBehind})` : ''}`
    case 'waiting': return 'waiting: chat is waiting for an answer or permission'
    case 'maintenance': return 'waiting: chat is resetting or compacting'
    case 'queue': return 'waiting for queued tasks'
    case 'reopening': return 'waiting: reopening the chat'
    case 'model': return 'waiting: choose a model for the Manager'
    case 'person': return 'waiting: you were just here'
    case 'update': return 'waiting: Poise is updating'
    case 'backoff': return 'waiting: retry after a while'
  }
}

/** The header's and Settings' status line for a wake view, on Chat's clock:
 *  the day's cost, then the state. A hold reads before a past failure: the
 *  failure resurfaces once the wake-up resumes and until one succeeds. */
export function wakeStatusText(view: ManagerWakeView, timeZone: string, now: number): string {
  const cost = `Up to ${wakeTurnsPerDay(view.everyMinutes)} turns a day`
  const timer = view.timer
  if (timer?.state === 'held') {
    if (timer.reason === 'person_stopped') return 'On hold: you stopped the Manager'
    if (timer.reason === 'person_held') return 'On hold: you put the Manager on hold'
    return 'On hold: all timers are on hold'
  }
  if (view.lastFailure && timer) {
    return `${cost} · last wake-up failed at ${shortTime(view.lastFailure.at, timeZone, now)}: ${view.lastFailure.error} · next ${shortTime(timer.nextAt, timeZone, now)}`
  }
  if (timer) {
    if (timer.waitingFor) return `${cost} · due now · ${wakeWaitLine(timer.waitingFor)}`
    return `${cost} · next ${shortTime(timer.nextAt, timeZone, now)}`
  }
  if (view.pendingOn === 'charter') return `${cost} · wake-ups start when the /manager snippet has text`
  return `${cost} · wake-ups start when you create a Manager`
}
