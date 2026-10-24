// The conditions the workspace alerts on (docs/Service-architecture.md,
// "Alerts"). Each function is called from the place that decides its
// condition. An alert that cannot be recorded must never stop the work it is
// about, so a failure to record one is logged there instead of thrown.
//
// The browser client has no URL routing (each browser remembers its own
// view), so alerts open the workspace's front page; a sign-in alert from
// Connected accounts opens Settings there. Each alert's notice in the page
// opens its own target: the view, Settings tab or Chat session it is about.

import { createHash } from 'node:crypto'
import { materialFailureCause } from '../../gateway/src/diagnostics/material-cause'
import { CONNECTED_ACCOUNTS_PATH, GITHUB_AUTOMATION_SIGN_IN_TITLE, type AccountId, type ConnectedAccount } from '../accounts/types'
import { behaviorLedgerSnapshot, type BehaviorLedgerSnapshot } from '../behavior-ledger'
import type { ClaudeAuthStatus } from '../claude-auth'
import type { StopReason } from '../chat/protocol'
import { isSwitchboardSession } from '../chat/switchboard-store'
import { getMeta, setMeta } from '../db'
import { isServiceMode } from '../service/config'
import { getNotificationSettings } from '../settings'
import { openAlerts, raiseAlert, resolveAlert, updateAlertDetails, type AlertTarget } from './store'

const FRONT_PAGE = '/'
/** Datastore sync alerts once it has been failing this long. */
export const DATASTORE_FAILING_ALERT_MS = 15 * 60_000
/** A Chat turn alerts when it finishes after running longer than this. */
export const LONG_CHAT_TURN_MS = 2 * 60_000

const BEHAVIOR_LABELS: Record<string, string> = {
  'review-new-prs': 'Review New Pull Requests',
  'approve-prs': 'Approve Pull Requests',
  'resolve-unblocking': 'Resolve Unblocking Conversations',
  'review-new-issues': 'Review New Issues',
}

function record<T>(what: string, action: () => T): T | undefined {
  try {
    return action()
  } catch (error) {
    console.error(`[alerts] could not record ${what}:`, error)
    return undefined
  }
}

/** One line of at most `max` characters, for a notification. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

function minutes(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000))
  return `${value} minute${value === 1 ? '' : 's'}`
}

const CLAUDE_SIGN_IN = 'sign-in:claude'
const ACCOUNTS: AlertTarget = { settings: 'accounts' }

/** The Claude auth monitor's status: `reauth_required` alerts, and the alert
 *  clears once Claude is `authenticated` again. Other states say nothing. */
export function claudeAuthStatusChanged(status: ClaudeAuthStatus): void {
  if (status === 'authenticated') {
    record('the end of the Claude sign-in alert', () => resolveAlert(CLAUDE_SIGN_IN))
    return
  }
  if (status !== 'reauth_required') return
  record('the Claude sign-in alert', () => raiseAlert({
    kind: 'sign_in_needed',
    dedupeKey: CLAUDE_SIGN_IN,
    title: 'Claude needs you to sign in again',
    body: isServiceMode()
      ? 'Claude-backed work is paused. Connect Claude in Settings → Accounts.'
      : 'Claude-backed work is paused until you sign in to Claude from Poise.',
    path: FRONT_PAGE,
    ...(isServiceMode() ? { target: ACCOUNTS } : {}),
  }))
}

const ACCOUNT_NAMES: Partial<Record<AccountId, string>> = { codex: 'Codex', grok: 'Grok', muse: 'Muse', antigravity: 'Antigravity' }

/** The two GitHub accounts Settings → General names, each of which gh must
 *  hold signed in. */
export interface GitHubIdentities {
  me: string
  agentAccount: string
}

const GH_ROLES = [
  {
    key: 'sign-in:gh:you',
    login: (identities: GitHubIdentities) => identities.me,
    title: 'Your GitHub account is not signed in to gh',
    body: (login: string) => `Poise reads GitHub as ${login}, which gh does not hold signed in. Connect GitHub in Settings → Accounts and sign in as ${login}.`,
  },
  {
    key: 'sign-in:gh:agent',
    login: (identities: GitHubIdentities) => identities.agentAccount,
    title: GITHUB_AUTOMATION_SIGN_IN_TITLE,
    body: (login: string) => `Reviews and comments are posted as ${login}, which gh does not hold signed in. Connect GitHub in Settings → Accounts and sign in as ${login}.`,
  },
]

