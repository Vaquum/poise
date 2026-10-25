import { feedback } from './fixtures/view-feedback'
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

// Paged history mock: newest-first pages behind an index cursor, with an
// exact total and server search over the prompt. Running reads are empty:
// these histories are completed. Cursor is opaque to the view.
function paged(logs: ReturnType<typeof history>, url: URL, firstSize: number) {
  const search = url.searchParams.get('search') || ''
  const filtered = search
    ? logs.filter((row) => `${row.prompt} ${row.repo} ${row.pr_id}`.toLowerCase().includes(search.toLowerCase()))
    : logs
  const cursor = url.searchParams.get('cursor')
  const start = cursor === null ? 0 : Number(cursor)
  const size = cursor === null ? firstSize : filtered.length - start
  const slice = filtered.slice(start, start + size)
  const next = start + slice.length
  return { logs: slice, total: filtered.length, nextCursor: next < filtered.length ? String(next) : null }
}

async function ready(page: Page) { await workspace(page); await settled(page) }
const rows = '#swarm-tbody > .agent-row'
const pagerNext = (page: Page) => page.locator('#swarm-pagination [data-page="next"]')

// Bounded variant of paged: continuations return at most `size` rows like the
// first page, so exhaustion, search continuation and gap transitions are
// exercisable. Server search matches the prompt, repo and pr_id.
function pagedBounded(logs: ReturnType<typeof history>, url: URL, size: number) {
  const search = url.searchParams.get('search') || ''
  const filtered = search
    ? logs.filter((row) => `${row.prompt} ${row.repo} ${row.pr_id}`.toLowerCase().includes(search.toLowerCase()))
    : logs
  const cursor = url.searchParams.get('cursor')
  const start = cursor === null ? 0 : Number(cursor)
  const slice = filtered.slice(start, start + size)
  const next = start + slice.length
  return { logs: slice, total: filtered.length, nextCursor: next < filtered.length ? String(next) : null }
}

function boundedRoute(page: Page, logs: () => ReturnType<typeof history>, cursorReads: string[]) {
  return page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    const cursor = url.searchParams.get('cursor')
    if (cursor !== null && !url.searchParams.has('search')) cursorReads.push(cursor)
    else if (cursor !== null) cursorReads.push(`search:${cursor}`)
    return route.fulfill({ json: pagedBounded(logs(), url, 200) })
  })
}

async function settledRefresh(page: Page) {
  const received = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/agent-logs' && url.searchParams.get('status') === 'running'
  })
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await (await received).finished()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test('Swarm paints recent calls before the complete history arrives and retains controls', async ({ page }) => {
  await ready(page)
  const older = deferred(), logs = history()
  await page.route('**/api/agent-logs**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    if (url.searchParams.has('search')) return route.fulfill({ json: paged(logs, url, 200) })
    if (url.searchParams.get('cursor') === null) return route.fulfill({ json: paged(logs, url, 50) })
    await older.promise
    await route.fulfill({ json: paged(logs, url, 200) })
  })
  try {
    const start = Date.now()
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator(rows)).toHaveCount(50, { timeout: 2000 })
    await expect(page.locator('#swarm-stale')).toHaveCount(0)
    await expect(page.locator('#swarm-count')).toHaveText('50')
    console.log(`Swarm recent calls: ${Date.now() - start}ms; older-history page still held`)
    const control = await page.locator(rows).first().getByRole('button', { name: 'Toggle detail' }).elementHandle()
    await control!.focus()
    older.release()
    await expect(page.locator(rows)).toHaveCount(60)
    expect(await control!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true)
    await expect(page.locator('#swarm-stale')).toHaveCount(0)
    await expect(page.locator('#swarm-count')).not.toContainText('loaded')
    await page.locator('#swarm-search').fill('acme run 60')
    await expect(page.locator(rows)).toHaveCount(1)
    await expect(page.locator(rows)).toContainText('#60')
  } finally { older.release() }
})

