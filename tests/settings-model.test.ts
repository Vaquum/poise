import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG } from './model-catalog-fixture'

// server/settings.ts is the whole persisted settings model. It writes through
// setMeta, and now also drops the org-scoped repo cache when the org changes.
const mocks = vi.hoisted(() => ({
  store: new Map<string, string>(),
  invalidateRepoListCache: vi.fn(),
}))

vi.mock('../server/db', () => ({
  // As the database answers: null for a key never written.
  getMeta: (k: string) => mocks.store.get(k) ?? null,
  setMeta: (k: string, v: string) => { mocks.store.set(k, v) },
}))
vi.mock('../server/gh', () => ({ invalidateRepoListCache: mocks.invalidateRepoListCache }))

const { agentAccount, callerAccounts, getSettings, isReady, requireAgentAccount, seedAgentAccount, setSettings } = await import('../server/settings')

beforeEach(() => {
  mocks.store.clear()
  mocks.invalidateRepoListCache.mockClear()
})

describe('what the settings model accepts', () => {
  it('stores a well-formed org, username and timezone', () => {
    const s = setSettings({ org: ' Vaquum ', me: ' mikkokotila ', timezone: 'Europe/Helsinki' })
    expect(s).toEqual({ org: 'Vaquum', me: 'mikkokotila', agentAccount: '', timezone: 'Europe/Helsinki', models: {}, chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }, notifications: { enabled: true }, manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 0 } })
  })

  it('refuses a pasted URL rather than storing something no query can use', () => {
    expect(() => setSettings({ org: 'https://github.com/Vaquum' })).toThrow(/GitHub name/)
    expect(() => setSettings({ me: 'me@example.com' })).toThrow(/GitHub name/)
  })

  it('refuses a name that starts or ends with a hyphen', () => {
    expect(() => setSettings({ org: '-leading' })).toThrow(/GitHub name/)
    expect(() => setSettings({ org: 'trailing-' })).toThrow(/GitHub name/)
  })

  it('refuses consecutive hyphens in your account and the agent account, naming the single-hyphen rule', () => {
    expect(() => setSettings({ me: 'a--b' })).toThrow(/single hyphens/)
    expect(() => setSettings({ agentAccount: 'x--y' })).toThrow(/single hyphens/)
    expect(() => setSettings({ me: '  a--b  ' })).toThrow(/single hyphens/)
    expect(() => setSettings({ agentAccount: 'A--B' })).toThrow(/single hyphens/)
  })

  it('still saves single-hyphen, single-character and 39-character account names', () => {
    expect(setSettings({ me: 'a-b' }).me).toBe('a-b')
    expect(setSettings({ me: 'a' }).me).toBe('a')
    expect(setSettings({ me: 'a'.repeat(39) }).me).toBe('a'.repeat(39))
    expect(setSettings({ agentAccount: 'ab-cd-ef' }).agentAccount).toBe('ab-cd-ef')
    expect(() => setSettings({ me: 'a'.repeat(40) })).toThrow(/GitHub name/)
  })

  it('keeps the legacy org on the shape check, so a stored value cannot brick Settings saves', () => {
    expect(setSettings({ org: 'a--b' }).org).toBe('a--b')
  })

  it('grandfathers a stored consecutive-hyphen value a save does not change', () => {
    mocks.store.set('me', 'a--b')
    mocks.store.set('agentAccount', 'x--y')
    expect(setSettings({ me: 'a--b', timezone: 'UTC' })).toMatchObject({ me: 'a--b', timezone: 'UTC' })
    expect(setSettings({ agentAccount: 'x--y' }).agentAccount).toBe('x--y')
    expect(() => setSettings({ me: 'c--d' })).toThrow(/single hyphens/)
    expect(() => setSettings({ agentAccount: 'z--w' })).toThrow(/single hyphens/)
  })

  it('allows clearing a field back to empty', () => {
    setSettings({ org: 'Vaquum', me: 'mikkokotila' })
    expect(setSettings({ org: '' }).org).toBe('')
  })

  it('ignores a field that is not a string instead of coercing it', () => {
    setSettings({ org: 'Vaquum' })
    expect(setSettings({ org: undefined, me: 'mikkokotila' }).org).toBe('Vaquum')
  })

  it('refuses a time zone Intl does not know, naming it, and changes nothing of that save', () => {
    setSettings({ org: 'acme', me: 'mikkokotila', timezone: 'UTC' })
    const before = getSettings()
    mocks.invalidateRepoListCache.mockClear()
    expect(() => setSettings({ org: 'new-org', me: 'octocat', timezone: 'Mars/Olympus' }))
      .toThrow('timezone must be a time zone the Poise server knows, such as Europe/Helsinki; "Mars/Olympus" is not one')
    expect(getSettings()).toEqual(before)
    expect(mocks.invalidateRepoListCache).not.toHaveBeenCalled()
  })

  it('names at most 100 characters of a refused time zone', () => {
    expect(() => setSettings({ timezone: 'x'.repeat(1000) })).toThrow(`; "${'x'.repeat(100)}…" is not one`)
  })

  it('reports the first refused field, in the order org, me, agent account, time zone', () => {
    expect(() => setSettings({ timezone: 'Mars/Olympus', me: 'not a name' })).toThrow(/^me must be a GitHub name/)
  })

  // Intl here (Node 22, ICU 78) accepts any letter case and both spellings of
  // Kolkata, and spells them its own way (Asia/Kolkata as Asia/Calcutta). That
  // spelling differs between ICU versions, so a zone is stored as given.
  it('stores the zones Intl knows as given, UTC, aliases and other letter cases included', () => {
    for (const zone of ['Europe/Helsinki', 'europe/helsinki', 'UTC', 'Etc/UTC', 'Asia/Kolkata', 'Asia/Calcutta']) expect(setSettings({ timezone: zone }).timezone).toBe(zone)
  })

  it('clears the time zone with an empty or blank one, and ignores one that is not a string', () => {
    setSettings({ timezone: 'UTC' })
    expect(setSettings({ timezone: 123 as unknown as string }).timezone).toBe('UTC')
    expect(setSettings({ timezone: '   ' }).timezone).toBe('')
    setSettings({ timezone: 'UTC' })
    expect(setSettings({ timezone: '' }).timezone).toBe('')
  })
})

