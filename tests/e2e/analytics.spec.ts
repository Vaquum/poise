import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AnalyticsReport } from '../../src/analytics-format'
import type { AnalyticsHistory } from '../../src/analytics-history'
import type { GithubQuotaReport } from '../../src/github-quota'

function report(merged: number, hours = 27): AnalyticsReport {
  return {
    window: { since: null, until: null },
    agentAccount: 'octo-agent',
    issues: { opened: 12, closed: 9 },
    pullRequests: {
      opened: 5,
      closedUnmerged: 1,
      merged,
      mergedByAgent: merged ? merged - 1 : 0,
      firstReview: { count: 3, medianMs: hours > 30 ? 150_000 : 75_000 },
      commentsPerPr: merged ? 3.25 : null,
      medianCommentsPerPr: merged ? 3 : null,
      lines: { total: merged ? 4210 : null, median: merged ? 180 : null, counted: merged ? merged - 1 : 0 },
      behaviors: { medianPerPr: merged ? 2 : null, perPr: merged ? 2 : null, approvals: merged, reviews: merged, changesRequested: 0 },
      averageTimeToMergeMs: merged ? hours * 3_600_000 : null,
      medianTimeToMergeMs: merged ? hours / 4.5 * 3_600_000 : null,
    },
    errors: [],
  }
}

// A year of deterministic 7-day periods between the requested edges.
function history(bounds: string[]): AnalyticsHistory {
  return { errors: [], periods: bounds.slice(1).map((until, i) => {
    const quiet = i % 13 === 0
    const merged = quiet ? 0 : 7 + i % 5
    return { since: bounds[i], until, issues: { opened: i % 9, closed: (i * 3) % 7 },
      pullRequests: { ...report(merged).pullRequests, lines: { total: quiet ? null : 700 + 50 * (i % 6), median: quiet ? null : 100 + i, counted: merged }, averageTimeToMergeMs: quiet ? null : (10 + i % 7) * 3_600_000, medianTimeToMergeMs: quiet ? null : (10 + i % 7) * 3_600_000 } }
  }) }
}

interface Workspace {
  historyReads: Array<{ bounds: string[], org: string | null }>
  historyFails: boolean
  reads: Array<{ since: string | null, until: string | null, org: string | null }>
  fail: boolean
  stale: boolean
  baselineHours: number
  baselineMerged: number
  pacing: { merged: number, median: number } | null
}

async function workspace(page: Page, timezone = 'UTC'): Promise<Workspace> {
  const state: Workspace = { historyReads: [], historyFails: false, reads: [], fail: false, stale: false, baselineHours: 54, baselineMerged: 8, pacing: null }
  await page.clock.setFixedTime(new Date('2026-10-09T12:00:00Z'))
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.clear()
    localStorage.setItem('poise-view', 'current')
    localStorage.setItem('poise-current-filters', JSON.stringify({ time: 'week', status: 'all' }))
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  const organizations = ['acme', 'beta'].map((login) => ({ login, managed: true, status: 'ready', stage: 'ready', error: null, activatedAt: '2026-10-01T08:00:00Z' }))
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/analytics/history') {
      const bounds = url.searchParams.get('bounds')!.split(',')
      state.historyReads.push({ bounds, org: url.searchParams.get('org') })
      if (state.historyFails) return route.fulfill({ status: 502, json: { error: 'acme: datastore offline' } })
      return route.fulfill({ json: history(bounds) })
    }
    if (url.pathname === '/api/analytics') {
      const read = { since: url.searchParams.get('since'), until: url.searchParams.get('until'), org: url.searchParams.get('org') }
      state.reads.push(read)
      if (state.fail) return route.fulfill({ status: 502, json: { error: 'acme: datastore offline' } })
      const baseline = Date.parse(read.until!) - Date.parse(read.since!) > 2 * 86_400_000
      const result = baseline ? report(state.baselineMerged, state.baselineHours) : report(state.pacing?.merged ?? (read.since === '2026-10-08T00:00:00.000Z' ? 0 : 4))
      result.window = { since: read.since, until: read.until }
      if (state.stale) result.errors = [{ org: 'acme', error: 'Synchronization failed', stale: true }]
      if (baseline) result.daily = Array.from({ length: 7 }, () => {
        const pullRequests = report(state.pacing?.median ?? 1).pullRequests
        if (state.pacing) pullRequests.lines = { total: pullRequests.merged * 1000, median: 180, counted: pullRequests.merged }
        return { issues: { opened: 2, closed: 1 }, pullRequests }
      })
      if (state.pacing) result.pullRequests.lines = { total: result.pullRequests.merged * 1000, median: 180, counted: result.pullRequests.merged }
      return route.fulfill({ json: result })
    }
    if (url.pathname === '/api/settings') return route.fulfill({ json: { org: 'acme', me: 'octocat', timezone, organizations, models: {} } })
    if (url.pathname === '/api/organizations') return route.fulfill({ json: { organizations } })
    if (url.pathname === '/api/gh') return route.fulfill({ json: { records: [], count: 0, errors: [] } })
    if (url.pathname === '/api/current') return route.fulfill({ json: { cards: [] } })
    if (url.pathname === '/api/repos') return route.fulfill({ json: { repos: [] } })
    if (url.pathname === '/api/agent-logs') return route.fulfill({ json: { logs: [] } })
    if (url.pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    if (url.pathname === '/api/notices') return route.fulfill({ json: { enabled: false, notices: [] } })
    if (url.pathname === '/api/github-quota') return route.fulfill({ json: { accounts: [] } })
    return route.fulfill({ json: {} })
  })
  return state
}

async function openAnalytics(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('#menu-popover').getByRole('button', { name: 'Analytics', exact: true }).click()
  await expect(page.locator('#view-analytics')).toBeVisible()
  await expect(page.locator('#menu-surface')).toBeHidden()
}

// Leaving is choosing another view; there is no panel to close.
async function leaveAnalytics(page: Page) {
  await page.locator('#top-nav').getByRole('button', { name: 'Current', exact: true }).click()
  await expect(page.locator('#view-analytics')).toBeHidden()
}

