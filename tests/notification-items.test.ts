// What the notification rail lists (src/notification-items.ts): notices and
// Behaviors' diagnostics as one list, grouped by who acts, with a failed
// behavior's notice and its diagnostic as one entry.

import { describe, expect, it } from 'vitest'
import type { BehaviorDiagnostics } from '../src/behaviors'
import type { Notice } from '../src/notices'
import { behaviorCounts, countItems, headTone, noticeMeta, notificationItems, openLabel } from '../src/notification-items'

const T0 = Date.parse('2026-10-17T10:00:00.000Z')
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
const NOW = T0 + 60 * 60_000

function notice(id: string, overrides: Partial<Notice> = {}): Notice {
  return { id, kind: 'chat_waiting', title: 'Claude Code is waiting for you', body: 'Allow it?', since: iso(0), due: iso(0), silenceable: false, target: { chat: 's1' }, ...overrides }
}

function diagnostics(overrides: Partial<BehaviorDiagnostics> = {}): BehaviorDiagnostics {
  return {
    status: 'ok', agentLogsError: null,
    datastore: { status: 'healthy', checkedAt: '', ageSeconds: 1, lastSuccessAt: '', error: null },
    identity: { status: 'valid', actor: 'bit-mis', error: null },
    failures: [], deadLetters: [], ...overrides,
  }
}

const HELD_SUBJECT = { behavior: 'review-new-prs', target: 'acme/api#9' }
const held = notice('held', { kind: 'behavior_held', title: 'Review New Pull Requests failed on acme/api#9', body: 'Open Swarm in Poise to see what happened.', target: { swarm: 'failed-call' }, subject: HELD_SUBJECT })
const letter = (target: string, overrides: Partial<BehaviorDiagnostics['deadLetters'][number]> = {}) => ({
  id: `letter-${target}`, behavior: 'review-new-prs', target, error: 'The reviewer stopped before posting.', createdAt: iso(5), attemptCount: 3, ...overrides,
})

describe('the list', () => {
  it('groups notices by who acts, in the order the server gave them', () => {
    const items = notificationItems([
      notice('waiting'),
      notice('sign-in', { kind: 'sign_in_needed', target: { settings: 'accounts' } }),
      notice('held-plain', { kind: 'behavior_held', target: { view: 'behaviors' } }),
      notice('sync', { kind: 'datastore_sync_failing', target: { settings: 'general' } }),
      notice('ready', { kind: 'pr_ready', silenceable: true, target: { pullRequest: 'https://github.com/acme/api/pull/7' } }),
      notice('finished', { kind: 'chat_turn_finished' }),
    ], null, NOW)
    expect(items.map((item) => [item.id, item.group, item.tone, item.source])).toEqual([
      ['waiting', 'needs', 'blue', 'Chat'],
      ['sign-in', 'needs', 'amber', 'Accounts'],
      ['held-plain', 'needs', 'amber', 'Behaviors'],
      ['sync', 'needs', 'amber', 'GitHub data'],
      ['ready', 'ready', 'green', 'GitHub'],
      ['finished', 'ready', 'teal', 'Chat'],
    ])
    expect(items.every((item) => item.notice !== null)).toBe(true)
  })

  it("says how long a ready pull request has waited, on its reminders only", () => {
    const first = notice('a', { kind: 'pr_ready', since: iso(0), due: iso(0) })
    const reminder = { ...first, due: iso(15) }
    expect(noticeMeta(first, T0 + 2 * 60_000)).toBe('')
    expect(noticeMeta(reminder, T0 + 16 * 60_000)).toBe('for 16 min')
    expect(notificationItems([reminder], null, T0 + 16 * 60_000)[0].meta).toBe('for 16 min')
  })

  it('lists Behaviors’ activity alone while notices are off, Poise-wide conditions about no behavior', () => {
    const items = notificationItems([], diagnostics({ agentLogsError: 'agent-interface --logs exited with status 1' }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ group: 'needs', source: 'Behaviors', scope: 'Agent log', behaviors: [], notice: null, body: '' })
    expect(items[0].details.map((entry) => entry.detail)).toEqual(['agent-interface --logs exited with status 1'])
  })

  it('gives a diagnostic the same identity on every read', () => {
    const read = () => notificationItems([], diagnostics({ deadLetters: [letter('acme/api#3')] }), NOW)[0].id
    expect(read()).toBe(read())
    expect(read()).toMatch(/^diagnostic:/)
  })
})