test('Swarm completes a large history without blocking the preview controls', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium exposes the long-task observer used by this regression.')
  await ready(page)
  const older = deferred(), logs = history('acme', 6280)
  await page.route('**/api/agent-logs**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    if (url.searchParams.has('search')) return route.fulfill({ json: paged(logs, url, 200) })
    if (url.searchParams.get('cursor') === null) return route.fulfill({ json: paged(logs, url, 50) })
    await older.promise
    await route.fulfill({ json: paged(logs, url, 6230) })
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
    await expect(page.locator(rows)).toHaveCount(200)
    const worstTask = await tasks.evaluate(({ durations, observer }) => {
      durations.push(...observer.takeRecords().map(entry => entry.duration)); observer.disconnect()
      return Math.max(0, ...durations)
    })
    console.log(`Swarm preview to 6280 calls: longest main-thread task ${worstTask}ms`)
    expect(worstTask).toBeLessThan(350)
    const counts = await tasks.evaluate(({ counts, mutations }) => { mutations.disconnect(); return counts })
    expect(Math.max(...counts)).toBeLessThanOrEqual(200)
    await expect(page.locator('#swarm-count')).toHaveText('6280')
    expect(await control!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true)
    await page.locator('#swarm-search').fill('acme run 6280')
    await expect(page.locator(rows)).toHaveCount(1)
    await expect(page.locator(rows)).toContainText('#6280')
  } finally { older.release() }
})

test('a failed older-history page keeps recent calls, reports incompleteness and recovers', async ({ page }) => {
  await ready(page)
  const logs = history()
  let reads = 0
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    if (url.searchParams.has('search')) return route.fulfill({ json: paged(logs, url, 200) })
    if (url.searchParams.get('cursor') === null) return route.fulfill({ json: paged(logs, url, 50) })
    return ++reads === 1 ? route.fulfill({ status: 502, json: { error: 'History unavailable' } }) : route.fulfill({ json: paged(logs, url, 200) })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(50)
  await expect(await feedback(page)).toContainText('History unavailable')
  await expect(await feedback(page)).toContainText('Only 50 of 60 runs loaded')
  await page.locator('#swarm-search').fill('acme run 60')
  await expect(page.locator('#swarm-empty')).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(page.locator(rows)).toHaveCount(1)
  await expect(page.locator(rows)).toContainText('#60')
  await expect(page.locator('#swarm-stale')).toHaveCount(0)
  await expect((await feedback(page)).locator('.nr-card').filter({ hasText: 'Swarm is not updating' })).toHaveCount(0)
})

test('returning to Swarm paints history received while hidden before its new refresh', async ({ page }) => {
  await ready(page)
  const first = deferred(), refresh = deferred(), logs = history('acme', 6280)
  let historyReads = 0
  await page.route('**/api/agent-logs**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    if (url.searchParams.has('search')) return route.fulfill({ json: paged(logs, url, 200) })
    if (url.searchParams.get('cursor') !== null) {
      historyReads++
      await first.promise
      await route.fulfill({ json: paged(logs, url, 6230) })
      return
    }
    if (++historyReads === 1) return route.fulfill({ json: paged(logs, url, 50) })
    await refresh.promise
    await route.fulfill({ json: paged(logs, url, 50) })
  })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator(rows)).toHaveCount(50)
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    const hiddenRows = await page.evaluateHandle(() => {
      let created = 0
      const original = document.createElement.bind(document)
      document.createElement = ((...args: Parameters<typeof document.createElement>) => {
        if (args[0].toLowerCase() === 'tr') created++
        return original(...args)
      }) as typeof document.createElement
      return { count: () => created }
    })
    const received = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/agent-logs' && url.searchParams.has('cursor')
    })
    first.release()
    await (await received).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await hiddenRows.evaluate(value => value.count())).toBe(0)
    await expect(page.locator(rows)).toHaveCount(0)
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator(rows)).toHaveCount(200, { timeout: 1000 })
    await expect(page.locator('#swarm-count')).toHaveText('6280')
    await page.locator('#swarm-search').fill('acme run 6280')
    await expect(page.locator(rows)).toHaveCount(1)
    await expect(page.locator(rows)).toContainText('#6280')
    await expect.poll(() => historyReads).toBe(3)
  } finally { first.release(); refresh.release() }
})

