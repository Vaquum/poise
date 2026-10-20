import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AnalyticsReport } from '../../src/analytics-format'
import type { AnalyticsHistory } from '../../src/analytics-history'
import type { GithubQuotaReport } from '../../src/github-quota'
import { WORK_TYPES } from '../../src/analytics-work-review'

test('reorders the card board by its headers, persists across reads and reload, and supports cancellation and reduced motion', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/github-quota', route => route.fulfill({ json: quotaReport() }))
  await page.goto('/')
  await openAnalytics(page)
  const board = page.locator('.analytics-board')
  await expect(board.locator('.analytics-panel')).toHaveCount(18)
  const ids = () => board.locator(':scope > [data-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-id')))
  const original = await ids()
  const first = board.getByRole('button', { name: 'Move Pull requests opened', exact: true })
  const second = board.getByRole('button', { name: 'Move Pull requests merged', exact: true })
  const a = (await first.boundingBox())!, b = (await second.boundingBox())!
  await page.mouse.move(a.x + 60, a.y + 20)
  await page.mouse.down()
  await page.mouse.move(b.x + 60, b.y + 20, { steps: 12 })
  await expect(board.locator('.analytics-card-held')).toHaveCount(1)
  await expect(page.locator('.analytics-drop-slot')).toBeVisible()
  expect(Math.abs((await first.boundingBox())!.x - b.x)).toBeLessThan(1)
  await expect.poll(() => board.locator('.analytics-panel:not(.analytics-card-held)[data-motion-running]').count()).toBeGreaterThan(0)
  await page.mouse.move(a.x + 60, a.y + 20, { steps: 4 })
  expect(Math.abs((await first.boundingBox())!.x - a.x)).toBeLessThan(1)
  await page.mouse.move(b.x + 60, b.y + 20, { steps: 4 })
  await expect(board.locator('.analytics-panel')).toHaveCount(18)
  await page.mouse.up()
  await expect.poll(async () => (await ids()).slice(0, 2)).toEqual([original[1], original[0]])
  await expect(board.locator('.analytics-card-held')).toHaveCount(0)
  const placed = await ids()
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect.poll(ids).toEqual(placed)
  await page.reload()
  await expect(board.locator('.analytics-panel')).toHaveCount(18)
  await expect.poll(ids).toEqual(placed)
  await first.focus()
  await first.press('Space')
  await first.press('End')
  await first.press('Escape')
  await expect.poll(ids).toEqual(placed)
  const quota = board.getByRole('button', { name: 'Move GitHub API · Live · octocat', exact: true })
  await quota.focus()
  await quota.press('Space')
  await quota.press('Home')
  await quota.press('Space')
  await expect.poll(async () => (await ids())[0]).toBe('quota:octocat')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await first.focus()
  await first.press('Space')
  await first.press('End')
  await first.press('Space')
  await expect.poll(async () => (await ids()).at(-1)).toBe(original[0])
  await expect(board.locator('[data-motion-running]')).toHaveCount(0)
  await expect(board.locator('.analytics-card-held')).toHaveCount(0)
  await expect(first).toBeFocused()
  for (const width of [1280, 736, 360]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(() => board.evaluate(board => Math.round(board.clientWidth))).toBeGreaterThan(0)
    await expect.poll(() => board.locator('[data-size="tall"]').evaluateAll(cards => new Set(cards.map(card => card.getBoundingClientRect().height)).size)).toBe(1)
    await expect.poll(() => board.locator('[data-size="short"]').evaluateAll(cards => new Set(cards.map(card => card.getBoundingClientRect().height)).size)).toBe(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
  }
  await expect(board.locator('[data-group="work-review"] .analytics-histogram, .quota-distribution')).toHaveCount(0)
})

test('retains the held card through live reads, restores cancelled pointer moves, and refits typography', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/github-quota', route => route.fulfill({ json: quotaReport() }))
  await page.goto('/')
  await openAnalytics(page)
  const board = page.locator('.analytics-board')
  await expect(board.locator('.analytics-panel')).toHaveCount(18)
  await expect(board.locator('.analytics-history-line')).toHaveCount(15)
  const first = board.getByRole('button', { name: 'Move Pull requests opened', exact: true })
  const second = board.getByRole('button', { name: 'Move Pull requests merged', exact: true })
  const retained = await first.elementHandle()
  const order = () => board.locator(':scope > [data-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-id')))
  const original = await order()
  const a = (await first.boundingBox())!, b = (await second.boundingBox())!
  await first.evaluate(button => {
    if (button instanceof HTMLElement) button.addEventListener('pointerdown', event => button.setAttribute('data-test-pointer', String(event.pointerId)), { once: true })
  })
  await page.mouse.move(a.x + 60, a.y + 20)
  await page.mouse.down()
  await page.mouse.move(b.x + 60, b.y + 20, { steps: 12 })
  const pointerId = Number(await first.getAttribute('data-test-pointer'))
  await page.evaluate(() => { window.dispatchEvent(new Event('poise:refresh-tick')); document.dispatchEvent(new Event('visibilitychange')) })
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  expect(await retained!.evaluate(button => button.isConnected)).toBe(true)
  await first.dispatchEvent('pointercancel', { pointerId })
  expect(await first.evaluate((button, id) => button.hasPointerCapture(id), pointerId)).toBe(false)
  await page.mouse.up()
  await expect.poll(order).toEqual(original)
  await expect(board.locator('.analytics-card-held')).toHaveCount(0)
  await expect(first).toHaveCSS('touch-action', 'none')
  await first.focus()
  await first.press('Space')
  await page.setViewportSize({ width: 500, height: 900 })
  await expect(first).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.analytics-drop-slot')).toBeHidden()
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--typo-size', '24px')
    document.documentElement.style.setProperty('--typo-lh', '1.8')
  })
  await expect.poll(() => board.locator('.analytics-panel').evaluateAll(cards => cards.every(card => card.scrollHeight <= card.clientHeight + 2 && card.scrollWidth <= card.clientWidth + 1))).toBe(true)
  for (const family of ['tall', 'short']) await expect.poll(() => board.locator(`[data-size="${family}"]`).evaluateAll(cards => new Set(cards.map(card => card.getBoundingClientRect().height)).size)).toBe(1)
})

test('applies and clears a deferred live read even when saving the card order fails', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  const handle = page.getByRole('button', { name: 'Move Pull requests opened', exact: true })
  await expect(mergeTrend(page)).toContainText('7-day median: 12h')
  await page.evaluate(() => {
    const write = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'poise-analytics-card-order') throw new DOMException('Storage full', 'QuotaExceededError')
      return write.call(this, key, value)
    }
  })
  await handle.focus()
  await handle.press('Space')
  await handle.press('ArrowRight')
  state.baselineHours = 81
  const baselineRead = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/analytics' && url.searchParams.has('dailyBounds')
  })
  const dayRead = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/analytics' && !url.searchParams.has('dailyBounds')
  })
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await Promise.all((await Promise.all([baselineRead, dayRead])).map(response => response.finished()))
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(handle).toHaveAttribute('aria-pressed', 'true')
  await handle.press('Space')
  await expect(page.locator('#analytics-layout-status')).toContainText('Analytics layout could not be saved')
  await expect(mergeTrend(page)).toContainText('7-day median: 18h')
  state.baselineHours = 90
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(mergeTrend(page)).toContainText('7-day median: 20h')
  await handle.focus()
  await handle.press('Space')
  await handle.press('Escape')
  await expect(mergeTrend(page)).toContainText('7-day median: 20h')
})

