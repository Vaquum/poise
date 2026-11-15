// How much of Answer here to show (#556, Overview's level). The place and the
// bell in the top bar both read it, so the bell's number is always what the
// level shows: on Overview its own entries, elsewhere the same sources (away.ts).
import { store } from '../../dom'
import type { NoticeKind } from '../../../notices'

/** Who acts, in the order the list shows them. Finished work is not listed. */
export type Group = 'needs-you' | 'fault' | 'auto'

export const GROUPS: readonly (readonly [Group, string, string])[] = [
  ['needs-you', 'Only you', 'Nothing moves until you act.'],
  ['fault', 'Faults', 'Stuck: broken, or not moved in 4 hours.'],
  ['auto', 'Handled automatically', 'What Poise is handling and what it has observed.'],
]

/** Each level includes the ones before it: [name, gloss]. */
export const LEVELS: readonly (readonly [string, string])[] = [
  ['Only you', 'Only what waits on you: nothing moves until you act'],
  ['+ Faults', 'Also what is stuck: broken, or not moved in 4 hours'],
  ['Everything', 'Also what Poise is handling on its own'],
]

/** Automatic work that has not moved for this long is stuck: a fault. */
export const STUCK_MS = 4 * 60 * 60 * 1000

export const LEVEL_KEY = 'poise-overview-show'
/** The four-level key before Done left the list: Only you, + Faults, + Done, Everything. */
const OLD_LEVEL_KEY = 'poise-overview-level'
export const DEFAULT_LEVEL = 1

export function readLevel(): number {
  const saved = store.get<unknown>(LEVEL_KEY, null)
  // + Done showed what + Faults shows now; Everything moved up by one.
  const value = saved === null ? [0, 1, 1, 2][Number(store.get<unknown>(OLD_LEVEL_KEY, DEFAULT_LEVEL))] ?? DEFAULT_LEVEL : Number(saved)
  return Number.isInteger(value) && value >= 0 && value < LEVELS.length ? value : DEFAULT_LEVEL
}

export const groupRank = (group: Group): number => GROUPS.findIndex(([key]) => key === group)
export const shownAt = (group: Group, level: number): boolean => groupRank(group) <= level

// Requests use the live Chat feed. Server notices are for the owner only
// when they name a sign-in or a formal GitHub review request.
const NOTICE_GROUPS: Record<NoticeKind, Group | null> = {
  chat_waiting: null,
  sign_in_needed: 'needs-you',
  review_requested: 'needs-you',
  storage_low: 'fault',
  action_needed: 'fault',
  action_failed: 'fault',
  pr_ready: 'auto',
  pr_conflict: 'fault',
  worker_idle: null,
  behavior_held: 'fault',
  ledger_queue_stalled: 'fault',
  ledger_capture_loss: 'fault',
  datastore_sync_failing: 'auto',
  github_quota_warning: 'auto',
  github_quota_exhausted: 'auto',
  read_failed: 'auto',
  behavior_metrics_incomplete: 'fault',
  chat_turn_finished: null,
  action_finished: null,
}

export function noticeGroup(kind: NoticeKind): Group | null {
  return NOTICE_GROUPS[kind]
}

export interface Tally { count: number, tone: '' | 'failed' | 'needs-you' }

/** What the level shows, never what Poise handles on its own, in the colour
 *  of the most urgent: a fault, then what waits on you. */
export function tally(groups: readonly Group[], level: number): Tally {
  const shown = groups.filter((group) => group !== 'auto' && shownAt(group, level))
  const tone = shown.includes('fault') ? 'failed' : shown.length ? 'needs-you' : ''
  return { count: shown.length, tone }
}

const listeners = new Set<() => void>()
const changed = (): void => { for (const listener of listeners) listener() }

/** Hears the level and Overview's entries change. */
export function onBellChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function saveLevel(level: number): void {
  store.set(LEVEL_KEY, level)
  changed()
}

// While Overview is mounted it hands over its open entries' groups, chat
// requests and decisions included; elsewhere away.ts reads them.
let answerGroups: (() => readonly Group[]) | null = null

export const onOverview = (): boolean => answerGroups !== null

export function setAnswerGroups(source: (() => readonly Group[]) | null): void {
  answerGroups = source
  changed()
}

/** Overview's entries changed: the bell counts again. */
export function answersChanged(): void {
  if (answerGroups) changed()
}

export function bellTally(away: () => readonly Group[]): Tally {
  return tally(answerGroups ? answerGroups() : away(), readLevel())
}
