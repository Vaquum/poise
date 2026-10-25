import { describe, expect, it } from 'vitest'
import {
  conflictLeaves,
  conflictMessage,
  deepEqual,
  generalPayload,
  validateGeneralDraft,
  validateModelChoices,
  type GeneralDraft,
} from '../src/settings-save'

// The Settings save round trip without the panel: only drafts are validated
// and sent, with the values this tab read, and a refused save names what
// moved elsewhere.

const DRAFT: GeneralDraft = {
  me: 'octocat',
  agentAccount: 'review-bot',
  timezone: 'UTC',
  branchPrefix: 'chat/',
  idleTimeoutMinutes: 120,
  maxConcurrentLocalTurns: 4,
  updateTurnBoundMinutes: 15,
}
const STORED = { me: 'octocat', agentAccount: 'review-bot' }

describe('general draft validation', () => {
  it('validates only drafted fields, so untouched values cannot block the save', () => {
    const draft = { ...DRAFT, me: '', agentAccount: 'not a login', branchPrefix: 'bad prefix', idleTimeoutMinutes: -1 }
    expect(validateGeneralDraft(draft, STORED, new Set())).toBeNull()
    expect(validateGeneralDraft(draft, STORED, new Set(['timezone']))).toBeNull()
    expect(validateGeneralDraft(draft, STORED, new Set(['me']))).toEqual({ message: 'Your GitHub account is required.', field: 'me' })
    expect(validateGeneralDraft(draft, STORED, new Set(['agentAccount']))?.message).toBe('The agent account must be a GitHub login, not a URL or email.')
  })

  it('requires your account only when it is drafted', () => {
    expect(validateGeneralDraft({ ...DRAFT, me: '' }, STORED, new Set(['me']))).toEqual({ message: 'Your GitHub account is required.', field: 'me' })
    expect(validateGeneralDraft({ ...DRAFT, me: 'me@example.com' }, STORED, new Set(['me']))?.message).toBe('Your GitHub account must be a GitHub login, not a URL or email.')
    expect(validateGeneralDraft({ ...DRAFT }, STORED, new Set(['me']))).toBeNull()
  })

  it('grandfathers a stored consecutive-hyphen account that was drafted back to itself', () => {
    const stored = { me: 'a--b', agentAccount: 'x--y' }
    expect(validateGeneralDraft({ ...DRAFT, me: 'a--b', agentAccount: 'x--y' }, stored, new Set(['me', 'agentAccount']))).toBeNull()
    expect(validateGeneralDraft({ ...DRAFT, me: 'c--d' }, stored, new Set(['me']))?.field).toBe('me')
  })

  it('takes the idle timeout for whole minutes 0–10080, with 0 meaning no idle expiry', () => {
    for (const minutes of [0, 1, 120, 10080]) {
      expect(validateGeneralDraft({ ...DRAFT, idleTimeoutMinutes: minutes }, STORED, new Set(['idleTimeoutMinutes']))).toBeNull()
    }
    for (const minutes of [-1, 10081, 1.5, NaN]) {
      expect(validateGeneralDraft({ ...DRAFT, idleTimeoutMinutes: minutes }, STORED, new Set(['idleTimeoutMinutes'])))
        .toEqual({ message: 'Idle timeout must be a whole number of minutes between 0 and 10080.', field: 'idleTimeoutMinutes' })
    }
  })

  it('keeps the other chat bounds: concurrent turns 1–64, update bound 1–10080', () => {
    expect(validateGeneralDraft({ ...DRAFT, maxConcurrentLocalTurns: 0 }, STORED, new Set(['maxConcurrentLocalTurns']))?.message)
      .toBe('Concurrent local turns must be a whole number between 1 and 64.')
    expect(validateGeneralDraft({ ...DRAFT, updateTurnBoundMinutes: 0 }, STORED, new Set(['updateTurnBoundMinutes']))?.message)
      .toBe('Update turn bound must be a whole number of minutes between 1 and 10080.')
    expect(validateGeneralDraft({ ...DRAFT, maxConcurrentLocalTurns: 64, updateTurnBoundMinutes: 10080 }, STORED, new Set(['maxConcurrentLocalTurns', 'updateTurnBoundMinutes']))).toBeNull()
  })

  it('refuses a bad branch prefix in the drafted order', () => {
    const draft = { ...DRAFT, branchPrefix: 'bad prefix', idleTimeoutMinutes: -1 }
    expect(validateGeneralDraft(draft, STORED, new Set(['branchPrefix', 'idleTimeoutMinutes']))?.field).toBe('branchPrefix')
    expect(validateGeneralDraft(draft, STORED, new Set(['idleTimeoutMinutes']))?.field).toBe('idleTimeoutMinutes')
  })
})