function mergeTrend(page: Page) {
  return page.locator('.analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: /^Time to merge$/ }) }).locator('.analytics-summary')
}

function value(page: Page, label: string) {
  return page.locator('#view-analytics .analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.analytics-value')
}

function countTrend(page: Page, label = 'Pull requests merged') {
  return page.locator('#view-analytics .analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.analytics-summary')
}

function quotaReport(): GithubQuotaReport {
  return { accounts: [{
    login: 'octocat', roles: ['user', 'automation'], checkedAt: '2026-10-09T12:00:00Z', error: null,
    buckets: ['REST API', 'GraphQL', 'Search', 'Code search'].map((label, index) => ({
      history: Array.from({ length: 24 }, (_, hour) => ({ at: Date.parse('2026-10-09T12:00:00Z') - (23 - hour) * 3_600_000, used: hour * 100, remaining: 5000 - hour * 100, limit: 5000 })),
      resource: ['core', 'graphql', 'search', 'code_search'][index], label, limit: 5000, used: 3000, remaining: 2000, resetAt: '2026-10-09T12:30:00Z', perMinute: 75, riskPercent: [25, 50, 90, 0][index],
    })),
  }, { login: 'octo-agent', roles: ['automation'], checkedAt: null, error: 'GitHub authentication is unavailable for octo-agent.', buckets: [] }] }
}

async function lefts(region: Locator, items: string): Promise<number[]> {
  return region.locator(items).evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().left)))
}

test('opens from the burger as a view of its own: productivity topline, per merged pull request, then GitHub', async ({ page }, info) => {
  await workspace(page)
  await page.route('**/api/github-quota', (route) => route.fulfill({ json: quotaReport() }))
  await page.goto('/')
  await openAnalytics(page)
  const view = page.locator('#view-analytics')
  for (const other of ['#view-current', '#view-main', '#view-behaviors']) await expect(page.locator(other)).toBeHidden()
  await expect(page.locator('#top-nav .nav-item.active')).toHaveCount(0)
  await expect(page.locator('#menu-popover [data-action="analytics"]')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#menu-toggle')).toBeFocused()
  await expect(page.locator('#menu-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(view.locator('main h2')).toHaveText(['Productivity', 'Per merged pull request', 'GitHub API · Live'])
  const topline = view.getByRole('region', { name: 'Productivity' })
  const flow = topline
  const perPr = view.getByRole('region', { name: 'Per merged pull request' })
  const quota = view.getByRole('region', { name: 'GitHub API · Live' })
  const cardOrder = ['Pull requests opened', 'Pull requests merged', 'Closed without merging', 'Lines changed', 'Time to first review', 'Time to merge', 'Issues opened', 'Issues closed']
  await expect(topline.locator('.analytics-label')).toHaveText(cardOrder)
  await expect(perPr.locator('.analytics-label')).toHaveText(['Comments', 'Median lines', 'Behaviors', 'Median time', 'Merged by agent'])
  // Seconds matter: agents review within minutes.
  await expect(value(page, 'Time to first review')).toHaveText('1m 15s')
  await expect(flow.locator('.analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: /^Time to first review$/ }) }).locator('[data-help="Faster vs 7-day median"]')).toBeVisible()
  await expect(flow).toContainText('7-day median: 2m 30s · 3 first reviews')
  await expect(value(page, 'Merged by agent')).toHaveText('75%')
  await expect(perPr.locator('.analytics-value').last()).toHaveAttribute('data-help', /3 of 4 by octo-agent/)
  await expect(quota.locator('.github-quota-bucket')).toHaveCount(2)
  // Productivity fills two rows of four, with the smaller per-PR row below.
  expect(await view.locator('main').evaluate((main) => main.getBoundingClientRect().width)).toBeGreaterThan(1200)
  const placed = await topline.locator('.analytics-tile').evaluateAll((tiles) => tiles.map((tile) => {
    const box = tile.getBoundingClientRect()
    return { label: tile.querySelector('.analytics-label')!.textContent, top: Math.round(box.top), left: Math.round(box.left) }
  }))
  expect(new Set(placed.map(tile => tile.top)).size).toBe(2)
  expect(new Set(placed.map(tile => tile.left)).size).toBe(4)
  expect(placed.sort((a, b) => a.top - b.top || a.left - b.left).map(tile => tile.label)).toEqual(cardOrder)
  expect(new Set(await lefts(perPr, '.analytics-tile')).size).toBe(5)
  const accounts = await quota.locator('.github-quota-account').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().top))
  expect(new Set(accounts).size).toBe(1)
  await expect(quota.locator('.github-quota-avatar')).toHaveCount(2)
  await expect(quota.locator('.github-quota-bucket h4')).toHaveText(['REST API', 'GraphQL'])
  await expect(view.locator('.analytics-histogram svg rect')).toHaveCount(130)
  await expect(perPr.locator('.analytics-note')).toHaveCount(5)
  await page.screenshot({ path: info.outputPath('analytics-view.png'), fullPage: true })

  await page.reload()
  await expect(view).toBeVisible()
  await expect(view.locator('.analytics-date')).toHaveText('Today')
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  await expect(page.locator('#menu-popover [data-action="analytics"]')).toHaveAttribute('aria-current', 'page')
  await leaveAnalytics(page)
  await expect(page.locator('#top-nav .nav-item.active')).toHaveText('Current')
  await expect(page.locator('#menu-popover [data-action="analytics"]')).not.toHaveAttribute('aria-current', 'page')
})

test('choosing Analytics again from the menu returns to Today', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  const view = page.locator('#view-analytics')
  await view.getByRole('button', { name: 'Previous day' }).click()
  await expect(view.locator('.analytics-date')).toHaveText('Yesterday')
  await expect(value(page, 'Pull requests merged')).toHaveText('0')
  await openAnalytics(page)
  await expect(view.locator('.analytics-date')).toHaveText('Today')
  await expect(view.getByRole('button', { name: 'Next day' })).toBeDisabled()
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  await expect.poll(() => state.reads.slice(-2)).toEqual([
    { since: '2026-10-09T00:00:00.000Z', until: '2026-10-10T00:00:00.000Z', org: null },
    { since: '2026-10-02T00:00:00.000Z', until: '2026-10-09T00:00:00.000Z', org: null },
  ])
})

test('keeps Productivity in two rows beside a docked notification rail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await workspace(page)
  await page.addInitScript(() => localStorage.setItem('poise-notification-rail', JSON.stringify({ docked: true, open: true })))
  await page.route('**/api/github-quota', (route) => route.fulfill({ json: quotaReport() }))
  await page.goto('/')
  await expect(page.locator('body')).toHaveClass(/notifications-docked/)
  await openAnalytics(page)
  const topline = page.getByRole('region', { name: 'Productivity' })
  await expect(topline.locator('.analytics-tile')).toHaveCount(8)
  const main = (await page.locator('#view-analytics main').boundingBox())!
  const rail = (await page.getByRole('complementary', { name: 'Notifications' }).boundingBox())!
  expect(main.x + main.width).toBeLessThanOrEqual(rail.x + 1)
  const tops = await topline.locator('.analytics-tile').evaluateAll((tiles) => tiles.map((tile) => Math.round(tile.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(2)
})

test('draws each headline figure\'s past year by 7-day period, ending at the selected day', async ({ page }, info) => {
  const state = await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  const topline = page.getByRole('region', { name: 'Productivity' })
  const plots = topline.locator('.analytics-history-plot')
  await expect(plots).toHaveCount(8)
  await expect(topline.locator('.analytics-history-latest')).toHaveCount(8)
  // The charts share one floor even where a figure above has no trend line.
  await expect(topline.locator('.analytics-tile').filter({ hasText: 'Lines changed' }).locator('.analytics-trend [role=img]')).toHaveCount(0)
  expect(new Set(await plots.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().bottom)))).size).toBe(2)
  for (const plot of await plots.all()) await expect(plot.locator('.analytics-history-line')).toHaveAttribute('d', /^M[\d.]+ [\d.]+ L/)
  // Weeks without a merge leave time to merge unknown, not zero.
  await expect(topline.locator('.analytics-history[data-series="Time to merge"] .analytics-history-line')).toHaveAttribute('d', / M/)
  await expect(topline.locator('.analytics-history[data-series="Pull requests merged"] .analytics-history-max')).toHaveText('Max 1.6/day')
  expect(state.historyReads).toHaveLength(1)
  const [{ bounds, org }] = state.historyReads
  expect(bounds).toHaveLength(53)
  expect([bounds[0], bounds.at(-2), bounds.at(-1), org]).toEqual(['2025-10-10T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-09T00:00:00.000Z', null])
  await expect(topline).not.toContainText('Under each figure')
  await expect(topline.locator('table, details')).toHaveCount(0)

  const merged = topline.locator('.analytics-history[data-series="Pull requests merged"]')
  const box = (await merged.locator('.analytics-history-plot').boundingBox())!
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2)
  const tip = merged.locator('.analytics-history-tip')
  await expect(tip).toHaveCount(0)
  await expect(tip).toBeVisible()
  await expect(tip.locator('small')).toContainText('Last period: the 7 days before the selected day.')
  await expect(tip.locator('strong')).toHaveText('1.1/day')
  await expect(tip.locator('span')).toHaveText('8 merged · 2 Oct – 8 Oct 2026')
  await page.screenshot({ path: info.outputPath('analytics-history.png') })
  await page.mouse.move(box.x + box.width / 2, box.y - 60)
  await expect(tip).toHaveCount(0)

  await merged.locator('.analytics-history-plot').focus()
  await expect(tip.locator('span')).toHaveText('8 merged · 2 Oct – 8 Oct 2026')
  await page.keyboard.press('ArrowLeft')
  await expect(tip.locator('strong')).toHaveText('1.0/day')
  await expect(tip.locator('span')).toHaveText(/^7 merged · 25 Sept? – 1 Oct 2026$/)
  await page.keyboard.press('Home')
  await expect(tip.locator('span')).toHaveText('0 merged · 10 Oct – 16 Oct 2025')
  await page.keyboard.press('Escape')
  await expect(tip).toHaveCount(0)

  await page.locator('#view-analytics').getByRole('button', { name: 'Previous day' }).click()
  await page.locator('#analytics-filters').getByLabel('Organization filter').selectOption('beta')
  await expect.poll(() => state.historyReads.at(-1)?.org).toBe('beta')
  expect(state.historyReads.at(-1)!.bounds.at(-1)).toBe('2026-10-08T00:00:00.000Z')
})