// The write loop applied key by key, so a value rejected halfway through left
// the keys before it already written — a save that reported failure but had
// partly happened.
describe('a rejected save changes nothing at all', () => {
  it('does not keep the valid half of an invalid update', () => {
    setSettings({ org: 'Vaquum', me: 'mikkokotila', timezone: 'UTC' })
    expect(() => setSettings({ timezone: 'Europe/Berlin', org: 'not a valid org' })).toThrow()
    // The timezone in the same call must not have landed.
    expect(getSettings()).toEqual({ org: 'Vaquum', me: 'mikkokotila', agentAccount: '', timezone: 'UTC', models: {}, chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 }, notifications: { enabled: true }, manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 0 } })
  })

  it('does not keep the valid half when consecutive hyphens reject the other half', () => {
    setSettings({ me: 'octocat', timezone: 'UTC' })
    expect(() => setSettings({ timezone: 'Europe/Berlin', me: 'a--b' })).toThrow(/single hyphens/)
    expect(getSettings()).toMatchObject({ me: 'octocat', timezone: 'UTC' })
  })
})

describe('the agent account', () => {
  it('is saved beside your own account and must be a GitHub login', () => {
    expect(setSettings({ me: 'octocat', agentAccount: ' review-bot ' })).toMatchObject({ me: 'octocat', agentAccount: 'review-bot' })
    expect(() => setSettings({ agentAccount: 'https://github.com/review-bot' })).toThrow('agentAccount must be a GitHub name')
    expect(() => setSettings({ agentAccount: 'bot@example.com', timezone: 'UTC' })).toThrow(/GitHub name/)
    expect(getSettings()).toMatchObject({ agentAccount: 'review-bot', timezone: '' })
    expect(setSettings({ agentAccount: '' }).agentAccount).toBe('')
  })

  it('is required, with where to set it, by anything that posts as it', () => {
    expect(() => requireAgentAccount()).toThrow('No agent account is set. Set it in Settings → General')
    setSettings({ agentAccount: 'review-bot' })
    expect(requireAgentAccount()).toBe('review-bot')
    // A hand-edited database is not trusted either.
    mocks.store.set('agentAccount', 'not a login')
    expect(() => requireAgentAccount()).toThrow('not a GitHub username')
  })

  it('is seeded by REVIEW_AGENT_USERNAME only on the first start without one', () => {
    seedAgentAccount(' seeded-bot ')
    expect(agentAccount()).toBe('seeded-bot')
    seedAgentAccount('other-bot')
    expect(agentAccount()).toBe('seeded-bot')
    // Cleared in Settings stays cleared.
    setSettings({ agentAccount: '' })
    seedAgentAccount('other-bot')
    expect(agentAccount()).toBe('')
  })

  it('takes no seed from an empty or malformed REVIEW_AGENT_USERNAME', () => {
    seedAgentAccount(undefined)
    seedAgentAccount('  ')
    expect(mocks.store.has('agentAccount')).toBe(false)
    expect(() => seedAgentAccount('not a login')).toThrow('REVIEW_AGENT_USERNAME must be a GitHub username')
    expect(mocks.store.has('agentAccount')).toBe(false)
  })

  it('reaches Caller as your account and the agent account, each only when set', () => {
    expect(callerAccounts()).toEqual({})
    setSettings({ me: 'octocat' })
    expect(callerAccounts()).toEqual({ GITHUB_INTERFACE_USER: 'octocat' })
    setSettings({ agentAccount: 'review-bot' })
    expect(callerAccounts()).toEqual({ GITHUB_INTERFACE_USER: 'octocat', GITHUB_INTERFACE_AGENT_USER: 'review-bot' })
  })
})

