import { expect, test, type Page } from '@playwright/test'
import type { AnalyticsReport } from '../../src/analytics-format'

// The Analytics panel (src/analytics.ts): opened from the burger menu on the
// range Current shows, switching ranges, the account filter, an error, and
// closing it. Poise's API is stood in for.

function report(merged: number): AnalyticsReport {
  return {
    window: { since: null, until: null },
    issues: { opened: 12, closed: 9 },
    pullRequests: {
      merged,
      commentsPerPr: merged ? 3.25 : null,
      lines: { total: merged ? 4210 : null, median: merged ? 180 : null, counted: merged ? merged - 1 : 0 },
      behaviors: { perPr: merged ? 2 : null, approvals: merged, reviews: merged, changesRequested: 0 },
      averageTimeToMergeMs: merged ? 27 * 3_600_000 : null,
    },
    errors: [],
  }
}

interface Workspace {
  /** Each /api/analytics read: its since, until and org. */
  reads: Array<{ since: string | null, until: string | null, org: string | null }>
  fail: boolean
}

async function workspace(page: Page): Promise<Workspace> {
  const state: Workspace = { reads: [], fail: false }
  // A Friday: the week began on Monday the 5th, in UTC as Settings says.
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
      // The week has merged pull requests, the other ranges none.
      return route.fulfill({ json: report(read.since === '2026-10-05T00:00:00.000Z' ? 4 : 0) })
    }
    if (url.pathname === '/api/settings') {
      return route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', organizations, models: {} } })
    }
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

function value(page: Page, label: string) {
  return page.locator('#analytics-panel .analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: new RegExp(`^${label}$`) }) }).locator('.analytics-value')
}

test('opens on Current\'s range and reads another range without changing Current', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  await expect(page.locator('#current-time-picker [data-time="week"]')).toHaveClass(/active/)
  await expect(page.locator('#analytics-panel')).toHaveAttribute('inert', '')

  await openAnalytics(page)
  const panel = page.locator('#analytics-panel')
  await expect(panel.getByRole('button', { name: 'This week' })).toHaveAttribute('aria-pressed', 'true')
  await expect(value(page, 'Opened')).toHaveText('12')
  await expect(value(page, 'Closed')).toHaveText('9')
  await expect(value(page, 'Merged')).toHaveText('4')
  await expect(value(page, 'Lines changed')).toHaveText('4,210')
  await expect(value(page, 'Time to merge')).toHaveText('1d 3h')
  await expect(value(page, 'Comments')).toHaveText('3.3')
  await expect(value(page, 'Median lines')).toHaveText('180')
  await expect(value(page, 'Behaviors')).toHaveText('2.0')
  await expect(panel).toContainText('4 approvals · 4 reviews · 0 change requests')
  await expect(panel).toContainText('From 3 of 4 pull requests')
  expect(state.reads).toEqual([{ since: '2026-10-05T00:00:00.000Z', until: null, org: null }])

  await panel.getByRole('button', { name: 'Yesterday' }).click()
  await expect(panel.getByRole('button', { name: 'Yesterday' })).toHaveAttribute('aria-pressed', 'true')
  await expect(value(page, 'Merged')).toHaveText('0')
  await expect(panel).toContainText('No pull requests were merged in this range.')
  await expect(value(page, 'Comments')).toHaveText('—')
  await panel.getByRole('button', { name: 'Today' }).click()
  await expect(panel.getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true')
  await panel.getByRole('button', { name: 'Any time' }).click()
  await expect(panel.getByRole('button', { name: 'Any time' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => state.reads.slice(1)).toEqual([
    { since: '2026-10-08T00:00:00.000Z', until: '2026-10-09T00:00:00.000Z', org: null },
    { since: '2026-10-09T00:00:00.000Z', until: null, org: null },
    { since: null, until: null, org: null },
  ])

  // Current keeps its own range.
  await expect(page.locator('#current-time-picker [data-time="week"]')).toHaveClass(/active/)

  await page.keyboard.press('Escape')
  await expect(panel).not.toHaveClass(/open/)
  await expect(panel).toHaveAttribute('inert', '')
})

test('reads the selected account again when the account filter changes', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Merged')).toHaveText('4')
  await page.locator('#current-filters').getByLabel('Account filter').selectOption('beta')
  await expect.poll(() => state.reads.at(-1)).toEqual({ since: '2026-10-05T00:00:00.000Z', until: null, org: 'beta' })
})

test('says when the numbers could not be read instead of showing old ones', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Merged')).toHaveText('4')
  state.fail = true
  await page.locator('#analytics-panel').getByRole('button', { name: 'Today' }).click()
  await expect(page.locator('#analytics-panel .analytics-status')).toHaveText('acme: datastore offline')
  await expect(page.locator('#analytics-panel .analytics-tile')).toHaveCount(0)
  // The burger closes the panel, as it closes Settings and Typography.
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(page.locator('#analytics-panel')).not.toHaveClass(/open/)
})
