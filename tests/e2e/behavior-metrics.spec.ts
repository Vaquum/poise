import { feedback } from './fixtures/view-feedback'
import { expect, test, type Page } from '@playwright/test'
import { BEHAVIORS } from '../../src/behaviors'

async function workspace(page: Page, longSettings = false) {
  const reads: URL[] = []
  const state = { fail: false, reads, filteredRuns: 4, durationMinutes: 240.5 as number | null,
    unreadableReview: false, heldToday: null as Promise<void> | null }
  await page.clock.setFixedTime(new Date('2026-10-17T12:00:00Z'))
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('poise-view', 'behaviors')
    localStorage.setItem('poise-current-filters', JSON.stringify({ time: 'week', status: 'all' }))
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/behavior-metrics') {
      state.reads.push(url)
      if (state.fail) return route.fulfill({ status: 502, json: { error: 'Run history unavailable' } })
      const filtered = url.searchParams.has('since')
      const totalRuns = filtered ? state.filteredRuns : 120
      if (url.searchParams.get('since') === '2026-10-16T18:30:00.000Z' && state.heldToday) await state.heldToday
      return route.fulfill({ json: { error: state.unreadableReview ? 'Affected metrics are unreadable' : null,
        behaviors: Object.fromEntries(BEHAVIORS.map(({ key }) => [key,
        state.unreadableReview && key === 'review-new-prs' ? null
          : { totalRuns, durationMinutes: filtered ? 8.5 : state.durationMinutes, successRate: filtered ? 75 : 95 },
      ])) } })
    }
    if (url.pathname === '/api/behaviors') return route.fulfill({ json: Object.fromEntries(BEHAVIORS.map(({ key }) => [key,
      { owner: key === 'review-new-issues' ? 'review-bot' : 'octocat / review-bot', enabled: true, setting: 'p2', reviewers: 1, scratchpad: '',
        skipRepos: longSettings && key === 'review-new-prs' ? Array.from({ length: 236 }, (_, i) => `acme/repo-${i}`) : [],
        repos: [], authors: [], lastTriggered: null },
    ])) })
    if (url.pathname === '/api/settings') return route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'Asia/Kolkata', models: {} } })
    if (url.pathname === '/api/workspace') return route.fulfill({ json: { mode: 'local' } })
    if (url.pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    if (url.pathname === '/api/notices') return route.fulfill({ json: { enabled: false, notices: [] } })
    if (url.pathname === '/api/agent-logs') return route.fulfill({ json: { logs: [] } })
    return route.fulfill({ json: {} })
  })
  return state
}

test('filters the entire metrics section in the configured timezone without changing settings or Current', async ({ page }) => {
  const state = await workspace(page)
  await page.goto('/')
  const row = page.locator('tr[data-behavior="review-new-prs"]')
  await expect(row.locator('.behavior-metric')).toHaveText(['120', '4h', '95%'])
  await expect(row.locator('td').first().locator('input')).toBeChecked()
  await expect(page.locator('#behaviors-table th').first()).toHaveText('')
  await expect(page.locator('#behaviors-table th').nth(2)).toHaveText('Status')
  await expect(page.locator('#view-behaviors')).not.toContainText('Behavior settings apply')
  for (const [range, since, until] of [
    ['today', '2026-10-16T18:30:00.000Z', null],
    ['yesterday', '2026-10-15T18:30:00.000Z', '2026-10-16T18:30:00.000Z'],
    ['week', '2026-10-11T18:30:00.000Z', null],
  ]) {
    await page.locator(`#behaviors-time-picker [data-time="${range}"]`).click()
    await expect(row.locator('.behavior-metric')).toHaveText(['4', '8m 30s', '75%'])
    expect(state.reads.at(-1)?.searchParams.get('since')).toBe(since)
    expect(state.reads.at(-1)?.searchParams.get('until')).toBe(until)
    await expect(row.locator('input')).toBeChecked()
    await expect(page.locator(`#behaviors-time-picker [data-time="${range}"]`)).toHaveAttribute('aria-pressed', 'true')
  }
  await page.locator('#behaviors-time-picker [data-time="all"]').click()
  await expect(row.locator('.behavior-metric')).toHaveText(['120', '4h', '95%'])
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('poise-current-filters') || '{}').time)).toBe('week')
  state.fail = true
  await page.locator('#behaviors-time-picker [data-time="today"]').click()
  await expect(row.locator('.behavior-metric')).toHaveText(['—', '—', '—'])
  await expect(await feedback(page)).toContainText('Run history unavailable')
})