// The repo list is scoped to the organization, so it cannot survive a change
// of organization — the pickers would keep offering the old org's repos, and
// opening an issue against one would go somewhere else entirely.
describe('changing the organization drops the org-scoped repo cache', () => {
  it('invalidates when the org actually changes', () => {
    setSettings({ org: 'Vaquum' })
    expect(mocks.invalidateRepoListCache).toHaveBeenCalledTimes(1)
  })

  it('does not invalidate when the org is re-saved unchanged', () => {
    setSettings({ org: 'Vaquum' })
    mocks.invalidateRepoListCache.mockClear()
    setSettings({ org: 'Vaquum', me: 'mikkokotila' })
    expect(mocks.invalidateRepoListCache).not.toHaveBeenCalled()
  })
})

describe('the concurrent local turns cap', () => {
  const chat = (maxConcurrentLocalTurns: number) => ({ branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns, updateTurnBoundMinutes: 15 })
  it('defaults to 4 and accepts 1 through 64', () => {
    expect(getSettings().chat).toMatchObject({ maxConcurrentLocalTurns: 4 })
    expect(setSettings({ chat: chat(1) }).chat.maxConcurrentLocalTurns).toBe(1)
    expect(setSettings({ chat: chat(64) }).chat.maxConcurrentLocalTurns).toBe(64)
  })

  it('refuses anything outside 1 through 64 without saving it', () => {
    for (const value of [0, 65, 1.5, Number.NaN, 'four']) {
      expect(() => setSettings({ chat: chat(value as never) })).toThrow(/concurrent local turns/)
    }
    expect(getSettings().chat.maxConcurrentLocalTurns).toBe(4)
  })

  it('falls back to 4 for a corrupt stored value', () => {
    mocks.store.set('chat_settings', JSON.stringify({ branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 0 }))
    expect(getSettings().chat.maxConcurrentLocalTurns).toBe(4)
    mocks.store.set('chat_settings', 'not json')
    expect(getSettings().chat).toEqual({ branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 })
  })
})

describe('the update turn bound', () => {
  const chat = (updateTurnBoundMinutes: number) => ({ branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes })
  it('defaults to 15 and accepts 1 through 10080', () => {
    expect(getSettings().chat).toMatchObject({ updateTurnBoundMinutes: 15 })
    expect(setSettings({ chat: chat(1) }).chat.updateTurnBoundMinutes).toBe(1)
    expect(setSettings({ chat: chat(10080) }).chat.updateTurnBoundMinutes).toBe(10080)
  })

  it('refuses anything outside 1 through 10080 without saving it', () => {
    for (const value of [0, 10081, 1.5, Number.NaN, 'fifteen']) {
      expect(() => setSettings({ chat: chat(value as never) })).toThrow(/update turn bound/)
    }
    expect(getSettings().chat.updateTurnBoundMinutes).toBe(15)
  })

  it('falls back to 15 for a corrupt stored value', () => {
    mocks.store.set('chat_settings', JSON.stringify({ branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 0 }))
    expect(getSettings().chat.updateTurnBoundMinutes).toBe(15)
    mocks.store.set('chat_settings', 'not json')
    expect(getSettings().chat).toEqual({ branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 })
  })
})