test('holds each chart\'s place while the past year loads, and says when it cannot be read', async ({ page }) => {
  const state = await workspace(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/analytics/history?**', async (route) => { await held; await route.fallback() })
  await page.goto('/')
  await openAnalytics(page)
  const tile = page.getByRole('region', { name: 'Productivity' }).locator('.analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: /^Issues opened$/ }) })
  await expect(value(page, 'Issues opened')).toHaveText('12')
  await expect(tile.locator('.analytics-history')).toHaveAttribute('aria-busy', 'true')
  const pending = (await tile.boundingBox())!.height
  release()
  await expect(tile.locator('.analytics-history-line')).toHaveCount(1)
  expect((await tile.boundingBox())!.height).toBe(pending)

  state.historyFails = true
  await page.locator('#view-analytics').getByRole('button', { name: 'Previous day' }).click()
  await expect(tile.locator('.analytics-history')).toHaveAttribute('aria-label', 'History unavailable')
  await expect(page.locator('#view-analytics')).not.toContainText('datastore offline')
  await expect(value(page, 'Issues opened')).toHaveText('12')
  expect((await tile.boundingBox())!.height).toBe(pending)
})

test('stops reading quota once another view is chosen', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/github-quota', (route) => route.fulfill({ json: quotaReport() }))
  await page.goto('/')
  await openAnalytics(page)
  await expect(page.locator('.github-quota-bucket')).toHaveCount(2)
  // The 15-second timer and a returning tab both refresh through one guard.
  const refresh = async () => {
    const read = page.waitForRequest('**/api/github-quota', { timeout: 1_000 }).then(() => true, () => false)
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    return read
  }
  expect(await refresh()).toBe(true)
  await leaveAnalytics(page)
  expect(await refresh()).toBe(false)
})

for (const theme of ['light', 'dark']) test(`fits a narrow window and large text in ${theme} mode`, async ({ page }, info) => {
  await page.setViewportSize({ width: 420, height: 820 })
  await workspace(page)
  await page.route('**/api/github-quota', (route) => route.fulfill({ json: quotaReport() }))
  await page.goto('/')
  await page.evaluate((chosen) => {
    document.documentElement.dataset.theme = chosen
    document.documentElement.style.fontSize = '20px'
  }, theme)
  await openAnalytics(page)
  const view = page.locator('#view-analytics')
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  await expect(view.locator('.github-quota-bucket')).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  const clipped = await view.locator('.analytics-day > *').evaluateAll((items) => items.map((item) => item.scrollWidth - item.clientWidth))
  expect(Math.max(...clipped)).toBeLessThanOrEqual(1)
  expect(new Set(await lefts(view.getByRole('region', { name: 'Productivity' }), '.analytics-tile')).size).toBe(2)
  await expect(view.locator('.analytics-history-line')).toHaveCount(13)
  const overflows = await view.locator('.analytics-tile').evaluateAll((tiles) => tiles.map((tile) => {
    const histogram = tile.querySelector('.analytics-histogram')!
    return histogram.getBoundingClientRect().bottom - tile.getBoundingClientRect().bottom
  }))
  expect(Math.max(...overflows)).toBeLessThanOrEqual(-8)
  const duration = value(page, 'Time to first review')
  expect(await duration.evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(await duration.evaluate(el => parseFloat(getComputedStyle(el).lineHeight)) + 1)
  await page.screenshot({ path: info.outputPath(`analytics-narrow-${theme}.png`), fullPage: true })
  // A readout wider than a right-column chart stays on the page.
  const closed = view.locator('.analytics-history[data-series="Issues closed"] .analytics-history-plot')
  await closed.scrollIntoViewIfNeeded()
  const plot = (await closed.boundingBox())!
  await page.mouse.move(plot.x + plot.width - 1, plot.y + plot.height / 2)
  await expect(closed.locator('.analytics-history-tip')).toBeVisible()
  const tip = (await closed.locator('.analytics-history-tip').boundingBox())!
  const main = (await view.locator('main').boundingBox())!
  expect(tip.width).toBeGreaterThan(plot.width)
  expect(tip.x).toBeGreaterThanOrEqual(main.x - 1)
  expect(tip.x + tip.width).toBeLessThanOrEqual(main.x + main.width + 1)
  await page.mouse.move(0, 0)
  await expect(view.locator('.analytics-history-table')).toHaveCount(0)
})

test('shows live account quota below daily analytics with usage, resets and risk colors', async ({ page }, info) => {
  await workspace(page)
  const quota: GithubQuotaReport = { accounts: [{
    login: 'octocat', roles: ['user', 'automation'], checkedAt: '2026-10-09T12:00:00Z', error: null,
    buckets: [25, 50, 90, 0, null].map((riskPercent, index) => ({
      resource: ['core', 'graphql', 'search', 'code_search', 'other'][index], label: ['REST API', 'GraphQL', 'Search', 'Code search', 'Collecting'][index],
      limit: 5000, used: 3000, remaining: 2000, resetAt: '2026-10-09T12:30:00Z', perMinute: index === 4 ? null : 75, riskPercent,
    })),
  }, { login: 'octo-agent', roles: ['automation'], checkedAt: null, error: 'GitHub authentication is unavailable for octo-agent.', buckets: [] }] }
  await page.route('**/api/github-quota', (route) => route.fulfill({ json: quota }))
  await page.goto('/')
  await openAnalytics(page)
  const section = page.getByRole('region', { name: 'GitHub API · Live' })
  await expect(section).toContainText('octocatuser + automation')
  await expect(section.locator('.github-quota-account')).toHaveCount(2)
  await expect(section).toContainText('3,000 / 5,000 used · 2,000 left')
  await expect(section).toContainText('12:30:00 UTC · 30.0 min left')
  await expect(section).toContainText('75 / min used · 66.7 / min available')
  const risk = section.locator('.github-quota-risk')
  await expect(risk.nth(0)).toHaveClass(/yellow/)
  await expect(risk.nth(0)).toHaveText('25% estimated risk')
  await expect(risk.nth(1)).toHaveClass(/orange/)
  await expect(section).not.toContainText('GitHub authentication is unavailable for octo-agent.')
  expect(await section.evaluate((element) => element.previousElementSibling?.className)).toBe('analytics-groups')
  await page.locator('#view-analytics').getByRole('button', { name: 'Previous day' }).click()
  await expect(risk.nth(0)).toHaveText('25% estimated risk')
  await risk.nth(1).scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('github-quota.png') })
  const avatar = section.locator('.github-quota-avatar img').first()
  await expect(avatar).toHaveClass(/broken/)
  quota.accounts[0].buckets[0].remaining = 0
  quota.accounts[0].buckets[0].used = 5000
  quota.accounts[0].buckets[0].riskPercent = 100
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(risk.nth(0)).toHaveText('100% estimated risk · Exhausted')
  await expect(avatar).toHaveClass(/broken/)
  await expect(avatar).toBeHidden()
})