test('touch dragging reaches an off-screen destination without extending the page', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium CDP provides native touch input.')
  await workspace(page)
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto('/')
  await openAnalytics(page)
  const board = page.getByRole('region', { name: 'Analytics panels', exact: true })
  await expect(board.locator('.analytics-history-line')).toHaveCount(15)
  const first = board.getByRole('button', { name: 'Move Pull requests opened', exact: true })
  await first.scrollIntoViewIfNeeded()
  const a = (await first.boundingBox())!
  const originalHeight = await page.evaluate(() => document.documentElement.scrollHeight)
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x + 60, y: a.y + 20, id: 1 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + 60, y: 784, id: 1 }] })
    await expect(first).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight - scrollY), { timeout: 15_000 }).toBeLessThan(5)
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(originalHeight + 2)
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => board.locator(':scope > [data-id]').last().getAttribute('data-label')).toBe('Pull requests opened')
    await expect(board.locator('.analytics-card-held')).toHaveCount(0)
    await expect(page.locator('.analytics-drop-slot')).toBeHidden()
  } finally { await client.detach() }
})

test('fits all work types and retains interleaved account positions through failures, foreground loads and corrupt preferences', async ({ page }) => {
  await workspace(page)
  let quotaFails = false, hold = false, release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const quota = quotaReport()
  quota.accounts[1].login = 'averylonggithubaccountwiththirtyninechars'.slice(0, 39)
  await page.route('**/api/github-quota', route => quotaFails ? route.fulfill({ status: 502, json: { error: 'Quota offline' } }) : route.fulfill({ json: quota }))
  await page.route('**/api/analytics?**', async route => {
    if (hold) await waiting
    const data = report(12)
    data.pullRequests.workReview!.types = WORK_TYPES.map(type => ({ type, count: 1 }))
    await route.fulfill({ json: data })
  })
  await page.goto('/')
  const prefix = ['quota:octocat', 'metric:work-review:Work type', 'metric:per-merged-pr:Comments', 'metric:productivity:Lines changed']
  await page.evaluate(order => localStorage.setItem('poise-analytics-card-order', JSON.stringify([...order, order[0], 'obsolete'])), prefix)
  await openAnalytics(page)
  const board = page.getByRole('region', { name: 'Analytics panels', exact: true })
  const order = () => board.locator(':scope > [data-id]').evaluateAll(cards => cards.map(card => card.getAttribute('data-id')))
  await expect(board.locator('.analytics-panel')).toHaveCount(18)
  await expect.poll(async () => (await order()).slice(0, 4)).toEqual(prefix)
  await expect(board.getByRole('article', { name: 'Comments per merged pull request', exact: true })).toHaveCount(1)
  await expect(board.getByRole('article', { name: 'GitHub API · Live · octocat', exact: true })).toHaveAttribute('aria-describedby', 'analytics-quota-help')
  await expect(board.locator('.analytics-work-type')).toHaveCount(12)
  for (const width of [1280, 736, 360]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => document.documentElement.style.setProperty('--typo-size', '24px'))
    await expect.poll(() => board.locator('.analytics-panel').evaluateAll(cards => cards.every(card => card.scrollHeight <= card.clientHeight + 2 && card.scrollWidth <= card.clientWidth + 1))).toBe(true)
    for (const family of ['tall', 'short']) await expect.poll(() => board.locator(`[data-size="${family}"]`).evaluateAll(cards => new Set(cards.map(card => card.getBoundingClientRect().height)).size)).toBe(1)
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  const plot = board.locator('.analytics-history[data-series="Lines changed"] .analytics-history-plot')
  await plot.focus()
  await plot.press('Home')
  const retained = await plot.elementHandle()
  quotaFails = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(board.locator('.github-quota-account')).toHaveCount(0)
  await expect(plot).toBeFocused()
  expect(await retained!.evaluate(element => element.closest<HTMLElement>('[data-id]')!.dataset.id)).toBe('metric:productivity:Lines changed')
  quotaFails = false
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(board.locator('.github-quota-account')).toHaveCount(2)
  await expect.poll(async () => (await order()).slice(0, 4)).toEqual(prefix)
  const before = await board.locator('[data-group="quota"]').evaluateAll(cards => cards.map(card => ({ id: card.getAttribute('data-id'), y: card.getBoundingClientRect().y })))
  hold = true
  try {
    await page.getByRole('button', { name: 'Previous day', exact: true }).click()
    await expect(board).toHaveAttribute('aria-busy', 'true')
    await expect(board.locator('.analytics-value')).toHaveCount(0)
    await expect.poll(() => board.locator('[data-group="quota"]').evaluateAll((cards, previous) => cards.every((card, index) => card.getAttribute('data-id') === previous[index].id && Math.abs(card.getBoundingClientRect().y - previous[index].y) < 1), before)).toBe(true)
  } finally { hold = false; release() }
  await expect(board.locator('.analytics-value')).toHaveCount(16)
  await expect.poll(async () => (await order()).slice(0, 4)).toEqual(prefix)
  await page.evaluate(() => localStorage.setItem('poise-analytics-card-order', '{bad json'))
  await page.reload()
  await expect(board.locator('.analytics-panel')).toHaveCount(18)
  await expect(page.locator('#analytics-layout-status')).toContainText('Saved analytics layout could not be read')
  expect(new Set(await order()).size).toBe(18)
})

test('places a wide account card at both boundaries sharing a wrapped destination', async ({ page }) => {
  await workspace(page)
  await page.setViewportSize({ width: 1280, height: 2600 })
  await page.route('**/api/github-quota', route => route.fulfill({ json: quotaReport() }))
  await page.goto('/')
  await openAnalytics(page)
  const board = page.locator('.analytics-board')
  await expect(board.locator('.analytics-panel')).toHaveCount(18)
  const quota = board.getByRole('button', { name: 'Move GitHub API · Live · octocat', exact: true })
  for (const index of [3, 4]) {
    await quota.focus()
    await quota.press('Space')
    await quota.press('End')
    await quota.press('Space')
    await expect(board.locator('.analytics-card-held')).toHaveCount(0)
    const target = (await board.locator('[data-group="productivity"]').nth(index - 1).boundingBox())!
    const start = (await quota.boundingBox())!
    await page.mouse.move(start.x + 30, start.y + 20)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width - 2, target.y + 20, { steps: 16 })
    await page.mouse.up()
    await expect.poll(() => board.locator(':scope > [data-id]').nth(index).getAttribute('data-id')).toBe('quota:octocat')
    await expect(board.locator('.analytics-card-held')).toHaveCount(0)
  }
})

test('vertical header keys move wide cards between visual rows', async ({ page }) => {
  await workspace(page)
  await page.goto('/')
  await openAnalytics(page)
  const handle = page.getByRole('button', { name: 'Move Work type', exact: true })
  await handle.scrollIntoViewIfNeeded()
  await handle.focus()
  const top = () => handle.evaluate(button => button.getBoundingClientRect().top + scrollY)
  const before = await top()
  await handle.press('Space')
  await handle.press('ArrowDown')
  await handle.press('Space')
  await expect.poll(top).toBeGreaterThan(before + 1)
  const below = await top()
  await handle.press('Space')
  await handle.press('ArrowUp')
  await handle.press('Space')
  await expect.poll(top).toBeLessThan(below - 1)
  await expect(handle).toBeFocused()
})

