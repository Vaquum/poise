export const GITHUB_QUOTA_REFRESH_MS = 15_000

export interface GithubQuotaObservation {
  at: number
  used: number
  remaining: number
  limit: number
}

export interface GithubQuotaBucket {
  resource: string
  label: string
  limit: number
  used: number
  remaining: number
  resetAt: string
  perMinute: number | null
  riskPercent: number | null
  /** Latest observed snapshot in each hour; absent hours stay unknown. */
  history?: GithubQuotaObservation[]
}

export interface GithubQuotaAccount {
  login: string
  roles: Array<'user' | 'automation'>
  checkedAt: string | null
  error: string | null
  buckets: GithubQuotaBucket[]
}

export interface GithubQuotaReport { accounts: GithubQuotaAccount[] }

export function quotaRiskTone(percent: number | null): string {
  return percent === null || percent === 0 ? '' : percent <= 100 / 3 ? 'yellow' : percent <= 200 / 3 ? 'orange' : 'red'
}

/** Exactly 24 hourly slots, including the current hour, without filling gaps. */
export function quotaHours(history: GithubQuotaObservation[], now: number): Array<GithubQuotaObservation | null> {
  const hour = 3_600_000
  const end = Math.floor(now / hour) * hour
  return Array.from({ length: 24 }, (_, i) => history.find((sample) => Math.floor(sample.at / hour) * hour === end - (23 - i) * hour) ?? null)
}
