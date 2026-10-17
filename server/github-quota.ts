import { GH_STORED_ACCOUNTS_ENV } from './accounts/clis'
import { openAlerts, raiseAlert, resolveAlert, updateAlertDetails } from './alerts/store'
import { getMeta, setMeta } from './db'
import { runFile } from './process'
import { getNotificationSettings, getSettings } from './settings'
import { GITHUB_QUOTA_REFRESH_MS, type GithubQuotaAccount, type GithubQuotaBucket, type GithubQuotaReport } from '../src/github-quota'

export const QUOTA_INTERVAL_MS = GITHUB_QUOTA_REFRESH_MS
const HISTORY_MS = 5 * 60_000
const RESOURCES = { core: 'REST API', graphql: 'GraphQL', search: 'Search', code_search: 'Code search' }
const PREFIX = 'github-quota:'
interface Sample { at: number, used: number, reset: number }
interface Snapshot { checkedAt: number, buckets: GithubQuotaBucket[], error: string | null }
const cache = new Map<string, { snapshot: Snapshot, expiresAt: number }>()
const pending = new Map<string, Promise<Snapshot>>()

/** Poisson tail P(requests before reset >= remaining), conditional on a
 * constant rate. Log-space summation avoids underflow for hourly budgets. */
export function exhaustionRisk(remaining: number, expected: number): number {
  if (remaining <= 0) return 100
  if (expected <= 0) return 0
  let term = -expected
  let cdf = term
  for (let k = 1; k < remaining; k++) {
    term += Math.log(expected) - Math.log(k)
    const high = Math.max(cdf, term)
    cdf = high + Math.log1p(Math.exp(Math.min(cdf, term) - high))
  }
  return Math.round(Math.max(0, Math.min(1, -Math.expm1(Math.min(0, cdf)))) * 100)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub quota response')
  return value as Record<string, unknown>
}

export function quotaBuckets(value: unknown, login: string, now: number): GithubQuotaBucket[] {
  const resources = object(object(value).resources)
  if (!resources.core) throw new Error('GitHub quota response is missing REST API limits')
  const histories: Array<[string, Sample[]]> = []
  const buckets = Object.entries(RESOURCES).flatMap(([resource, label]): GithubQuotaBucket[] => {
    if (resources[resource] === undefined) return []
    const row = object(resources[resource])
    const { limit, used, remaining, reset } = row
    if (![limit, used, remaining, reset].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
      || typeof limit !== 'number' || typeof used !== 'number' || typeof remaining !== 'number' || typeof reset !== 'number'
      || limit > 1_000_000 || used + remaining !== limit || reset > 8_640_000_000_000) throw new Error(`Invalid GitHub ${label} quota`)
    const key = `${PREFIX}samples:${login}:${resource}`
    const stored = getMeta(key)
    const history = stored ? JSON.parse(stored) as Sample[] : []
    const samples = history.at(-1) && history.at(-1)!.used > used ? [] : history.filter((sample) => sample.reset === reset && sample.at >= now - HISTORY_MS && sample.at < now)
    const first = samples[0]
    const perMinute = first && now - first.at >= QUOTA_INTERVAL_MS ? (used - first.used) * 60_000 / (now - first.at) : null
    histories.push([key, [...samples, { at: now, used, reset }].slice(-21)])
    const minutesLeft = Math.max(0, (reset * 1000 - now) / 60_000)
    return [{ resource, label, limit, used, remaining, resetAt: new Date(reset * 1000).toISOString(), perMinute,
      riskPercent: limit === 0 || minutesLeft === 0 ? null : remaining === 0 ? 100 : perMinute === null ? null : exhaustionRisk(remaining, perMinute * minutesLeft) }]
  })
  for (const [key, samples] of histories) setMeta(key, JSON.stringify(samples))
  return buckets
}

function configuredAccounts(): Array<Pick<GithubQuotaAccount, 'login' | 'roles'>> {
  const { me, agentAccount } = getSettings()
  const accounts = new Map<string, Pick<GithubQuotaAccount, 'login' | 'roles'>>()
  for (const [name, role] of [[me, 'user'], [agentAccount, 'automation']] as const) {
    if (!name) continue
    const key = name.toLowerCase()
    const account = accounts.get(key) ?? { login: name, roles: [] }
    account.roles.push(role)
    accounts.set(key, account)
  }
  return [...accounts.values()]
}