test('paints history readouts above neighboring cards and retains their period through quota polling', async ({ page }) => {
  await workspace(page)
  let quotaReads = 0
  await page.route('**/api/github-quota', route => { quotaReads++; return route.fulfill({ json: quotaReport() }) })
  await page.goto('/')
  await openAnalytics(page)
  const panel = page.locator('[data-id="metric:productivity:Pull requests opened"]')
  const plot = panel.locator('.analytics-history-plot')
  await plot.focus()
  await plot.press('End')
  const tip = panel.locator('.analytics-history-tip')
  await expect(tip).toBeVisible()
  expect(await tip.evaluate(element => {
    const card = element.closest<HTMLElement>('.analytics-panel')!, box = element.getBoundingClientRect(), bounds = card.getBoundingClientRect()
    if (box.right <= bounds.right + 8) throw new Error('The fixture must overlap a neighbor.')
    const previous = (element as HTMLElement).style.pointerEvents
    ;(element as HTMLElement).style.pointerEvents = 'auto'
    const hit = document.elementFromPoint(bounds.right + 8, box.top + 8)?.closest<HTMLElement>('.analytics-panel')?.dataset.id
    ;(element as HTMLElement).style.pointerEvents = previous
    return hit
  })).toBe('metric:productivity:Pull requests opened')
  await plot.press('Home')
  const selected = await tip.locator('span').first().innerText()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(() => quotaReads).toBe(2)
  await expect(tip).toBeVisible()
  await expect(tip.locator('span').first()).toHaveText(selected)
  await expect(plot).toBeFocused()
})

function report(merged: number, hours = 27): AnalyticsReport {
  return {
    window: { since: null, until: null },
    agentAccount: 'octo-agent',
    issues: { opened: 12, closed: 9 },
    pullRequests: {
      opened: 5,
      closedUnmerged: 1,
      merged,
      workReview: {
        reviewed: merged,
        types: merged ? [{ type: 'feat', count: Math.ceil(merged / 2) }, { type: 'fix', count: Math.floor(merged / 2) }] : [],
        rounds: { median: merged ? 3 : null, counted: merged, missingReviews: 0, distribution: merged ? [{ rounds: 3, prs: merged }] : [] },
        changesRequested: { prs: merged ? merged === 4 ? 3 : Math.floor(merged / 2) : 0, reviews: merged, dismissed: 0, counted: merged },
      },
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
  quotaReads: number
  historyReads: Array<{ bounds: string[], org: string | null }>
  historyFails: boolean
  reads: Array<{ since: string | null, until: string | null, org: string | null }>
  fail: boolean
  stale: boolean
  partial: 'day' | 'baseline' | null
  additionalMissingOrg: string | null
  baselineHours: number
  baselineMerged: number
  pacing: { merged: number, median: number } | null
  closedUnmerged: { current: number, median: number } | null
  medianLines: { current: number, baseline: number } | null
}

async function workspace(page: Page, timezone = 'UTC'): Promise<Workspace> {
  const state: Workspace = { quotaReads: 0, historyReads: [], historyFails: false, reads: [], fail: false, stale: false, partial: null, additionalMissingOrg: null, baselineHours: 54, baselineMerged: 8, pacing: null, closedUnmerged: null, medianLines: null }
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
      if (state.partial === (baseline ? 'baseline' : 'day')) result.errors.push({ org: 'beta', error: 'Account scope unavailable' })
      if (baseline && state.additionalMissingOrg) result.errors.push({ org: state.additionalMissingOrg, error: 'Additional account scope unavailable' })
      if (baseline) result.daily = Array.from({ length: 7 }, () => {
        const pullRequests = report(state.pacing?.median ?? 1).pullRequests
        if (state.pacing) pullRequests.lines = { total: pullRequests.merged * 1000, median: 180, counted: pullRequests.merged }
        if (state.closedUnmerged) pullRequests.closedUnmerged = state.closedUnmerged.median
        return { issues: { opened: 2, closed: 1 }, pullRequests }
      })
      if (state.pacing) result.pullRequests.lines = { total: result.pullRequests.merged * 1000, median: 180, counted: result.pullRequests.merged }
      if (state.closedUnmerged) result.pullRequests.closedUnmerged = baseline ? state.closedUnmerged.median * 7 : state.closedUnmerged.current
      if (state.medianLines) result.pullRequests.lines = { ...result.pullRequests.lines, median: baseline ? state.medianLines.baseline : state.medianLines.current, counted: result.pullRequests.merged }
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
    if (url.pathname === '/api/github-quota') {
      state.quotaReads++
      return route.fulfill({ json: { accounts: [] } })
    }
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

async function installRefreshClock(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install({ time: new Date('2026-10-09T10:00:00Z') })
}

async function pauseRefreshClock(page: Page) {
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible()
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(new Date(now + 1000))
  await page.clock.setFixedTime(new Date('2026-10-09T10:00:00Z'))
}

async function refreshAnalytics(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
}

async function changeVisibility(page: Page, state: DocumentVisibilityState) {
  await page.evaluate(visibility => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: visibility })
    Object.defineProperty(document, 'hidden', { configurable: true, value: visibility === 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
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
  await expect(view.locator('main h2')).toHaveCount(0)
  const topline = view.locator('[data-group="productivity"]')
  const flow = topline
  const perPr = view.locator('[data-group="per-merged-pr"]')
  const quota = view.locator('.analytics-board')
  const cardOrder = ['Pull requests opened', 'Pull requests merged', 'Closed without merging', 'Lines changed', 'Time to first review', 'Time to merge', 'Issues opened', 'Issues closed']
  await expect(topline.locator('.analytics-label')).toHaveText(cardOrder)
  await expect(perPr.locator('.analytics-label')).toHaveText(['Comments', 'Median lines', 'Behaviors', 'Median time', 'Merged by agent'])
  // Seconds matter: agents review within minutes.
  await expect(value(page, 'Time to first review')).toHaveText('1m 15s')
  await expect(flow.locator('.analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: /^Time to first review$/ }) }).locator('[data-help="Faster vs 7-day median"]')).toBeVisible()
  await expect(view.locator('.analytics-board')).toContainText('7-day median: 2m 30s · 3 first reviews')
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
  const work = view.locator('[data-group="work-review"]')
  await expect(work.locator('.analytics-label')).toHaveText(['Work type', 'Review rounds', 'Change-request share'])
  const row = await work.locator('.analytics-tile').evaluateAll((tiles) => tiles.map((tile) => {
    const { x, y, width, height } = tile.closest('.analytics-panel')!.getBoundingClientRect()
    return { x, y, width, height }
  }))
  expect(new Set(row.map((box) => box.y)).size).toBe(1)
  expect(row[0].width).toBeCloseTo(row[1].width * 2 + 12, 0)
  expect(row[1].width).toBeCloseTo(row[2].width, 0)
  expect(row[0].y).toBeGreaterThan((await topline.first().boundingBox())!.y)
  expect(row[0].y + row[0].height).toBeLessThan((await perPr.first().boundingBox())!.y)
  await expect(value(page, 'Work type')).toHaveText('50.0%')
  await expect(work.locator('.analytics-work-type')).toHaveCount(2)
  await expect(value(page, 'Review rounds')).toHaveText('3.0')
  await expect(countTrend(page, 'Review rounds')).toContainText('0%')
  await expect(countTrend(page, 'Review rounds')).toContainText('7-day median: 3.0 · 8 PRs')
  await expect(countTrend(page, 'Review rounds')).toHaveClass(/neutral/)
  await expect(value(page, 'Review rounds')).toHaveAttribute('data-help', /Multiple reviews of one commit count once/)
  await expect(countTrend(page, 'Change-request share')).toHaveClass(/bad/)
  await expect(value(page, 'Change-request share')).toHaveText('75.0%')
  await expect(countTrend(page, 'Change-request share')).toContainText('50%')
  await expect(countTrend(page, 'Change-request share')).toContainText('7-day share: 50.0% · 8 PRs')
  await expect(work.locator('.analytics-histogram')).toHaveCount(0)
  await expect(work.locator('select')).toHaveCount(0)
  await expect(work.locator('.analytics-drag-handle')).toHaveCount(3)
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
  await expect(value(page, 'Work type')).toHaveText('—')
  await expect(value(page, 'Review rounds')).toHaveText('—')
  await expect(value(page, 'Change-request share')).toHaveText('—')
  await openAnalytics(page)
  await expect(view.locator('.analytics-date')).toHaveText('Today')
  await expect(view.getByRole('button', { name: 'Next day' })).toBeDisabled()
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  await expect.poll(() => state.reads.slice(-2)).toEqual([
    { since: '2026-10-09T00:00:00.000Z', until: '2026-10-10T00:00:00.000Z', org: null },
    { since: '2026-10-02T00:00:00.000Z', until: '2026-10-09T00:00:00.000Z', org: null },
  ])
})

test('keeps missing review identities in tooltips while showing known change-request incidence', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/analytics?**', async (route) => {
    const data = report(4)
    data.pullRequests.workReview!.rounds = { median: null, counted: 3, missingReviews: 2, distribution: [{ rounds: 3, prs: 3 }] }
    await route.fulfill({ json: data })
  })
  await page.goto('/')
  await openAnalytics(page)
  const figure = value(page, 'Review rounds')
  await expect(figure).toHaveText('—')
  await expect(figure).toHaveAttribute('data-help', /exact round counts for 3 of 4 merged PRs; 2 reviews lack commit identities/)
  await expect(value(page, 'Change-request share')).toHaveText('75.0%')
  await expect(page.locator('.analytics-history[data-series="Review rounds"] .analytics-history-line')).toHaveCount(1)
  await figure.scrollIntoViewIfNeeded()
  await expect(figure).toBeInViewport()
  await figure.focus()
  await expect(page.getByRole('tooltip')).toContainText('3 of 4 merged PRs')
  await expect(page.locator('.analytics-board')).not.toContainText('lack commit identities')
})

test('explains missing baseline and historical round coverage independently of a complete day', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 820 })
  await workspace(page)
  await page.route('**/api/analytics?**', async (route) => {
    const query = new URL(route.request().url()).searchParams
    const baseline = Date.parse(query.get('until')!) - Date.parse(query.get('since')!) > 2 * 86_400_000
    const data = report(4)
    if (baseline) data.pullRequests.workReview!.rounds = { median: null, counted: 3, missingReviews: 2, distribution: [{ rounds: 3, prs: 3 }] }
    await route.fulfill({ json: data })
  })
  await page.route('**/api/analytics/history?**', async (route) => {
    const data = history(new URL(route.request().url()).searchParams.get('bounds')!.split(','))
    data.periods.at(-1)!.pullRequests = report(4).pullRequests
    data.periods.at(-1)!.pullRequests.workReview!.rounds = { median: null, counted: 3, missingReviews: 2, distribution: [{ rounds: 3, prs: 3 }] }
    await route.fulfill({ json: data })
  })
  await page.goto('/')
  await openAnalytics(page)
  const figure = value(page, 'Review rounds')
  await expect(figure).toHaveText('3.0')
  await expect(figure).toHaveAttribute('data-help', /Selected day: exact round counts for 4 of 4.*7-day baseline: exact round counts for 3 of 4 merged PRs; 2 reviews lack commit identities/)
  await expect(countTrend(page, 'Review rounds')).toContainText('7-day median: — · 4 PRs')
  const plot = page.locator('.analytics-history[data-series="Review rounds"] .analytics-history-plot')
  await plot.focus()
  await page.keyboard.press('End')
  await expect(page.locator('.analytics-history[data-series="Review rounds"] .analytics-history-tip')).toContainText('exact round counts for 3 of 4 merged PRs; 2 reviews lack commit identities')
  const tip = (await page.locator('.analytics-history[data-series="Review rounds"] .analytics-history-tip').boundingBox())!
  expect(tip.x).toBeGreaterThanOrEqual(8)
  expect(tip.x + tip.width).toBeLessThanOrEqual(412)
})

