import { describe, expect, it } from 'vitest'
import { isRiskPressured, quotaRiskKey } from '../server/quota-risk'

describe('quota pressure', () => {
  it('keys risk state by account and resource', () => {
    expect(quotaRiskKey('Review-Bot', 'graphql')).toBe('github-quota:risk:review-bot:graphql')
  })

  it('treats a sustained warning and exhaustion as pressure', () => {
    const now = Date.now()
    const resetAt = new Date(now + 3_600_000).toISOString()
    expect(isRiskPressured(JSON.stringify({ resetAt, since: now - 60_000, lastAt: now, warned: true }), now)).toBe(true)
    expect(isRiskPressured(JSON.stringify({ resetAt, since: null, lastAt: now, warned: false, exhaustedSince: now - 1000 }), now)).toBe(true)
  })

  it('treats missing, corrupt and expired state as no pressure', () => {
    const now = Date.now()
    expect(isRiskPressured(null, now)).toBe(false)
    expect(isRiskPressured('not json', now)).toBe(false)
    expect(isRiskPressured(JSON.stringify({ resetAt: new Date(now - 1000).toISOString(), since: now - 60_000, lastAt: now, warned: true }), now)).toBe(false)
    expect(isRiskPressured(JSON.stringify({ resetAt: new Date(now + 3_600_000).toISOString(), since: null, lastAt: now, warned: false }), now)).toBe(false)
  })
})
