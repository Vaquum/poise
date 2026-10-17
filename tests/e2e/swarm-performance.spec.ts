import { expect, test } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { settled } from './fixtures/motion'

// Distinct response-bearing calls cannot collapse into identical-result groups.
// Match the observed production history size without using personal run data.
const logs = Array.from({ length: 1300 }, (_, index) => ({
  id: `perf-${index}`, repo: 'acme/project', pr_id: String(index + 1), actor: 'octo-agent',
  model: 'opus', behavior: 'pr-review', session_id: null, prompt: `Review pull request ${index + 1}`,
  started_at: '2026-10-13T08:00:00Z', started_at_precise: '2026-10-13T08:00:00Z',
  completed_at: '2026-10-13T08:01:00Z', time_elapsed: '1m', status: 'completed',
  outcome: 'approved', response: 'available', error: '',
}))

test('Swarm animates visible history without blocking navigation or replaying cached entry', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium exposes the performance counters used by this regression.')
  await workspace(page)
  await settled(page)
  let holdReads = false
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/agent-logs**', async route => {
    if (holdReads) await held
    await route.fulfill({ json: { logs } })
  })
  // Background consumers may read the same endpoint before Swarm opens.
  // They must not advance the mock into holding the refresh under test.
  await page.evaluate(() => Promise.all([fetch('/api/agent-logs'), fetch('/api/agent-logs')]))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const before = await cdp.send('Performance.getMetrics')
  const longTasks = await page.evaluateHandle(() => {
    const durations: number[] = []
    const observer = new PerformanceObserver(list => durations.push(...list.getEntries().map(entry => entry.duration)))
    observer.observe({ entryTypes: ['longtask'] })
    return { durations, observer }
  })
  const started = Date.now()
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator('#swarm-tbody > .agent-row')).toHaveCount(1300)
    const mounted = Date.now() - started
    const worstTask = await longTasks.evaluate(({ durations, observer }) => {
      durations.push(...observer.takeRecords().map(entry => entry.duration)); observer.disconnect()
      return Math.max(0, ...durations)
    })
    console.log(`Swarm first mount: ${mounted}ms; longest main-thread task: ${worstTask}ms`)
    expect(worstTask).toBeLessThan(350)
    const firstRow = page.locator('#swarm-tbody > .agent-row').first()
    const control = await firstRow.getByRole('button', { name: 'Toggle detail', exact: true }).elementHandle()
    await control!.focus()
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent-logs')
    await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
    await refreshed
    expect(await control!.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true)
    const moving = await page.locator('#swarm-tbody > [data-motion-running]').count()
    expect(moving).toBeLessThan(30)
    holdReads = true
    const navigation = await page.evaluate(() => new Promise<number>(resolve => {
      requestAnimationFrame(() => {
        const start = performance.now()
        document.querySelector<HTMLButtonElement>('[data-view="current"]')!.click()
        requestAnimationFrame(() => resolve(performance.now() - start))
      })
    }))
    expect(navigation).toBeLessThan(1000)
    await expect(page.locator('#view-current')).toBeVisible()
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    const cached = await page.evaluate(() => ({
      rows: document.querySelectorAll('#swarm-tbody > .agent-row').length,
      entrance: document.querySelector('#view-swarm > main')!.hasAttribute('data-motion-running'),
    }))
    expect(cached).toEqual({ rows: 1300, entrance: false })
    // A retained control remains actionable while the re-entry fetch is held.
    await page.locator('#swarm-search').fill('Review pull request 1300')
    await expect(page.locator('#swarm-tbody > .agent-row')).toHaveCount(1)
    await expect(page.locator('#swarm-tbody')).toContainText('#1300')
    await page.getByRole('button', { name: 'Current', exact: true }).click()
    await expect(page.locator('#view-current')).toBeVisible()
    const after = await cdp.send('Performance.getMetrics')
    const layouts = (metrics: typeof before) => metrics.metrics.find(metric => metric.name === 'LayoutCount')!.value
    const count = layouts(after) - layouts(before)
    const styles = (metrics: typeof before) => metrics.metrics.find(metric => metric.name === 'RecalcStyleCount')!.value
    expect(styles(after) - styles(before)).toBeLessThan(300)
    console.log(`Swarm 1300 calls: mounted=${mounted}ms; navigation=${navigation.toFixed(1)}ms; layouts=${count}; moving=${moving}`)
    expect(count).toBeLessThan(200)
  } finally { release() }
})


test('a filtered prepared row reflects replay completion before it is revealed', async ({ page }) => {
  await workspace(page)
  await settled(page)
  const history = logs.map(entry => ({ ...entry, behavior: 'pr_review' }))
  let completeHistory = false
  await page.route('**/api/agent-logs**', route => route.fulfill({ json: { logs: completeHistory ? history : history.slice(0, 1) } }))
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/agent-replay', async route => {
    await held
    await route.fulfill({ status: 409, json: { error: 'Replay refused for this test.' } })
  })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    const row = page.locator('#swarm-tbody > .agent-row[data-id="perf-0"]')
    const replay = row.getByRole('button', { name: 'Replay this run' })
    await replay.click()
    await expect(replay).toBeDisabled()
    await page.locator('#swarm-search').fill('1300')
    await expect(row).toHaveCount(0)
    completeHistory = true
    await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
    await expect(page.locator('#swarm-tbody > .agent-row[data-id="perf-1299"]')).toBeVisible()
    const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/agent-replay')
    release()
    await (await response).finished()
    await page.locator('#swarm-search').fill('')
    await expect(replay).toBeEnabled()
    await expect(page.locator('#swarm-tbody > .agent-refusal-row').getByRole('alert')).toHaveText('Replay refused for this test.')
  } finally { release() }
})