test('keeps known daily round counts visible while year history is delayed or unavailable', async ({ page }) => {
  await workspace(page)
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/analytics/history?**', async (route) => {
    await held
    await route.fulfill({ status: 502, json: { error: 'History unavailable' } })
  })
  await page.route('**/api/analytics?**', async (route) => {
    const data = report(4)
    data.pullRequests.workReview!.rounds = { median: null, counted: 3, missingReviews: 2, distribution: [{ rounds: 0, prs: 1 }, { rounds: 3, prs: 2 }] }
    await route.fulfill({ json: data })
  })
  await page.goto('/')
  await openAnalytics(page)
  const rounds = page.locator('[data-group="work-review"]').locator('.analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: /^Review rounds$/ }) })
  await expect(value(page, 'Review rounds')).toHaveText('—')
  await expect(rounds.locator('.analytics-history-plot')).toHaveAttribute('aria-busy', 'true')
  await expect(rounds.locator('.analytics-histogram')).toHaveCount(0)
  release()
  await expect(rounds.locator('.analytics-history')).toHaveAttribute('aria-label', 'History unavailable')
  await expect(rounds.locator('.analytics-histogram')).toHaveCount(0)
})

test('updates work and review cards and charts by day and organization, discarding late history', async ({ page }) => {
  await workspace(page)
  const dataFor = (org: string | null, since: string) => {
    const beta = org === 'beta'
    const yesterday = since === '2026-10-08T00:00:00.000Z'
    const data = report(4)
    const rounds = beta ? yesterday ? 7 : 6 : yesterday ? 3 : 2
    data.pullRequests.workReview!.types = [{ type: beta ? yesterday ? 'perf' : 'fix' : yesterday ? 'docs' : 'feat', count: 4 }]
    data.pullRequests.workReview!.rounds = { median: rounds, counted: 4, missingReviews: 0, distribution: [{ rounds, prs: 4 }] }
    data.pullRequests.workReview!.changesRequested.prs = beta ? yesterday ? 4 : 3 : yesterday ? 2 : 1
    return data
  }
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let lateHistory = false
  let finished = false
  await page.route('**/api/analytics?**', async (route) => {
    const query = new URL(route.request().url()).searchParams
    await route.fulfill({ json: dataFor(query.get('org'), query.get('since')!) })
  })
  await page.route('**/api/analytics/history?**', async (route) => {
    const query = new URL(route.request().url()).searchParams
    const bounds = query.get('bounds')!.split(',')
    const delayed = query.get('org') === 'beta' && bounds.at(-1) === '2026-10-08T00:00:00.000Z'
    if (delayed) { lateHistory = true; await held }
    const data = history(bounds)
    for (const period of data.periods) period.pullRequests = dataFor(query.get('org'), bounds.at(-1)!).pullRequests
    try { await route.fulfill({ json: data }) } finally { if (delayed) finished = true }
  })
  await page.goto('/')
  await openAnalytics(page)
  const work = page.locator('[data-group="work-review"]')
  const assertCards = async (type: string, rounds: number, share: string, chart = true) => {
    await expect(work.locator('.analytics-work-label')).toHaveText(type)
    await expect(value(page, 'Review rounds')).toHaveText(`${rounds}.0`)
    await expect(value(page, 'Change-request share')).toHaveText(share)
    await expect(work.locator('.analytics-work-type')).toHaveAttribute('data-help', new RegExp(`${type}: 4 of 4`))
    if (chart) await expect(work.locator('.analytics-history[data-series="Review rounds"] .analytics-history-max')).toHaveText(`Max ${rounds}.0`)
  }
  await assertCards('feat', 2, '25.0%')
  await page.getByRole('button', { name: 'Previous day' }).click()
  await assertCards('docs', 3, '50.0%')
  await page.locator('#analytics-filters').getByLabel('Organization filter').selectOption('beta')
  await assertCards('perf', 7, '100.0%', false)
  await expect.poll(() => lateHistory).toBe(true)
  await page.getByRole('button', { name: 'Next day' }).click()
  await assertCards('fix', 6, '75.0%')
  release()
  await expect.poll(() => finished).toBe(true)
  await assertCards('fix', 6, '75.0%')
  await page.locator('#analytics-filters').getByLabel('Organization filter').selectOption('')
  await assertCards('feat', 2, '25.0%')
})

