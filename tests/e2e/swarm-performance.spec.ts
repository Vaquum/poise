import { feedback } from './fixtures/view-feedback'
import { expect, test } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { settled } from './fixtures/motion'

// Distinct response-bearing calls cannot collapse into identical-result groups.
// Match the observed production history size without using personal run data.
const logs = Array.from({ length: 6280 }, (_, index) => ({
  id: `perf-${index}`, repo: 'acme/project', pr_id: String(index + 1), actor: 'octo-agent',
  model: 'opus', behavior: 'pr_review', session_id: null, prompt: `Review pull request ${index + 1}`,
  started_at: '2026-10-13T08:00:00Z', started_at_precise: '2026-10-13T08:00:00Z',
  completed_at: '2026-10-13T08:01:00Z', time_elapsed: '1m', status: 'completed',
  outcome: 'approved', response: 'available', error: '',
}))

test('Swarm animates visible history without blocking navigation or replaying cached entry', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium exposes the performance counters used by this regression.')
  await workspace(page)
  await settled(page)
  let holdReads = false
  let refreshedLogs = logs
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/agent-logs**', async route => {
    if (holdReads) await held
    await route.fulfill({ json: { logs: refreshedLogs } })
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
    await expect(page.locator('#swarm-tbody > .agent-row')).toHaveCount(200)
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
    refreshedLogs = logs.map((entry, index) => index === 0 ? { ...entry, time_elapsed: '2m' } : entry)
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent-logs')
    await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
    await refreshed
    await expect(firstRow.locator('.elapsed-cell')).toHaveText('2m')
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
      rowEntrances: document.querySelectorAll('#swarm-tbody > [data-motion-running]').length,
    }))
    expect(cached).toEqual({ rows: 200, entrance: false, rowEntrances: 0 })
    // A retained control remains actionable while the re-entry fetch is held.
    await page.locator('#swarm-search').fill('Review pull request 6280')
    await expect(page.locator('#swarm-tbody > .agent-row')).toHaveCount(1)
    await expect(page.locator('#swarm-tbody')).toContainText('#6280')
    await page.getByRole('button', { name: 'Current', exact: true }).click()
    await expect(page.locator('#view-current')).toBeVisible()
    const after = await cdp.send('Performance.getMetrics')
    const layouts = (metrics: typeof before) => metrics.metrics.find(metric => metric.name === 'LayoutCount')!.value
    const count = layouts(after) - layouts(before)
    const styles = (metrics: typeof before) => metrics.metrics.find(metric => metric.name === 'RecalcStyleCount')!.value
    expect(styles(after) - styles(before)).toBeLessThan(300)
    console.log(`Swarm 6280 calls: mounted=${mounted}ms; navigation=${navigation.toFixed(1)}ms; layouts=${count}; moving=${moving}`)
    expect(count).toBeLessThan(200)
  } finally { release() }
})


test('a filtered run reflects replay completion before it is revealed', async ({ page }) => {
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
    await page.locator('#swarm-search').fill('6280')
    await expect(row).toHaveCount(0)
    completeHistory = true
    await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
    await expect(page.locator('#swarm-tbody > .agent-row[data-id="perf-6279"]')).toBeVisible()
    const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/agent-replay')
    release()
    await (await response).finished()
    await page.locator('#swarm-search').fill('')
    await expect(replay).toBeEnabled()
    await expect(await feedback(page, 'Swarm replay refused')).toContainText('Replay refused for this test.')
  } finally { release() }
})

test('cold Swarm pages keep the existing long-task and navigation budgets', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium exposes long tasks and CPU throttling.')
  await workspace(page); await settled(page)
  let history = logs.map((entry, index) => ({ ...entry, id: index.toString(16).padStart(32, '0') }))
  await page.route('**/api/agent-logs**', route => route.fulfill({ json: { logs: history } }))
  const cdp = await page.context().newCDPSession(page)
  // The 4× run is controlled local evidence; CI retains its existing budgets.
  const rate = process.env.POISE_SWARM_CPU_RATE === '4' ? 4 : 1
  await cdp.send('Emulation.setCPUThrottlingRate', { rate })
  const samples: Record<string, number> = {}
  const measure = async (name: string, action: () => Promise<unknown>) => {
    const tasks = await page.evaluateHandle(() => {
      const durations: number[] = []
      const observer = new PerformanceObserver(list => durations.push(...list.getEntries().map(entry => entry.duration)))
      observer.observe({ entryTypes: ['longtask'] })
      return { durations, observer }
    })
    await action()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    samples[name] = await tasks.evaluate(({ durations, observer }) => {
      durations.push(...observer.takeRecords().map(entry => entry.duration)); observer.disconnect()
      return Math.max(0, ...durations)
    })
    expect(samples[name], name).toBeLessThan(350)
  }
  const rows = page.locator('#swarm-tbody > .agent-row')
  await measure('first entry', async () => { await page.getByRole('button', { name: 'Swarm', exact: true }).click(); await expect(rows).toHaveCount(200) })
  await settled(page)
  await measure('cold page', async () => { await page.locator('#swarm-pagination [data-page="next"]').click(); await expect(rows.first()).toHaveAttribute('data-id', history[200].id) })
  await measure('search', async () => { await page.locator('#swarm-search').fill('Review pull request 6280'); await expect(rows).toHaveCount(1) })
  await measure('clear search', async () => { await page.locator('#swarm-search').fill(''); await expect(rows).toHaveCount(200) })
  await measure('call deep link', async () => {
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('poise:goto-swarm-call', { detail: { id } })), history[6279].id)
    await expect(page.locator(`.agent-row[data-id="${history[6279].id}"]`)).toHaveClass(/agent-row-focus/)
  })
  await measure('target deep link', async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:goto-swarm-row', { detail: { repo: 'acme/project', pr_id: '6001' } })))
    await expect(page.locator(`.agent-row[data-id="${history[6000].id}"]`)).toHaveClass(/agent-row-focus/)
  })
  const navigation = await page.evaluate(() => new Promise<number>(resolve => {
    const start = performance.now()
    document.querySelector<HTMLButtonElement>('[data-view="current"]')!.click()
    requestAnimationFrame(() => resolve(performance.now() - start))
  }))
  expect(navigation).toBeLessThan(1000)
  await expect(rows).toHaveCount(0)
  await measure('cached return', async () => { await page.getByRole('button', { name: 'Swarm', exact: true }).click(); await expect(rows).toHaveCount(200) })
  history = history.map((entry, index) => index < 300 ? { ...history[0], id: entry.id, response: '' } : entry)
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('poise:goto-swarm-call', { detail: { id } })), history[0].id)
  await expect(page.locator('.agent-group-btn')).toHaveAttribute('aria-expanded', 'false')
  await measure('group expansion', async () => { await page.locator('.agent-group-btn').click(); await expect(page.locator('.agent-repeat-row')).toHaveCount(199) })
  console.log(JSON.stringify({ rate, longestTasks: samples, navigation }))
})