describe('the general payload', () => {
  const baselines = new Map<string, unknown>([
    ['me', 'octocat'],
    ['timezone', 'UTC'],
    ['chat', { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }],
  ])

  it('is null without drafts: nothing is sent and nothing is validated', () => {
    expect(generalPayload(DRAFT, new Set(), baselines)).toBeNull()
  })

  it('carries only drafted fields, with the values this tab read', () => {
    const payload = generalPayload({ ...DRAFT, timezone: 'Europe/Berlin' }, new Set(['timezone']), baselines)!
    expect(payload.body).toEqual({ timezone: 'Europe/Berlin' })
    expect(payload.expect).toEqual({ timezone: 'UTC' })
    expect(payload.fields).toEqual(['timezone'])
  })

  it('sends a partial chat object with the whole read chat as its expectation', () => {
    const payload = generalPayload({ ...DRAFT, idleTimeoutMinutes: 0 }, new Set(['idleTimeoutMinutes']), baselines)!
    expect(payload.body).toEqual({ chat: { idleTimeoutMinutes: 0 } })
    expect(payload.expect).toEqual({ chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 } })
    expect(payload.fields).toEqual(['chat'])
  })

  it('omits the expectation for a field without a baseline', () => {
    const payload = generalPayload(DRAFT, new Set(['me']), new Map())!
    expect(payload.body).toEqual({ me: 'octocat' })
    expect(payload.expect).toEqual({})
  })
})

describe('model choice validation', () => {
  it('names the place whose reviewers collide', () => {
    expect(validateModelChoices({ pr_review: { default: 'a', fallback: 'a' } })).toBe('pr_review: the fallback must differ from the default.')
    expect(validateModelChoices({ pr_review: { default: 'a', fallback: 'b', secondary: 'a' } })).toBe('pr_review: the secondary reviewer must differ from the default.')
    expect(validateModelChoices({ pr_review: { default: 'a', fallback: 'b', secondary: 'c', tertiary: 'c' } })).toBe('pr_review: the tertiary reviewer must differ from the default and the secondary.')
  })

  it('accepts distinct choices, including a secondary that matches the fallback', () => {
    expect(validateModelChoices({ chat: { default: 'a', fallback: 'b' } })).toBeNull()
    expect(validateModelChoices({ pr_review: { default: 'a', fallback: 'b', secondary: 'b', tertiary: 'c' } })).toBeNull()
    expect(validateModelChoices({})).toBeNull()
  })
})

describe('the refused save', () => {
  it('narrows the conflict to the leaves that actually moved', () => {
    const baselines = new Map<string, unknown>([
      ['timezone', 'UTC'],
      ['chat', { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }],
      ['models', { chat: { default: 'a', fallback: 'b' } }],
    ])
    expect(conflictLeaves({ timezone: 'Europe/Berlin' }, baselines)).toEqual([{ field: 'timezone', leaf: null, current: 'Europe/Berlin' }])
    expect(conflictLeaves({ chat: { branchPrefix: 'agent/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 } }, baselines))
      .toEqual([{ field: 'chat', leaf: 'branchPrefix', current: 'agent/' }])
    expect(conflictLeaves({ models: { chat: { default: 'c', fallback: 'b' } } }, baselines))
      .toEqual([{ field: 'models', leaf: 'chat', current: { default: 'c', fallback: 'b' } }])
  })

  it('names the field when shapes differ without a moved leaf', () => {
    const baselines = new Map<string, unknown>([['chat', { branchPrefix: 'chat/', idleTimeoutMinutes: 120 }]])
    expect(conflictLeaves({ chat: { branchPrefix: 'chat/' } }, baselines)).toEqual([{ field: 'chat', leaf: null, current: { branchPrefix: 'chat/' } }])
    expect(conflictLeaves({ chat: { branchPrefix: 'chat/' } }, new Map())).toEqual([{ field: 'chat', leaf: null, current: { branchPrefix: 'chat/' } }])
  })

  it('tells what moved and how to go on: retry or read again, drafts kept', () => {
    expect(conflictMessage([{ field: 'timezone', leaf: null, current: 'Europe/Berlin' }]))
      .toBe('Time zone is now "Europe/Berlin". Your edits are kept — Save again to overwrite, or Read again for the saved values.')
    expect(conflictMessage([
      { field: 'chat', leaf: 'idleTimeoutMinutes', current: 0 },
      { field: 'models', leaf: 'chat', current: { default: 'c', fallback: 'b' } },
    ])).toBe('Idle timeout is now 0; Models "chat" is now default "c", fallback "b". Your edits are kept — Save again to overwrite, or Read again for the saved values.')
    expect(conflictMessage([])).toBe('Settings changed on the server. Your edits are kept — Save again to overwrite, or Read again for the saved values.')
  })

  it('compares values structurally', () => {
    expect(deepEqual({ a: 1, b: { c: [2] } }, { b: { c: [2] }, a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual('a', 'a')).toBe(true)
  })
})