test('keeps Productivity in two rows beside a docked notification rail', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await workspace(page)
  await page.addInitScript(() => localStorage.setItem('poise-notification-rail', JSON.stringify({ docked: true, open: true })))
  await page.route('**/api/github-quota', (route) => route.fulfill({ json: quotaReport() }))
  await page.goto('/')
  await expect(page.locator('body')).toHaveClass(/notifications-docked/)
  await openAnalytics(page)
  const topline = page.locator('[data-group="productivity"]')
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
  const topline = page.locator('[data-group="productivity"]')
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
  await expect(page.locator('.analytics-board')).not.toContainText('Under each figure')
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
  const tile = page.locator('[data-group="productivity"]').locator('.analytics-tile').filter({ has: page.locator('.analytics-label', { hasText: /^Issues opened$/ }) })
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
  expect(new Set(await lefts(view.locator('[data-group="productivity"]'), '.analytics-tile')).size).toBe(1)
  await expect(view.locator('.analytics-history-line')).toHaveCount(15)
  const overflows = await view.locator('.analytics-tile:not(.analytics-work-tile)').evaluateAll((tiles) => tiles.map((tile) => {
    const histogram = tile.querySelector('.analytics-histogram')!
    return histogram ? histogram.getBoundingClientRect().bottom - tile.getBoundingClientRect().bottom : -Infinity
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
  expect(tip.width).toBeLessThanOrEqual(main.width)
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
  const section = page.locator('.analytics-board')
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
  await expect(section.locator(':scope > .github-quota-account')).toHaveCount(2)
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
  const section = page.locator('.analytics-board')
  await expect(section).not.toContainText('Quota service unavailable')
  failed = false
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(section.locator('.github-quota-account')).toHaveCount(0)
  await expect(section).not.toHaveClass(/st-help-error/)
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
  await expect(panel.locator('[data-group="per-merged-pr"] .analytics-label').nth(3)).toHaveText('Median time')
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

test('refreshes one quiet local pair on ticks and visibility return while keeping counts and pace in one snapshot', async ({ page }) => {
  const state = await workspace(page)
  state.pacing = { merged: 15, median: 27 }
  state.baselineMerged = 189
  let releaseHistory!: () => void
  const historyHeld = new Promise<void>((resolve) => { releaseHistory = resolve })
  await page.route('**/api/analytics/history?**', async (route) => { await historyHeld; await route.fallback() })
  await installRefreshClock(page)
  await page.goto('/')
  await pauseRefreshClock(page)
  await openAnalytics(page)
  const merged = countTrend(page)
  const panel = page.locator('#view-analytics')
  const expectInitialSnapshot = async () => {
    await expect(merged.locator('.analytics-value')).toHaveText('15')
    await expect(merged).toHaveClass(/good/)
    await expect(merged.locator('.analytics-arrow')).toHaveText('↑')
    await expect(merged.locator('.analytics-delta')).toHaveText('33.3% ahead of pace')
    await expect(merged).toContainText('Typical by now: 11.3 · 7-day median: 27.0 / day')
    await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 10:00 UTC, when totals were read\./)
  }
  await expectInitialSnapshot()

  await page.clock.setFixedTime(new Date('2026-10-09T13:00:00Z'))
  await expectInitialSnapshot()
  expect(state.reads).toHaveLength(2)
  expect(state.historyReads).toHaveLength(0)
  const graph = page.locator('.analytics-history[data-series="Pull requests merged"] .analytics-history-line')
  await expectInitialSnapshot()

  let releaseRefresh!: () => void
  const refreshHeld = new Promise<void>((resolve) => { releaseRefresh = resolve })
  let refreshRequests = 0
  await page.route('**/api/analytics?**', async (route) => {
    refreshRequests++
    await refreshHeld
    await route.fallback()
  })
  await page.clock.setFixedTime(new Date('2026-10-09T14:00:00Z'))
  state.pacing.merged = 16
  await refreshAnalytics(page)
  await expect.poll(() => refreshRequests).toBe(2)
  await expectInitialSnapshot()
  await expect(panel.locator('.analytics-tile')).toHaveCount(16)
  await expect(panel.getByRole('status', { name: 'Loading analytics' })).toBeHidden()
  await expect(panel.locator('.analytics-groups')).not.toHaveAttribute('aria-busy', 'true')
  await refreshAnalytics(page)
  await refreshAnalytics(page)
  expect(refreshRequests).toBe(2)
  expect(state.historyReads).toHaveLength(0)
  expect(state.quotaReads).toBe(1)
  await changeVisibility(page, 'visible')
  await expect.poll(() => state.quotaReads).toBe(2)
  expect(refreshRequests).toBe(2)
  releaseRefresh()
  await expect(merged.locator('.analytics-value')).toHaveText('16')
  await expect(merged).toHaveClass(/neutral/)
  await expect(merged.locator('.analytics-arrow')).toHaveText('→')
  await expect(merged.locator('.analytics-delta')).toHaveText('On pace')
  await expect(merged).toContainText('Typical by now: 15.8 · 7-day median: 27.0 / day')
  await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 14:00 UTC, when totals were read\./)
  const colors = await merged.evaluate(element => ['.analytics-value', '.analytics-arrow', '.analytics-delta'].map(selector => getComputedStyle(element.querySelector(selector)!).color))
  expect(new Set(colors).size).toBe(1)
  expect(state.reads).toHaveLength(4)
  expect(state.historyReads).toHaveLength(0)
  releaseHistory()
  await expect(graph).toHaveAttribute('d', /^M/)
  const graphBefore = await graph.getAttribute('d')
  await expect(merged.locator('.analytics-value')).toHaveText('16')
  await expect(merged.locator('.analytics-delta')).toHaveText('On pace')
  await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 14:00 UTC/)
  expect(state.historyReads).toHaveLength(1)

  await changeVisibility(page, 'hidden')
  await page.clock.setFixedTime(new Date('2026-10-09T18:00:00Z'))
  state.pacing.merged = 17
  await refreshAnalytics(page)
  expect(state.reads).toHaveLength(4)
  expect(state.quotaReads).toBe(2)
  await expect(merged.locator('.analytics-value')).toHaveText('16')
  await changeVisibility(page, 'visible')
  await expect(merged.locator('.analytics-value')).toHaveText('17')
  await expect(merged).toHaveClass(/bad/)
  await expect(merged.locator('.analytics-arrow')).toHaveText('↓')
  await expect(merged.locator('.analytics-delta')).toHaveText('16% behind pace')
  await expect(merged).toContainText('Typical by now: 20.3 · 7-day median: 27.0 / day')
  await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 18:00 UTC, when totals were read\./)
  await expect(mergeTrend(page).locator('.analytics-delta')).toHaveText('50%')
  expect(state.reads).toHaveLength(6)
  expect(state.historyReads).toHaveLength(1)
  await expect.poll(() => state.quotaReads).toBe(3)
  await expect(graph).toHaveAttribute('d', graphBefore!)

  await leaveAnalytics(page)
  const hiddenSummary = await merged.textContent()
  await refreshAnalytics(page)
  await changeVisibility(page, 'visible')
  await expect(merged).toHaveText(hiddenSummary!)
  expect(state.reads).toHaveLength(6)
  expect(state.historyReads).toHaveLength(1)
  expect(state.quotaReads).toBe(3)
})

