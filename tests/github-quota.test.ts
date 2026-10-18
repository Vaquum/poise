import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { quotaHours, quotaRiskTone } from '../src/github-quota'
import type { GithubQuotaAccount } from '../src/github-quota'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...(await original<typeof import('../server/process')>()), runFile: mocks.runFile,
}))

let root: string
let database: typeof import('../server/db')
let quota: typeof import('../server/github-quota')
let alerts: typeof import('../server/alerts/store')
const T0 = Date.parse('2026-10-17T12:00:00Z')
const reset = T0 / 1000 + 3600
const payload = (used = 100, resets = reset, limit = 5000) => ({ resources: {
  core: { used, remaining: limit - used, limit, reset: resets },
  graphql: { used: 0, remaining: 5000, limit: 5000, reset: resets },
  search: { used: 0, remaining: 30, limit: 30, reset: T0 / 1000 + 60 },
} })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-github-quota-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.resetModules()
  database = await import('../server/db')
  quota = await import('../server/github-quota')
  alerts = await import('../server/alerts/store')
  mocks.runFile.mockReset()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

afterEach(async () => {
  await quota.stopGithubQuotaRuntime()
  database.closeDatabase()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('estimated exhaustion risk', () => {
  it('computes a Poisson tail, including stable large budgets and idle or exhausted budgets', () => {
    expect(quota.exhaustionRisk(1, Math.log(2))).toBe(50)
    expect(quota.exhaustionRisk(10, 10)).toBe(54)
    expect(quota.exhaustionRisk(5000, 10000)).toBe(100)
    expect(quota.exhaustionRisk(5000, 1)).toBe(0)
    expect(quota.exhaustionRisk(5000, 5000)).toBe(50)
    expect(quota.exhaustionRisk(1, 0)).toBe(0)
    expect(quota.exhaustionRisk(0, 0)).toBe(100)
  })

  it('colors only positive risk in the requested thirds', () => {
    expect([null, 0, 1, 33, 34, 66, 67, 100].map(quotaRiskTone)).toEqual(['', '', 'yellow', 'yellow', 'orange', 'orange', 'red', 'red'])
  })

  it('measures recent consumption without assuming an hourly start, and drops old windows', () => {
    const first = quota.quotaBuckets(payload(), 'octocat', T0)
    expect(first[0]).toMatchObject({ perMinute: null, riskPercent: null })
    expect(first[2].resetAt).toBe(new Date(T0 + 60_000).toISOString())
    const second = quota.quotaBuckets(payload(200), 'octocat', T0 + 60_000)
    expect(second[0]).toMatchObject({ perMinute: 100, riskPercent: 100 })
    expect(second[1]).toMatchObject({ perMinute: 0, riskPercent: 0 })
    expect(quota.quotaBuckets(payload(150), 'octocat', T0 + 90_000)[0].perMinute).toBeNull()
    expect(quota.quotaBuckets(payload(0, reset + 3600), 'octocat', T0 + 120_000)[0]).toMatchObject({ perMinute: null, riskPercent: null })
    expect(quota.quotaBuckets(payload(10), 'octocat', T0 + 600_000)[0].perMinute).toBeNull()
    expect(quota.quotaBuckets(payload(5000), 'other', T0)[0].riskPercent).toBe(100)
    expect(quota.quotaBuckets(payload(0, reset, 0), 'disabled', T0)[0].riskPercent).toBeNull()
    expect(quota.quotaBuckets(payload(5000), 'expired', T0 + 3_600_000)[0].riskPercent).toBeNull()
    expect(() => quota.quotaBuckets({ resources: { core: { limit: 5 } } }, 'bad', T0)).toThrow('Invalid GitHub')
  })

  it('can estimate exhaustion inside a one-minute search window', () => {
    quota.quotaBuckets(payload(), 'octocat', T0)
    const next = payload()
    next.resources.search.used = 10
    next.resources.search.remaining = 20
    const search = quota.quotaBuckets(next, 'octocat', T0 + 15_000)[2]
    expect(search.perMinute).toBe(40)
    expect(search.riskPercent).toBeGreaterThan(0)
  })
})

describe('identity-scoped reads', () => {
  it('pins each request to its stored credential and shares concurrent/cache reads', async () => {
    database.setMeta('me', 'Octocat')
    database.setMeta('agentAccount', 'octo-agent')
    const credentials = new Map([['Octocat', 'token-user'], ['octo-agent', 'token-automation']])
    mocks.runFile.mockImplementation(async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === 'auth') {
        const token = credentials.get(args.at(-1)!)
        if (!token) throw new Error('Stored account not found with this casing')
        return { stdout: token }
      }
      expect(options.env.GH_TOKEN).toMatch(/^token-(user|automation)$/)
      return { stdout: JSON.stringify(payload()) }
    })
    const [first, second] = await Promise.all([quota.readGithubQuota(), quota.readGithubQuota()])
    expect(first).toEqual(second)
    expect(first.accounts.map((account) => [account.login, account.roles])).toEqual([['Octocat', ['user']], ['octo-agent', ['automation']]])
    expect(first.accounts.every((account) => account.error === null)).toBe(true)
    expect(mocks.runFile).toHaveBeenCalledTimes(4)
    expect(mocks.runFile.mock.calls[0][2].env).toMatchObject({ GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_ENTERPRISE_TOKEN: undefined })
    await quota.readGithubQuota()
    expect(mocks.runFile).toHaveBeenCalledTimes(4)
    database.setMeta('agentAccount', 'OCTOCAT')
    const shared = await quota.readGithubQuota()
    expect(shared.accounts).toHaveLength(1)
    expect(shared.accounts[0].roles).toEqual(['user', 'automation'])
    expect(mocks.runFile).toHaveBeenCalledTimes(4)
  })

  it('expires the cache from request start so CLI latency does not skip the next tick', async () => {
    database.setMeta('me', 'Octocat')
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      vi.setSystemTime(Date.now() + 100)
      return { stdout: args[0] === 'auth' ? 'test-token' : JSON.stringify(payload()) }
    })
    await quota.readGithubQuota()
    expect(Date.now()).toBe(T0 + 200)
    vi.setSystemTime(T0 + 15_000)
    await quota.readGithubQuota()
    expect(mocks.runFile).toHaveBeenCalledTimes(4)
  })

  it('reports account failures without stderr secrets and preserves the other account', async () => {
    database.setMeta('me', 'octocat')
    database.setMeta('agentAccount', 'octo-agent')
    mocks.runFile.mockImplementation(async (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      if (args[0] === 'auth') return { stdout: `token-${args.at(-1)}` }
      if (options.env.GH_TOKEN === 'token-octocat') throw new Error('token-octocat ghp_secret')
      return { stdout: JSON.stringify(payload()) }
    })
    const result = await quota.readGithubQuota()
    expect(result.accounts[0]).toMatchObject({ error: expect.stringContaining('could not be read'), buckets: [] })
    expect(result.accounts[1].error).toBeNull()
    expect(JSON.stringify(result)).not.toMatch(/token-|ghp_secret/)
  })

  it('does not publish results for identities changed during a read', async () => {
    database.setMeta('me', 'octocat')
    mocks.runFile.mockImplementation(async () => {
      database.setMeta('me', 'other')
      return { stdout: JSON.stringify(payload(5000)) }
    })
    await expect(quota.readGithubQuota()).rejects.toThrow('accounts changed')
    expect(alerts.openAlerts()).toEqual([])
  })
})