test('shows quota read failure and refreshes it without retaining stale values', async ({ page }) => {
  await workspace(page)
  let failed = true
  await page.route('**/api/github-quota', (route) => failed
    ? route.fulfill({ status: 502, json: { error: 'Quota service unavailable' } })
    : route.fulfill({ json: { accounts: [] } }))
  await page.goto('/')
  await openAnalytics(page)
  const section = page.getByRole('region', { name: 'GitHub API · Live' })
  await expect(section).not.toContainText('Quota service unavailable')
  failed = false
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(section.locator('.github-quota-account')).toHaveCount(0)
  await expect(section.locator('.github-quota-accounts')).not.toHaveClass(/st-help-error/)
})

test('opens Today with a seven-day comparison and navigates days without changing Current', async ({ page }, info) => {
  const state = await workspace(page)
  await page.goto('/')
  await expect(page.locator('#current-time-picker [data-time="week"]')).toHaveClass(/active/)
  await expect(page.locator('#view-analytics')).toBeHidden()
  await openAnalytics(page)
  const panel = page.locator('#view-analytics')
  await expect(panel.locator('.analytics-date')).toHaveText('Today')
  await expect(panel.getByRole('button', { name: 'Next day' })).toBeDisabled()
  await expect(value(page, 'Issues opened')).toHaveText('12')
  await expect(value(page, 'Issues closed')).toHaveText('9')
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  await expect(value(page, 'Lines changed')).toHaveText('4,210')
  await expect(value(page, 'Time to merge')).toHaveText('6h')
  await expect(value(page, 'Comments')).toHaveText('3.0')
  await expect(value(page, 'Median lines')).toHaveText('—')
  await expect(value(page, 'Behaviors')).toHaveText('2.0')
  await expect(value(page, 'Median time')).toHaveText('6h')
  await expect(panel.locator('.analytics-group').last().locator('.analytics-label').nth(3)).toHaveText('Median time')
  await expect(mergeTrend(page)).toHaveClass(/good/)
  await expect(mergeTrend(page)).toContainText('50%')
  await expect(mergeTrend(page).getByRole('img')).toHaveAccessibleName('50% faster versus the preceding 7-day median')
  await expect(panel).toContainText('7-day median: 12h · 8 PRs')
  await expect(value(page, 'Lines changed')).toHaveAttribute('data-help', /From 3 of 4 pull requests/)
  await expect(panel.locator('.analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: /^Issues opened$/ }) }).locator('.analytics-trend')).toContainText('1,100% ahead of pace')
  await expect(panel).toContainText('7-day median: 2.0 / day')
  await page.screenshot({ path: info.outputPath('analytics-day-trend.png') })
  expect(state.reads).toEqual([
    { since: '2026-10-09T00:00:00.000Z', until: '2026-10-10T00:00:00.000Z', org: null },
    { since: '2026-10-02T00:00:00.000Z', until: '2026-10-09T00:00:00.000Z', org: null },
  ])

  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('Yesterday')
  await expect(panel.getByRole('button', { name: 'Next day' })).toBeEnabled()
  await expect(value(page, 'Pull requests merged')).toHaveText('0')
  await expect(value(page, 'Median time')).toHaveText('—')
  await expect(mergeTrend(page).getByRole('img')).toHaveCount(0)
  await expect(panel).not.toContainText('No pull requests were merged in this range.')
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('7 Oct 2026')
  await expect.poll(() => state.reads.slice(2)).toEqual([
    { since: '2026-10-08T00:00:00.000Z', until: '2026-10-09T00:00:00.000Z', org: null },
    { since: '2026-10-01T00:00:00.000Z', until: '2026-10-08T00:00:00.000Z', org: null },
    { since: '2026-10-07T00:00:00.000Z', until: '2026-10-08T00:00:00.000Z', org: null },
    { since: '2026-09-30T00:00:00.000Z', until: '2026-10-07T00:00:00.000Z', org: null },
  ])
  await panel.getByRole('button', { name: 'Next day' }).click()
  await panel.getByRole('button', { name: 'Next day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('Today')
  await expect(panel.getByRole('button', { name: 'Next day' })).toBeDisabled()
  await expect(page.locator('#current-time-picker [data-time="week"]')).toHaveClass(/active/)
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('Yesterday')
  await leaveAnalytics(page)
  await expect(page.locator('#current-time-picker [data-time="week"]')).toHaveClass(/active/)
  await openAnalytics(page)
  await expect(panel.locator('.analytics-date')).toHaveText('Today')
})

test('compares cumulative cards with elapsed-day pace while retaining actual values and completed-day comparisons', async ({ page }, info) => {
  const state = await workspace(page)
  state.pacing = { merged: 15, median: 27 }
  state.baselineMerged = 189
  await page.clock.setFixedTime(new Date('2026-10-09T10:00:00Z'))
  await page.goto('/')
  await openAnalytics(page)
  const merged = countTrend(page)
  const lines = countTrend(page, 'Lines changed')
  await expect(merged.locator('.analytics-value')).toHaveText('15')
  await expect(merged).toHaveClass(/good/)
  await expect(merged.locator('.analytics-arrow')).toHaveText('↑')
  await expect(merged.locator('.analytics-delta')).toHaveText('33.3% ahead of pace')
  await expect(merged).toContainText('Typical by now: 11.3 · 7-day median: 27.0 / day')
  await expect(lines.locator('.analytics-value')).toHaveText('15,000')
  await expect(lines.locator('.analytics-delta')).toHaveText('33.3% ahead of pace')
  await expect(lines).toContainText('Typical by now: 11,250.0 · 7-day median: 27,000.0 / day')
  await expect(mergeTrend(page).locator('.analytics-delta')).toHaveText('50%')
  await expect(value(page, 'Time to merge')).toHaveText('6h')
  await expect(countTrend(page, 'Comments').locator('.analytics-delta')).toHaveText('0%')
  await expect(value(page, 'Median lines')).toHaveText('180')
  await expect(page.locator('.analytics-history[data-series="Pull requests merged"] .analytics-history-max')).toHaveText('Max 1.6/day')
  expect(state.reads).toHaveLength(2)
  expect(state.historyReads).toHaveLength(1)
  await page.screenshot({ path: info.outputPath('analytics-elapsed-day-pace.png'), fullPage: true })

  await page.locator('#view-analytics').getByRole('button', { name: 'Previous day' }).click()
  await expect(page.locator('.analytics-date')).toHaveText('Yesterday')
  await expect(merged.locator('.analytics-value')).toHaveText('15')
  await expect(merged).toHaveClass(/bad/)
  await expect(merged.locator('.analytics-arrow')).toHaveText('↓')
  await expect(merged.locator('.analytics-delta')).toHaveText('44.4%')
  await expect(merged).toContainText('7-day median: 27.0 / day')
  await expect(merged).not.toContainText('Typical by now')
  await expect(merged).not.toContainText('pace')
  expect(state.reads).toHaveLength(4)
  expect(state.historyReads).toHaveLength(2)
})

test('keeps pace tied to its data snapshot through elapsed time, history and quota updates, then renews it on reopening', async ({ page }) => {
  const state = await workspace(page)
  state.pacing = { merged: 15, median: 27 }
  state.baselineMerged = 189
  let releaseHistory!: () => void
  const historyHeld = new Promise<void>((resolve) => { releaseHistory = resolve })
  await page.route('**/api/analytics/history?**', async (route) => { await historyHeld; await route.fallback() })
  await page.clock.install({ time: new Date('2026-10-09T10:00:00Z') })
  await page.goto('/')
  await openAnalytics(page)
  const merged = countTrend(page)
  const expectInitialSnapshot = async () => {
    await expect(merged.locator('.analytics-value')).toHaveText('15')
    await expect(merged).toHaveClass(/good/)
    await expect(merged.locator('.analytics-arrow')).toHaveText('↑')
    await expect(merged.locator('.analytics-delta')).toHaveText('33.3% ahead of pace')
    await expect(merged).toContainText('Typical by now: 11.3 · 7-day median: 27.0 / day')
    await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 10:00 UTC, when totals were read\./)
  }
  await expectInitialSnapshot()

  await page.clock.fastForward(3 * 3_600_000)
  await expectInitialSnapshot()
  expect(state.reads).toHaveLength(2)
  expect(state.historyReads).toHaveLength(0)
  releaseHistory()
  await expect(page.locator('.analytics-history[data-series="Pull requests merged"] .analytics-history-line')).toHaveAttribute('d', /^M/)
  await expectInitialSnapshot()
  const quotaRefresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/github-quota')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await quotaRefresh
  await expectInitialSnapshot()
  expect(state.reads).toHaveLength(2)
  expect(state.historyReads).toHaveLength(1)

  await leaveAnalytics(page)
  const hiddenSummary = await merged.textContent()
  await page.clock.fastForward(3_600_000)
  await expect(merged).toHaveText(hiddenSummary!)
  expect(state.reads).toHaveLength(2)
  expect(state.historyReads).toHaveLength(1)

  state.pacing.merged = 16
  await openAnalytics(page)
  await expect(merged.locator('.analytics-value')).toHaveText('16')
  await expect(merged).toHaveClass(/neutral/)
  await expect(merged.locator('.analytics-arrow')).toHaveText('→')
  await expect(merged.locator('.analytics-delta')).toHaveText('On pace')
  await expect(merged).toContainText('Typical by now: 15.8 · 7-day median: 27.0 / day')
  await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 14:00 UTC, when totals were read\./)
  const colors = await merged.evaluate(element => ['.analytics-value', '.analytics-arrow', '.analytics-delta'].map(selector => getComputedStyle(element.querySelector(selector)!).color))
  expect(new Set(colors).size).toBe(1)
  expect(state.reads).toHaveLength(4)
  expect(state.historyReads).toHaveLength(2)

  await leaveAnalytics(page)
  await page.clock.fastForward(4 * 3_600_000)
  await page.clock.setFixedTime(new Date('2026-10-09T18:00:00Z'))
  state.pacing.merged = 17
  await openAnalytics(page)
  await expect(merged.locator('.analytics-value')).toHaveText('17')
  await expect(merged).toHaveClass(/bad/)
  await expect(merged.locator('.analytics-arrow')).toHaveText('↓')
  await expect(merged.locator('.analytics-delta')).toHaveText('16% behind pace')
  await expect(merged).toContainText('Typical by now: 20.3 · 7-day median: 27.0 / day')
  await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 18:00 UTC, when totals were read\./)
  await expect(mergeTrend(page).locator('.analytics-delta')).toHaveText('50%')
  expect(state.reads).toHaveLength(6)
  expect(state.historyReads).toHaveLength(3)
})

test('keeps stale totals and their pacing context without judging Today, while retaining completed-day comparisons', async ({ page }) => {
  const state = await workspace(page)
  state.pacing = { merged: 15, median: 27 }
  state.stale = true
  await page.clock.setFixedTime(new Date('2026-10-09T18:00:00Z'))
  await page.goto('/')
  await openAnalytics(page)
  const merged = countTrend(page)
  await expect(merged.locator('.analytics-value')).toHaveText('15')
  await expect(merged).toHaveClass(/neutral/)
  await expect(merged.locator('.analytics-arrow')).toHaveCount(0)
  await expect(merged.locator('.analytics-delta')).toHaveCount(0)
  await expect(merged).toContainText('Typical by now: 20.3 · 7-day median: 27.0 / day')
  expect(state.reads).toHaveLength(2)
  expect(state.historyReads).toHaveLength(1)

  await page.locator('#view-analytics').getByRole('button', { name: 'Previous day' }).click()
  await expect(page.locator('.analytics-date')).toHaveText('Yesterday')
  await expect(merged.locator('.analytics-value')).toHaveText('15')
  await expect(merged).toHaveClass(/bad/)
  await expect(merged.locator('.analytics-arrow')).toHaveText('↓')
  await expect(merged.locator('.analytics-delta')).toHaveText('44.4%')
  await expect(merged).toContainText('7-day median: 27.0 / day')
  await expect(merged).not.toContainText('Typical by now')
  expect(state.reads).toHaveLength(4)
  expect(state.historyReads).toHaveLength(2)
})

test('reads both periods for the selected account and shows slower merges in red', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  state.baselineHours = 9
  await page.locator('#analytics-filters').getByLabel('Organization filter').selectOption('beta')
  await expect.poll(() => state.reads.slice(-2)).toEqual([
    { since: '2026-10-09T00:00:00.000Z', until: '2026-10-10T00:00:00.000Z', org: 'beta' },
    { since: '2026-10-02T00:00:00.000Z', until: '2026-10-09T00:00:00.000Z', org: 'beta' },
  ])
  await expect(mergeTrend(page)).toHaveClass(/bad/)
  await expect(mergeTrend(page)).toContainText('200%')
  await expect(mergeTrend(page).getByRole('img')).toHaveAccessibleName('200% slower versus the preceding 7-day median')
})