/** What Connected accounts read from each CLI's own status command. An
 *  installed CLI that says it is not signed in alerts until it says it is;
 *  for gh, so does your GitHub account or the agent account when gh does not
 *  hold it signed in. A CLI whose state is unknown changes nothing, and Claude
 *  is left to its auth monitor (claudeAuthStatusChanged). */
export function accountsChecked(accounts: readonly ConnectedAccount[], identities: GitHubIdentities): void {
  for (const account of accounts) {
    if (account.id === 'claude' || !account.installed) continue
    if (account.id === 'gh') {
      ghAccountsChecked(account, identities)
      continue
    }
    if (account.signedIn === null) continue
    const name = ACCOUNT_NAMES[account.id] ?? account.id
    const dedupeKey = `sign-in:${account.id}`
    if (account.signedIn) {
      record(`the end of the ${name} sign-in alert`, () => resolveAlert(dedupeKey))
      continue
    }
    record(`the ${name} sign-in alert`, () => raiseAlert({
      kind: 'sign_in_needed',
      dedupeKey,
      title: `${name} needs you to sign in`,
      body: `${name} is not signed in, so work that runs it cannot start. Connect it in Settings → Accounts.`,
      path: CONNECTED_ACCOUNTS_PATH,
      target: ACCOUNTS,
    }))
  }
}

function ghAccountsChecked(gh: ConnectedAccount, identities: GitHubIdentities): void {
  // Without gh's own answer nothing is known about either account.
  if (!gh.accounts) return
  const held = gh.accounts
  for (const role of GH_ROLES) {
    const login = role.login(identities)
    const signedIn = held.some((account) => account.signedIn && account.login.toLowerCase() === login.toLowerCase())
    // An account that is not set is not one gh has to hold.
    if (!login || signedIn) {
      record(`the end of the alert "${role.title}"`, () => resolveAlert(role.key))
      continue
    }
    record(`the alert "${role.title}"`, () => raiseAlert({
      kind: 'sign_in_needed',
      dedupeKey: role.key,
      title: role.title,
      body: role.body(login),
      path: CONNECTED_ACCOUNTS_PATH,
      target: ACCOUNTS,
    }))
  }
}

/** A behavior recorded a dead letter for `target`. `alreadyHeld` says whether
 *  the Behaviors view showed an incident for it just before: if not, any
 *  earlier alert for it belongs to an incident that has cleared. */
export function behaviorHeld(behavior: string, target: string, alreadyHeld: boolean, error = ''): void {
  const dedupeKey = `behavior-held:${behavior}:${target}`
  const body = error ? `${clip(error, 240)} Open Behaviors in Poise for details.` : 'Open Behaviors in Poise to see what happened.'
  const cause = createHash('sha256').update(materialFailureCause(error || body)).digest('hex')
  record(`the ${behavior} alert for ${target}`, () => {
    const previous = openAlerts({ kind: 'behavior_held' }).find((alert) => alert.dedupeKey === dedupeKey)
    if (!alreadyHeld || (previous && previous.cause !== cause)) resolveAlert(dedupeKey)
    raiseAlert({
      kind: 'behavior_held',
      dedupeKey,
      title: `${BEHAVIOR_LABELS[behavior] ?? behavior} failed on ${clip(target, 80)}`,
      body,
      cause,
      path: FRONT_PAGE,
      target: { view: 'behaviors' },
    })
  })
}


const datastoreKey = (login: string) => `datastore-sync:${login.toLowerCase()}`

/** A sync of `login`'s datastore failed; it has been failing since `sinceMs`. */
export function datastoreSyncFailed(login: string, sinceMs: number, nowMs = Date.now()): void {
  if (nowMs - sinceMs < DATASTORE_FAILING_ALERT_MS) return
  record(`the datastore alert for ${login}`, () => raiseAlert({
    kind: 'datastore_sync_failing',
    dedupeKey: datastoreKey(login),
    title: `GitHub data for ${login} is not updating`,
    body: `Syncing it has failed for ${minutes(nowMs - sinceMs)}. Poise keeps retrying; Settings → General → GitHub accounts shows the error.`,
    path: FRONT_PAGE,
    target: { settings: 'general' },
  }))
}

export function datastoreSyncRecovered(login: string): void {
  record(`the end of the datastore alert for ${login}`, () => resolveAlert(datastoreKey(login)))
}

export interface ChatSessionAlertContext {
  sessionId: string
  /** The agent's name as Chat shows it, e.g. "Claude Code". */
  agent: string
  title: string
}

export type ChatRequest = { kind: 'permission', title: string } | { kind: 'question', question: string }

