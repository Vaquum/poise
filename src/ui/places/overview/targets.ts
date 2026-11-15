// Where a notice's target lives in the new places (#556, Design → Addresses):
// the service still writes classic's targets, and each opens its place here
// with a route back to Overview.
import { placeHref } from '../../address'
import type { NoticeTarget } from '../../../notices'
import type { DiagnosticEvidence } from '../../../../gateway/src/diagnostics/evidence-contract'

export interface Opening {
  href: string
  label: string
  /** A page outside Poise, opened in a new tab. */
  external?: boolean
}

/** owner/name#number for a GitHub pull request or issue URL, or null. */
export function itemOf(url: string): string | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:pull|issues)\/([1-9][0-9]*)$/.exec(url)
  return match ? `${match[1]}/${match[2]}#${match[3]}` : null
}

/** A chat or a worker opens in Chat; the Manager opens in the Manager place. */
export function chatOpening(chat: string, role?: 'manager' | 'worker' | null): Opening {
  if (role === 'manager') return { href: placeHref('manager', { back: 'overview' }), label: 'Open the Manager' }
  return { href: placeHref('chat', { chat, back: 'overview' }), label: 'Open the chat' }
}

/** The place a notice's target names. `role` says whether a chat is a worker
 *  or the Manager, when Overview has read the chats. */
export function targetOpening(target: NoticeTarget, role?: (chat: string) => 'manager' | 'worker' | null | undefined): Opening {
  if ('view' in target) return { href: placeHref('settings', { settings: 'behaviors', back: 'overview' }), label: 'Open Settings, Behaviors' }
  if ('swarm' in target) return { href: placeHref('observe', { part: 'behaviors', call: target.swarm, back: 'overview' }), label: 'Open the run in Observe' }
  if ('settings' in target) {
    const label = { accounts: 'Accounts', general: 'General', extensions: 'Extensions' }[target.settings]
    return { href: placeHref('settings', { settings: target.settings, back: 'overview' }), label: `Open Settings, ${label}` }
  }
  if ('chat' in target) return chatOpening(target.chat, role?.(target.chat))
  const item = itemOf(target.pullRequest)
  return item
    ? { href: placeHref('board', { item, back: 'overview' }), label: 'Open its card on Board' }
    : { href: target.pullRequest, label: 'Open on GitHub', external: true }
}

/** A diagnostic's exact place in Observe → Logging, with its interval. */
export function diagnosticHref(ref: DiagnosticEvidence): string {
  return placeHref('observe', { part: 'logging', event: ref.eventId, from: ref.from, to: ref.to, back: 'overview' })
}

/** A chain's timeline in Observe → Tasks, from the step a notice names. */
export function timelineHref(chain: string, after: number): string {
  return placeHref('observe', { part: 'tasks', chain, after: String(Math.max(0, after)), back: 'overview' })
}

/** The step a chain's journal link starts at: `/api/behavior-chains?id=…&after=…`. */
export function journalStep(journal: string): { chain: string, after: number } | null {
  try {
    const params = new URL(journal, 'http://poise.invalid').searchParams
    const chain = params.get('id')
    const after = Number(params.get('after') ?? 0)
    return chain && Number.isSafeInteger(after) && after >= 0 ? { chain, after } : null
  } catch {
    return null
  }
}