describe('quota notifications', () => {
  const account = (used: number, riskPercent: number | null, error: string | null = null): GithubQuotaAccount => ({
    login: 'octocat', roles: ['user'], checkedAt: new Date(T0).toISOString(), error,
    buckets: error ? [] : [{ resource: 'core', label: 'REST API', limit: 5000, used, remaining: 5000 - used, resetAt: new Date(reset * 1000).toISOString(), perMinute: 100, riskPercent }],
  })

  it('deduplicates, updates risk, escalates after dismissal, and clears on reset or removal', () => {
    quota.syncQuotaAlerts([account(100, 25)], T0)
    const warning = alerts.openAlerts()[0]
    alerts.dismissAlert(warning.seq)
    quota.syncQuotaAlerts([account(200, 90)], T0 + 60_000)
    expect(alerts.latestAlertSeq()).toBe(warning.seq)
    expect(alerts.openAlerts()[0].body).toContain('90%')
    expect(alerts.openAlerts()[0].dismissedAt).not.toBeNull()
    quota.syncQuotaAlerts([account(5000, 100)], T0 + 120_000)
    expect(alerts.openAlerts()).toHaveLength(1)
    expect(alerts.openAlerts()[0]).toMatchObject({ kind: 'github_quota_exhausted', dismissedAt: null })
    quota.syncQuotaAlerts([account(0, null, 'Network unavailable')], reset * 1000)
    expect(alerts.openAlerts()).toHaveLength(0)
    quota.syncQuotaAlerts([account(5000, 100)], T0)
    quota.syncQuotaAlerts([], T0 + 60_000)
    expect(alerts.openAlerts()).toHaveLength(0)
  })

  it('keeps known risk on failed reads, clears recovery, and respects Notifications off', async () => {
    quota.syncQuotaAlerts([account(100, 25)], T0)
    quota.syncQuotaAlerts([account(0, null, 'Network unavailable')], T0 + 60_000)
    expect(alerts.openAlerts()).toHaveLength(1)
    quota.syncQuotaAlerts([account(100, null)], T0 + 90_000)
    expect(alerts.openAlerts()).toHaveLength(1)
    quota.syncQuotaAlerts([account(100, 0)], T0 + 120_000)
    expect(alerts.openAlerts()).toHaveLength(0)
    database.setMeta('notification_settings', JSON.stringify({ enabled: false }))
    database.setMeta('me', 'octocat')
    quota.syncQuotaAlerts([account(5000, 100)], T0)
    quota.startGithubQuotaRuntime()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(mocks.runFile).not.toHaveBeenCalled()
    expect(alerts.openAlerts()).toHaveLength(0)
  })

  it('clears exhaustion on confirmed remaining quota even while the rate is unknown', () => {
    const exhausted = quota.quotaBuckets(payload(5000), 'octocat', T0)[0]
    quota.syncQuotaAlerts([{ ...account(5000, 100), buckets: [exhausted] }], T0)
    expect(alerts.openAlerts()[0].kind).toBe('github_quota_exhausted')
    const recovered = quota.quotaBuckets(payload(100), 'octocat', T0 + 15_000)[0]
    expect(recovered).toMatchObject({ remaining: 4900, perMinute: null, riskPercent: null })
    quota.syncQuotaAlerts([{ ...account(100, null), buckets: [recovered] }], T0 + 15_000)
    expect(alerts.openAlerts()).toHaveLength(0)
  })

  it('monitors while Analytics is closed and stops cleanly', async () => {
    database.setMeta('me', 'octocat')
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify(payload(5000)) })
    quota.startGithubQuotaRuntime()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(alerts.openAlerts()[0].kind).toBe('github_quota_exhausted')
    await quota.stopGithubQuotaRuntime()
    const count = mocks.runFile.mock.calls.length
    await vi.advanceTimersByTimeAsync(180_000)
    expect(mocks.runFile).toHaveBeenCalledTimes(count)
  })
})

