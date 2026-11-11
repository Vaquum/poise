// How much of Answer here to show (#556, Overview's level). The place and the
// bell in the top bar both read it, so the bell's number is always what the
// level shows: on Overview its own entries, elsewhere the notices themselves.
import { store } from '../../dom'
import type { NoticeKind } from '../../../notices'

/** Who acts, in the order the list shows them. */
export type Group = 'needs-you' | 'fault' | 'ready' | 'auto'

export const GROUPS: readonly (readonly [Group, string, string])[] = [
  ['needs-you', 'Needs you', 'What only you can do.'],
  ['fault', 'Poise faults', 'Poise itself needs repair.'],
  ['ready', 'Done', 'Finished, for you to see.'],
  ['auto', 'Handled automatically', 'Poise is retrying; there is nothing to do.'],
]

/** Each level includes the ones before it: [name, gloss]. */
export const LEVELS: readonly (readonly [string, string])[] = [
  ['Only you', 'Only what needs you'],
  ['+ Faults', 'What needs you, and Poise faults'],
  ['+ Done', 'Also what has finished. The bell counts this'],
  ['Everything', 'Also what Poise handles on its own'],
]

export const LEVEL_KEY = 'poise-overview-level'
export const DEFAULT_LEVEL = 2

export function readLevel(): number {
  const value = Number(store.get<unknown>(LEVEL_KEY, DEFAULT_LEVEL))
  return Number.isInteger(value) && value >= 0 && value < LEVELS.length ? value : DEFAULT_LEVEL
}

export const groupRank = (group: Group): number => GROUPS.findIndex(([key]) => key === group)
export const shownAt = (group: Group, level: number): boolean => groupRank(group) <= level

// The notices' groups follow #556's mapping (Design → Vocabulary): main's
// Ready is Done, a pull request ready to merge needs you because green means
// Done, and only Poise's own failures are faults.
const NOTICE_GROUPS: Record<NoticeKind, Group> = {
  chat_waiting: 'needs-you',
  sign_in_needed: 'needs-you',
  behavior_held: 'needs-you',
  datastore_sync_failing: 'needs-you',
  storage_low: 'needs-you',
  github_quota_warning: 'needs-you',
  action_needed: 'needs-you',
  pr_ready: 'needs-you',
  review_requested: 'needs-you',
  pr_conflict: 'needs-you',
  worker_idle: 'needs-you',
  github_quota_exhausted: 'fault',
  read_failed: 'fault',
  action_failed: 'fault',
  ledger_queue_stalled: 'fault',
  ledger_capture_loss: 'fault',
  chat_turn_finished: 'ready',
  action_finished: 'ready',
}

export function noticeGroup(kind: NoticeKind): Group {
  return NOTICE_GROUPS[kind]
}

export interface Tally { count: number, tone: '' | 'failed' | 'needs-you' | 'done' }

/** What the level shows, never what Poise handles on its own, in the colour
 *  of the most urgent: a fault, then what needs you, then what is done. */
export function tally(groups: readonly Group[], level: number): Tally {
  const shown = groups.filter((group) => group !== 'auto' && shownAt(group, level))
  const tone = shown.includes('fault') ? 'failed' : shown.includes('needs-you') ? 'needs-you' : shown.length ? 'done' : ''
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
// requests, decisions and threads included; elsewhere the bell counts notices.
let answerGroups: (() => readonly Group[]) | null = null

export function setAnswerGroups(source: (() => readonly Group[]) | null): void {
  answerGroups = source
  changed()
}

/** Overview's entries changed: the bell counts again. */
export function answersChanged(): void {
  if (answerGroups) changed()
}

export function bellTally(notices: readonly { kind: NoticeKind }[]): Tally {
  return tally(answerGroups ? answerGroups() : notices.map((notice) => noticeGroup(notice.kind)), readLevel())
}
