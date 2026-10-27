import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: { me: 'octocat', agentAccount: 'robot', org: 'alpha', timezone: 'UTC' },
  org: '',
  interval: 60_000,
}))
vi.mock('../src/config', () => ({
  getSettings: () => state.settings,
  effectiveTimezone: () => state.settings.timezone,
  getRefreshRateMs: () => state.interval,
}))
vi.mock('../src/organizations', () => ({
  getSelectedOrganization: () => state.org,
  organizationUrl: (path: string, org: string) => org ? `${path}&org=${org}` : path,
}))
vi.mock('../src/analytics-day', () => ({
  analyticsDay: (offset: number, anchor: Date) => {
    const since = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate() + offset)).toISOString()
    return { since, until: new Date(Date.parse(since) + 86_400_000).toISOString(), baselineSince: new Date(Date.parse(since) - 7 * 86_400_000).toISOString() }
  },
  analyticsDailyBounds: () => Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 9, 2 + i)).toISOString()),
}))

const anchor = new Date('2026-10-09T10:00:00Z')
function response() {
  return Response.json({
    window: { since: null, until: null }, agentAccount: 'robot', issues: { opened: 1, closed: 0 }, errors: [],
    pullRequests: { opened: 1, closedUnmerged: 0, merged: 0, mergedByAgent: 0, firstReview: { count: 0, medianMs: null },
      commentsPerPr: null, lines: { total: null, median: null, counted: 0 }, behaviors: { perPr: null, approvals: 0, reviews: 0, changesRequested: 0 },
      averageTimeToMergeMs: null, medianTimeToMergeMs: null },
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.setSystemTime(anchor)
  state.settings = { me: 'octocat', agentAccount: 'robot', org: 'alpha', timezone: 'UTC' }
  state.org = ''
  vi.stubGlobal('fetch', vi.fn(async () => response()))
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('prepared Analytics snapshots', () => {
  it('shares a pending preparation with entry and retains the actual read time until expiry', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    vi.mocked(fetch).mockImplementation(async () => { await held; return response() })
    const { readAnalyticsSnapshot, preparedAnalytics } = await import('../src/analytics-snapshot')
    const pending = readAnalyticsSnapshot(0, anchor)
    expect(readAnalyticsSnapshot(0, anchor)).toBe(pending)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(preparedAnalytics(0, anchor)).toBeNull()
    release()
    const snapshot = await pending
    vi.setSystemTime(new Date(anchor.getTime() + 12_000))
    expect(preparedAnalytics(0, anchor)).toBe(snapshot)
    expect(snapshot.capturedAt).toBe(anchor.getTime())
    vi.setSystemTime(new Date(anchor.getTime() + state.interval + 1))
    expect(preparedAnalytics(0, anchor)).toBeNull()
  })

  it.each(['me', 'agentAccount', 'org', 'timezone'] as const)('never reuses another %s setting', async key => {
    const { readAnalyticsSnapshot, preparedAnalytics } = await import('../src/analytics-snapshot')
    await readAnalyticsSnapshot(0, anchor)
    state.settings[key] = 'changed'
    expect(preparedAnalytics(0, anchor)).toBeNull()
  })

  it('isolates selected organizations and calendar dates', async () => {
    const { readAnalyticsSnapshot, preparedAnalytics } = await import('../src/analytics-snapshot')
    await readAnalyticsSnapshot(0, anchor)
    state.org = 'beta'
    expect(preparedAnalytics(0, anchor)).toBeNull()
    state.org = ''
    expect(preparedAnalytics(-1, anchor)).toBeNull()
    expect(preparedAnalytics(0, new Date('2026-10-10T10:00:00Z'))).toBeNull()
  })

  it('retries an aborted read without sharing its rejected promise', async () => {
    vi.mocked(fetch).mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const { readAnalyticsSnapshot } = await import('../src/analytics-snapshot')
    const controller = new AbortController()
    const first = readAnalyticsSnapshot(0, anchor, controller.signal)
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    vi.mocked(fetch).mockImplementation(async () => response())
    const second = readAnalyticsSnapshot(0, anchor)
    expect(second).not.toBe(first)
    await rejected
    expect((await second).report.issues.opened).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('retains a complete prepared snapshot when a later account read becomes unavailable', async () => {
    const { readAnalyticsSnapshot, preparedAnalytics } = await import('../src/analytics-snapshot')
    const original = await readAnalyticsSnapshot(0, anchor)
    vi.mocked(fetch).mockImplementation(async () => Response.json({ ...await response().json(), errors: [{ org: 'alpha', error: 'offline' }] }))
    const degraded = await readAnalyticsSnapshot(0, anchor)
    expect(degraded.report.errors).toHaveLength(1)
    expect(preparedAnalytics(0, anchor)).toBe(original)
    vi.mocked(fetch).mockRejectedValue(new Error('connection reset'))
    await expect(readAnalyticsSnapshot(0, anchor)).rejects.toThrow('connection reset')
    expect(preparedAnalytics(0, anchor)).toBe(original)
  })

  it.each([{}, { window: {}, issues: {}, pullRequests: {}, errors: [{}] }])('rejects malformed preparation envelopes through the read error path', async payload => {
    vi.mocked(fetch).mockImplementation(async () => Response.json(payload))
    const { readAnalyticsSnapshot, preparedAnalytics } = await import('../src/analytics-snapshot')
    await expect(readAnalyticsSnapshot(0, anchor)).rejects.toThrow('Analytics returned an invalid report')
    expect(preparedAnalytics(0, anchor)).toBeNull()
  })
})
