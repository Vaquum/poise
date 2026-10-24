// Notices: the notifications the page's notification rail lists, the most
// pressing first (src/views/notification-rail.ts). Each is an unresolved alert
// the person has not put away.
//
// The person's own pull requests are checked here for being ready to merge. A
// ready one alerts once when it becomes ready, which Poise Link shows too, and
// its notice comes back every 15 minutes until it is merged, stops being
// ready, or the person silences it.
//
// Settings → General → Notifications turns this off: the page shows nothing
// and nothing here checks GitHub. Poise Link's other alerts go on as before.

import type { EvidenceAttachment } from '../../gateway/src/diagnostics/evidence-contract'
import { GITHUB_AUTOMATION_SIGN_IN_TITLE } from '../accounts/types'
import { getBehaviorIncident, listBehaviorIncidents } from '../db'
import { readInvolvedPullRequests, readOwnPullRequests, type InvolvedPullRequest, type OwnPullRequest } from '../gh'
import { HttpError } from '../http'
import { getOrganizations } from '../organizations'
import { getNotificationSettings } from '../settings'
import {
  alertKind, alertRow, alertSeq, dismissAlert, forgetSilence, openAlerts, raiseAlert, resolveAlert, silenceAlert, silenced, silencedKeys,
  type AlertKind, type AlertTarget, type OpenAlert,
} from './store'
import { recordHandling, type HandlingActor } from './handling'

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
const ORDER: readonly AlertKind[] = ['chat_waiting', 'sign_in_needed', 'github_quota_exhausted', 'storage_low', 'github_quota_warning', 'behavior_held', 'review_requested', 'pr_conflict', 'ledger_queue_stalled', 'ledger_capture_loss', 'datastore_sync_failing', 'pr_ready', 'chat_turn_finished']
const SILENCEABLE: ReadonlySet<AlertKind> = new Set(['pr_ready', 'review_requested'])

