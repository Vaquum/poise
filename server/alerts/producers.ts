// The conditions the workspace alerts on (docs/Service-architecture.md,
// "Alerts"). Each function is called from the place that decides its
// condition. An alert that cannot be recorded must never stop the work it is
// about, so a failure to record one is logged there instead of thrown.
//
// The browser client has no URL routing (each browser remembers its own
// view), so alerts open the workspace's front page; a sign-in alert from
// Connected accounts opens Settings there.

import { CONNECTED_ACCOUNTS_PATH, type AccountId, type ConnectedAccount } from '../accounts/types'
import type { ClaudeAuthStatus } from '../claude-auth'
import type { StopReason } from '../chat/protocol'
import { isServiceMode } from '../service/config'
import { raiseAlert, resolveAlert } from './store'

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

function record(what: string, action: () => void): void {
  try {
    action()
  } catch (error) {
    console.error(`[alerts] could not record ${what}:`, error)
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
      ? 'Claude-backed work is paused. Connect Claude in Settings → Connected accounts.'
      : 'Claude-backed work is paused until you sign in to Claude from Poise.',
    path: FRONT_PAGE,
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
    title: 'The agent account is not signed in to gh',
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
    }))
  }
}

/** A behavior recorded a dead letter for `target`. `alreadyHeld` says whether
 *  the Behaviors view showed an incident for it just before: if not, any
 *  earlier alert for it belongs to an incident that has cleared. */
export function behaviorHeld(behavior: string, target: string, alreadyHeld: boolean): void {
  const dedupeKey = `behavior-held:${behavior}:${target}`
  record(`the ${behavior} alert for ${target}`, () => {
    if (!alreadyHeld) resolveAlert(dedupeKey)
    raiseAlert({
      kind: 'behavior_held',
      dedupeKey,
      title: `${BEHAVIOR_LABELS[behavior] ?? behavior} failed on ${clip(target, 80)}`,
      body: 'Open Behaviors in Poise to see what happened.',
      path: FRONT_PAGE,
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
  }))
}

export function chatWaitingEnded(sessionId: string): void {
  record(`the end of the waiting alert for Chat session ${sessionId}`, () => resolveAlert(chatWaitingKey(sessionId)))
}

/** A Chat turn finished. Only a turn that ran longer than two minutes alerts,
 *  and a turn the person stopped does not. */
export function chatTurnFinished(session: ChatSessionAlertContext, turn: { id: string, stopReason: StopReason, durationMs: number }): void {
  if (turn.stopReason === 'cancelled' || turn.durationMs <= LONG_CHAT_TURN_MS) return
  const finished = turn.stopReason === 'end_turn'
  record(`the finished-turn alert for Chat turn ${turn.id}`, () => raiseAlert({
    kind: 'chat_turn_finished',
    dedupeKey: `chat-turn-finished:${turn.id}`,
    title: finished ? `${session.agent} finished` : `${session.agent} stopped early`,
    body: finished
      ? `${sessionName(session.title)} is done after ${minutes(turn.durationMs)}.`
      : `${sessionName(session.title)} ended (${turn.stopReason.replace('_', ' ')}) after ${minutes(turn.durationMs)}.`,
    path: FRONT_PAGE,
  }))
}
