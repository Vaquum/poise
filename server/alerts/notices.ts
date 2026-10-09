// Notices: the notifications the page shows at its top, one at a time, the
// most pressing first (src/views/notice-island.ts). Each is an unresolved
// alert the person has not put away.
//
// The person's own pull requests are checked here for being ready to merge. A
// ready one alerts once when it becomes ready, which Poise Link shows too, and
// its notice comes back every 15 minutes until it is merged, stops being
// ready, or the person silences it.
//
// Settings → General → Notifications turns this off: the page shows nothing
// and nothing here checks GitHub. Poise Link's other alerts go on as before.

import { listBehaviorIncidents } from '../db'
import { readOwnPullRequests, type OwnPullRequest } from '../gh'
import { HttpError } from '../http'
import { getNotificationSettings } from '../settings'
import {
  alertKind, alertSeq, dismissAlert, openAlerts, raiseAlert, resolveAlert, silenceAlert, silenced,
  type AlertKind, type AlertTarget, type OpenAlert,
} from './store'

/** How often a ready pull request is noticed again. */
export const REMINDER_INTERVAL_MS = 15 * 60_000
/** A finished Chat turn is news for an hour; after that, Chat itself says it. */
export const EVENT_NOTICE_MS = 60 * 60_000
/** How often the person's pull requests are checked for being ready to merge.
 *  Each check asks GitHub about every one of them as the agent account, which
 *  behaviors also use, so this stays slower than Current's minute. */
export const READY_CHECK_INTERVAL_MS = 2 * 60_000
/** A server that has just started, as it does on every update, settles first. */
export const FIRST_CHECK_DELAY_MS = 15_000
/** Incidents read to decide which failed-behavior alerts have cleared. */
const INCIDENT_READ_LIMIT = 500

// The most pressing first: someone is blocked on the person, then work that
// cannot run, then work that failed, then what waits for them.
const ORDER: readonly AlertKind[] = ['chat_waiting', 'sign_in_needed', 'behavior_held', 'datastore_sync_failing', 'pr_ready', 'chat_turn_finished']
const SILENCEABLE: ReadonlySet<AlertKind> = new Set(['pr_ready'])

export interface Notice {
  id: string
  kind: AlertKind
  title: string
  body: string
  /** When the condition began; for a ready pull request, when it became ready. */
  since: string
  /** When this showing became due: `since`, or the latest reminder. */
  due: string
  /** Whether the person can ask to hear no more about it. */
  silenceable: boolean
  /** Where the notice opens; null when it only informs. */
  target: AlertTarget | null
}

export interface NoticesState {
  enabled: boolean
  notices: Notice[]
}

/** When `alert`'s notice became due, or null when it is not to be shown now. */
function dueAt(alert: OpenAlert, now: number): number | null {
  const since = Date.parse(alert.createdAt)
  const dismissed = alert.dismissedAt === null ? null : Date.parse(alert.dismissedAt)
  if (alert.kind === 'pr_ready') {
    if (alert.silencedAt !== null) return null
    const due = since + Math.max(0, Math.floor((now - since) / REMINDER_INTERVAL_MS)) * REMINDER_INTERVAL_MS
    return dismissed !== null && dismissed >= due ? null : due
  }
  if (dismissed !== null) return null
  if (alert.kind === 'chat_turn_finished' && now - since >= EVENT_NOTICE_MS) return null
  return since
}

/** What the page shows now, the most pressing first. */
export function noticesState(now = Date.now()): NoticesState {
  if (!getNotificationSettings().enabled) return { enabled: false, notices: [] }
  const notices = openAlerts({ now }).flatMap((alert): Notice[] => {
    const due = dueAt(alert, now)
    if (due === null) return []
    return [{
      id: alert.id,
      kind: alert.kind,
      title: alert.title,
      body: alert.body,
      since: alert.createdAt,
      due: new Date(due).toISOString(),
      silenceable: SILENCEABLE.has(alert.kind),
      target: alert.target,
    }]
  })
  // Within a kind, the one that most recently came due leads.
  notices.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.due.localeCompare(a.due))
  return { enabled: true, notices }
}

function storedSeq(id: string): number {
  const seq = typeof id === 'string' ? alertSeq(id) : null
  if (seq === null) throw new HttpError(404, 'There is no such notification.')
  return seq
}

/** The person put a notice away: for good, or for a ready pull request until
 *  its next reminder. */
export function dismissNotice(id: string, now = Date.now()): void {
  if (!dismissAlert(storedSeq(id), now)) throw new HttpError(404, 'That notification has already cleared.')
}