test('keeps the last complete snapshot on a quiet failure, cancels the other half and recovers on the next tick', async ({ page }) => {
  const state = await workspace(page)
  state.pacing = { merged: 15, median: 27 }
  state.baselineMerged = 189
  await installRefreshClock(page)
  await page.goto('/')
  await pauseRefreshClock(page)
  await openAnalytics(page)
  const panel = page.locator('#view-analytics')
  const merged = countTrend(page)
  await expect(merged.locator('.analytics-delta')).toHaveText('33.3% ahead of pace')

  let releaseBaseline!: () => void
  const baselineHeld = new Promise<void>((resolve) => { releaseBaseline = resolve })
  let baselineFinished!: () => void
  const finished = new Promise<void>((resolve) => { baselineFinished = resolve })
  let holdBaseline = true
  await page.route('**/api/analytics?**', async (route) => {
    const query = new URL(route.request().url()).searchParams
    if (!holdBaseline || !query.has('dailyBounds')) return route.fallback()
    state.reads.push({ since: query.get('since'), until: query.get('until'), org: query.get('org') })
    await baselineHeld
    try { await route.fulfill({ json: report(189, 54) }) } finally { baselineFinished() }
  })
  await page.clock.setFixedTime(new Date('2026-10-09T14:00:00Z'))
  state.pacing.merged = 16
  state.fail = true
  const canceledBaseline = page.waitForEvent('requestfailed', {
    predicate: request => new URL(request.url()).pathname === '/api/analytics' && new URL(request.url()).searchParams.has('dailyBounds'),
  })
  await refreshAnalytics(page)
  await canceledBaseline
  await expect(merged.locator('.analytics-value')).toHaveText('15')
  await expect(merged.locator('.analytics-delta')).toHaveText('33.3% ahead of pace')
  await expect(merged).toContainText('Typical by now: 11.3 · 7-day median: 27.0 / day')
  await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 10:00 UTC/)
  await expect(panel.getByRole('status', { name: 'Loading analytics' })).toBeHidden()
  await expect(panel.locator('.analytics-tile')).toHaveCount(16)
  await page.locator('.nr-bell').click()
  const failure = page.locator('.nr-rail .nr-card').filter({ hasText: 'acme: datastore offline' })
  await expect(failure).toHaveCount(1)
  expect(state.reads).toHaveLength(4)
  expect(state.historyReads).toHaveLength(1)
  expect(state.quotaReads).toBe(1)
  releaseBaseline()
  await finished

  holdBaseline = false
  state.fail = false
  await refreshAnalytics(page)
  await expect(merged.locator('.analytics-value')).toHaveText('16')
  await expect(merged.locator('.analytics-delta')).toHaveText('On pace')
  await expect(merged).toContainText('Typical by now: 15.8 · 7-day median: 27.0 / day')
  await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 14:00 UTC/)
  await expect(failure).toHaveCount(0)
  expect(state.reads).toHaveLength(6)
  expect(state.historyReads).toHaveLength(1)
  expect(state.quotaReads).toBe(1)

  await page.clock.setFixedTime(new Date('2026-10-09T15:00:00Z'))
  state.pacing.merged = 20
  state.partial = 'baseline'
  await refreshAnalytics(page)
  const partialFailure = page.locator('.nr-rail .nr-card').filter({ hasText: 'Account scope unavailable' })
  await expect(partialFailure).toHaveCount(1)
  await expect(partialFailure).toContainText('GitHub data for beta is unavailable')
  await expect(merged.locator('.analytics-value')).toHaveText('16')
  await expect(merged.locator('.analytics-delta')).toHaveText('On pace')
  await expect(merged).toContainText('Typical by now: 15.8 · 7-day median: 27.0 / day')
  await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 14:00 UTC/)
  await expect(panel.getByRole('status', { name: 'Loading analytics' })).toBeHidden()
  expect(state.reads).toHaveLength(8)
  expect(state.historyReads).toHaveLength(1)

  await page.clock.setFixedTime(new Date('2026-10-09T16:00:00Z'))
  state.partial = null
  state.stale = true
  await refreshAnalytics(page)
  await expect(merged.locator('.analytics-value')).toHaveText('20')
  await expect(merged.locator('.analytics-arrow')).toHaveCount(0)
  await expect(merged.locator('.analytics-delta')).toHaveCount(0)
  await expect(merged).toContainText('Typical by now: 18.0 · 7-day median: 27.0 / day')
  await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 16:00 UTC/)
  await expect(partialFailure).toHaveCount(0)
  expect(state.reads).toHaveLength(10)
  expect(state.historyReads).toHaveLength(1)
  expect(state.quotaReads).toBe(1)
})

for (const partial of ['day', 'baseline'] as const) {
  test(`refreshes an initially partial ${partial} snapshot until another account becomes unavailable`, async ({ page }) => {
    const state = await workspace(page)
    state.pacing = { merged: 15, median: 27 }
    state.partial = partial
    await installRefreshClock(page)
    await page.goto('/')
    await pauseRefreshClock(page)
    await openAnalytics(page)
    const merged = countTrend(page)
    await expect(merged.locator('.analytics-value')).toHaveText('15')
    await expect(merged.locator('.analytics-arrow')).toHaveCount(0)
    await expect(merged.locator('.analytics-delta')).toHaveCount(0)

    await page.clock.setFixedTime(new Date('2026-10-09T14:00:00Z'))
    state.pacing.merged = 16
    await refreshAnalytics(page)
    await expect(merged.locator('.analytics-value')).toHaveText('16')
    await expect(merged).toContainText('Typical by now: 15.8 · 7-day median: 27.0 / day')
    await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 14:00 UTC/)
    await expect(merged.locator('.analytics-arrow')).toHaveCount(0)
    await expect(merged.locator('.analytics-delta')).toHaveCount(0)
    await page.locator('.nr-bell').click()
    const notices = page.locator('.nr-rail .nr-card')
    await expect(notices.filter({ hasText: 'Account scope unavailable' })).toHaveCount(1)
    await expect(notices.filter({ hasText: 'Account scope unavailable' })).toContainText('GitHub data for beta is unavailable')
    expect(state.reads).toHaveLength(4)
    expect(state.historyReads).toHaveLength(1)

    await page.clock.setFixedTime(new Date('2026-10-09T15:00:00Z'))
    state.pacing.merged = 20
    state.additionalMissingOrg = 'acme'
    await refreshAnalytics(page)
    await expect(notices.filter({ hasText: 'Additional account scope unavailable' })).toHaveCount(1)
    await expect(merged.locator('.analytics-value')).toHaveText('16')
    await expect(merged).toContainText('Typical by now: 15.8 · 7-day median: 27.0 / day')
    await expect(merged.locator('.analytics-value')).toHaveAttribute('data-help', /Pace as of 9 Oct 2026, 14:00 UTC/)
    await expect(merged.locator('.analytics-arrow')).toHaveCount(0)
    expect(state.reads).toHaveLength(6)
    expect(state.historyReads).toHaveLength(1)
    expect(state.quotaReads).toBe(1)
  })
}

