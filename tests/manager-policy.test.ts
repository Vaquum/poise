import { beforeEach, describe, expect, it, vi } from 'vitest'

// The effective policy block: the Manager controls with the wording the
// person chose between, the policy version, and the precedence.
const mocks = vi.hoisted(() => ({ store: new Map<string, string>() }))

vi.mock('../server/db', () => ({
  getMeta: (k: string) => mocks.store.get(k) ?? null,
  setMeta: (k: string, v: string) => { mocks.store.set(k, v) },
  db: { transaction: (fn: (...args: never[]) => unknown) => fn },
}))
vi.mock('../server/gh', () => ({ invalidateRepoListCache: vi.fn() }))

const { managerPolicyBlock } = await import('../server/chat/manager-policy')
const { setSettings } = await import('../server/settings')

beforeEach(() => {
  mocks.store.clear()
})

describe('the effective policy', () => {
  it('carries the defaults with version zero and the precedence', () => {
    expect(managerPolicyBlock()).toBe([
      '[Manager controls — policy version 0.]',
      'Rhythm: 5 Manager slots.',
      'Stability: Balanced — "Tell me first, and install minor releases automatically."',
      'Autonomy: Balanced — decides "The routine work." Brings "Anything irreversible, and anything you\'re unsure about."',
      'Scope: every followed repository.',
      'Paused: no.',
      'Precedence: a direct request from the person in this chat first, then these controls, then the charter, then Memories.',
    ].join('\n'))
  })

  it('carries changed controls with their wording and version', () => {
    setSettings({ manager: { rhythm: 1, stability: 'Full expansion', autonomy: 'Ask first', scope: ['acme/api', 'acme/web'], paused: true } as never })
    expect(managerPolicyBlock()).toBe([
      '[Manager controls — policy version 1.]',
      'Rhythm: 1 Manager slot.',
      'Stability: Full expansion — "Install releases automatically."',
      'Autonomy: Ask first — decides "Nothing on my behalf." Brings "Everything: review and approve all of it."',
      'Scope: acme/api, acme/web.',
      'Paused: yes — new work waits until the person resumes.',
      'Precedence: a direct request from the person in this chat first, then these controls, then the charter, then Memories.',
    ].join('\n'))
  })

  it('names an empty scope as no repositories', () => {
    setSettings({ manager: { scope: [] } as never })
    expect(managerPolicyBlock()).toContain('Scope: no repositories.')
  })
})