test('a late initial read cannot restart Swarm polling after leaving', async ({ page }) => {
  await ready(page)
  const initial = deferred(), logs = history().slice(0, 1)
  let reads = 0
  await page.route('**/api/agent-logs**', async route => {
    reads++
    await initial.promise
    const url = new URL(route.request().url())
    await route.fulfill({ json: url.searchParams.get('status') === 'running' ? { logs: [] } : { logs, total: 1, nextCursor: null } })
  })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect.poll(() => reads).toBe(2)
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent-logs')
    initial.release()
    await (await received).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
    await page.waitForTimeout(150)
    expect(reads).toBe(2)
  } finally { initial.release() }
})

test('switching accounts supersedes an older pending history page', async ({ page }) => {
  await ready(page)
  const organizations = ['acme', 'beta'].map(login => ({ login, managed: true, status: 'ready', stage: 'ready', error: null, activatedAt: null }))
  await page.route('**/api/settings', route => route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', organizations, models: {} } }))
  await page.route('**/api/organizations', route => route.fulfill({ json: { organizations } }))
  await page.reload(); await settled(page)
  const older = deferred()
  await page.route('**/api/agent-logs**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    const org = url.searchParams.get('org') || 'acme', logs = history(org)
    if (url.searchParams.has('search')) return route.fulfill({ json: paged(logs, url, 200) })
    if (url.searchParams.get('cursor') === null) {
      return route.fulfill({ json: paged(logs, url, org === 'beta' ? 1 : 50) })
    }
    await older.promise
    await route.fulfill({ json: paged(logs, url, 200) })
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
    await expect(page.locator('#swarm-stale')).toHaveCount(0)
  } finally { older.release() }
})


test('an empty-history refresh failure remains visible on re-entry while another read is pending', async ({ page }) => {
  await ready(page)
  const refresh = deferred()
  let historyReads = 0
  await page.route('**/api/agent-logs**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    if (++historyReads === 1) return route.fulfill({ status: 502, json: { error: 'History unavailable' } })
    await refresh.promise
    await route.fulfill({ json: { logs: [], total: 0, nextCursor: null } })
  })
  try {
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator('#swarm-empty')).toHaveCount(0)
    await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
    await expect(await feedback(page)).toContainText('History unavailable')
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect.poll(() => historyReads).toBe(2)
    await expect(await feedback(page)).toContainText('History unavailable')
    refresh.release()
    await expect((await feedback(page)).locator('.nr-card').filter({ hasText: 'Swarm is not updating' })).toHaveCount(0)
    await expect(page.locator('#swarm-empty')).toHaveCount(0)
  } finally { refresh.release() }
})

test('a new search with cached first-page matches still reaches older matches', async ({ page }) => {
  await ready(page)
  const logs = history('acme', 450).map((row, index) => index < 250
    ? { ...row, prompt: `alpha run ${index + 1}` }
    : { ...row, prompt: `beta run ${index + 1}` })
  const cursorReads: string[] = []
  await boundedRoute(page, () => logs, cursorReads)
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(200)
  await page.locator('#swarm-search').fill('alpha')
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 200+')
  await expect(pagerNext(page)).toBeEnabled()
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–250 / 250')
  await expect(page.locator(rows).first()).toContainText('#201')
  await expect(page.locator(rows).last()).toContainText('#250')
  expect(cursorReads).toEqual(['search:200'])
})

test('an unchanged refresh preserves a partially loaded continuation', async ({ page }) => {
  await ready(page)
  const logs = history('acme', 450)
  const cursorReads: string[] = []
  await boundedRoute(page, () => logs, cursorReads)
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(200)
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–400 / 400+')
  expect(cursorReads).toEqual(['200'])
  await settledRefresh(page)
  await expect(page.locator('#swarm-page')).toHaveText('201–400 / 400+')
  await expect(pagerNext(page)).toBeEnabled()
  expect(cursorReads).toEqual(['200'])
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('401–450 / 450')
  await expect(pagerNext(page)).toBeDisabled()
  expect(cursorReads).toEqual(['200', '400'])
})