export interface Notice extends EvidenceAttachment {
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
  /** A failed behavior's behavior and target, as Behaviors' diagnostics name
   *  them, so the page can show the notice and its diagnostic as one. */
  subject?: { behavior: string, target: string }
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
  if (alert.silencedAt !== null && SILENCEABLE.has(alert.kind)) return null
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
    // A notice may outlive the incident list's first page. Look up its exact
    // current incident, including alerts recorded before Swarm navigation.
    const held = alert.kind === 'behavior_held' ? /^behavior-held:([^:]+):(.+)$/.exec(alert.dedupeKey) : null
    const incident = held ? getBehaviorIncident(held[1], held[2]) : null
    const target: AlertTarget | null = incident?.callId ? { swarm: incident.callId } : alert.target
    return [{
      id: alert.id,
      kind: alert.kind,
      title: alert.kind === 'sign_in_needed' && alert.dedupeKey === 'sign-in:gh:agent'
        ? GITHUB_AUTOMATION_SIGN_IN_TITLE : alert.title,
      body: target && 'swarm' in target ? 'Open it in Poise to see what happened.' : alert.body,
      since: alert.createdAt,
      due: new Date(due).toISOString(),
      silenceable: SILENCEABLE.has(alert.kind),
      target,
      ...(held ? { subject: { behavior: held[1], target: held[2] } } : {}),
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
 *  its next reminder. The dismissal is handled even while the condition
 *  continues; a later clearing records another row. Each dismissal carries
 *  its own time in its ref, so dismissing a later reminder of the same
 *  alert records its own row instead of colliding with the first. */
export function dismissNotice(id: string, now = Date.now()): void {
  const seq = storedSeq(id)
  const row = alertRow(seq)
  if (!dismissAlert(seq, now)) throw new HttpError(404, 'That notification has already cleared.')
  if (row) {
    const at = new Date(now).toISOString()
    recordHandling({ kind: 'notice', source: row.kind, title: row.title, startedAt: row.createdAt,
      finishedAt: at, outcome: 'dismissed', actor: 'person', ref: `alert:${seq}:dismissed:${at}` }, at)
  }
}

/** The person asked to hear no more about a ready pull request, until it is
 *  merged or closed, or about a requested review, until the request is gone:
 *  the checks forget the silence then. */
export function silenceNotice(id: string, now = Date.now(), actor: HandlingActor = 'person'): void {
  const seq = storedSeq(id)
  const kind = alertKind(seq)
  if (kind === null) throw new HttpError(404, 'There is no such notification.')
  if (!SILENCEABLE.has(kind)) throw new HttpError(400, 'Only a pull request ready to merge or asking for your review can be silenced; dismiss this notification instead.')
  const row = alertRow(seq)
  if (!silenceAlert(seq, now)) throw new HttpError(404, 'That notification has already cleared.')
  if (row) {
    const at = new Date(now).toISOString()
    recordHandling({ kind: 'notice', source: row.kind, title: row.title, startedAt: row.createdAt,
      finishedAt: at, outcome: 'silenced', actor, ref: `alert:${seq}:silenced:${at}` }, at)
  }
}

const READY_PREFIX = 'pr-ready:'
const readyKey = (pr: Pick<OwnPullRequest, 'repo' | 'number'>) => `${READY_PREFIX}${pr.repo}#${pr.number}`

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

/** The accounts followed right now, read at raise time: a pass that read
 *  its lists before an account was unfollowed must not raise that
 *  account's alerts from its stale read after the removal resolved them. */
function followedNow(): Set<string> {
  return new Set(getOrganizations().map((org) => org.login.toLowerCase()))
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
  // Turned off while GitHub was being asked: nothing more is noticed, on the desktop either.
  if (!getNotificationSettings().enabled) return
  const followed = followedNow()
  const open = new Set<string>()
  for (const pr of pullRequests) {
    // Unfollowed after this pass read its lists: never raised from the
    // stale read. The removal already resolved what stood.
    if (!followed.has(pr.repo.split('/')[0].toLowerCase())) continue
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
  resolveMissing('pr_ready', READY_PREFIX, open, listed, tracked, now())
}

/** Resolves the kind's alerts missing from their read, and forgets their
 *  silences. Missing from a complete list: merged, closed, or out of scope.
 *  Missing because its account is starting or failed to read: not known yet. */
function resolveMissing(kind: AlertKind, prefix: string, open: Set<string>, listed: string[], tracked: string[], now: number): void {
  const complete = new Set(listed.map((login) => login.toLowerCase()))
  const followed = new Set(tracked.map((login) => login.toLowerCase()))
  const gone = (dedupeKey: string) => {
    if (open.has(dedupeKey)) return false
    const owner = dedupeKey.slice(prefix.length).split('/')[0].toLowerCase()
    return !followed.has(owner) || complete.has(owner)
  }
  for (const alert of openAlerts({ kind, now })) {
    if (gone(alert.dedupeKey)) resolveAlert(alert.dedupeKey, now)
  }
  for (const dedupeKey of silencedKeys(prefix)) {
    if (gone(dedupeKey)) forgetSilence(dedupeKey)
  }
}

const REVIEW_PREFIX = 'review-requested:'
const reviewKey = (pr: Pick<InvolvedPullRequest, 'repo' | 'number'>) => `${REVIEW_PREFIX}${pr.repo}#${pr.number}`

/** Raises an alert for each involved open pull request that currently asks
 *  your GitHub account to review it, whoever authored it. One per pull
 *  request, as fresh as the datastore sync.
 *
 *  A request resolves only on an authoritative read without it: GitHub drops
 *  the request when you submit a review, so that resolves too. A failed or
 *  incomplete read keeps what it had. A request made again after removal
 *  raises anew, and silence lasts until the request is removed. */
export async function checkReviewRequests(
  read: typeof readInvolvedPullRequests = readInvolvedPullRequests,
  now = () => Date.now(),
): Promise<void> {
  const { pullRequests, read: listed, tracked } = await read()
  if (!getNotificationSettings().enabled) return
  const followed = followedNow()
  const open = new Set<string>()
  for (const pr of pullRequests) {
    if (!followed.has(pr.repo.split('/')[0].toLowerCase())) continue
    const dedupeKey = reviewKey(pr)
    open.add(dedupeKey)
    if (pr.reviewRequested === null) continue
    if (pr.reviewRequested === false) {
      resolveAlert(dedupeKey, now())
      forgetSilence(dedupeKey)
      continue
    }
    if (silenced(dedupeKey)) continue
    raiseAlert({
      kind: 'review_requested',
      dedupeKey,
      title: `${pr.repo}#${pr.number} requests your review`,
      body: clip(pr.title, 160),
      path: '/',
      target: { pullRequest: `https://github.com/${pr.repo}/pull/${pr.number}` },
    }, now())
  }
  resolveMissing('review_requested', REVIEW_PREFIX, open, listed, tracked, now())
}

const CONFLICT_PREFIX = 'pr-conflict:'
const conflictKey = (pr: Pick<OwnPullRequest, 'repo' | 'number'>) => `${CONFLICT_PREFIX}${pr.repo}#${pr.number}`

/** Raises an alert for each of the person's own open pull requests whose
 *  held reasons include a conflict, from the same check that colours it. */
export async function checkConflictPullRequests(
  read: typeof readOwnPullRequests = readOwnPullRequests,
  now = () => Date.now(),
): Promise<void> {
  const { pullRequests, read: listed, tracked } = await read()
  if (!getNotificationSettings().enabled) return
  const followed = followedNow()
  const open = new Set<string>()
  for (const pr of pullRequests) {
    if (!followed.has(pr.repo.split('/')[0].toLowerCase())) continue
    const dedupeKey = conflictKey(pr)
    open.add(dedupeKey)
    if (pr.status === undefined) continue
    if (!pr.held.reasons.includes('conflict')) {
      resolveAlert(dedupeKey, now())
      continue
    }
    raiseAlert({
      kind: 'pr_conflict',
      dedupeKey,
      title: `${pr.repo}#${pr.number} has a merge conflict`,
      body: clip(pr.title, 160),
      path: '/',
      target: { pullRequest: `https://github.com/${pr.repo}/pull/${pr.number}` },
    }, now())
  }
  resolveMissing('pr_conflict', CONFLICT_PREFIX, open, listed, tracked, now())
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

async function runPass(read: typeof readOwnPullRequests, involved: typeof readInvolvedPullRequests): Promise<void> {
  try {
    retireClearedBehaviorAlerts()
    await checkReadyPullRequests(read)
    await checkReviewRequests(involved)
    await checkConflictPullRequests(read)
  } catch (error) {
    console.error('[notices] could not check what needs attention:', error)
  }
}

/** One pass, unless one is already running or notifications are off. */
export function checkNotices(
  read: typeof readOwnPullRequests = readOwnPullRequests,
  involved: typeof readInvolvedPullRequests = readInvolvedPullRequests,
): Promise<void> {
  if (pass) return pass
  if (!getNotificationSettings().enabled) return Promise.resolve()
  // Cleared once settled, never before it is recorded: a pass that fails before
  // its first await has already finished by the time runPass returns.
  const current: Promise<void> = runPass(read, involved).finally(() => {
    if (pass === current) pass = null
  })
  pass = current
  return current
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
