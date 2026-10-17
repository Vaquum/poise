import { expect, test, type Page } from '@playwright/test'
import type { AnalyticsReport } from '../../src/analytics-format'

function report(merged: number, hours = 27): AnalyticsReport {
  return {
    window: { since: null, until: null },
    issues: { opened: 12, closed: 9 },
    pullRequests: {
      merged,
      commentsPerPr: merged ? 3.25 : null,
      lines: { total: merged ? 4210 : null, median: merged ? 180 : null, counted: merged ? merged - 1 : 0 },
      behaviors: { perPr: merged ? 2 : null, approvals: merged, reviews: merged, changesRequested: 0 },
      averageTimeToMergeMs: merged ? hours * 3_600_000 : null,
      medianTimeToMergeMs: merged ? 6 * 3_600_000 : null,
    },
    errors: [],
  }
}

interface Workspace {
  reads: Array<{ since: string | null, until: string | null, org: string | null }>
  fail: boolean
  baselineHours: number
  baselineMerged: number
}

async function workspace(page: Page, timezone = 'UTC'): Promise<Workspace> {
  const state: Workspace = { reads: [], fail: false, baselineHours: 54, baselineMerged: 8 }
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
    if (url.pathname === '/api/analytics') {
      const read = { since: url.searchParams.get('since'), until: url.searchParams.get('until'), org: url.searchParams.get('org') }
      state.reads.push(read)
      if (state.fail) return route.fulfill({ status: 502, json: { error: 'acme: datastore offline' } })
      const baseline = Date.parse(read.until!) - Date.parse(read.since!) > 2 * 86_400_000
      return route.fulfill({ json: baseline ? report(state.baselineMerged, state.baselineHours) : report(read.since === '2026-10-08T00:00:00.000Z' ? 0 : 4) })
    }
    if (url.pathname === '/api/settings') return route.fulfill({ json: { org: 'acme', me: 'octocat', timezone, organizations, models: {} } })
    if (url.pathname === '/api/organizations') return route.fulfill({ json: { organizations } })
    if (url.pathname === '/api/gh') return route.fulfill({ json: { records: [], count: 0, errors: [] } })
    if (url.pathname === '/api/current') return route.fulfill({ json: { cards: [] } })
    if (url.pathname === '/api/repos') return route.fulfill({ json: { repos: [] } })
    if (url.pathname === '/api/agent-logs') return route.fulfill({ json: { logs: [] } })
    if (url.pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    if (url.pathname === '/api/notices') return route.fulfill({ json: { enabled: false, notices: [] } })
    return route.fulfill({ json: {} })
  })
  return state
}

async function openAnalytics(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'Analytics' }).click()
  await expect(page.locator('#analytics-panel')).toHaveClass(/open/)
}

