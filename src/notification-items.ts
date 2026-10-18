// What the notification rail lists (src/views/notification-rail.ts): the
// notices (src/notices.ts) and Behaviors' diagnostics (src/behavior-diagnostics.ts)
// as one list, grouped by who acts. A failed behavior's notice and its
// diagnostic are one entry: the notice carries what can be done about it, the
// diagnostic what happened and how Behaviors classifies it.

import { BEHAVIORS, type BehaviorDiagnostics } from './behaviors'
import { behaviorDiagnosticGroups, targetRef, type DiagnosticEntry } from './behavior-diagnostics'
import type { DiagnosticSeverity } from './behavior-failure-cause'
import { standingFor, type Notice, type NoticeKind, type NoticeSubject, type NoticeTarget } from './notices'

export type ItemGroup = 'needs' | 'faults' | 'ready' | 'auto'
export type ItemTone = 'blue' | 'amber' | 'red' | 'green' | 'teal' | 'slate'
export type ItemIcon = 'chat' | 'key' | 'held' | 'sync' | 'merge' | 'check' | 'fault' | 'retry'

/** The groups in the order the rail shows them: what needs the person first. */
export const GROUPS: readonly { key: ItemGroup, label: string, short: string, note: string }[] = [
  { key: 'needs', label: 'Needs you', short: 'Needs you', note: 'Only you can do these.' },
  { key: 'faults', label: 'Poise faults', short: 'Faults', note: 'Poise needs repair.' },
  { key: 'ready', label: 'Ready', short: 'Ready', note: 'Done and waiting for you.' },
  { key: 'auto', label: 'Handled automatically', short: 'Automatic', note: 'Poise is retrying. Nothing to do.' },
]

export interface NotificationItem {
  /** A notice's id, or `diagnostic:` and its group's identity: stable across reads. */
  id: string
  group: ItemGroup
  tone: ItemTone
  icon: ItemIcon
  title: string
  body: string
  /** Where it comes from and what it is about. */
  source: string
  scope: string | null
  /** When it began, or for a diagnostic when it last happened, when known. */
  when: string | null
  /** A ready pull request's reminder: "for 16 min". */
  meta: string
  /** What happened, as Behaviors' diagnostics record it. */
  details: DiagnosticEntry[]
  /** The behaviors it is about. */
  behaviors: string[]
  /** The notice behind it, which can be opened, put away or silenced. */
  notice: Notice | null
}

export type ItemCounts = Record<ItemGroup, number> & { open: number }

const NOTICE_LOOK: Record<NoticeKind, { group: ItemGroup, tone: ItemTone, icon: ItemIcon, source: string }> = {
  read_failed: { group: 'faults', tone: 'red', icon: 'fault', source: 'Data' },
  chat_waiting: { group: 'needs', tone: 'blue', icon: 'chat', source: 'Chat' },
  sign_in_needed: { group: 'needs', tone: 'amber', icon: 'key', source: 'Accounts' },
  behavior_held: { group: 'needs', tone: 'amber', icon: 'held', source: 'Behaviors' },
  datastore_sync_failing: { group: 'needs', tone: 'amber', icon: 'sync', source: 'GitHub data' },
  storage_low: { group: 'needs', tone: 'amber', icon: 'held', source: 'Storage' },
  pr_ready: { group: 'ready', tone: 'green', icon: 'merge', source: 'GitHub' },
  chat_turn_finished: { group: 'ready', tone: 'teal', icon: 'check', source: 'Chat' },
  github_quota_warning: { group: 'needs', tone: 'amber', icon: 'held', source: 'GitHub API' },
  github_quota_exhausted: { group: 'faults', tone: 'red', icon: 'fault', source: 'GitHub API' },
}

// Colour says who can correct a condition (src/behavior-failure-cause.ts):
// red is Poise's to repair, amber the person's, grey Poise is already on it.
const SEVERITY_LOOK: Record<DiagnosticSeverity, { group: ItemGroup, tone: ItemTone, icon: ItemIcon }> = {
  error: { group: 'faults', tone: 'red', icon: 'fault' },
  warning: { group: 'needs', tone: 'amber', icon: 'held' },
  info: { group: 'auto', tone: 'slate', icon: 'retry' },
}
const SEVERITY_RANK: Record<DiagnosticSeverity, number> = { info: 0, warning: 1, error: 2 }
const GROUP_RANK: Record<ItemGroup, number> = { needs: 0, faults: 1, ready: 2, auto: 3 }