test('coalesces ticks during a foreground read and discards a superseded background day', async ({ page }) => {
  const state = await workspace(page)
  state.pacing = { merged: 15, median: 27 }
  await installRefreshClock(page)
  let initialRelease!: () => void
  const initialHeld = new Promise<void>((resolve) => { initialRelease = resolve })
  let requests = 0
  let holdInitial = true
  let releaseOldDay!: () => void
  const oldDayHeld = new Promise<void>((resolve) => { releaseOldDay = resolve })
  let oldDayFinished!: () => void
  const finished = new Promise<void>((resolve) => { oldDayFinished = resolve })
  let holdOldDay = false
  await page.route('**/api/analytics?**', async (route) => {
    requests++
    const query = new URL(route.request().url()).searchParams
    if (holdInitial) await initialHeld
    if (holdOldDay && !query.has('dailyBounds') && query.get('since') === '2026-10-09T00:00:00.000Z') {
      await oldDayHeld
      try { await route.fulfill({ json: report(99) }) } finally { oldDayFinished() }
      return
    }
    await route.fallback()
  })
  await page.goto('/')
  await pauseRefreshClock(page)
  await openAnalytics(page)
  await expect.poll(() => requests).toBe(2)
  await refreshAnalytics(page)
  await changeVisibility(page, 'visible')
  await expect.poll(() => state.quotaReads).toBe(2)
  expect(requests).toBe(2)
  holdInitial = false
  initialRelease()
  await expect(value(page, 'Pull requests merged')).toHaveText('15')

  holdOldDay = true
  await page.clock.setFixedTime(new Date('2026-10-09T14:00:00Z'))
  await refreshAnalytics(page)
  await expect.poll(() => requests).toBe(4)
  state.pacing.merged = 20
  const canceledOldDay = page.waitForEvent('requestfailed', {
    predicate: request => {
      const url = new URL(request.url())
      return url.pathname === '/api/analytics' && !url.searchParams.has('dailyBounds') && url.searchParams.get('since') === '2026-10-09T00:00:00.000Z'
    },
  })
  await page.locator('#view-analytics').getByRole('button', { name: 'Previous day' }).click()
  await canceledOldDay
  await expect(page.locator('.analytics-date')).toHaveText('Yesterday')
  await expect(value(page, 'Pull requests merged')).toHaveText('20')
  await expect(countTrend(page)).not.toContainText('Typical by now')
  releaseOldDay()
  await finished
  await expect(value(page, 'Pull requests merged')).toHaveText('20')
  expect(requests).toBe(6)
  expect(state.historyReads).toHaveLength(2)

  state.pacing.merged = 21
  await refreshAnalytics(page)
  await expect(value(page, 'Pull requests merged')).toHaveText('21')
  await expect(countTrend(page).locator('.analytics-delta')).toHaveText('22.2%')
  await expect(countTrend(page)).not.toContainText('Typical by now')
  expect(requests).toBe(8)
  expect(state.historyReads).toHaveLength(2)
  expect(state.quotaReads).toBe(2)
})

for (const rate of ['1m', '5m'] as const) {
  test(`uses the shared ${rate} cadence for quiet local refreshes`, async ({ page }) => {
    const state = await workspace(page)
    state.pacing = { merged: 15, median: 27 }
    await installRefreshClock(page)
    await page.goto('/')
    await pauseRefreshClock(page)
    await page.evaluate(refreshRate => {
      localStorage.setItem('poise-refresh-rate', refreshRate)
      window.dispatchEvent(new Event('poise:refresh-rate-changed'))
    }, rate)
    await openAnalytics(page)
    await expect(value(page, 'Pull requests merged')).toHaveText('15')
    state.pacing.merged = 16
    const interval = rate === '1m' ? 60_000 : 300_000
    await page.clock.fastForward(interval - 1)
    expect(state.reads).toHaveLength(2)
    await expect(value(page, 'Pull requests merged')).toHaveText('15')
    await page.clock.fastForward(1)
    await expect(value(page, 'Pull requests merged')).toHaveText('16')
    expect(state.reads).toHaveLength(4)
    expect(state.historyReads).toHaveLength(1)
  })
}

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

test('treats fewer unmerged closures as better while preserving numeric arrows, the pace band and zero baselines', async ({ page }) => {
  const state = await workspace(page)
  const cases = [
    { current: 5, median: 20, direction: 'good', arrow: '↓', delta: '50% below typical' },
    { current: 15, median: 20, direction: 'bad', arrow: '↑', delta: '50% above typical' },
    { current: 9, median: 20, direction: 'neutral', arrow: '→', delta: 'On pace' },
    { current: 11, median: 20, direction: 'neutral', arrow: '→', delta: 'On pace' },
    { current: 0, median: 20, direction: 'good', arrow: '↓', delta: '100% below typical' },
    { current: 0, median: 0, direction: 'neutral', arrow: '→', delta: 'On pace' },
    { current: 3, median: 0, direction: 'bad', arrow: '↑', delta: '3.0 above typical' },
  ]
  state.closedUnmerged = cases[0]
  await page.goto('/')
  await openAnalytics(page)
  const summary = countTrend(page, 'Closed without merging')
  const graph = page.locator('.analytics-history[data-series="Closed without merging"] .analytics-history-line')
  let graphBefore: string | null = null
  for (const [index, sample] of cases.entries()) {
    if (index) {
      state.closedUnmerged = sample
      await page.locator('#analytics-filters').getByLabel('Organization filter').selectOption(index % 2 ? 'beta' : 'acme')
    }
    await expect(summary.locator('.analytics-value')).toHaveText(String(sample.current))
    await expect(summary).toHaveClass(new RegExp(sample.direction))
    await expect(summary.locator('.analytics-arrow')).toHaveText(sample.arrow)
    await expect(summary.locator('.analytics-delta')).toHaveText(sample.delta)
    await expect(summary).toContainText(`Typical by now: ${(sample.median / 2).toFixed(1)} · 7-day median: ${sample.median.toFixed(1)} / day`)
    if (sample.direction === 'neutral') {
      const colors = await summary.evaluate(element => ['.analytics-value', '.analytics-arrow', '.analytics-delta'].map(selector => getComputedStyle(element.querySelector(selector)!).color))
      expect(new Set(colors).size).toBe(1)
    }
    await expect(graph).toHaveAttribute('d', /^M/)
    const path = await graph.getAttribute('d')
    if (index === 0) graphBefore = path
    else expect(path).toBe(graphBefore)
    expect(state.reads).toHaveLength((index + 1) * 2)
    expect(state.historyReads).toHaveLength(index + 1)
  }

  state.closedUnmerged = { current: 5, median: 20 }
  await page.locator('#view-analytics').getByRole('button', { name: 'Previous day' }).click()
  await expect(summary).toHaveClass(/good/)
  await expect(summary.locator('.analytics-arrow')).toHaveText('↓')
  await expect(summary.locator('.analytics-delta')).toHaveText('75%')
  await expect(summary.locator('.analytics-arrow')).toHaveAccessibleName('75% below versus the preceding 7-day median')
  await expect(summary).not.toContainText('Typical by now')

  state.closedUnmerged.current = 25
  await page.locator('#analytics-filters').getByLabel('Organization filter').selectOption('beta')
  await expect(summary).toHaveClass(/bad/)
  await expect(summary.locator('.analytics-arrow')).toHaveText('↑')
  await expect(summary.locator('.analytics-delta')).toHaveText('25%')
  await expect(summary.locator('.analytics-arrow')).toHaveAccessibleName('25% above versus the preceding 7-day median')
  expect(state.reads).toHaveLength(18)
  expect(state.historyReads).toHaveLength(9)
})