/** The person asked to hear no more about a ready pull request, until it is
 *  merged or closed. */
export function silenceNotice(id: string, now = Date.now()): void {
  const seq = storedSeq(id)
  const kind = alertKind(seq)
  if (kind === null) throw new HttpError(404, 'There is no such notification.')
  if (!SILENCEABLE.has(kind)) throw new HttpError(400, 'Only a pull request ready to merge can be silenced; dismiss this notification instead.')
  if (!silenceAlert(seq, now)) throw new HttpError(404, 'That notification has already cleared.')
}

const READY_PREFIX = 'pr-ready:'
const readyKey = (pr: Pick<OwnPullRequest, 'repo' | 'number'>) => `${READY_PREFIX}${pr.repo}#${pr.number}`

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/** Raises an alert for each of the person's own pull requests that has become
 *  ready to merge, and resolves those that have stopped being ready, were
 *  merged or closed, or belong to an account Poise no longer follows. A pull
 *  request GitHub could not be asked about, or whose account could not be read
 *  just now, keeps what it had. */
export async function checkReadyPullRequests(
  read: typeof readOwnPullRequests = readOwnPullRequests,
  now = () => Date.now(),
): Promise<void> {
  const { pullRequests, read: listed, tracked } = await read()
  const open = new Set<string>()
  for (const pr of pullRequests) {
    const dedupeKey = readyKey(pr)
    open.add(dedupeKey)
    if (pr.status === undefined) continue
    if (pr.status !== 'green') {
      resolveAlert(dedupeKey, now())
      continue
    }
    // Silenced stays silenced while the pull request is open, ready or not.
    if (silenced(dedupeKey)) continue
    raiseAlert({
      kind: 'pr_ready',
      dedupeKey,
      title: `${pr.repo}#${pr.number} is ready to merge`,
      body: clip(pr.title, 160),
      path: '/',
      target: { pullRequest: `https://github.com/${pr.repo}/pull/${pr.number}` },
    }, now())
  }
  const complete = new Set(listed.map((login) => login.toLowerCase()))
  const followed = new Set(tracked.map((login) => login.toLowerCase()))
  for (const alert of openAlerts({ kind: 'pr_ready', now: now() })) {
    if (open.has(alert.dedupeKey)) continue
    const owner = alert.dedupeKey.slice(READY_PREFIX.length).split('/')[0].toLowerCase()
    // Missing from a complete list: merged or closed. Missing because its
    // account is starting or failed to read: not known yet.
    if (followed.has(owner) && !complete.has(owner)) continue
    resolveAlert(alert.dedupeKey, now())
  }
}

/** Resolves each failed-behavior alert whose incident the Behaviors view no
 *  longer shows: retried, recovered or retired. A later failure alerts again. */
export function retireClearedBehaviorAlerts(now = Date.now()): void {
  const alerts = openAlerts({ kind: 'behavior_held', now })
  if (alerts.length === 0) return
  const incidents = listBehaviorIncidents(INCIDENT_READ_LIMIT)
  // A read cut short could leave out an incident that still stands.
  if (incidents.length >= INCIDENT_READ_LIMIT) return
  const standing = new Set(incidents.map((incident) => `behavior-held:${incident.behavior}:${incident.target}`))
  for (const alert of alerts) {
    if (!standing.has(alert.dedupeKey)) resolveAlert(alert.dedupeKey, now)
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let firstCheck: ReturnType<typeof setTimeout> | null = null
let pass: Promise<void> | null = null

/** One pass, unless one is already running or notifications are off. */
export function checkNotices(read: typeof readOwnPullRequests = readOwnPullRequests): Promise<void> {
  if (pass) return pass
  if (!getNotificationSettings().enabled) return Promise.resolve()
  pass = (async () => {
    try {
      retireClearedBehaviorAlerts()
      await checkReadyPullRequests(read)
    } catch (error) {
      console.error('[notices] could not check what needs attention:', error)
    } finally {
      pass = null
    }
  })()
  return pass
}

export function startNoticesRuntime(): void {
  if (timer) return
  timer = setInterval(() => { void checkNotices() }, READY_CHECK_INTERVAL_MS)
  timer.unref?.()
  firstCheck = setTimeout(() => { void checkNotices() }, FIRST_CHECK_DELAY_MS)
  firstCheck.unref?.()
}

export async function stopNoticesRuntime(): Promise<void> {
  if (timer) clearInterval(timer)
  if (firstCheck) clearTimeout(firstCheck)
  timer = null
  firstCheck = null
  await pass
}