test('names an empty baseline instead of inventing a trend', async ({ page }) => {
  const state = await workspace(page)
  state.baselineMerged = 0
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Time to merge')).toHaveText('6h')
  await expect(mergeTrend(page).getByRole('img')).toHaveCount(0)
  await expect(page.locator('#view-analytics')).toContainText('7-day median: — · 0 PRs · No baseline')
})

for (const day of [
  { hours: 25, now: '2026-10-25T07:00:00Z', since: '2026-10-24T21:00:00.000Z', until: '2026-10-25T22:00:00.000Z', baselineSince: '2026-10-17T21:00:00.000Z', typical: '10.8', ahead: '38.9%' },
  { hours: 23, now: '2026-03-29T08:00:00Z', since: '2026-03-28T22:00:00.000Z', until: '2026-03-29T21:00:00.000Z', baselineSince: '2026-03-21T22:00:00.000Z', typical: '11.7', ahead: '27.8%' },
]) {
  test(`uses the configured timezone's ${day.hours}-hour DST day for elapsed-day pace`, async ({ page }) => {
    const state = await workspace(page, 'Europe/Helsinki')
    state.pacing = { merged: 15, median: 27 }
    await page.clock.setFixedTime(new Date(day.now))
    await page.goto('/')
    await openAnalytics(page)
    const merged = countTrend(page)
    await expect(merged.locator('.analytics-value')).toHaveText('15')
    await expect(merged.locator('.analytics-delta')).toHaveText(`${day.ahead} ahead of pace`)
    await expect(merged).toContainText(`Typical by now: ${day.typical} · 7-day median: 27.0 / day`)
    expect(state.reads).toEqual([
      { since: day.since, until: day.until, org: null },
      { since: day.baselineSince, until: day.since, org: null },
    ])
    expect(state.historyReads).toHaveLength(1)
  })
}

