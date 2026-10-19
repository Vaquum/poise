import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { settled } from './fixtures/motion'

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function history(org = 'acme', length = 60) {
  return Array.from({ length }, (_, index) => ({
    id: `${org}-${index}`, repo: `${org}/project`, pr_id: String(index + 1), actor: 'review-bot',
    model: 'opus', behavior: 'pr_review', session_id: null, prompt: `${org} run ${index + 1}`,
    started_at: '2026-10-14T08:00:00Z', completed_at: '2026-10-14T08:01:00Z',
    time_elapsed: '1m', status: 'completed', outcome: 'approved', response: 'available', error: '',
  }))
}

async function ready(page: Page) { await workspace(page); await settled(page) }
const rows = '#swarm-tbody > .agent-row'

test('Swarm paints recent calls before the complete history arrives and retains controls', async ({ page }) => {
  await ready(page)
  const older = deferred(), logs = history()
  await page.route('**/api/agent-logs**', async route => {
    if (new URL(route.request().url()).searchParams.has('limit')) return route.fulfill({ json: { logs: logs.slice(0, 50), total: 60 } })
    await older.promise
    await route.fulfill({ json: { logs } })
  })
  try {
    const start = Date.now()
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator(rows)).toHaveCount(50, { timeout: 2000 })
    await expect(page.locator('#swarm-stale')).toContainText('Loading older runs')
    await expect(page.locator('#swarm-stale')).toHaveCSS('color', 'rgb(142, 149, 158)')
    await expect(page.locator('#swarm-count')).toContainText('50 of 60 runs loaded')
    console.log(`Swarm recent calls: ${Date.now() - start}ms; full-history response still held`)
    const control = await page.locator(rows).first().getByRole('button', { name: 'Toggle detail' }).elementHandle()
    await control!.focus()
    older.release()
    await expect(page.locator(rows)).toHaveCount(60)
    expect(await control!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true)
    await expect(page.locator('#swarm-stale')).toBeHidden()
    await expect(page.locator('#swarm-count')).not.toContainText('loaded')
    await page.locator('#swarm-search').fill('acme run 60')
    await expect(page.locator(rows)).toHaveCount(1)
    await expect(page.locator(rows)).toContainText('#60')
  } finally { older.release() }
})

test('Swarm completes a large history without blocking the preview controls', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium exposes the long-task observer used by this regression.')
  await ready(page)
  const older = deferred(), logs = history('acme', 1300)
  await page.route('**/api/agent-logs**', async route => {
    if (new URL(route.request().url()).searchParams.has('limit')) return route.fulfill({ json: { logs: logs.slice(0, 50), total: logs.length } })
    await older.promise
    await route.fulfill({ json: { logs } })
  })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator(rows)).toHaveCount(50)
    await settled(page)
    const control = await page.locator(rows).first().getByRole('button', { name: 'Toggle detail' }).elementHandle()
    await control!.focus()
    const tasks = await page.evaluateHandle(() => {
      const durations: number[] = []
      const observer = new PerformanceObserver(list => durations.push(...list.getEntries().map(entry => entry.duration)))
      observer.observe({ entryTypes: ['longtask'] })
      const counts: number[] = []
      const mutations = new MutationObserver(() => counts.push(document.querySelectorAll('#swarm-tbody > .agent-row').length))
      mutations.observe(document.getElementById('swarm-tbody')!, { childList: true })
      return { durations, observer, counts, mutations }
    })
    older.release()
    await expect(page.locator(rows)).toHaveCount(1300)
    const worstTask = await tasks.evaluate(({ durations, observer }) => {
      durations.push(...observer.takeRecords().map(entry => entry.duration)); observer.disconnect()
      return Math.max(0, ...durations)
    })
    console.log(`Swarm preview to 1300 calls: longest main-thread task ${worstTask}ms`)
    expect(worstTask).toBeLessThan(350)
    const counts = await tasks.evaluate(({ counts, mutations }) => { mutations.disconnect(); return counts })
    expect(counts.some(count => count > 50 && count < 1300)).toBe(true)
    expect(await control!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true)
    await page.locator('#swarm-search').fill('acme run 1300')
    await expect(page.locator(rows)).toHaveCount(1)
    await expect(page.locator(rows)).toContainText('#1300')
  } finally { older.release() }
})

