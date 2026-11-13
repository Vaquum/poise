// GitHub API quota in Overview (O13): one card per account, REST and GraphQL,
// live every 15 seconds whatever the day. Classic Analytics' read and words
// (src/views/analytics-view.ts, src/github-quota.ts).
import { GITHUB_QUOTA_REFRESH_MS, quotaHours, quotaRiskTone, type GithubQuotaReport } from '../../../github-quota'
import { noticeFeed, type ReadFailure } from '../../../notices'
import { placeHref } from '../../address'
import { esc } from '../../dom'
import { bar } from './charts'
import type { RightFilter } from './find'
import { clockAt, json, reason, readLine, unread, whileVisible, type Read, type PartContext } from './util'

// Classic's yellow, orange and red, in the new interface's words.
const TONE: Record<string, string> = { '': 'ok', yellow: 'low', orange: 'mid', red: 'high' }

export function mountQuota(ctx: PartContext, box: HTMLElement, find: RightFilter): void {
  let quota: Read<GithubQuotaReport> = unread()
  const n = (value: number) => value.toLocaleString('en-US')

  function paint(): void {
    const now = Date.now()
    if (!quota.data) {
      box.innerHTML = `<div class="oquota" data-ref="ov.quota"><p class="onote${quota.error ? ' is-warn' : ''}" role="status">${quota.error ? `${esc(readLine('GitHub API quota', quota))} It tries again every 15 seconds.` : 'Reading the API quota…'}</p></div>`
      return
    }
    if (!quota.data.accounts.length) {
      box.innerHTML = `<div class="oquota" data-ref="ov.quota"><p class="onote">GitHub quota needs configured accounts. Set your GitHub user and automation accounts in <a class="lnk" href="${esc(placeHref('settings', { settings: 'general', back: 'overview' }))}">Settings → General</a>.</p></div>`
      return
    }
    const stale = quota.error ? `<p class="onote is-warn" role="status" data-ref="ov.read">${esc(readLine('GitHub API quota', quota))}</p>` : ''
    const accounts = quota.data.accounts.filter((account) => find.matches(account.login, 'GitHub API', ...account.roles.map((role) => role === 'automation' ? 'automation account' : 'your account')))
    if (!accounts.length) { box.innerHTML = `${stale}<div class="oquota" data-ref="ov.quota"><p class="onote" role="status">${esc(find.none())}</p></div>`; return }
    box.innerHTML = `${stale}<div class="oquota" data-ref="ov.quota">${accounts.map((account) => `<div class="qa"><p class="qa-h"><span class="t-mono">${esc(account.login)}</span><span class="t-gloss">${esc(account.roles.map((role) => role === 'automation' ? 'automation account' : 'your account').join(' + '))}</span></p>
      ${account.error ? `<p class="onote is-warn">Unavailable: ${esc(account.error)}${account.checkedAt ? ` Last read at ${clockAt(account.checkedAt)}.` : ''}</p>` : account.buckets.filter((bucket) => bucket.resource === 'core' || bucket.resource === 'graphql').map((bucket) => {
        const minutes = Math.max(0, (Date.parse(bucket.resetAt) - now) / 60_000)
        const risk = minutes > 0 ? bucket.riskPercent : null
        const tone = TONE[quotaRiskTone(risk)] ?? 'ok'
        const hours = quotaHours((bucket.history ?? []).filter((sample) => sample.at <= now && sample.limit > 0), now)
        return `<div class="qb is-${tone}" data-ref="ov.bucket"><p class="qb-h"><b>${bucket.resource === 'core' ? 'REST' : 'GraphQL'}</b><span class="qrisk is-${tone}" data-ref="ov.risk">${risk === null ? 'collecting samples' : `${risk}% risk${bucket.remaining === 0 ? ' · exhausted' : ''}`}</span></p>
          ${bucket.limit ? bar('qbar', (bucket.used / bucket.limit) * 100) : ''}
          <p class="qb-n">${n(bucket.used)} of ${n(bucket.limit)} used · ${n(bucket.remaining)} left · resets ${clockAt(bucket.resetAt)}, in ${Math.round(minutes)} min</p>
          <p class="qb-n">${bucket.perMinute === null ? '—' : `${n(Math.round(bucket.perMinute * 10) / 10)} a minute now`} · ${(bucket.remaining / Math.max(minutes, 1 / 60)).toFixed(1)} a minute would last</p>
          <svg class="qhours" viewBox="0 0 96 20" preserveAspectRatio="none" role="img" aria-label="Use in each of the last 24 hours">${hours.map((sample, i) => sample ? `<rect class="q-hr" x="${i * 4 + 0.5}" y="${(20 - (sample.used / sample.limit) * 20).toFixed(1)}" width="3" height="${((sample.used / sample.limit) * 20).toFixed(1)}"><title>${esc(clockAt(sample.at))}: ${n(sample.used)} used · ${n(sample.remaining)} left</title></rect>` : '').join('')}</svg></div>`
      }).join('')}</div>`).join('')}</div>`
  }

  async function read(): Promise<void> {
    try {
      const data = await json<GithubQuotaReport>('/api/github-quota')
      if (!Array.isArray(data?.accounts)) throw new Error('the service answered with something this page cannot read')
      quota = { data, error: '', at: Date.now() }
      const failures: ReadFailure[] = data.accounts.flatMap((account) => account.error ? [{ key: `quota:${account.login.toLowerCase()}`, title: `GitHub quota for ${account.login} is unavailable`, body: account.error }] : [])
      noticeFeed.reportReadErrors('overview-quota', failures)
    } catch (error) {
      // A failed read keeps what was read, with when.
      quota = { ...quota, error: reason(error) }
      noticeFeed.reportReadErrors('overview-quota', [{ key: 'overview-quota', title: 'GitHub quota is unavailable', body: reason(error) }])
    }
    paint()
  }

  paint()
  whileVisible(ctx, GITHUB_QUOTA_REFRESH_MS, () => { void read() })
  find.onChange(paint)
  ctx.signal.addEventListener('abort', () => noticeFeed.reportReadErrors('overview-quota', []))
}