test('says when the numbers could not be read instead of showing old ones', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  state.fail = true
  await page.locator('#view-analytics').getByRole('button', { name: 'Previous day' }).click()
  await expect(page.locator('#view-analytics')).not.toContainText('acme: datastore offline')
  await expect(page.locator('#view-analytics .analytics-tile')).toHaveCount(0)
})

test('a slow old date cannot overwrite the latest date or its trend', async ({ page }) => {
  await workspace(page)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/analytics?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('since') === '2026-10-08T00:00:00.000Z' && url.searchParams.get('until') === '2026-10-09T00:00:00.000Z') {
      await held
      await route.fulfill({ json: report(99) })
    } else await route.fallback()
  })
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  const panel = page.locator('#view-analytics')
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('7 Oct 2026')
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  const response = page.waitForResponse(res => new URL(res.url()).searchParams.get('since') === '2026-10-08T00:00:00.000Z')
  release()
  await response
  await expect(panel.locator('.analytics-groups')).not.toHaveAttribute('aria-busy', 'true')
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  await expect(mergeTrend(page)).toContainText('50%')
})

test('retains the selected calendar date and completes its pace comparison across midnight', async ({ page }) => {
  const state = await workspace(page)
  state.pacing = { merged: 15, median: 27 }
  await page.clock.install({ time: new Date('2026-10-09T23:59:30Z') })
  await page.goto('/')
  await openAnalytics(page)
  const panel = page.locator('#view-analytics')
  const merged = countTrend(page)
  await expect(panel.locator('.analytics-date')).toHaveText('Today')
  await expect(merged).toContainText('Typical by now: 27.0 · 7-day median: 27.0 / day')
  await page.clock.fastForward(60_000)
  await expect(panel.locator('.analytics-date')).toHaveText('Yesterday')
  await expect(merged.locator('.analytics-value')).toHaveText('15')
  await expect(merged.locator('.analytics-delta')).toHaveText('44.4%')
  await expect(merged).toContainText('7-day median: 27.0 / day')
  await expect(merged).not.toContainText('Typical by now')
  expect(state.reads).toHaveLength(4)
  expect(state.historyReads).toHaveLength(2)
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('7 Oct 2026')
  await page.clock.setFixedTime(new Date('2026-10-10T00:01:00Z'))
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('6 Oct 2026')
  await expect.poll(() => state.reads.at(-2)?.since).toBe('2026-10-06T00:00:00.000Z')
  expect(state.reads).toHaveLength(10)
  expect(state.historyReads).toHaveLength(5)
})