describe('a failed behavior', () => {
  it('is one entry with its diagnostic: what happened, how it is classified, what can be done', () => {
    const items = notificationItems([held], diagnostics({ deadLetters: [letter('acme/api#9')] }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: 'held', group: 'needs', tone: 'amber', title: held.title, scope: 'acme/api#9',
      body: 'The review outcome needs verification before retry.', behaviors: ['review-new-prs'], notice: held,
    })
    expect(items[0].details).toEqual([{ behavior: 'review-new-prs', target: 'acme/api#9', at: iso(5), detail: 'review-new-prs acme/api#9: The reviewer stopped before posting. (3 attempts)' }])
  })

  it('takes its group from the diagnostic: a Poise fault, or handled automatically', () => {
    const fault = notificationItems([held], diagnostics({ deadLetters: [letter('acme/api#9', { diagnostic: { severity: 'error', code: 'invalid_agent_result' } })] }), NOW)[0]
    expect(fault).toMatchObject({ group: 'faults', tone: 'red', icon: 'fault', body: 'Poise could not reconcile the worker result.' })
    const automatic = notificationItems([held], diagnostics({ deadLetters: [letter('acme/api#9', { diagnostic: { severity: 'info', code: 'head_changed' } })] }), NOW)[0]
    expect(automatic).toMatchObject({ group: 'auto', tone: 'slate', body: 'PR updated. Poise will reconsider the latest revision.' })
  })

  it('finds its pull request in a line that names a reviewer slot', () => {
    const items = notificationItems([held], diagnostics({ failures: [{
      behavior: 'review-new-prs', target: 'acme/api#9:secondary:check', kind: 'operation', consecutiveFailures: 2,
      lastFailureAt: iso(7), nextRetryAt: '', error: 'GitHub 404: Not Found',
    }] }), NOW)
    expect(items).toHaveLength(1)
    expect(items[0].details[0]).toMatchObject({ target: 'acme/api#9:secondary:check', at: iso(7) })
  })

  it('leaves the lines about anything else in their own entry', () => {
    const items = notificationItems([held], diagnostics({ deadLetters: [letter('acme/api#9'), letter('acme/api#10'), letter('acme/api#9', { behavior: 'approve-prs' })] }), NOW)
    expect(items.map((item) => item.id)).toEqual(['held', expect.stringMatching(/^diagnostic:/), expect.stringMatching(/^diagnostic:/)])
    expect(items[0].details.map((entry) => entry.target)).toEqual(['acme/api#9'])
    expect(items.slice(1).flatMap((item) => item.details.map((entry) => `${entry.behavior} ${entry.target}`)).sort())
      .toEqual(['approve-prs acme/api#9', 'review-new-prs acme/api#10'])
  })

  it('shows its notice as it is until Behaviors’ diagnostics have been read', () => {
    expect(notificationItems([held], null, NOW)[0]).toMatchObject({ group: 'needs', tone: 'amber', body: held.body, details: [] })
  })
})

describe('the counts', () => {
  const items = notificationItems([
    notice('waiting'),
    notice('ready', { kind: 'pr_ready', target: { pullRequest: 'https://github.com/acme/api/pull/7' } }),
    held,
  ], diagnostics({ deadLetters: [letter('acme/api#9'), letter('acme/web#2', { behavior: 'approve-prs', diagnostic: { severity: 'error', code: 'invalid_agent_result' } }), letter('acme/web#3', { diagnostic: { severity: 'info', code: 'head_changed' } })] }), NOW)

  it('count what is open, and colour the bell by the most serious', () => {
    expect(countItems(items)).toEqual({ needs: 2, faults: 1, ready: 1, auto: 1, open: 4 })
    expect(headTone(countItems(items))).toBe('red')
    expect(headTone(countItems(items.filter((item) => item.group === 'needs')))).toBe('amber')
    expect(headTone(countItems(items.filter((item) => item.group === 'ready')))).toBe('green')
    const automatic = countItems(items.filter((item) => item.group === 'auto'))
    expect(automatic.open).toBe(0)
    expect(headTone(automatic)).toBeNull()
  })

  it('count per behavior', () => {
    expect(behaviorCounts(items, 'review-new-prs')).toEqual({ needs: 1, faults: 0, ready: 0, auto: 1, open: 1 })
    expect(behaviorCounts(items, 'approve-prs')).toEqual({ needs: 0, faults: 1, ready: 0, auto: 0, open: 1 })
    expect(behaviorCounts(items, 'merge-prs')).toEqual({ needs: 0, faults: 0, ready: 0, auto: 0, open: 0 })
  })
})

describe('where a notice opens', () => {
  it('says so on its button, and offers none for a failure explained in place', () => {
    expect(openLabel({ swarm: 'failed-call' })).toBe('Open the run in Swarm')
    expect(openLabel({ chat: 's1' })).toBe('Open the session')
    expect(openLabel({ settings: 'accounts' })).toBe('Open Settings, Accounts')
    expect(openLabel({ settings: 'general' })).toBe('Open Settings')
    expect(openLabel({ pullRequest: 'https://github.com/acme/api/pull/7' })).toBe('Open on GitHub')
    expect(openLabel({ view: 'behaviors' })).toBeNull()
  })
})
