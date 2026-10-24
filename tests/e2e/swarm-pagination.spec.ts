import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { settled } from './fixtures/motion'

const rows = '#swarm-tbody > .agent-row'
const next = (page: Page) => page.getByRole('group', { name: 'Swarm pages' }).getByRole('button', { name: 'Next', exact: true })
const previous = (page: Page) => page.getByRole('group', { name: 'Swarm pages' }).getByRole('button', { name: 'Previous', exact: true })
const id = (index: number) => index.toString(16).padStart(32, '0')
const history = () => Array.from({ length: 6280 }, (_, index) => ({
  id: id(index), repo: 'acme/project', pr_id: String(index + 1), actor: 'review-bot', model: 'opus',
  behavior: 'pr_review', session_id: null, prompt: `Run ${index + 1}`, response: 'available', error: '',
  status: 'completed', outcome: 'approved', started_at: '2026-10-14T08:00:00Z',
  completed_at: '2026-10-14T08:01:00Z', time_elapsed: '1m',
}))

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

// Process ordered mutations, rather than sampling the final DOM: a full mount
// followed by a same-turn trim must still exceed the bound.
async function observeRows(page: Page) {
  return page.evaluateHandle(() => {
    let count = document.querySelectorAll('#swarm-tbody > .agent-row').length, peak = count
    const update = (records: MutationRecord[]) => {
      for (const record of records) {
        if (!(record.target instanceof Element) || record.target.id !== 'swarm-tbody') continue
        for (const node of record.removedNodes) if (node instanceof Element && node.matches('.agent-row')) count--
        for (const node of record.addedNodes) if (node instanceof Element && node.matches('.agent-row')) { count++; peak = Math.max(peak, count) }
      }
    }
    const observer = new MutationObserver(update)
    observer.observe(document, { childList: true, subtree: true })
    return { peak: () => { update(observer.takeRecords()); return peak } }
  })
}

test('fixed pages preserve boundary focus, complete traversal, full-history search and both deep links', async ({ page }) => {
  await workspace(page); await settled(page)
  const organizations = ['acme', 'beta'].map(login => ({ login, managed: true, status: 'ready', stage: 'ready', error: null, activatedAt: null }))
  await page.route('**/api/settings', route => route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', organizations, models: {} } }))
  await page.route('**/api/organizations', route => route.fulfill({ json: { organizations } }))
  await page.reload(); await settled(page)
  let logs = history()
  await page.route('**/api/agent-logs**', route => route.fulfill({ json: { logs } }))
  const peak = await observeRows(page)
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(200)
  const control = await page.locator(`${rows}[data-id="${id(199)}"] .expand-btn`).elementHandle()
  await control!.focus()
  logs = [{ ...logs[0], id: id(7000), pr_id: '7001', prompt: 'New arrival' }, ...logs.map((entry, index) => index === 199 ? { ...entry, time_elapsed: '2m' } : entry)]
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(page.locator(`${rows}[data-id="${id(199)}"] .elapsed-cell`)).toHaveText('2m')
  await expect(page.locator('#swarm-page')).toHaveText('201–400 / 6281')
  expect(await control!.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true)
  await previous(page).click()
  const visited: string[] = []
  for (;;) {
    visited.push(...await page.locator(rows).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id!)))
    if (!await next(page).isEnabled()) break
    const before = await page.locator('#swarm-page').textContent()
    await next(page).click()
    await expect(page.locator('#swarm-page')).not.toHaveText(before!)
  }
  expect(visited).toEqual(logs.map(entry => entry.id))
  await page.locator('#swarm-search').fill('Run 6280')
  await expect(page.locator(rows)).toHaveCount(1)
  await expect(page.locator(rows)).toHaveAttribute('data-id', id(6279))
  await page.locator('#swarm-search').fill('')
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 6281')
  await page.evaluate(target => window.dispatchEvent(new CustomEvent('poise:goto-swarm-call', { detail: { id: target } })), id(6279))
  await expect(page.locator(`${rows}[data-id="${id(6279)}"]`)).toHaveClass(/agent-row-focus/)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:goto-swarm-row', { detail: { repo: 'acme/project', pr_id: '6001' } })))
  await expect(page.locator(`${rows}[data-id="${id(6000)}"]`)).toHaveClass(/agent-row-focus/)
  await page.locator('#view-swarm').getByLabel('Organization filter').selectOption('acme')
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 6281')
  expect(await peak.evaluate(value => value.peak())).toBeLessThanOrEqual(200)
  expect(await page.locator('*').count()).toBeLessThan(12_000)
})