test('a deep link to a missing run does not re-walk exhausted history', async ({ page }) => {
  await ready(page)
  const logs = history('acme', 401)
  const cursorReads: string[] = []
  await boundedRoute(page, () => logs, cursorReads)
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  for (;;) {
    if (!await pagerNext(page).isEnabled()) break
    const before = await page.locator('#swarm-page').textContent()
    await pagerNext(page).click()
    await expect(page.locator('#swarm-page')).not.toHaveText(before!)
  }
  await expect(page.locator('#swarm-page')).toHaveText('401–401 / 401')
  expect(cursorReads).toEqual(['200', '400'])
  // The deep link validates its id; only a well-formed absent id reaches lookup.
  const absent = 'f'.repeat(32)
  await page.evaluate((target) => window.dispatchEvent(new CustomEvent('poise:goto-swarm-call', { detail: { id: target } })), absent)
  await expect(await feedback(page)).toContainText(`No run found for call ${absent}.`)
  expect(cursorReads).toEqual(['200', '400'])
})

test('an exhausted search reopens when a call beyond the first page starts matching', async ({ page }) => {
  await ready(page)
  let logs = history('acme', 250).map((row, index) => ({ ...row, prompt: `alpha run ${index + 1}` }))
  const runningCall = { ...logs[0], id: 'acme-900', pr_id: '900', prompt: 'nightly run',
    status: 'running', completed_at: null, response: '', error: '', time_elapsed: '' }
  let running = [runningCall]
  const cursorReads: string[] = []
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: running } })
    const cursor = url.searchParams.get('cursor')
    if (cursor !== null) cursorReads.push(url.searchParams.has('search') ? `search:${cursor}` : cursor)
    return route.fulfill({ json: pagedBounded(logs, url, 200) })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(200)
  await page.locator('#swarm-search').fill('alpha')
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 200+')
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–250 / 250')
  await expect(pagerNext(page)).toBeDisabled()
  // The running call completes beyond the first page: no arrival carries it,
  // but the search total grows. Its prompt gains the term the way its status
  // would server-side; this mock filters prompt, repo and pr_id only.
  const completed = { ...runningCall, prompt: 'nightly run alpha', status: 'completed',
    completed_at: '2026-10-14T08:01:00Z', response: 'available', time_elapsed: '1m' }
  logs = [...logs.slice(0, 225), completed, ...logs.slice(225)]
  running = []
  await settledRefresh(page)
  await expect(page.locator('#swarm-page')).toHaveText('201–250 / 250+')
  await expect(pagerNext(page)).toBeEnabled()
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–251 / 251')
  await expect(page.locator(`${rows}[data-id="acme-900"]`)).toHaveCount(1)
  await expect(pagerNext(page)).toBeDisabled()
  expect(cursorReads).toEqual(['search:200', 'search:200'])
})

test('an exhausted search reopens when arrivals and a hidden match land together', async ({ page }) => {
  await ready(page)
  let logs = history('acme', 250).map((row, index) => ({ ...row, prompt: `alpha run ${index + 1}` }))
  const runningCall = { ...logs[0], id: 'acme-900', pr_id: '900', prompt: 'nightly run',
    status: 'running', completed_at: null, response: '', error: '', time_elapsed: '' }
  let running = [runningCall]
  const cursorReads: string[] = []
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: running } })
    const cursor = url.searchParams.get('cursor')
    if (cursor !== null) cursorReads.push(url.searchParams.has('search') ? `search:${cursor}` : cursor)
    return route.fulfill({ json: pagedBounded(logs, url, 200) })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(200)
  await page.locator('#swarm-search').fill('alpha')
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 200+')
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–250 / 250')
  await page.locator('#swarm-pagination [data-page="previous"]').click()
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 250')
  // Fifty overlapping arrivals plus a completion beyond the first page: total
  // growth past the absorbed rows must reopen the walk for the hidden match.
  // The completed prompt gains the term the way its status would server-side.
  const fresh = Array.from({ length: 50 }, (_, index) => ({
    ...logs[0], id: `acme-new-${index}`, pr_id: `new-${index + 1}`, prompt: `alpha arrival ${index + 1}`,
  }))
  const completed = { ...runningCall, prompt: 'nightly run alpha', status: 'completed',
    completed_at: '2026-10-14T08:01:00Z', response: 'available', time_elapsed: '1m' }
  logs = [...fresh, ...logs]
  logs.splice(300, 0, completed)
  running = []
  await settledRefresh(page)
  // The hidden match is not merged yet — only the reopened cursor's `+`
  // proves the walk reopened; the match arrives with the next fetch below.
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 300+')
  await expect(pagerNext(page)).toBeEnabled()
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–301 / 301')
  await expect(page.locator(`${rows}[data-id="acme-900"]`)).toContainText('Approved')
  await expect(pagerNext(page)).toBeDisabled()
  expect(cursorReads).toEqual(['search:200', 'search:200'])
})

