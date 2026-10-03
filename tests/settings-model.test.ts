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
    expect(s).toEqual({ org: 'Vaquum', me: 'mikkokotila', agentAccount: '', timezone: 'Europe/Helsinki', models: {}, chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } })
  })

  it('refuses a pasted URL rather than storing something no query can use', () => {
    expect(() => setSettings({ org: 'https://github.com/Vaquum' })).toThrow(/GitHub name/)
    expect(() => setSettings({ me: 'me@example.com' })).toThrow(/GitHub name/)
  })

  it('refuses a name that starts or ends with a hyphen', () => {
    expect(() => setSettings({ org: '-leading' })).toThrow(/GitHub name/)
    expect(() => setSettings({ org: 'trailing-' })).toThrow(/GitHub name/)
  })

  it('allows clearing a field back to empty', () => {
    setSettings({ org: 'Vaquum', me: 'mikkokotila' })
    expect(setSettings({ org: '' }).org).toBe('')
  })

  it('ignores a field that is not a string instead of coercing it', () => {
    setSettings({ org: 'Vaquum' })
    expect(setSettings({ org: undefined, me: 'mikkokotila' }).org).toBe('Vaquum')
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
    expect(getSettings()).toEqual({ org: 'Vaquum', me: 'mikkokotila', agentAccount: '', timezone: 'UTC', models: {}, chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120 } })
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
    expect(() => requireAgentAccount()).toThrow('No agent account is set. Set it in Settings → GitHub')
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