const chatWaitingKey = (sessionId: string) => `chat-waiting:${sessionId}`
const sessionName = (title: string) => (title.trim() ? `“${clip(title, 60)}”` : 'a Chat session')

/** A Chat agent asked for a permission or an answer. One alert per session
 *  until it is no longer waiting. */
export function chatWaiting(session: ChatSessionAlertContext, request: ChatRequest): void {
  record(`the waiting alert for Chat session ${session.sessionId}`, () => raiseAlert({
    kind: 'chat_waiting',
    dedupeKey: chatWaitingKey(session.sessionId),
    title: `${session.agent} is waiting for you`,
    body: request.kind === 'permission'
      ? `In ${sessionName(session.title)}: allow or deny ${clip(request.title, 120)}.`
      : `In ${sessionName(session.title)}: ${clip(request.question, 120)}`,
    path: FRONT_PAGE,
    target: { chat: session.sessionId },
  }))
}

export function chatWaitingEnded(sessionId: string): void {
  record(`the end of the waiting alert for Chat session ${sessionId}`, () => resolveAlert(chatWaitingKey(sessionId)))
}

/** How often the ledger's drain state is checked: the behavior tick's own
 *  cadence, as a local constant — this module cannot import the behaviors
 *  runtime that imports it. */
export const LEDGER_HEALTH_CHECK_MS = 60_000
/** Queue age past the stall budget alerts only after this many checks in a
 *  row, so one slow store write does not page the owner. */
export const LEDGER_STALL_ALERT_CHECKS = 2

const LEDGER_QUEUE_KEY = 'ledger:queue'
const LEDGER_WORKER_KEY = 'ledger:queue:worker'
const BEHAVIORS_VIEW: AlertTarget = { view: 'behaviors' }
const lossKey = (generation: string) => `ledger:loss:${generation}`
const baselineKey = (generation: string) => `ledger-loss-baseline:${generation}`

let stalledChecks = 0
let ledgerTimer: ReturnType<typeof setInterval> | undefined

/** Raises (or refreshes) a standing ledger alert. True once the condition
 *  is surfaced: a failed raise must not consume what it was meant to report. */
function ledgerStanding(what: string, input: Parameters<typeof raiseAlert>[0]): boolean {
  try {
    raiseAlert(input)
  } catch (error) {
    console.error(`[alerts] could not record ${what}:`, error)
    return false
  }
  record(`${what} details`, () => updateAlertDetails(input.dedupeKey, input.title, input.body))
  return true
}

function ledgerCleared(what: string, dedupeKey: string, nowMs?: number): void {
  record(`the end of ${what}`, () => resolveAlert(dedupeKey, nowMs))
}

/** The ledger's drain state as this check saw it: a stalled queue, a dead
 *  worker, and lost-capture deltas alert through the durable alert path
 *  (Poise Link, and the page's notices while it is open). Raising honors
 *  the Notifications setting; resolution does not, so a condition that
 *  cleared while notifications were off cannot alert stale.
 *
 *  Loss is baselined per store generation in meta: an unchanged historical
 *  `dropped` never re-alerts on a poll or a restart, a later increase
 *  alerts (and refreshes the standing alert's details) even while the
 *  ledger is already degraded, and counters are never subtracted across
 *  different stores. The baseline advances only once a delta is surfaced,
 *  so neither a failed alert write nor notifications being off can consume
 *  an increase unreported. */