describe('readiness', () => {
  it('needs both an org and a username', () => {
    expect(isReady()).toBe(false)
    setSettings({ org: 'Vaquum' })
    expect(isReady()).toBe(false)
    setSettings({ me: 'mikkokotila' })
    expect(isReady()).toBe(true)
  })
})


describe('model choices per place', () => {
  const catalog = CATALOG as any

  it('stores a default and fallback per place and keeps them across unrelated saves', () => {
    expect(getSettings().models).toEqual({})
    const chosen = { pr_review: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' } }
    expect(setSettings({ models: chosen }, catalog).models).toEqual(chosen)
    expect(setSettings({ timezone: 'UTC' }).models).toEqual(chosen)
    const more = setSettings({ models: { chat: { default: 'grok-4.6-xhigh', fallback: 'opus-5-max' } } }, catalog).models
    expect(more).toEqual({ ...chosen, chat: { default: 'grok-4.6-xhigh', fallback: 'opus-5-max' } })
  })

  it('reads the pre-identity review preference until it is saved over', () => {
    mocks.store.set('reviewModel', 'astra')
    expect(getSettings().models).toEqual({
      pr_review: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' },
      pr_approve: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' },
    })
    mocks.store.set('reviewModel', 'opus')
    expect(getSettings().models).toEqual({})
  })

  it('rejects choices the catalog cannot honor without partially saving other settings', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ chat: { default: 'opus', fallback: 'opus-5-max' } }, /from the catalog/],
      [{ pr_review: { default: 'grok-4.6-xhigh', fallback: 'grok-4.6-xhigh' } }, /differ/],
      [{ chat: { default: 'opus-5-max', fallback: 'opus-5-max' } }, /differ/],
      [{ content: { default: 'opus-5-max', fallback: 'opus-5-xhigh' } }, /unknown model place/],
      [[], /object of places/],
    ]
    for (const [models, message] of cases) {
      expect(() => setSettings({ org: 'Vaquum', models: models as any }, catalog)).toThrow(message)
      expect(getSettings().org).toBe('')
      expect(getSettings().models).toEqual({})
    }
    expect(() => setSettings({ models: { chat: { default: 'opus-5-max', fallback: 'grok-4.6-high' } } })).toThrow(/catalog is unavailable/)
  })
})

describe('the Manager controls', () => {
  const manager = (overrides: Record<string, unknown> = {}) => ({
    rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, ...overrides,
  })

  it('starts unconfigured with the defaults and no policy version', () => {
    expect(getSettings().manager).toEqual({ rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 0 })
  })

  it('stores changed controls and reads them back with a bumped version', () => {
    const first = setSettings({ manager: manager({ rhythm: 1, paused: true }) as never })
    expect(first.manager).toEqual({ rhythm: 1, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: true, version: 1 })
    expect(getSettings().manager).toEqual(first.manager)
    const second = setSettings({ manager: manager({ rhythm: 1, paused: true }) as never })
    expect(second.manager.version).toBe(1)
    const third = setSettings({ manager: { autonomy: 'Ask first' } as never })
    expect(third.manager).toMatchObject({ autonomy: 'Ask first', rhythm: 1, paused: true, version: 2 })
  })

  it('keeps the scope it is given, null or listed', () => {
    expect(setSettings({ manager: manager({ scope: ['acme/api'] }) as never }).manager.scope).toEqual(['acme/api'])
    expect(setSettings({ manager: { scope: null } as never }).manager.scope).toBeNull()
  })

  it('rejects bad values without storing anything', () => {
    const cases: Array<[unknown, RegExp]> = [
      ['rhythm', /manager settings must be an object/],
      [{ rhythm: 0 }, /between 1 and 10/],
      [{ rhythm: 11 }, /between 1 and 10/],
      [{ rhythm: 2.5 }, /between 1 and 10/],
      [{ stability: 'Reckless' }, /one of/],
      [{ autonomy: 'YOLO' }, /one of/],
      [{ scope: ['nope'] }, /owner\/name/],
      [{ scope: 'acme/api' }, /owner\/name/],
      [{ paused: 'yes' }, /true or false/],
    ]
    for (const [value, message] of cases) {
      expect(() => setSettings({ manager: value as never })).toThrow(message)
      expect(getSettings().manager).toEqual({ rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 0 })
    }
  })

  it('ignores a version the caller sends: the server owns it', () => {
    const saved = setSettings({ manager: { rhythm: 2, version: 99 } as never })
    expect(saved.manager).toMatchObject({ rhythm: 2, version: 1 })
  })
})
