import { describe, expect, it } from 'vitest'
import {
  conflictLeaves,
  conflictMessage,
  deepEqual,
  generalPayload,
  modelsExpect,
  rereadValue,
  validateGeneralDraft,
  validateModelChoices,
  wholeExpect,
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
  const basis = new Map<string, unknown>([['me', 'octocat'], ['timezone', 'UTC'], ['idleTimeoutMinutes', 120]])
  const freshChat = { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }

  it('is null without drafts: nothing is sent and nothing is validated', () => {
    expect(generalPayload(DRAFT, new Set(), basis, freshChat)).toBeNull()
  })

  it('carries only drafted fields, with the values this tab read', () => {
    const payload = generalPayload({ ...DRAFT, timezone: 'Europe/Berlin' }, new Set(['timezone']), basis, freshChat)!
    expect(payload.body).toEqual({ timezone: 'Europe/Berlin' })
    expect(payload.expect).toEqual({ timezone: 'UTC' })
    expect(payload.fields).toEqual(['timezone'])
  })

  it('sends a partial chat object with fresh values except for the drafted leaves', () => {
    const payload = generalPayload({ ...DRAFT, idleTimeoutMinutes: 0 }, new Set(['idleTimeoutMinutes']), basis, freshChat)!
    expect(payload.body).toEqual({ chat: { idleTimeoutMinutes: 0 } })
    expect(payload.expect).toEqual({ chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 } })
    expect(payload.fields).toEqual(['idleTimeoutMinutes'])
  })

  it('omits the expectation for a field without a basis', () => {
    const payload = generalPayload(DRAFT, new Set(['me']), new Map(), freshChat)!
    expect(payload.body).toEqual({ me: 'octocat' })
    expect(payload.expect).toEqual({})
  })
})