test('shows explicit duration units and distinguishes zero from unknown', async ({ page }) => {
  const state = await workspace(page)
  state.durationMinutes = 0.1
  await page.goto('/')
  const metrics = page.locator('tr[data-behavior="review-new-prs"] .behavior-metric')
  await expect(metrics).toHaveText(['120', '6s', '95%'])
  for (const [minutes, text] of [[0, '0s'], [null, '—']] as const) {
    state.durationMinutes = minutes
    await page.locator('#behaviors-time-picker [data-time="today"]').click()
    await expect(metrics).toHaveText(['4', '8m 30s', '75%'])
    await page.locator('#behaviors-time-picker [data-time="all"]').click()
    await expect(metrics).toHaveText(['120', text, '95%'])
  }
})

test('keeps readable behavior metrics visible beside an unreadable behavior', async ({ page }) => {
  const state = await workspace(page)
  state.unreadableReview = true
  await page.goto('/')
  await expect(page.locator('tr[data-behavior="review-new-prs"] .behavior-metric')).toHaveText(['—', '—', '—'])
  await expect(page.locator('tr[data-behavior="approve-prs"] .behavior-metric')).toHaveText(['120', '4h', '95%'])
  await expect(await feedback(page)).toContainText('Affected metrics are unreadable')
})

test('keeps the selected period when an earlier metrics read finishes later', async ({ page }) => {
  const state = await workspace(page)
  let release!: () => void
  state.heldToday = new Promise<void>((resolve) => { release = resolve })
  await page.goto('/')
  const metrics = page.locator('#behaviors-tbody tr').first().locator('.behavior-metric')
  await expect(metrics).toHaveText(['120', '4h', '95%'])
  try {
    await page.locator('#behaviors-time-picker [data-time="today"]').click()
    await expect.poll(() => state.reads.at(-1)?.searchParams.get('since')).toBe('2026-10-16T18:30:00.000Z')
    state.filteredRuns = 8
    await page.locator('#behaviors-time-picker [data-time="yesterday"]').click()
    await expect(metrics).toHaveText(['8', '8m 30s', '75%'])
    const answered = page.waitForResponse((response) => new URL(response.url()).searchParams.get('since') === '2026-10-16T18:30:00.000Z')
    release()
    await (await answered).finished()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(metrics).toHaveText(['8', '8m 30s', '75%'])
  } finally { release() }
})

test('keeps columns spaced and single-line across desktop and narrow viewports in both themes', async ({ page }, info) => {
  await workspace(page, true)
  await page.goto('/')
  await expect(page.locator('#behaviors-tbody tr')).toHaveCount(6)
  await expect(page.locator('#behaviors-tbody tr').first().locator('.behavior-metric')).toHaveText(['120', '4h', '95%'])
  for (const width of [1920, 1600, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const geometry = await page.locator('#view-behaviors main').evaluate((main) => {
      const table = main.querySelector('table')!
      const reviewers = table.querySelector<HTMLElement>('.col-reviewers')!.getBoundingClientRect()
      const memory = table.querySelector<HTMLElement>('.col-memory')!.getBoundingClientRect()
      const setting = table.querySelector<HTMLElement>('.behavior-triggers-btn')!
      const style = getComputedStyle(setting)
      return { left: main.getBoundingClientRect().left, width: main.clientWidth, tableWidth: table.clientWidth,
        reviewerGap: memory.left - reviewers.left,
        settingLabel: setting.querySelector('span')!.getBoundingClientRect().width,
        settingSpace: setting.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        pageWidth: document.querySelector('.view:not([hidden]) .view-header')!.getBoundingClientRect().width,
        cells: [...table.querySelectorAll('tbody tr:first-child td')].map((cell) => cell.getBoundingClientRect().height) }
    })
    expect(geometry.left).toBeCloseTo(24, 0)
    expect(geometry.width).toBeCloseTo(geometry.pageWidth - 48, 0)
    expect(geometry.reviewerGap).toBeGreaterThanOrEqual(90)
    expect(geometry.settingLabel).toBeLessThanOrEqual(geometry.settingSpace + 0.5)
    expect(new Set(geometry.cells).size).toBe(1)
    if (width >= 1600) expect(geometry.tableWidth).toBeLessThanOrEqual(geometry.width)
    await page.screenshot({ path: info.outputPath(`behaviors-${width}-light.png`), animations: 'disabled' })
  }
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.screenshot({ path: info.outputPath('behaviors-1600-dark.png'), animations: 'disabled' })
})


test('shows both possible PR actors and the single issue-review actor', async ({ page }) => {
  await workspace(page)
  await page.goto('/')
  const pr = page.locator('tr[data-behavior="review-new-prs"] .behavior-owner-cell')
  await expect(pr.locator('.behavior-owner-name')).toHaveText(['octocat', 'review-bot'])
  await expect(pr.locator('img')).toHaveCount(2)
  await expect(page.locator('tr[data-behavior="review-new-issues"] .behavior-owner-name')).toHaveText('review-bot')
})