export function ledgerHealthObserved(snapshot: BehaviorLedgerSnapshot | null, nowMs = Date.now()): void {
  const enabled = getNotificationSettings().enabled
  if (snapshot?.failed) {
    stalledChecks = 0
    ledgerCleared('the ledger queue alert', LEDGER_QUEUE_KEY, nowMs)
    if (enabled) {
      ledgerStanding('the ledger worker alert', {
        kind: 'ledger_queue_stalled',
        dedupeKey: LEDGER_WORKER_KEY,
        title: 'Behavior ledger worker stopped',
        body: 'Behavior history is not being recorded. It resumes when Poise restarts.',
        path: FRONT_PAGE,
        target: BEHAVIORS_VIEW,
      })
    }
  } else {
    ledgerCleared('the ledger worker alert', LEDGER_WORKER_KEY, nowMs)
    const queueAgeMs = snapshot && !snapshot.stopping ? snapshot.queueAgeMs : null
    const stallBudgetMs = snapshot && !snapshot.stopping ? snapshot.stallBudgetMs : null
    const stalled = queueAgeMs !== null && stallBudgetMs !== null && queueAgeMs > stallBudgetMs
    stalledChecks = stalled ? stalledChecks + 1 : 0
    if (stalled && queueAgeMs !== null && stalledChecks >= LEDGER_STALL_ALERT_CHECKS && enabled) {
      ledgerStanding('the ledger queue alert', {
        kind: 'ledger_queue_stalled',
        dedupeKey: LEDGER_QUEUE_KEY,
        title: 'Behavior ledger is not draining',
        body: `Its oldest queued capture is ${minutes(queueAgeMs)} old; history is delayed until the queue drains.`,
        path: FRONT_PAGE,
        target: BEHAVIORS_VIEW,
      })
    } else if (!stalled) {
      ledgerCleared('the ledger queue alert', LEDGER_QUEUE_KEY, nowMs)
    }
  }
  const generation = snapshot?.health.generation ?? null
  for (const alert of openAlerts({ kind: 'ledger_capture_loss', now: nowMs })) {
    if (alert.dedupeKey !== (generation === null ? '' : lossKey(generation))) {
      ledgerCleared('a superseded ledger loss alert', alert.dedupeKey, nowMs)
    }
  }
  if (generation === null || !snapshot) return
  const dropped = snapshot.health.dropped
  const raw = record('the ledger loss baseline', () => getMeta(baselineKey(generation)))
  const baseline = typeof raw === 'string' && /^\d{1,15}$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
  if (baseline === null || dropped < baseline) {
    // First sight of this store, or counters that do not continue it:
    // baseline silently, never alert on history alone.
    record('the ledger loss baseline', () => setMeta(baselineKey(generation), String(dropped)))
    return
  }
  if (dropped === baseline) return
  const delta = dropped - baseline
  const lost = delta === 1 ? '1 capture was lost' : `${delta} captures were lost`
  // The baseline advances only once the delta is surfaced. An alert write
  // that throws leaves the baseline behind so the next check retries, and
  // while notifications are off the delta accumulates instead of being
  // consumed, so re-enabling surfaces what was lost.
  if (enabled && ledgerStanding('the ledger loss alert', {
    kind: 'ledger_capture_loss',
    dedupeKey: lossKey(generation),
    title: 'Behavior ledger lost captures',
    body: `${lost}; ${dropped} total in this store. The gaps stay in history.`,
    path: FRONT_PAGE,
    target: BEHAVIORS_VIEW,
  })) {
    record('the ledger loss baseline', () => setMeta(baselineKey(generation), String(dropped)))
  }
}

/** One ledger health check, from the timer below. */
export function checkLedgerHealth(nowMs = Date.now()): void {
  try {
    ledgerHealthObserved(behaviorLedgerSnapshot(), nowMs)
  } catch (error) {
    console.error('[alerts] could not check ledger health:', error)
  }
}

export function startLedgerHealthRuntime(): void {
  if (ledgerTimer) return
  ledgerTimer = setInterval(checkLedgerHealth, LEDGER_HEALTH_CHECK_MS)
  ledgerTimer.unref?.()
}

export function stopLedgerHealthRuntime(): void {
  clearInterval(ledgerTimer)
  ledgerTimer = undefined
}

/** A Chat turn finished. Only a turn that ran longer than two minutes alerts,
 *  and neither a turn the person stopped, a timer turn that ended normally,
 *  nor the Switchboard's finished checks do. */
export function chatTurnFinished(session: ChatSessionAlertContext, turn: { id: string, stopReason: StopReason, durationMs: number, timer?: boolean }): void {
  if (turn.stopReason === 'cancelled' || turn.durationMs <= LONG_CHAT_TURN_MS) return
  if (turn.timer === true && turn.stopReason === 'end_turn') return
  const finished = turn.stopReason === 'end_turn'
  // Inside record: a failed lookup is logged, never thrown at the turn.
  record(`the finished-turn alert for Chat turn ${turn.id}`, () => finished && isSwitchboardSession(session.sessionId) ? undefined : raiseAlert({
    kind: 'chat_turn_finished',
    dedupeKey: `chat-turn-finished:${turn.id}`,
    title: finished ? `${session.agent} finished` : `${session.agent} stopped early`,
    body: finished
      ? `${sessionName(session.title)} is done after ${minutes(turn.durationMs)}.`
      : `${sessionName(session.title)} ended (${turn.stopReason.replace('_', ' ')}) after ${minutes(turn.durationMs)}.`,
    path: FRONT_PAGE,
    target: { chat: session.sessionId },
  }))
}