describe('the whole expectation', () => {
  it('keeps fresh values for clean leaves and each draft read basis for drafted ones', () => {
    const fresh = { branchPrefix: 'agent/', idleTimeoutMinutes: 0, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }
    expect(wholeExpect(new Set(['idleTimeoutMinutes']), new Map([['idleTimeoutMinutes', 120]]), fresh))
      .toEqual({ branchPrefix: 'agent/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 })
    expect(wholeExpect(new Set(['chat']), new Map(), { chat: { default: 'a' } })).toEqual({ chat: { default: 'a' } })
    expect(wholeExpect(new Set(['chat']), new Map([['chat', { default: 'b' }]]), { chat: { default: 'a' } })).toEqual({ chat: { default: 'b' } })
  })
})

describe('the models expectation', () => {
  it('adopts the still-empty read for a draft made with nothing stored', () => {
    expect(modelsExpect(new Set(['chat']), new Map([['chat', null]]), {}))
      .toEqual({})
    expect(modelsExpect(new Set(['chat']), new Map([['chat', null]]), { places: { pr_review: { slot: 'primary' } } }))
      .toEqual({ places: { pr_review: { slot: 'primary' } } })
    expect(modelsExpect(new Set(['slots']), new Map([['slots', null]]), {}))
      .toEqual({})
  })

  it('forces a refusal when the leaf gained a stored choice under the draft', () => {
    expect(modelsExpect(new Set(['chat']), new Map([['chat', null]]), { places: { chat: { slot: 'secondary' } } }))
      .toEqual({ places: { chat: null } })
    expect(modelsExpect(new Set(['slots']), new Map([['slots', null]]), { slots: { primary: 'n' } }))
      .toEqual({ slots: null })
  })

  it('keeps the read basis for a draft made with a stored choice', () => {
    expect(modelsExpect(new Set(['chat']), new Map([['chat', { slot: 'primary' }]]), { places: { chat: { slot: 'secondary' } } }))
      .toEqual({ places: { chat: { slot: 'primary' } } })
    expect(modelsExpect(new Set(['slots']), new Map([['slots', { primary: 's' }]]), { slots: { primary: 'n' } }))
      .toEqual({ slots: { primary: 's' } })
  })

  it('keeps fresh values for clean leaves across both halves', () => {
    expect(modelsExpect(new Set(['chat']), new Map([['chat', { slot: 'primary' }]]),
      { slots: { primary: 'n' }, places: { chat: { slot: 'secondary' }, pr_review: { slot: 'tertiary' } } }))
      .toEqual({ slots: { primary: 'n' }, places: { chat: { slot: 'primary' }, pr_review: { slot: 'tertiary' } } })
  })
})

describe('model choice validation', () => {
  it('names the slots that run the same model', () => {
    expect(validateModelChoices({ slots: { primary: 'a', tertiary: 'a' } })).toBe('Model slots primary and tertiary must be different models.')
    expect(validateModelChoices({ slots: { primary: 'a', secondary: 'a', tertiary: 'b' } })).toBe('Model slots primary and secondary must be different models.')
  })

  it('accepts distinct slot models, a partial draft, and place slots unchecked', () => {
    expect(validateModelChoices({ slots: { primary: 'a', secondary: 'b', tertiary: 'c' } })).toBeNull()
    expect(validateModelChoices({ slots: { secondary: 'b' } })).toBeNull()
    expect(validateModelChoices({ places: { chat: { slot: 'tertiary' } } })).toBeNull()
    expect(validateModelChoices({})).toBeNull()
  })
})

describe('the refused save', () => {
  it('narrows the conflict to the leaves that actually moved', () => {
    const baselines = new Map<string, unknown>([
      ['timezone', 'UTC'],
      ['chat', { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }],
      ['models', { slots: { primary: 'a' }, places: { chat: { slot: 'primary' } } }],
    ])
    expect(conflictLeaves({ timezone: 'Europe/Berlin' }, baselines)).toEqual([{ field: 'timezone', leaf: null, current: 'Europe/Berlin' }])
    expect(conflictLeaves({ chat: { branchPrefix: 'agent/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 } }, baselines))
      .toEqual([{ field: 'chat', leaf: 'branchPrefix', current: 'agent/' }])
    expect(conflictLeaves({ models: { slots: { primary: 'a' }, places: { chat: { slot: 'secondary' } } } }, baselines))
      .toEqual([{ field: 'models', leaf: 'chat', current: { slot: 'secondary' } }])
    expect(conflictLeaves({ models: { slots: { primary: 'b' }, places: { chat: { slot: 'primary' } } } }, baselines))
      .toEqual([{ field: 'models', leaf: 'slots', current: { primary: 'b' } }])
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
      { field: 'models', leaf: 'chat', current: { slot: 'secondary' } },
      { field: 'models', leaf: 'slots', current: { primary: 'a', secondary: 'b' } },
    ])).toBe('Idle timeout is now 0; Models "chat" is now slot "secondary"; Models "slots" is now primary "a", secondary "b". Your edits are kept — Save again to overwrite, or Read again for the saved values.')
    expect(conflictMessage([])).toBe('Settings changed on the server. Your edits are kept — Save again to overwrite, or Read again for the saved values.')
  })

  it('reads again from the refresh when it landed, else from the 409 snapshot', () => {
    const cached = { org: 'acme', me: 'octocat', timezone: 'Europe/Berlin', chat: { branchPrefix: 'agent/', idleTimeoutMinutes: 0, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 } }
    expect(rereadValue('timezone', null, 'Europe/Helsinki', cached, true)).toBe('Europe/Berlin')
    expect(rereadValue('timezone', null, 'Europe/Helsinki', cached, false)).toBe('Europe/Helsinki')
    expect(rereadValue('chat', 'idleTimeoutMinutes', 120, cached, true)).toBe(0)
    expect(rereadValue('chat', null, { idleTimeoutMinutes: 120 }, cached, true)).toEqual(cached.chat)
    expect(rereadValue('me', null, 'other', cached, true)).toBe('octocat')
    expect(rereadValue('agentAccount', null, 'bot', cached, true)).toBe('')
    expect(rereadValue('manager', null, { rhythm: 1 }, cached, true)).toEqual({ rhythm: 1 })
  })

  it('compares values structurally', () => {
    expect(deepEqual({ a: 1, b: { c: [2] } }, { b: { c: [2] }, a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual('a', 'a')).toBe(true)
  })
})