test('shows the standard loader with no old values on initial load, day/account changes and reopening', async ({ page }, info) => {
  await workspace(page)
  let release!: () => void
  let held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/analytics?**', async route => {
    await held
    await route.fallback()
  })
  await page.goto('/')
  await openAnalytics(page)
  const panel = page.locator('#view-analytics')
  const loader = panel.getByRole('status', { name: 'Loading analytics' })
  const pending = async () => {
    await expect(loader).toBeVisible()
    await expect(loader.locator('span')).toHaveCount(3)
    await expect(panel.locator('.analytics-tile')).toHaveCount(0)
    await expect(panel.locator('.analytics-status')).toBeHidden()
    await expect(panel.locator('.analytics-groups')).toHaveAttribute('aria-busy', 'true')
    await expect(loader.locator('span').first()).toHaveCSS('animation-name', 'pulse')
  }
  const loaded = async (merged: string) => {
    release()
    await expect(value(page, 'Pull requests merged')).toHaveText(merged)
    await expect(loader).toBeHidden()
    await expect(panel.locator('.analytics-groups')).not.toHaveAttribute('aria-busy', 'true')
    held = new Promise<void>(resolve => { release = resolve })
  }
  try {
    await pending()
    await loaded('4')
    const quotaTop = () => panel.locator('.github-quota-section').evaluate((section) => (section as HTMLElement).offsetTop)
    const settledTop = await quotaTop()
    await panel.getByRole('button', { name: 'Previous day' }).click()
    await pending()
    // GitHub holds its place while the day loads instead of jumping up.
    expect(await quotaTop()).toBe(settledTop)
    await page.screenshot({ path: info.outputPath('analytics-loading.png') })
    await loaded('0')
    await page.locator('#analytics-filters').getByLabel('Organization filter').selectOption('beta')
    await pending()
    await loaded('0')
    await leaveAnalytics(page)
    await openAnalytics(page)
    await pending()
    await loaded('4')
  } finally { release() }
})

test('clears a previous read error while retrying with the loader', async ({ page }) => {
  const state = await workspace(page)
  state.fail = true
  await page.goto('/')
  await openAnalytics(page)
  const panel = page.locator('#view-analytics')
  await expect(panel.getByRole('status', { name: 'Loading analytics' })).toBeHidden()
  await expect(panel).not.toContainText('acme: datastore offline')
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/analytics?**', async route => { await held; await route.fallback() })
  state.fail = false
  try {
    await panel.getByRole('button', { name: 'Previous day' }).click()
    await expect(panel.getByRole('status', { name: 'Loading analytics' })).toBeVisible()
    await expect(panel.locator('.analytics-status')).toBeHidden()
    await expect(panel.locator('.analytics-tile')).toHaveCount(0)
  } finally { release() }
  await expect(value(page, 'Pull requests merged')).toHaveText('0')
})

test('shows quota charts from the existing read and centers every organization selection', async ({ page }) => {
  const state = await workspace(page)
  let reads = 0
  await page.route('**/api/github-quota', (route) => { reads++; return route.fulfill({ json: quotaReport() }) })
  await page.goto('/')
  await openAnalytics(page)
  const view = page.locator('#view-analytics')
  await expect(view.locator('.quota-hour')).toHaveCount(48)
  await expect(view.locator('.quota-hour-empty')).toHaveCount(0)
  await expect(view.locator('.quota-distribution rect')).toHaveCount(40)
  await expect(view.locator('.github-quota-avatar img').first()).toHaveAttribute('src', 'https://github.com/octocat.png?size=80')
  await expect(view.locator('.github-quota-avatar').first()).toHaveCSS('border-radius', '999px')
  await expect(view.locator('.analytics-history-latest').first()).toHaveCSS('border-radius', '999px')
  expect(reads).toBe(1)
  expect(state.reads).toHaveLength(2)
  expect(state.historyReads).toHaveLength(1)
  const filter = view.getByLabel('Organization filter')
  await expect(filter.locator('option')).toHaveText(['All orgs', 'acme', 'beta'])
  for (const selection of ['', 'acme', 'beta']) {
    await filter.selectOption(selection)
    const geometry = await filter.evaluate((select) => {
      const style = getComputedStyle(select)
      return { height: select.getBoundingClientRect().height, line: parseFloat(style.lineHeight), top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom), border: parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) }
    })
    expect(geometry.top).toBe(geometry.bottom)
    expect(geometry.line + geometry.border).toBe(geometry.height)
  }
})

test('attaches delayed help to measurements, with plain headings and no quota explainer', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/github-quota', (route) => route.fulfill({ json: quotaReport() }))
  await page.goto('/')
  await openAnalytics(page)
  const view = page.locator('#view-analytics')
  await expect(view.locator('h2[data-help], dt[data-help]')).toHaveCount(0)
  await expect(view).not.toContainText('Estimated risk of running out before reset, assuming recent usage continues.')
  await expect(view.locator('.analytics-value[data-help]')).toHaveCount(13)
  const figure = value(page, 'Behaviors')
  await figure.scrollIntoViewIfNeeded()
  await page.mouse.move(0, 0)
  await figure.hover()
  const tooltip = page.getByRole('tooltip')
  await expect(tooltip).toBeHidden()
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('Median completed review and approval behaviors')
  await expect(figure).toHaveCSS('text-decoration-line', 'none')
  await page.mouse.move(0, 0)
  await expect(tooltip).toBeHidden()
})