test('treats smaller median PR size as better with numeric comparisons and unchanged history', async ({ page }) => {
  const state = await workspace(page)
  state.medianLines = { current: 90, baseline: 100 }
  await page.goto('/')
  await openAnalytics(page)
  const summary = countTrend(page, 'Median lines')
  const graph = page.locator('.analytics-history[data-series="Median lines"] .analytics-history-line')
  await expect(summary.locator('.analytics-value')).toHaveText('90')
  await expect(summary).toHaveClass(/good/)
  await expect(summary.locator('.analytics-arrow')).toHaveText('↓')
  await expect(summary.locator('.analytics-delta')).toHaveText('10%')
  await expect(summary.locator('.analytics-arrow')).toHaveAccessibleName('10% below versus the preceding 7-day median')
  await expect(summary).toContainText('7-day median: 100 · 8 PRs')
  await expect(graph).toHaveAttribute('d', /^M/)
  const graphBefore = await graph.getAttribute('d')

  state.medianLines.current = 110
  await page.locator('#analytics-filters').getByLabel('Organization filter').selectOption('beta')
  await expect(summary.locator('.analytics-value')).toHaveText('110')
  await expect(summary).toHaveClass(/bad/)
  await expect(summary.locator('.analytics-arrow')).toHaveText('↑')
  await expect(summary.locator('.analytics-delta')).toHaveText('10%')
  await expect(summary.locator('.analytics-arrow')).toHaveAccessibleName('10% above versus the preceding 7-day median')
  await expect(summary).not.toContainText(/faster|slower/i)
  await expect(graph).toHaveAttribute('d', graphBefore!)
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
  let started!: () => void
  const oldReadStarted = new Promise<void>(resolve => { started = resolve })
  let finished!: () => void
  const oldReadFinished = new Promise<void>(resolve => { finished = resolve })
  await page.route('**/api/analytics?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('since') === '2026-10-08T00:00:00.000Z' && url.searchParams.get('until') === '2026-10-09T00:00:00.000Z') {
      started()
      await held
      try { await route.fulfill({ json: report(99) }) } finally { finished() }
    } else await route.fallback()
  })
  await page.goto('/')
  await openAnalytics(page)
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  const panel = page.locator('#view-analytics')
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await oldReadStarted
  const canceled = page.waitForEvent('requestfailed', {
    predicate: request => {
      const query = new URL(request.url()).searchParams
      return query.get('since') === '2026-10-08T00:00:00.000Z' && query.get('until') === '2026-10-09T00:00:00.000Z'
    },
  })
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await canceled
  await expect(panel.locator('.analytics-date')).toHaveText('7 Oct 2026')
  await expect(value(page, 'Pull requests merged')).toHaveText('4')
  release()
  await oldReadFinished
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
  expect(state.historyReads).toHaveLength(1)
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('7 Oct 2026')
  await page.clock.setFixedTime(new Date('2026-10-10T00:01:00Z'))
  await panel.getByRole('button', { name: 'Previous day' }).click()
  await expect(panel.locator('.analytics-date')).toHaveText('6 Oct 2026')
  await expect.poll(() => state.reads.at(-2)?.since).toBe('2026-10-06T00:00:00.000Z')
  expect(state.reads).toHaveLength(10)
  expect(state.historyReads).toHaveLength(4)
})


for (const failure of ['HTTP', 'account'] as const) {
  test(`completes the selected day's calendar presentation when the midnight ${failure} refresh fails`, async ({ page }) => {
    const state = await workspace(page)
    state.pacing = { merged: 15, median: 27 }
    await page.clock.install({ time: new Date('2026-10-09T23:59:30Z') })
    await page.goto('/')
    await openAnalytics(page)
    const panel = page.locator('#view-analytics')
    const merged = countTrend(page)
    await expect(panel.locator('.analytics-date')).toHaveText('Today')
    await expect(panel.getByRole('button', { name: 'Next day' })).toBeDisabled()
    await expect(merged).toContainText('Typical by now: 27.0 · 7-day median: 27.0 / day')
    await expect(panel.locator('.analytics-history-line')).toHaveCount(15)
    state.pacing.merged = 20
    if (failure === 'HTTP') state.fail = true
    else state.partial = 'baseline'

    await page.clock.fastForward(60_000)
    await expect(panel.locator('.analytics-date')).toHaveText('Yesterday')
    await expect(panel.getByRole('button', { name: 'Next day' })).toBeEnabled()
    await expect(merged.locator('.analytics-value')).toHaveText('15')
    await expect(merged.locator('.analytics-delta')).toHaveText('44.4%')
    await expect(merged).toContainText('7-day median: 27.0 / day')
    await expect(merged).not.toContainText('Typical by now')
    await expect(merged.locator('.analytics-value')).not.toHaveAttribute('data-help', /Pace as of/)
    await expect(panel.getByRole('status', { name: 'Loading analytics' })).toBeHidden()
    await expect(panel.locator('.analytics-tile')).toHaveCount(16)
    await page.locator('.nr-bell').click()
    await expect(page.locator('.nr-rail .nr-card').filter({ hasText: failure === 'HTTP' ? 'acme: datastore offline' : 'Account scope unavailable' })).toHaveCount(1)
    expect(state.reads).toHaveLength(4)
    expect(state.historyReads).toHaveLength(1)
  })
}

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
    const quotaTop = () => panel.locator('.analytics-board').evaluate(board => [...board.querySelectorAll<HTMLElement>('[data-group="quota"]')].map(card => card.style.transform).join(','))
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
  await expect(view.locator('.quota-distribution')).toHaveCount(0)
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
  await expect(view.locator('.analytics-value[data-help]')).toHaveCount(16)
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

test('shows only the 24-hour quota chart and visibly explains an unset agent', async ({ page }) => {
  await workspace(page)
  const quota = quotaReport()
  const now = Date.parse('2026-10-09T12:00:00Z')
  quota.accounts[0].buckets[0].history = Array.from({ length: 169 }, (_, i) => ({ at: now - i * 3_600_000, used: 100, remaining: 4900, limit: 5000 }))
  await page.route('**/api/github-quota', route => route.fulfill({ json: quota }))
  await page.route('**/api/analytics?**', route => route.fulfill({ json: { ...report(4), agentAccount: null, pullRequests: { ...report(4).pullRequests, mergedByAgent: null } } }))
  await page.goto('/')
  await openAnalytics(page)
  await expect(page.locator('.quota-charts').first().locator('.quota-hour')).toHaveCount(24)
  await expect(page.locator('.quota-distribution')).toHaveCount(0)
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