const behaviorLabel = (key: string) => BEHAVIORS.find((behavior) => behavior.key === key)?.label ?? key

/** A reminder says how long its condition has stood; a first showing says nothing more. */
export function noticeMeta(notice: Notice, now: number): string {
  return notice.kind === 'pr_ready' && Date.parse(notice.due) > Date.parse(notice.since)
    ? `for ${standingFor(notice.since, now)}`
    : ''
}

/** What a notice's open button says, or null when there is nothing to open:
 *  a failed behavior without a recorded run is explained in the rail itself. */
export function openLabel(target: NoticeTarget): string | null {
  if ('view' in target) return null
  if ('swarm' in target) return 'Open the run in Swarm'
  if ('settings' in target) return target.settings === 'accounts' ? 'Open Settings, Accounts' : 'Open Settings'
  if ('chat' in target) return 'Open the session'
  return 'Open on GitHub'
}

function concerns(entry: DiagnosticEntry, subject: NoticeSubject): boolean {
  return entry.behavior === subject.behavior && entry.target !== null
    && (entry.target === subject.target || targetRef(entry.target) === targetRef(subject.target))
}

function latest(entries: readonly DiagnosticEntry[]): string | null {
  let best: string | null = null
  for (const entry of entries) {
    if (entry.at && Number.isFinite(Date.parse(entry.at)) && (best === null || Date.parse(entry.at) > Date.parse(best))) best = entry.at
  }
  return best
}

/** The rail's list: notices first within each group, in the server's order,
 *  then the diagnostics no notice already shows. */
export function notificationItems(notices: readonly Notice[], diagnostics: BehaviorDiagnostics | null, now: number): NotificationItem[] {
  const groups = diagnostics ? behaviorDiagnosticGroups(diagnostics) : []
  const items: NotificationItem[] = notices.map((notice) => {
    const item: NotificationItem = {
      id: notice.id, ...NOTICE_LOOK[notice.kind], title: notice.title, body: notice.body,
      scope: notice.subject?.target ?? null, when: notice.since, meta: noticeMeta(notice, now),
      details: [], behaviors: notice.subject ? [notice.subject.behavior] : [], notice,
    }
    const subject = notice.subject
    if (!subject) return item
    let strongest: DiagnosticSeverity | null = null
    let message = ''
    for (const group of groups) {
      const mine = group.entries.filter((entry) => concerns(entry, subject))
      if (!mine.length) continue
      item.details.push(...mine)
      group.entries = group.entries.filter((entry) => !mine.includes(entry))
      if (strongest === null || SEVERITY_RANK[group.severity] > SEVERITY_RANK[strongest]) {
        strongest = group.severity
        message = group.message
      }
    }
    if (strongest !== null) Object.assign(item, SEVERITY_LOOK[strongest], { body: message })
    return item
  })
  for (const group of groups) {
    // A group whose every line a notice already shows says nothing more.
    if (!group.entries.length) continue
    const behaviors = [...new Set(group.entries.flatMap((entry) => entry.behavior ? [entry.behavior] : []))]
    items.push({
      id: `diagnostic:${JSON.stringify([group.code, group.scope, group.message])}`,
      ...SEVERITY_LOOK[group.severity], title: group.message, body: behaviors.map(behaviorLabel).join(', '),
      source: 'Behaviors', scope: group.scope, when: latest(group.entries), meta: '',
      details: group.entries, behaviors, notice: null,
    })
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => GROUP_RANK[a.item.group] - GROUP_RANK[b.item.group] || a.index - b.index)
    .map(({ item }) => item)
}

export function countItems(items: readonly NotificationItem[]): ItemCounts {
  const counts: ItemCounts = { needs: 0, faults: 0, ready: 0, auto: 0, open: 0 }
  for (const item of items) counts[item.group] += 1
  counts.open = counts.needs + counts.faults + counts.ready
  return counts
}

/** The bell's colour: the most serious open group, or null with nothing open. */
export function headTone(counts: ItemCounts): ItemTone | null {
  return counts.faults ? 'red' : counts.needs ? 'amber' : counts.ready ? 'green' : null
}

export function behaviorCounts(items: readonly NotificationItem[], behavior: string): ItemCounts {
  return countItems(items.filter((item) => item.behaviors.includes(behavior)))
}