test('caps seven-day quota charts at 168 hours and visibly explains an unset agent', async ({ page }) => {
  await workspace(page)
  const quota = quotaReport()
  const now = Date.parse('2026-10-09T12:00:00Z')
  quota.accounts[0].buckets[0].history = Array.from({ length: 169 }, (_, i) => ({ at: now - i * 3_600_000, used: 100, remaining: 4900, limit: 5000 }))
  await page.route('**/api/github-quota', route => route.fulfill({ json: quota }))
  await page.route('**/api/analytics?**', route => route.fulfill({ json: { ...report(4), agentAccount: null, pullRequests: { ...report(4).pullRequests, mergedByAgent: null } } }))
  await page.goto('/')
  await openAnalytics(page)
  await expect(page.locator('.quota-charts').first()).toContainText('168/168 hours')
  const agent = page.locator('.analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: /^Merged by agent$/ }) })
  await expect(agent.locator('.analytics-value')).toHaveText('—')
  await expect(agent.locator('.analytics-note')).toHaveText('No agent account in Settings')
})

test('reopens a chart readout after keyboard focus leaves while the pointer stays inside', async ({ page }) => {
  await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  const plot = page.locator('.analytics-history[data-series="Issues opened"] .analytics-history-plot')
  const tip = plot.locator('.analytics-history-tip')
  await plot.hover()
  await expect(tip).toBeVisible()
  await plot.focus()
  await page.keyboard.press('Tab')
  await expect(tip).toHaveCount(0)
  const box = (await plot.boundingBox())!
  await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2)
  await expect(tip).toBeVisible()
})

test('keyboard selection takes precedence over a pending pointer readout', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-09T12:00:00Z') })
  await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  const plot = page.locator('.analytics-history[data-series="Issues opened"] .analytics-history-plot')
  await expect(plot.locator('.analytics-history-line')).toBeVisible()
  await page.clock.pauseAt(new Date('2026-10-09T12:01:00Z'))
  await page.mouse.move(0, 0)
  await plot.focus()
  const box = (await plot.boundingBox())!
  await page.mouse.move(box.x + 1, box.y + box.height / 2)
  await page.keyboard.press('End')
  await expect(plot.locator('.analytics-history-tip span')).toHaveText('6 opened · 2 Oct – 8 Oct 2026')
  await page.clock.runFor(600)
  await expect(plot.locator('.analytics-history-tip span')).toHaveText('6 opened · 2 Oct – 8 Oct 2026')
})

test('routes repeated account, history and quota failures into global notifications and restores colored median summaries', async ({ page }, info) => {
  await workspace(page)
  let failed = true
  const detail = 'pullRequests totalCount changed while enumerating Vaquum/design-system: 109 to 110'
  await page.route('**/api/notices', route => route.fulfill({ json: { enabled: true, notices: [] } }))
  await page.route('**/api/analytics/history?**', route => {
    const data = history(new URL(route.request().url()).searchParams.get('bounds')!.split(','))
    data.errors = failed ? [{ org: 'vaquum', error: detail, stale: true }] : []
    return route.fulfill({ json: data })
  })
  await page.route('**/api/analytics?**', route => {
    const query = new URL(route.request().url()).searchParams
    const baseline = query.has('dailyBounds')
    const data = report(baseline ? 8 : 4, baseline ? 54 : 27)
    if (baseline) data.daily = Array.from({ length: 7 }, () => ({ issues: { opened: 2, closed: 1 }, pullRequests: report(1).pullRequests }))
    data.errors = failed ? [{ org: 'vaquum', error: detail, stale: true }] : []
    return route.fulfill({ json: data })
  })
  await page.route('**/api/github-quota', route => route.fulfill({ json: failed ? quotaReport() : { accounts: [] } }))
  await page.goto('/')
  await openAnalytics(page)
  const view = page.locator('#view-analytics')
  const summary = mergeTrend(page)
  await expect(summary.locator('.analytics-value')).toHaveText('6h')
  await expect(summary.locator('.analytics-arrow')).toHaveText('↓')
  await expect(summary.locator('.analytics-delta')).toHaveText('50%')
  await expect(summary).toHaveClass(/good/)
  const colors = await summary.evaluate(el => [getComputedStyle(el.querySelector('.analytics-value')!).color, getComputedStyle(el.querySelector('.analytics-arrow')!).color, getComputedStyle(el.querySelector('.analytics-delta')!).color])
  expect(new Set(colors).size).toBe(1)
  const figure = (await summary.locator('.analytics-value').boundingBox())!
  const arrow = (await summary.locator('.analytics-arrow').boundingBox())!
  expect(arrow.x).toBeGreaterThan(figure.x + figure.width)
  expect(Math.abs(arrow.y + arrow.height - figure.y - figure.height)).toBeLessThan(8)
  await expect(view).not.toContainText(detail)
  await expect(view).not.toContainText(/52 weeks|Distribution|Some GitHub accounts are unavailable|Showing available results/)
  await page.locator('.nr-bell').click()
  const rail = page.locator('.nr-rail')
  await expect(rail.locator('.nr-card').filter({ hasText: detail })).toHaveCount(1)
  await expect(rail).toContainText('GitHub data for vaquum is not updating')
  await expect(rail).toContainText('GitHub authentication is unavailable for octo-agent.')
  await page.screenshot({ path: info.outputPath('analytics-colored-median-notifications.png'), fullPage: true })
  await leaveAnalytics(page)
  await page.locator('.nr-bell').click()
  await expect(rail).toBeVisible()
  await expect(rail.locator('.nr-card').filter({ hasText: detail })).toHaveCount(1)
  failed = false
  await openAnalytics(page)
  await expect(value(page, 'Time to merge')).toHaveText('6h')
  await page.locator('.nr-bell').click()
  await expect(rail).toBeVisible()
  await expect(rail.locator('.nr-card').filter({ hasText: detail })).toHaveCount(0)
  await expect(rail).not.toContainText('GitHub authentication is unavailable for octo-agent.')
})

test('notifies a shared failed read once outside Analytics and clears it after recovery', async ({ page }) => {
  const state = await workspace(page)
  state.fail = true
  state.historyFails = true
  await page.goto('/')
  await openAnalytics(page)
  await expect(page.locator('#view-analytics .analytics-loader')).toBeHidden()
  await expect(page.locator('#view-analytics')).not.toContainText('datastore offline')
  await page.locator('.nr-bell').click()
  const notices = page.locator('.nr-rail .nr-card').filter({ hasText: 'acme: datastore offline' })
  await expect(notices).toHaveCount(1)
  state.fail = false
  state.historyFails = false
  await page.locator('#view-analytics').getByRole('button', { name: 'Previous day' }).click()
  await expect(value(page, 'Pull requests merged')).toHaveText('0')
  await page.locator('.nr-bell').click()
  await expect(page.locator('.nr-rail')).toBeVisible()
  await expect(notices).toHaveCount(0)
})
