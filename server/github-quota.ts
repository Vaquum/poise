import { normalize } from '../gateway/src/diagnostics/contract'
import type { EvidenceSelector } from '../gateway/src/diagnostics/query-evidence'
import { loggingWorkspace } from './logging'
import { diagnostic, diagnosticFailure } from './logging'
import { GH_STORED_ACCOUNTS_ENV } from './accounts/clis'
import { quotaRiskKey as riskKey } from './quota-risk'
import { openAlerts, raiseAlert, resolveAlert, updateAlertDetails } from './alerts/store'
import { getMeta, setMeta } from './db'
import { runFile } from './process'
import { getNotificationSettings, getSettings, knownTimeZone } from './settings'
import { zonedTime } from '../src/clock'
import { GITHUB_QUOTA_REFRESH_MS, type GithubQuotaAccount, type GithubQuotaBucket, type GithubQuotaReport, type GithubQuotaObservation } from '../src/github-quota'

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
  const histories: Array<[string, string]> = []
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
    histories.push([key, JSON.stringify([...samples, { at: now, used, reset }].slice(-21))])
    let observations: GithubQuotaObservation[] | undefined
    if (resource === 'core' || resource === 'graphql') {
      const observationKey = `${PREFIX}hours:${login}:${resource}`
      const persisted = getMeta(observationKey)
      const hour = Math.floor(now / 3_600_000)
      const previous: GithubQuotaObservation[] = persisted ? JSON.parse(persisted) : []
      observations = [...previous.filter((sample) => Math.floor(sample.at / 3_600_000) >= hour - 167 && Math.floor(sample.at / 3_600_000) < hour), { at: now, used, remaining, limit }]
      histories.push([observationKey, JSON.stringify(observations)])
    }
    const minutesLeft = Math.max(0, (reset * 1000 - now) / 60_000)
    return [{ resource, label, limit, used, remaining, resetAt: new Date(reset * 1000).toISOString(), perMinute, ...(observations ? { history: observations } : {}),
      riskPercent: limit === 0 || minutesLeft === 0 ? null : remaining === 0 ? 100 : perMinute === null ? null : exhaustionRisk(remaining, perMinute * minutesLeft) }]
  })
  for (const [key, value] of histories) setMeta(key, value)
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
    } catch (error) {
      diagnosticFailure('github_quota.authentication', error, { account: login, phase: 'credential_lookup' }, { stderr: false, level: 'warning' })
      return { checkedAt: Date.now(), buckets: [], error: `GitHub authentication is unavailable for ${login}. Connect this account in Settings → Accounts.` }
    }
    try {
      const result = await runFile('gh', ['api', 'rate_limit', '--hostname', 'github.com'], {
        env: { ...GH_STORED_ACCOUNTS_ENV, GH_HOST: 'github.com', GH_TOKEN: token }, timeoutMs: 10_000, maxOutputBytes: 256 * 1024,
      })
      const now = Date.now()
      const buckets = quotaBuckets(JSON.parse(result.stdout), key, now)
      for (const bucket of buckets) {
        const was = cached?.snapshot.buckets.find((prior) => prior.resource === bucket.resource && prior.resetAt === bucket.resetAt)
        if (bucket.remaining === 0 && was?.remaining !== 0) diagnostic({ level: 'error', operation: 'github_quota.exhausted',
          account: login, target: bucket.resource, condition: bucket.resetAt, message: 'GitHub API budget is exhausted',
          context: { resource: bucket.resource, used: bucket.used, remaining: bucket.remaining, limit: bucket.limit, resetAt: bucket.resetAt, measuredAt: new Date(now).toISOString() } })
      }
      return { checkedAt: now, buckets, error: null }
    } catch (error) {
      diagnosticFailure('github_quota.read', error, { account: login, phase: 'rate_limit' }, { secrets: [token], level: 'warning' })
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

export const QUOTA_WARNING_RISK_PERCENT = 50
export const QUOTA_WARNING_SUSTAIN_MS = 30_000
/** A quota observation older than this means the monitor has stopped refreshing it. */
export const QUOTA_OBSERVATION_STALE_MS = 5 * 60_000
interface RiskWindow { resetAt: string; since: number | null; lastAt: number; warned: boolean; exhaustedSince?: number | null }
const conditionKey = (login: string, bucket: GithubQuotaBucket) => `${PREFIX}${login.toLowerCase()}:${bucket.resource}:${Date.parse(bucket.resetAt)}`

/** Observe actual snapshots even with popups off; cached reads cannot extend a risk interval. */
export function observeQuotaConditions(accounts: GithubQuotaAccount[], now = Date.now()): ReadonlySet<string> {
  const sustained = new Set<string>()
  for (const account of accounts) {
    if (account.error || !account.checkedAt) continue
    const at = Date.parse(account.checkedAt)
    if (!Number.isFinite(at) || at > now) throw new Error('Invalid GitHub quota observation time')
    for (const bucket of account.buckets) {
      const key = riskKey(account.login, bucket.resource)
      const raw = getMeta(key)
      let previous: RiskWindow | null = null
      if (raw) {
        const value = object(JSON.parse(raw))
        if (typeof value.resetAt !== 'string' || !Number.isFinite(Date.parse(value.resetAt))
          || (value.since !== null && (typeof value.since !== 'number' || !Number.isFinite(value.since)))
          || (value.exhaustedSince !== undefined && value.exhaustedSince !== null && (typeof value.exhaustedSince !== 'number' || !Number.isFinite(value.exhaustedSince)))
          || typeof value.lastAt !== 'number' || !Number.isFinite(value.lastAt) || typeof value.warned !== 'boolean') throw new Error('Invalid retained GitHub quota risk interval')
        previous = value as unknown as RiskWindow
      }
      const eligible = bucket.limit > 0 && bucket.remaining > 0 && Date.parse(bucket.resetAt) > now && bucket.riskPercent !== null && bucket.riskPercent >= QUOTA_WARNING_RISK_PERCENT
      const state: RiskWindow = previous?.resetAt === bucket.resetAt && previous.lastAt <= at
        ? { ...previous } : { resetAt: bucket.resetAt, since: null, lastAt: at, warned: false }
      state.exhaustedSince = bucket.remaining === 0 && Date.parse(bucket.resetAt) > now ? state.exhaustedSince ?? at : null
      // Positive capacity is authoritative even before a forecast can be computed.
      if (bucket.riskPercent === null) { setMeta(key, JSON.stringify(state)); continue }
      if (!eligible) { state.since = null; state.warned = false }
      else if (state.since === null) state.since = at
      state.lastAt = Math.max(state.lastAt, at)
      if (eligible && state.since !== null && state.lastAt - state.since >= QUOTA_WARNING_SUSTAIN_MS) {
        sustained.add(conditionKey(account.login, bucket))
        if (!state.warned) state.warned = diagnostic({ id: `quota-warning:${account.login.toLowerCase()}:${bucket.resource}:${bucket.resetAt}:${state.since}`,
          level: 'warning', operation: 'github_quota.warning', account: account.login, target: bucket.resource, condition: bucket.resetAt,
          message: 'GitHub API budget has sustained exhaustion risk', context: { resource: bucket.resource, riskPercent: bucket.riskPercent,
            used: bucket.used, remaining: bucket.remaining, limit: bucket.limit, perMinute: bucket.perMinute, resetAt: bucket.resetAt,
            measuredAt: account.checkedAt, riskSince: new Date(state.since).toISOString(), sustainMs: state.lastAt - state.since } }) !== null
      }
      setMeta(key, JSON.stringify(state))
    }
  }
  return sustained
}

// The notice is read on the desktop too, so its reset time names its zone:
// Settings' zone, or UTC while none is saved or the saved one is not one this
// server's Intl knows (Settings refuses those; the browser names them).
function noticeZone(): string {
  const { timezone } = getSettings()
  return timezone && knownTimeZone(timezone) ? timezone : 'UTC'
}

export function syncQuotaAlerts(accounts: GithubQuotaAccount[], now = Date.now(), observed?: ReadonlySet<string>): void {
  const enabled = getNotificationSettings().enabled
  const zone = noticeZone()
  const sustained = observed ?? observeQuotaConditions(accounts, now)
  const standing = new Set<string>()
  const existing = new Set(openAlerts({ now }).map((alert) => alert.dedupeKey))
  for (const account of accounts) {
    for (const bucket of account.buckets) {
      if (bucket.limit === 0 || Date.parse(bucket.resetAt) <= now) continue
      const exhausted = bucket.remaining === 0
      const key = `${PREFIX}${account.login.toLowerCase()}:${bucket.resource}:${Date.parse(bucket.resetAt)}:${exhausted ? 'error' : 'warning'}`
      // An upgrade has no observation history. An unchanged existing condition
      // keeps its identity and dismissal until an actual recovery.
      if (!exhausted && (bucket.riskPercent === null || bucket.riskPercent < QUOTA_WARNING_RISK_PERCENT
        || (!sustained.has(conditionKey(account.login, bucket)) && !existing.has(key)))) continue
      standing.add(key)
      const title = exhausted ? `GitHub ${bucket.label} quota exhausted for ${account.login}` : `GitHub ${bucket.label} quota may run out for ${account.login}`
      const body = `${account.roles.join(' + ')} account · ${bucket.used.toLocaleString('en-US')} of ${bucket.limit.toLocaleString('en-US')} used. ${exhausted ? 'Requests are blocked.' : `${bucket.riskPercent}% estimated risk before reset at the observed usage rate.`} Resets at ${zonedTime(bucket.resetAt, zone, now)}.`
      if (!enabled) continue
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
  const now = Date.now()
  const observed = observeQuotaConditions(accounts, now)
  syncQuotaAlerts(accounts, now, observed)
  return { accounts }
}

let timer: ReturnType<typeof setInterval> | undefined
let pass: Promise<void> | undefined
/** The monitor's last failure, so health can report it instead of only logging it. */
let monitorError: string | null = null
export function checkGithubQuota(): void {
  if (pass) return
  pass = readGithubQuota().then(() => {
    monitorError = null
  }).catch((error: unknown) => {
    monitorError = error instanceof Error ? error.message : String(error)
    console.error('[github-quota] monitor failed:', error)
  }).finally(() => { pass = undefined })
}

export interface GithubQuotaSnapshot {
  login: string
  roles: string[]
  /** ISO time of the cached observation, or null when never observed. */
  checkedAt: string | null
  /** How old the cached observation is; null when never observed. */
  observationAgeMs: number | null
  /** Resources with no budget left until reset; valid zero-limit buckets excluded. */
  exhausted: string[]
  /** Why the account has no usable observation, when it has none. */
  error: string | null
}

/** Cached quota observations only: health projects them without running
 *  any `gh` subprocess. An account reads stale only when the monitor that
 *  refreshes it has stopped. */
export function githubQuotaSnapshots(now = Date.now()): GithubQuotaSnapshot[] {
  return configuredAccounts().map((account) => {
    const cached = cache.get(account.login.toLowerCase())
    if (!cached) return { ...account, checkedAt: null, observationAgeMs: null, exhausted: [], error: monitorError }
    const exhausted = cached.snapshot.error ? [] : cached.snapshot.buckets
      .filter((bucket) => bucket.limit > 0 && bucket.remaining === 0 && Date.parse(bucket.resetAt) > now)
      .map((bucket) => bucket.resource)
    return {
      ...account,
      checkedAt: new Date(cached.snapshot.checkedAt).toISOString(),
      observationAgeMs: Math.max(0, now - cached.snapshot.checkedAt),
      exhausted,
      error: cached.snapshot.error,
    }
  })
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

/** The observed condition begins independently of when Notifications is enabled. */
export function quotaEvidenceSelector(account: string, resource: string, resetAt: string, exhausted: boolean): EvidenceSelector | null {
  const raw = getMeta(riskKey(account, resource))
  if (!raw) return null
  const state = object(JSON.parse(raw))
  if (state.resetAt !== resetAt) return null
  const since = exhausted ? state.exhaustedSince : state.since
  if (typeof since !== 'number' || !Number.isFinite(since) || since < 0) return null
  const operation = exhausted ? 'github_quota.exhausted' : 'github_quota.warning'
  const canonical = normalize({ id: `quota-warning:${account.toLowerCase()}:${resource}:${resetAt}:${since}`, level: 'warning', source: 'poise',
    operation, account, target: resource, condition: resetAt, message: '', workspace: loggingWorkspace() })!
  return { source: 'poise', operation, account, target: resource, ...(exhausted
    ? { incidentId: canonical.incidentId, from: new Date(since).toISOString() }
    : { eventId: canonical.id }) }
}