describe('quota chart observations', () => {
  it('persists one latest snapshot per hour across resets and restarts without extra upstream reads', async () => {
    quota.quotaBuckets(payload(100), 'octocat', T0)
    quota.quotaBuckets(payload(300), 'octocat', T0 + 60_000)
    let bucket = quota.quotaBuckets(payload(40, reset + 3600), 'octocat', T0 + 3_600_000)[0]
    expect(bucket.history?.map((sample) => sample.used)).toEqual([300, 40])
    vi.resetModules()
    quota = await import('../server/github-quota')
    database = await import('../server/db')
    bucket = quota.quotaBuckets(payload(50, reset + 7200), 'octocat', T0 + 7_200_000)[0]
    expect(bucket.history?.map((sample) => sample.used)).toEqual([300, 40, 50])
    expect(mocks.runFile).not.toHaveBeenCalled()
    bucket = quota.quotaBuckets(payload(20, reset + 8 * 86_400), 'octocat', T0 + 8 * 86_400_000)[0]
    expect(bucket.history).toHaveLength(1)
    expect(bucket.history?.[0].used).toBe(20)
  })

  it('gives exactly 24 slots and leaves unobserved hours unknown', () => {
    const samples = [{ at: T0, used: 100, remaining: 4900, limit: 5000 }]
    const hours = quotaHours(samples, T0 + 3_600_000)
    expect(hours).toHaveLength(24)
    expect(hours.filter(Boolean)).toEqual(samples)
    expect(hours[22]).toEqual(samples[0])
    expect(hours[23]).toBeNull()
  })
})

it('retains exactly 168 hourly slots including this hour after a full week', () => {
  const now = T0 + 30 * 60_000
  const history = Array.from({ length: 169 }, (_, i) => ({ at: now - (168 - i) * 3_600_000, used: i, remaining: 5000 - i, limit: 5000 }))
  database.setMeta('github-quota:hours:octocat:core', JSON.stringify(history))
  const bucket = quota.quotaBuckets(payload(200), 'octocat', now)[0]
  expect(bucket.history).toHaveLength(168)
  expect(bucket.history?.[0].at).toBe(now - 167 * 3_600_000)
  expect(bucket.history?.at(-1)?.used).toBe(200)
})