test('expanded identical runs span bounded pages and retain disclosure on return', async ({ page }) => {
  await workspace(page); await settled(page)
  const logs = history().slice(0, 420).map((entry, index, all) => index < 210 ? { ...all[0], id: entry.id, response: null } : entry)
  await page.route('**/api/agent-logs**', route => route.fulfill({ json: { logs } }))
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator('#swarm-count')).toHaveText('420')
  const peak = await observeRows(page)
  await page.locator('.agent-group-btn').click()
  await expect(page.locator(rows)).toHaveCount(200)
  await next(page).click()
  await expect(page.locator(rows).first()).toHaveAttribute('data-id', id(200))
  await expect(page.locator(rows).first()).toHaveClass(/agent-repeat-row/)
  await expect(page.locator(rows).first().locator('.agent-group-btn')).toHaveCount(0)
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(0)
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows).first()).toHaveAttribute('data-id', id(200))
  await previous(page).click()
  await expect(page.locator('.agent-group-btn')).toHaveAttribute('aria-expanded', 'true')
  await page.locator('.agent-group-btn').click()
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 211')
  await page.evaluate(target => window.dispatchEvent(new CustomEvent('poise:goto-swarm-call', { detail: { id: target } })), id(205))
  await expect(page.locator(`${rows}[data-id="${id(205)}"]`)).toHaveClass(/agent-row-focus/)
  expect(await peak.evaluate(value => value.peak())).toBeLessThanOrEqual(200)
})

test('reasoning and pending reads survive page teardown and hidden completion', async ({ page }) => {
  await workspace(page); await settled(page)
  const at = new Date().toISOString(), reasoning = deferred()
  const logs = history().slice(0, 401).map((entry, index) => index ? entry : { ...entry, response: null,
    progress: { version: 1, phase: 'finished', phase_started_at: at, heartbeat_at: at,
      last_provider_event_at: at, deadline_at: null, warning: null, reasoning_available: true, reasoning_chars: 10, events: [] } })
  await page.route('**/api/agent-logs**', route => route.fulfill({ json: { logs } }))
  let reads = 0
  await page.route(`**/api/agent-reasoning/${id(0)}`, async route => { reads++; await reasoning.promise; await route.fulfill({ json: { body: 'Reasoning retained' } }) })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await page.locator(`${rows}[data-id="${id(0)}"] .expand-btn`).click()
    await page.locator('.agent-reasoning summary').click()
    await expect.poll(() => reads).toBe(1)
    await next(page).click(); await previous(page).click()
    await expect(page.locator('.agent-reasoning')).toHaveAttribute('open', '')
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(page.locator('#swarm-tbody > *')).toHaveCount(0)
    const received = page.waitForResponse(response => response.url().includes('/api/agent-reasoning/'))
    reasoning.release(); await (await received).finished()
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator('.agent-reasoning')).toHaveAttribute('open', '')
    await expect(page.locator('.agent-reasoning-body')).toHaveText('Reasoning retained')
    expect(reads).toBe(1)
    const details = await page.locator('.agent-expand-row').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.expandFor))
    const mounted = await page.locator(rows).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id))
    expect(details.every(value => mounted.includes(value))).toBe(true)
    await expect(page.locator('#swarm-tbody > [data-motion-running]')).toHaveCount(0)
  } finally { reasoning.release() }
})

test('replay and Stop retain exact targets and busy state across pages and off-page completion', async ({ page }) => {
  await workspace(page); await settled(page)
  const logs = history().slice(0, 401).map((entry, index) => index === 201 ? { ...entry, status: 'running', completed_at: null } : entry)
  await page.route('**/api/agent-logs**', route => route.fulfill({ json: { logs } }))
  const replay = deferred(), stop = deferred(), replayBodies: unknown[] = [], stopBodies: unknown[] = []
  await page.route('**/api/agent-replay', async route => { replayBodies.push(route.request().postDataJSON()); await replay.promise; await route.fulfill({ status: 409, json: { error: 'Replay refused.' } }) })
  await page.route('**/api/agent-stop', async route => { stopBodies.push(route.request().postDataJSON()); await stop.promise; await route.fulfill({ status: 502, json: { error: 'Stop refused.' } }) })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    const replayButton = page.locator(`${rows}[data-id="${id(0)}"] .replay-btn`)
    await replayButton.click(); await expect(replayButton).toBeDisabled()
    await next(page).click()
    const stopButton = page.locator(`${rows}[data-id="${id(201)}"] .stop-btn`)
    await stopButton.click(); await stopButton.click(); await expect(stopButton).toBeDisabled()
    await previous(page).click(); await expect(replayButton).toBeDisabled()
    await next(page).click(); await expect(stopButton).toBeDisabled()
    expect(replayBodies).toEqual([{ behavior: 'pr_review', repo: 'acme/project', pr_id: '1' }])
    expect(stopBodies).toEqual([{ id: id(201) }])
    const replayReceived = page.waitForResponse(response => response.url().endsWith('/api/agent-replay'))
    replay.release(); await (await replayReceived).finished()
    await previous(page).click(); await expect(replayButton).toBeEnabled()
    const stopReceived = page.waitForResponse(response => response.url().endsWith('/api/agent-stop'))
    stop.release(); await (await stopReceived).finished()
    await next(page).click(); await expect(stopButton).toBeEnabled()
    expect(replayBodies).toHaveLength(1); expect(stopBodies).toHaveLength(1)
  } finally { replay.release(); stop.release() }
})