async function readAccount(login: string): Promise<Snapshot> {
  const key = login.toLowerCase()
  const cached = cache.get(key)
  if (cached && Date.now() < cached.expiresAt
    && cached.snapshot.buckets.every((bucket) => Date.parse(bucket.resetAt) > Date.now() || bucket.limit === 0)) return cached.snapshot
  const active = pending.get(key)
  if (active) return active
  const startedAt = Date.now()
  const read = (async (): Promise<Snapshot> => {
    let token: string
    try {
      token = (await runFile('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login], {
        env: GH_STORED_ACCOUNTS_ENV, timeoutMs: 10_000, maxOutputBytes: 64 * 1024,
      })).stdout.trim()
      if (!token) throw new Error('Empty credential')
    } catch {
      return { checkedAt: Date.now(), buckets: [], error: `GitHub authentication is unavailable for ${login}. Connect this account in Settings → Accounts.` }
    }
    try {
      const result = await runFile('gh', ['api', 'rate_limit', '--hostname', 'github.com'], {
        env: { ...GH_STORED_ACCOUNTS_ENV, GH_HOST: 'github.com', GH_TOKEN: token }, timeoutMs: 10_000, maxOutputBytes: 256 * 1024,
      })
      const now = Date.now()
      return { checkedAt: now, buckets: quotaBuckets(JSON.parse(result.stdout), key, now), error: null }
    } catch {
      // Neither the credential command nor HTTP stderr may expose a token.
      return { checkedAt: Date.now(), buckets: [], error: `GitHub API quota could not be read for ${login}. It will be checked again shortly.` }
    }
  })()
  pending.set(key, read)
  try {
    const snapshot = await read
    cache.set(key, { snapshot, expiresAt: startedAt + QUOTA_INTERVAL_MS })
    return snapshot
  } finally { pending.delete(key) }
}

export function syncQuotaAlerts(accounts: GithubQuotaAccount[], now = Date.now()): void {
  if (!getNotificationSettings().enabled) return
  const standing = new Set<string>()
  for (const account of accounts) {
    for (const bucket of account.buckets) {
      if (bucket.limit === 0 || Date.parse(bucket.resetAt) <= now || !bucket.riskPercent) continue
      const exhausted = bucket.remaining === 0
      const key = `${PREFIX}${account.login.toLowerCase()}:${bucket.resource}:${Date.parse(bucket.resetAt)}:${exhausted ? 'error' : 'warning'}`
      standing.add(key)
      const title = exhausted ? `GitHub ${bucket.label} quota exhausted for ${account.login}` : `GitHub ${bucket.label} quota may run out for ${account.login}`
      const body = `${account.roles.join(' + ')} account · ${bucket.used.toLocaleString('en-US')} of ${bucket.limit.toLocaleString('en-US')} used. ${exhausted ? 'Requests are blocked.' : `${bucket.riskPercent}% estimated risk before reset at the observed usage rate.`} Resets ${bucket.resetAt}.`
      raiseAlert({
        kind: exhausted ? 'github_quota_exhausted' : 'github_quota_warning', dedupeKey: key,
        title, body,
        path: '/',
      }, now)
      updateAlertDetails(key, title, body)
    }
  }
  for (const alert of openAlerts({ now })) {
    if (!alert.dedupeKey.startsWith(PREFIX) || standing.has(alert.dedupeKey)) continue
    const [, login, resource, reset] = alert.dedupeKey.split(':')
    const account = accounts.find((entry) => entry.login.toLowerCase() === login)
    const bucket = account?.buckets.find((entry) => entry.resource === resource)
    const known = !account?.error && bucket && (bucket.riskPercent !== null
      || (alert.kind === 'github_quota_exhausted' && bucket.remaining > 0)
      || bucket.limit === 0 || Date.parse(bucket.resetAt) !== Number(reset))
    if (!account || known || Number(reset) <= now) resolveAlert(alert.dedupeKey, now)
  }
}

export async function readGithubQuota(): Promise<GithubQuotaReport> {
  const configured = configuredAccounts()
  const accounts = await Promise.all(configured.map(async (account): Promise<GithubQuotaAccount> => {
    const snapshot = await readAccount(account.login)
    return { ...account, ...snapshot, checkedAt: new Date(snapshot.checkedAt).toISOString() }
  }))
  if (JSON.stringify(configured) !== JSON.stringify(configuredAccounts())) throw new Error('GitHub accounts changed while reading quota; retry.')
  syncQuotaAlerts(accounts)
  return { accounts }
}

let timer: ReturnType<typeof setInterval> | undefined
let pass: Promise<void> | undefined
export function checkGithubQuota(): void {
  if (pass || !getNotificationSettings().enabled) return
  pass = readGithubQuota().then(() => undefined).catch((error: unknown) => {
    console.error('[github-quota] monitor failed:', error)
  }).finally(() => { pass = undefined })
}

export function startGithubQuotaRuntime(): void {
  if (timer) return
  timer = setInterval(checkGithubQuota, QUOTA_INTERVAL_MS)
  timer.unref?.()
}

export async function stopGithubQuotaRuntime(): Promise<void> {
  clearInterval(timer)
  timer = undefined
  await pass
}