test('a failed complete-history read keeps recent calls, reports incompleteness and recovers', async ({ page }) => {
  await ready(page)
  const logs = history()
  let reads = 0
  await page.route('**/api/agent-logs**', route => {
    if (new URL(route.request().url()).searchParams.has('limit')) return route.fulfill({ json: { logs: logs.slice(0, 50), total: 60 } })
    return ++reads === 1 ? route.fulfill({ status: 502, json: { error: 'History unavailable' } }) : route.fulfill({ json: { logs } })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(50)
  await expect(page.locator('#swarm-stale')).toContainText('History unavailable')
  await expect(page.locator('#swarm-stale')).toHaveCSS('color', 'rgb(184, 80, 72)')
  await expect(page.locator('#swarm-stale')).toContainText('Only 50 of 60 runs loaded')
  await page.locator('#swarm-search').fill('acme run 60')
  await expect(page.locator('#swarm-empty')).toContainText('Older runs are unavailable')
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(page.locator(rows)).toHaveCount(1)
  await expect(page.locator(rows)).toContainText('#60')
  await expect(page.locator('#swarm-stale')).toBeHidden()
})

test('returning to Swarm paints history received while hidden before its new refresh', async ({ page }) => {
  await ready(page)
  const first = deferred(), refresh = deferred(), logs = history()
  let completeReads = 0
  await page.route('**/api/agent-logs**', async route => {
    if (new URL(route.request().url()).searchParams.has('limit')) return route.fulfill({ json: { logs: logs.slice(0, 50), total: 60 } })
    await (++completeReads === 1 ? first.promise : refresh.promise)
    await route.fulfill({ json: { logs } })
  })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator(rows)).toHaveCount(50)
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent-logs' && !new URL(response.url()).searchParams.has('limit'))
    first.release()
    await (await received).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator(rows)).toHaveCount(60, { timeout: 1000 })
    await expect.poll(() => completeReads).toBe(2)
  } finally { first.release(); refresh.release() }
})

test('a late initial read cannot restart Swarm polling after leaving', async ({ page }) => {
  await ready(page)
  const initial = deferred(), logs = history().slice(0, 1)
  let reads = 0
  await page.route('**/api/agent-logs**', async route => {
    reads++
    await initial.promise
    await route.fulfill({ json: { logs, total: 1 } })
  })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect.poll(() => reads).toBe(1)
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent-logs')
    initial.release()
    await (await received).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
    await page.waitForTimeout(150)
    expect(reads).toBe(1)
  } finally { initial.release() }
})

test('switching accounts supersedes an older pending full-history read', async ({ page }) => {
  await ready(page)
  const organizations = ['acme', 'beta'].map(login => ({ login, managed: true, status: 'ready', stage: 'ready', error: null, activatedAt: null }))
  await page.route('**/api/settings', route => route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', organizations, models: {} } }))
  await page.route('**/api/organizations', route => route.fulfill({ json: { organizations } }))
  await page.reload(); await settled(page)
  const older = deferred()
  await page.route('**/api/agent-logs**', async route => {
    const url = new URL(route.request().url()), org = url.searchParams.get('org') || 'acme', logs = history(org)
    if (url.searchParams.has('limit')) return route.fulfill({ json: { logs: org === 'beta' ? logs.slice(0, 1) : logs.slice(0, 50), total: org === 'beta' ? 1 : 60 } })
    await older.promise
    await route.fulfill({ json: { logs } })
  })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator(rows)).toHaveCount(50)
    await page.locator('#view-swarm').getByLabel('Organization filter').selectOption('beta')
    await expect(page.locator(rows)).toHaveCount(1)
    await expect(page.locator(rows)).toContainText('beta')
    older.release()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(page.locator(rows)).toHaveCount(1)
    await expect(page.locator(rows)).toContainText('beta')
    await expect(page.locator('#swarm-stale')).toBeHidden()
  } finally { older.release() }
})


test('an empty-history refresh failure remains visible on re-entry while another read is pending', async ({ page }) => {
  await ready(page)
  const refresh = deferred()
  let completeReads = 0
  await page.route('**/api/agent-logs**', async route => {
    if (new URL(route.request().url()).searchParams.has('limit')) return route.fulfill({ json: { logs: [], total: 0 } })
    if (++completeReads === 1) return route.fulfill({ status: 502, json: { error: 'History unavailable' } })
    await refresh.promise
    await route.fulfill({ json: { logs: [] } })
  })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator('#swarm-empty')).toHaveText('No agent calls.')
    await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
    await expect(page.locator('#swarm-empty')).toContainText('History unavailable')
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect.poll(() => completeReads).toBe(2)
    await expect(page.locator('#swarm-empty')).toContainText('History unavailable')
    refresh.release()
    await expect(page.locator('#swarm-empty')).toHaveText('No agent calls.')
  } finally { refresh.release() }
})