function mergeTrend(page: Page) {
  return page.locator('.analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: /^Time to merge$/ }) }).locator('.analytics-trend')
}

function value(page: Page, label: string) {
  return page.locator('#analytics-panel .analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.analytics-value')
}

test('opens Today with a seven-day comparison and navigates days without changing Current', async ({ page }, info) => {
  const state = await workspace(page)
  await page.goto('/')
  await expect(page.locator('#current-time-picker [data-time="week"]')).toHaveClass(/active/)
  await expect(page.locator('#analytics-panel')).toHaveAttribute('inert', '')
  await openAnalytics(page)
  const panel = page.locator('#analytics-panel')
  await expect(panel.locator('.analytics-date')).toHaveText('Today')
  await expect(panel.getByRole('button', { name: 'Next day' })).toBeDisabled()
  await expect(value(page, 'Opened')).toHaveText('12')
  await expect(value(page, 'Closed')).toHaveText('9')
  await expect(value(page, 'Merged')).toHaveText('4')
  await expect(value(page, 'Lines changed')).toHaveText('4,210')
  await expect(value(page, 'Time to merge')).toHaveText('1d 3h')
  await expect(value(page, 'Comments')).toHaveText('3.3')
  await expect(value(page, 'Median lines')).toHaveText('180')
  await expect(value(page, 'Behaviors')).toHaveText('2.0')
  await expect(value(page, 'Median time')).toHaveText('6h')
  await expect(panel.locator('.analytics-group').last().locator('.analytics-label').nth(3)).toHaveText('Median time')
  await expect(mergeTrend(page)).toHaveClass(/good/)
  await expect(mergeTrend(page)).toContainText('↓ 50%')
  await expect(mergeTrend(page).getByRole('img')).toHaveAccessibleName('50% faster versus the preceding 7-day average')
  await expect(panel).toContainText('7-day rolling average: 2d 6h · 8 PRs')
  await expect(panel).toContainText('From 3 of 4 pull requests')
  await expect(panel.locator('.analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: /^Opened$/ }) }).locator('.analytics-trend')).toContainText('↑ 600%')
  await expect(panel).toContainText('7-day daily average: 1.7')
  await page.screenshot({ path: info.outputPath('analytics-day-trend.png') })
  expect(state.reads).toEqual([
    { since: '2026-10-09T00:00:00.000Z', until: '2026-10-10T00:00:00.000Z', org: null },
    { since: '2026-10-02T00:00:00.000Z', until: '2026-10-09T00:00:00.000Z', org: null },
  ])

  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('Yesterday')
  await expect(panel.getByRole('button', { name: 'Next day' })).toBeEnabled()
  await expect(value(page, 'Merged')).toHaveText('0')
  await expect(value(page, 'Median time')).toHaveText('—')
  await expect(mergeTrend(page)).toHaveCount(0)
  await expect(panel).toContainText('No pull requests were merged in this range.')
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
  await page.keyboard.press('Escape')
  await expect(panel).not.toHaveClass(/open/)
  await expect(panel).toHaveAttribute('inert', '')
})

test('reads both periods for the selected account and shows slower merges in red', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Merged')).toHaveText('4')
  state.baselineHours = 9
  await page.locator('#current-filters').getByLabel('Account filter').selectOption('beta')
  await expect.poll(() => state.reads.slice(-2)).toEqual([
    { since: '2026-10-09T00:00:00.000Z', until: '2026-10-10T00:00:00.000Z', org: 'beta' },
    { since: '2026-10-02T00:00:00.000Z', until: '2026-10-09T00:00:00.000Z', org: 'beta' },
  ])
  await expect(mergeTrend(page)).toHaveClass(/bad/)
  await expect(mergeTrend(page)).toContainText('↑ 200%')
  await expect(mergeTrend(page).getByRole('img')).toHaveAccessibleName('200% slower versus the preceding 7-day average')
})

test('names an empty baseline instead of inventing a trend', async ({ page }) => {
  const state = await workspace(page)
  state.baselineMerged = 0
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Time to merge')).toHaveText('1d 3h')
  await expect(mergeTrend(page)).toHaveCount(0)
  await expect(page.locator('#analytics-panel')).toContainText('7-day rolling average: — · 0 PRs · No baseline')
})

test('uses configured timezone boundaries across DST', async ({ page }) => {
  const state = await workspace(page, 'Europe/Helsinki')
  await page.clock.setFixedTime(new Date('2026-10-25T12:00:00Z'))
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Merged')).toHaveText('4')
  expect(state.reads).toEqual([
    { since: '2026-10-24T21:00:00.000Z', until: '2026-10-25T22:00:00.000Z', org: null },
    { since: '2026-10-17T21:00:00.000Z', until: '2026-10-24T21:00:00.000Z', org: null },
  ])
})

test('says when the numbers could not be read instead of showing old ones', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Merged')).toHaveText('4')
  state.fail = true
  await page.locator('#analytics-panel').getByRole('button', { name: 'Previous day' }).click()
  await expect(page.locator('#analytics-panel .analytics-status')).toHaveText('acme: datastore offline')
  await expect(page.locator('#analytics-panel .analytics-tile')).toHaveCount(0)
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(page.locator('#analytics-panel')).not.toHaveClass(/open/)
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
  await expect(value(page, 'Merged')).toHaveText('4')
  const panel = page.locator('#analytics-panel')
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('7 Oct 2026')
  await expect(value(page, 'Merged')).toHaveText('4')
  const response = page.waitForResponse(res => new URL(res.url()).searchParams.get('since') === '2026-10-08T00:00:00.000Z')
  release()
  await response
  await expect(panel.locator('.analytics-groups')).not.toHaveAttribute('aria-busy', 'true')
  await expect(value(page, 'Merged')).toHaveText('4')
  await expect(mergeTrend(page)).toContainText('↓ 50%')
})

test('retains the selected calendar date when navigating across midnight', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  const panel = page.locator('#analytics-panel')
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('7 Oct 2026')
  await page.clock.setFixedTime(new Date('2026-10-10T00:01:00Z'))
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('6 Oct 2026')
  await expect.poll(() => state.reads.at(-2)?.since).toBe('2026-10-06T00:00:00.000Z')
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
  const panel = page.locator('#analytics-panel')
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
    await expect(value(page, 'Merged')).toHaveText(merged)
    await expect(loader).toBeHidden()
    await expect(panel.locator('.analytics-groups')).not.toHaveAttribute('aria-busy', 'true')
    held = new Promise<void>(resolve => { release = resolve })
  }
  try {
    await pending()
    await loaded('4')
    await panel.getByRole('button', { name: 'Previous day' }).click()
    await pending()
    await page.screenshot({ path: info.outputPath('analytics-loading.png') })
    await loaded('0')
    await page.locator('#current-filters').getByLabel('Account filter').selectOption('beta')
    await pending()
    await loaded('0')
    await page.keyboard.press('Escape')
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
  const panel = page.locator('#analytics-panel')
  await expect(panel.locator('.analytics-status')).toHaveText('acme: datastore offline')
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
  await expect(value(page, 'Merged')).toHaveText('0')
})
