export const GITHUB_QUOTA_REFRESH_MS = 15_000

export interface GithubQuotaBucket {
  resource: string
  label: string
  limit: number
  used: number
  remaining: number
  resetAt: string
  perMinute: number | null
  riskPercent: number | null
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
