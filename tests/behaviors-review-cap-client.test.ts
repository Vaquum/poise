import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The browser-side mirror of the review-round cap, under node with fetch and
// window stubbed like tests/behaviors-client-state.test.ts.
type BehaviorsModule = typeof import('../src/behaviors')

let behaviors: BehaviorsModule

function state(reviewCap: unknown): Record<string, unknown> {
  return {
    'approve-prs': { enabled: true, reviewCap, scratchpad: '', lastTriggered: null, owner: null },
    diagnostics: null,
  }
}

beforeEach(async () => {
  vi.stubGlobal('window', { dispatchEvent: () => true, CustomEvent })
  vi.resetModules()
  behaviors = await import('../src/behaviors')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('review cap client mirror', () => {
  it('is off until the server says otherwise', async () => {
    expect(behaviors.getReviewCap('approve-prs')).toBeNull()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => state(5) }))
    await behaviors.refreshState()
    expect(behaviors.getReviewCap('approve-prs')).toBe(5)
    expect(behaviors.isReviewCap(5)).toBe(true)
    expect(behaviors.isReviewCap(1)).toBe(false)
    expect(behaviors.isReviewCap(null)).toBe(false)
  })

  it('ignores an invalid cap from the server', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => state(1) }))
    await behaviors.refreshState()
    expect(behaviors.getReviewCap('approve-prs')).toBeNull()
  })

  it('saves the cap and restores it when the save fails', async () => {
    const posts: Array<{ url: string, body: unknown }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) })
        return { ok: true, status: 200, json: async () => ({ reviewCap: 5 }) }
      }
      return { ok: true, json: async () => state(null) }
    })
    await behaviors.refreshState()
    await behaviors.setSettingFields('approve-prs', { reviewCap: 5 })
    expect(posts).toEqual([{ url: '/api/behaviors/approve-prs', body: { reviewCap: 5 } }])
    expect(behaviors.getReviewCap('approve-prs')).toBe(5)

    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: false, status: 400, json: async () => ({ error: 'nope' }) }
      return { ok: true, json: async () => state(5) }
    })
    await expect(behaviors.setSettingFields('approve-prs', { reviewCap: null })).rejects.toThrow('nope')
    expect(behaviors.getReviewCap('approve-prs')).toBe(5)
  })
})