test('an exhausted search reopens when a quarantined arrival lands in both feeds with a hidden match', async ({ page }) => {
  await ready(page)
  let logs = history('acme', 250).map((row, index) => ({ ...row, prompt: `alpha run ${index + 1}` }))
  const runningCall = { ...logs[0], id: 'acme-900', pr_id: '900', prompt: 'nightly run',
    status: 'running', completed_at: null, response: '', error: '', time_elapsed: '' }
  let running = [runningCall]
  // Same new quarantined running row in both refresh feeds: one arrival key.
  const dupe = { index: 3, error: 'log row is not an object', id: 'c'.repeat(32),
    repo: null, prId: null, correlationId: null, behavior: null, sessionId: null }
  let quarantined: typeof dupe[] = []
  const cursorReads: string[] = []
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running')
      return route.fulfill({ json: { logs: running, quarantined } })
    const cursor = url.searchParams.get('cursor')
    if (cursor !== null) cursorReads.push(url.searchParams.has('search') ? `search:${cursor}` : cursor)
    const feed = pagedBounded(logs, url, 200)
    // Caller totals count every match; Poise splits the unreadable rows after.
    return route.fulfill({ json: { ...feed, total: feed.total + quarantined.length,
      quarantined: cursor === null ? quarantined : [] } })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(200)
  await page.locator('#swarm-search').fill('alpha')
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 200+')
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–250 / 250')
  await expect(pagerNext(page)).toBeDisabled()
  // The running call completes beyond the first page while the quarantined
  // row lands in both feeds: growth of two past one absorbed arrival must
  // reopen the walk for the hidden match.
  const completed = { ...runningCall, prompt: 'nightly run alpha', status: 'completed',
    completed_at: '2026-10-14T08:01:00Z', response: 'available', time_elapsed: '1m' }
  logs = [...logs.slice(0, 225), completed, ...logs.slice(225)]
  running = []
  quarantined = [dupe]
  await settledRefresh(page)
  // The refresh replays the page-2 continuation, which returns the 50
  // retained matches plus the newly matching completion and exhausts the
  // reopened walk in one fetch — no further Next is needed.
  await expect(page.locator('#swarm-page')).toHaveText('201–251 / 251')
  await expect(page.locator(`${rows}[data-id="acme-900"]`)).toHaveCount(1)
  await expect(pagerNext(page)).toBeDisabled()
  expect(cursorReads).toEqual(['search:200', 'search:200'])
})

test('a cleared search still reaches rows its narrowing discarded', async ({ page }) => {
  await ready(page)
  const logs = history('acme', 450).map((row, index) => index < 250
    ? { ...row, prompt: `alpha run ${index + 1}` }
    : { ...row, prompt: `beta run ${index + 1}` })
  const cursorReads: string[] = []
  await boundedRoute(page, () => logs, cursorReads)
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(200)
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–400 / 400+')
  // Narrowing discards the walked alpha rows from the cache; clearing must
  // release their pinned ids, or the next continuation skips them as placed.
  await page.locator('#swarm-search').fill('beta')
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 200')
  await expect(pagerNext(page)).toBeDisabled()
  await page.locator('#swarm-search').fill('')
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 400+')
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–400 / 450+')
  await expect(page.locator(rows).first()).toContainText('#201')
  await expect(page.locator(rows).last()).toContainText('#400')
  await pagerNext(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('401–450 / 450')
  await expect(pagerNext(page)).toBeDisabled()
  expect(cursorReads).toEqual(['200', '200', '400'])
})
