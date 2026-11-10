import { expect, test, type Page } from '@playwright/test'
import { feedback } from './fixtures/view-feedback'
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

// Bounded history mock: every read — first page and continuations — returns
// at most `size` newest-first rows behind an index cursor, with an exact
// total. Whole-history fixtures cannot exercise exhaustion or gap transitions.
function paged<T>(logs: T[], url: URL, size: number) {
  const cursor = url.searchParams.get('cursor')
  const start = cursor === null ? 0 : Number(cursor)
  const slice = logs.slice(start, start + size)
  const next = start + slice.length
  return { logs: slice, total: logs.length, nextCursor: next < logs.length ? String(next) : null }
}

// Settle a refresh tick: the running lane is read after the history page, so
// its response proves both refresh inputs landed; single-page histories skip
// that lane, so their history read is the signal instead.
async function refreshed(page: Page, multiPage: boolean) {
  const received = page.waitForResponse(response => {
    const url = new URL(response.url())
    if (url.pathname !== '/api/agent-logs') return false
    return multiPage
      ? url.searchParams.get('status') === 'running'
      : !url.searchParams.has('cursor') && !url.searchParams.has('status')
  })
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await (await received).finished()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
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

test('a native chain step names its command and shows no model', async ({ page }) => {
  await workspace(page); await settled(page)
  const steps = [
    ['native_action', '--merge-if-ready', 'merge-if-ready'],
    ['native_action', '--resolve-nonblocking-conversations-if-ready', 'resolve-nonblocking-conversations-if-ready'],
    ['native_action', '--rerun-grey-ci-if-ready', 'rerun-grey-ci-if-ready'],
    ['native_action', '--issue-work', 'issue-work'],
    ['native_publication', 'Complete original repair publication', 'publication'],
  ]
  const run = history()[0]
  const logs = [
    ...steps.map(([behavior, prompt], index) => ({ ...run, id: id(index), model: 'native-action', behavior, prompt })),
    { ...run, id: id(steps.length), model: 'opus-5', recovery_model: 'grok-4' },
  ]
  await page.route('**/api/agent-logs**', route => route.fulfill({ json: { logs } }))
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  const cells = (index: number) => page.locator(`${rows}[data-id="${id(index)}"] td`)
  for (const [index, [, , label]] of steps.entries()) {
    await expect(cells(index).nth(1)).toHaveText('—')
    await expect(cells(index).nth(2)).toHaveText(label)
  }
  await expect(cells(steps.length).nth(1)).toHaveText('opus-5 → grok-4')
  await expect(cells(steps.length).nth(2)).toHaveText('pr_review')
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

for (const size of [200, 201, 400, 401]) {
  test(`an exhausted ${size}-call history stays complete across refreshes and re-entry`, async ({ page }) => {
    await workspace(page); await settled(page)
    const logs = history().slice(0, size)
    const cursorReads: string[] = []
    const historyNotices: string[] = []
    page.on('console', message => {
      if (message.type() === 'info' && message.text().includes('[swarm-history]')) historyNotices.push(message.text())
    })
    await page.route('**/api/agent-logs**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
      const cursor = url.searchParams.get('cursor')
      if (cursor !== null) cursorReads.push(cursor)
      return route.fulfill({ json: paged(logs, url, 200) })
    })
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    const pager = page.getByRole('group', { name: 'Swarm pages' })
    const start = size - ((size - 1) % 200) - 1
    if (size > 200) {
      for (;;) {
        if (!await next(page).isEnabled()) break
        const before = await page.locator('#swarm-page').textContent()
        await next(page).click()
        await expect(page.locator('#swarm-page')).not.toHaveText(before!)
      }
      await expect(page.locator('#swarm-page')).toHaveText(`${start + 1}–${size} / ${size}`)
      await expect(next(page)).toBeDisabled()
    } else {
      await expect(page.locator(rows)).toHaveCount(200)
      await expect(pager).toBeHidden()
    }
    const reads = [...cursorReads]
    const complete = async () => {
      if (size > 200) {
        await expect(page.locator('#swarm-page')).toHaveText(`${start + 1}–${size} / ${size}`)
        await expect(next(page)).toBeDisabled()
      } else {
        await expect(pager).toBeHidden()
      }
      expect(cursorReads).toEqual(reads)
    }
    historyNotices.length = 0
    await refreshed(page, size > 200)
    await refreshed(page, size > 200)
    await complete()
    expect(historyNotices.filter(text => text.includes('Loading older runs'))).toEqual([])
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    const returned = page.waitForResponse(response => {
      const url = new URL(response.url())
      if (url.pathname !== '/api/agent-logs') return false
      return size > 200
        ? url.searchParams.get('status') === 'running'
        : !url.searchParams.has('cursor') && !url.searchParams.has('status')
    })
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await (await returned).finished()
    await complete()
    expect(cursorReads).toEqual(reads)
  })
}

test('an exhausted identical-run history keeps its pager hidden across refreshes', async ({ page }) => {
  await workspace(page); await settled(page)
  const base = history().slice(0, 401)
  const first = base[0]
  const logs = base.map((entry) => ({ ...first, id: entry.id, response: null }))
  const cursorReads: string[] = []
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    const cursor = url.searchParams.get('cursor')
    if (cursor !== null) cursorReads.push(cursor)
    return route.fulfill({ json: paged(logs, url, 200) })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(1)
  const pager = page.getByRole('group', { name: 'Swarm pages' })
  await expect(pager).toBeVisible()
  for (const [fetched, count] of [[1, '400'], [2, '401']] as const) {
    await expect(next(page)).toBeEnabled()
    await next(page).click()
    await expect.poll(() => cursorReads.length).toBe(fetched)
    await expect(page.locator('#swarm-count')).toHaveText(count)
  }
  await expect(pager).toBeHidden()
  expect(cursorReads).toEqual(['200', '400'])
  await refreshed(page, true)
  await expect(pager).toBeHidden()
  await expect(page.locator('#swarm-pagination [data-page="next"]')).toBeDisabled()
  expect(cursorReads).toEqual(['200', '400'])
})

test('quarantine counts follow stored records across refresh and pagination', async ({ page }) => {
  await workspace(page); await settled(page)
  const logs = history().slice(0, 401)
  const quarantine = (historyRowId: string, index: number, call: string | null = null) => ({
    historyRowId, index, error: `Caller History row ${index} is unreadable (INVALID_UTF8)`,
    id: call, repo: null, prId: null, correlationId: null, behavior: null, sessionId: null,
  })
  let offset = 0
  let extra = false
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    const known = quarantine('500', 1 + offset, 'b'.repeat(32))
    if (url.searchParams.get('status') === 'running') {
      return route.fulfill({ json: { logs: [], quarantined: [{ ...known, index: 0 }] } })
    }
    const quarantined = url.searchParams.has('cursor')
      ? [quarantine('299', 2)]
      : [known, quarantine('499', 2 + offset), ...(extra ? [quarantine('501', 0)] : [])]
    return route.fulfill({ json: { ...paged(logs, url, 200), quarantined } })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(await feedback(page)).toContainText('2 unreadable worker log row(s) isolated')
  await next(page).click()
  await expect(await feedback(page)).toContainText('3 unreadable worker log row(s) isolated')
  offset = 4
  await refreshed(page, true)
  const notice = await feedback(page)
  await expect(notice).toContainText('3 unreadable worker log row(s) isolated')
  await expect(notice).toContainText('INVALID_UTF8')
  extra = true
  await refreshed(page, true)
  await expect(notice).toContainText('4 unreadable worker log row(s) isolated')
})

test('known unreadable rows keep their alert age and dismissal across refresh, search, navigation and reload', async ({ page }) => {
  await workspace(page, 'current', undefined, { preserveOnReload: true }); await settled(page)
  await page.route('**/api/notices', route => route.fulfill({ json: { enabled: true, notices: [] } }))
  const logs = history().slice(0, 401)
  const quarantine = (historyRowId: string, index: number, error: string, call: string | null) => ({
    historyRowId, index, error, id: call, repo: null, prId: null, correlationId: null, behavior: null, sessionId: null,
  })
  const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32)
  let offset = 0
  let mode: 'AB' | 'AC' = 'AB'
  let failReads = false
  await page.route('**/api/agent-logs**', route => {
    if (failReads) return route.fulfill({ status: 502, json: { error: 'History offline' } })
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    const search = url.searchParams.get('search')
    if (search === 'nothing-matches-this') return route.fulfill({ json: { logs: [], total: 0, nextCursor: null, quarantined: [] } })
    if (search) return route.fulfill({ json: { logs: logs.slice(0, 1), total: 1, nextCursor: null,
      quarantined: [quarantine('500', 1 + offset, `Caller History row ${1 + offset} is unreadable (INVALID_RECORD)`, A)] } })
    const second = mode === 'AB'
      ? quarantine('499', 2 + offset, `payload fault ${offset} (INVALID_RECORD)`, B)
      : quarantine('501', 2 + offset, `payload fault ${offset} (INVALID_RECORD)`, C)
    const quarantined = [
      quarantine('500', 1 + offset, `Caller History row ${1 + offset} is unreadable (INVALID_RECORD)`, A),
      second,
      quarantine('502', 3 + offset, `agent-interface log row ${3 + offset} is unreadable (INVALID_UTF8)`, null),
    ]
    return route.fulfill({ json: { ...paged(logs, url, 200), quarantined } })
  })
  await page.reload(); await settled(page)
  const card = () => feedback(page, 'Unreadable Swarm records')
  const age = () => card().then(notice => notice.locator('time').getAttribute('datetime'))
  // A toast only shows while the rail is closed; asserting none with it open
  // would prove nothing. Leaving cards are already on their way out.
  const liveToasts = page.locator('.nr-toast:not([data-leaving="true"])')
  const closeRail = async () => {
    if (await page.locator('#notification-bell').getAttribute('aria-expanded') === 'true') await page.keyboard.press('Escape')
    await expect(page.locator('#notification-bell')).toHaveAttribute('aria-expanded', 'false')
  }
  const showSwarm = async () => {
    if (await page.locator('#view-swarm').isHidden()) await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    await expect(page.locator('#view-swarm')).toBeVisible()
  }
  // Toast assertions always run before opening the rail: opening it drops
  // toasts, so asserting after would prove nothing.
  await showSwarm()
  await expect(page.locator(rows)).toHaveCount(200)
  await closeRail()
  await expect(liveToasts).toHaveCount(1)
  await expect(liveToasts.locator('.nr-toast-title')).toHaveText('Unreadable Swarm records')
  await expect(await card()).toContainText('3 unreadable worker log row(s) isolated')
  await expect(await card()).toContainText('Call: unknown')
  const firstAge = await age()
  // Shifted indexes and reworded evidence update the text, not the alert.
  offset = 4
  await refreshed(page, true)
  await closeRail()
  await expect(liveToasts).toHaveCount(0)
  await expect(await card()).toContainText('payload fault 4')
  await expect.poll(age).toBe(firstAge)
  // A known undismissed notice reloads with its age and stays silent.
  await page.reload(); await settled(page)
  await showSwarm()
  await expect(page.locator(rows)).toHaveCount(200)
  await closeRail()
  await expect(liveToasts).toHaveCount(0)
  await expect(await card()).toContainText('payload fault 4')
  await expect.poll(age).toBe(firstAge)
  // Dismissed rows stay dismissed across refresh, subset and empty searches.
  await (await card()).locator('.nr-card-head').click()
  await (await card()).getByRole('button', { name: 'Dismiss' }).click()
  await expect(await card()).toHaveCount(0)
  await closeRail()
  offset = 9
  await refreshed(page, true)
  await closeRail()
  await expect(liveToasts).toHaveCount(0)
  await expect(await card()).toHaveCount(0)
  const searched = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/agent-logs' && url.searchParams.has('search')
  })
  await page.locator('#swarm-search').fill('Run 1')
  await (await searched).finished()
  await closeRail()
  await expect(liveToasts).toHaveCount(0)
  await expect(await card()).toHaveCount(0)
  const emptied = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/agent-logs' && url.searchParams.get('search') === 'nothing-matches-this'
  })
  await page.locator('#swarm-search').fill('nothing-matches-this')
  await (await emptied).finished()
  await expect(page.locator(rows)).toHaveCount(0)
  await closeRail()
  await expect(liveToasts).toHaveCount(0)
  await expect(await card()).toHaveCount(0)
  const cleared = page.waitForResponse(response => {
    const url = new URL(response.url())
    return url.pathname === '/api/agent-logs' && !url.searchParams.has('search') && !url.searchParams.has('status')
  })
  await page.locator('#swarm-search').fill('')
  await (await cleared).finished()
  await expect(page.locator(rows)).toHaveCount(200)
  await closeRail()
  await expect(liveToasts).toHaveCount(0)
  await expect(await card()).toHaveCount(0)
  // Navigation away and back, then a reload, keep the dismissal.
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  await expect(page.locator('#view-current')).toBeVisible()
  await showSwarm()
  await expect(page.locator(rows)).toHaveCount(200)
  await closeRail()
  await expect(liveToasts).toHaveCount(0)
  await expect(await card()).toHaveCount(0)
  await page.reload(); await settled(page)
  await showSwarm()
  await expect(page.locator(rows)).toHaveCount(200)
  await closeRail()
  await expect(liveToasts).toHaveCount(0)
  await expect(await card()).toHaveCount(0)
  // A new row replacing another at the same count alerts once, with a new age.
  mode = 'AC'
  // Boot anywhere but Swarm: the feed starts after the first view, so a poll
  // on boot would renew before the rail can announce it.
  await page.evaluate(() => localStorage.setItem('poise-view', 'current'))
  const announced = page.waitForResponse(response => new URL(response.url()).pathname === '/api/notices')
  await page.reload()
  await announced
  await settled(page)
  await showSwarm()
  await expect(page.locator(rows)).toHaveCount(200)
  await closeRail()
  await expect(liveToasts).toHaveCount(1)
  await expect(liveToasts.locator('.nr-toast-title')).toHaveText('Unreadable Swarm records')
  await expect(await card()).toContainText('3 unreadable worker log row(s) isolated')
  await expect(await card()).toContainText(`Call: ${C}`)
  const renewedAge = await age()
  expect(renewedAge).not.toBe(firstAge)
  // After dismissing the new row, returning to the known rows stays quiet.
  await (await card()).locator('.nr-card-head').click()
  await (await card()).getByRole('button', { name: 'Dismiss' }).click()
  await expect(await card()).toHaveCount(0)
  await closeRail()
  mode = 'AB'
  await refreshed(page, true)
  await closeRail()
  await expect(liveToasts).toHaveCount(0)
  await expect(await card()).toHaveCount(0)
  // A failed read warns separately without disturbing the retained dismissal.
  await closeRail()
  failReads = true
  await refreshed(page, false)
  await closeRail()
  await expect(liveToasts).toHaveCount(1)
  await expect(liveToasts.locator('.nr-toast-title')).toHaveText('Swarm is not updating')
  const rail = await feedback(page)
  await expect(rail.locator('.nr-card').filter({ hasText: 'Swarm is not updating' })).toHaveCount(1)
  await expect(await card()).toHaveCount(0)
  await closeRail()
  failReads = false
  await refreshed(page, true)
  await closeRail()
  await expect(liveToasts).toHaveCount(0)
  const recovered = await feedback(page)
  await expect(recovered.locator('.nr-card')).toHaveCount(0)
})

test('dismissed quarantines in one organization survive a clean organization and back', async ({ page }) => {
  await workspace(page); await settled(page)
  const organizations = ['acme', 'beta'].map(login => ({ login, managed: true, status: 'ready', stage: 'ready', error: null, activatedAt: null }))
  await page.route('**/api/settings', route => route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', organizations, models: {} } }))
  await page.route('**/api/organizations', route => route.fulfill({ json: { organizations } }))
  const logs = history().slice(0, 210)
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    const quarantined = url.searchParams.get('org') === 'beta' ? [] : [{
      historyRowId: '500', index: 1, error: 'Caller History row 1 is unreadable (INVALID_RECORD)',
      id: 'a'.repeat(32), repo: null, prId: null, correlationId: null, behavior: null, sessionId: null,
    }]
    return route.fulfill({ json: { ...paged(logs, url, 200), quarantined } })
  })
  await page.reload(); await settled(page)
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(200)
  const filter = page.locator('#view-swarm').getByLabel('Organization filter')
  await filter.selectOption('acme')
  const card = () => feedback(page, 'Unreadable Swarm records')
  await expect(await card()).toContainText('1 unreadable worker log row(s) isolated')
  await (await card()).locator('.nr-card-head').click()
  await (await card()).getByRole('button', { name: 'Dismiss' }).click()
  await expect(await card()).toHaveCount(0)
  // A clean, fully loaded organization must not erase the other one's
  // checkpoint: returning to it stays dismissed instead of alerting again.
  await filter.selectOption('beta')
  await expect(page.locator(rows)).toHaveCount(200)
  await next(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–210 / 210')
  await expect(await card()).toHaveCount(0)
  await filter.selectOption('acme')
  await expect(page.locator(rows)).toHaveCount(200)
  await expect(await card()).toHaveCount(0)
})

test('a dismissed showing forgets rows a complete read no longer carries', async ({ page }) => {
  await workspace(page, 'current', undefined, { preserveOnReload: true }); await settled(page)
  const logs = history().slice(0, 210)
  const quarantine = (tag: string, call: string, historyRowId: string, index: number) => ({
    historyRowId, index, error: `Caller History row ${index} is unreadable (${tag})`,
    id: call, repo: null, prId: null, correlationId: null, behavior: null, sessionId: null,
  })
  let tags = ['INVALID_RECORD', 'SQLITE_CORRUPT']
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    const quarantined = tags.map(tag => tag === 'INVALID_RECORD'
      ? quarantine(tag, 'a'.repeat(32), '500', 1) : quarantine(tag, 'b'.repeat(32), '499', 2))
    return route.fulfill({ json: { ...paged(logs, url, 200), quarantined } })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(200)
  const card = () => feedback(page, 'Unreadable Swarm records')
  await expect(await card()).toContainText('2 unreadable worker log row(s) isolated')
  await (await card()).locator('.nr-card-head').click()
  await (await card()).getByRole('button', { name: 'Dismiss' }).click()
  await expect(await card()).toHaveCount(0)
  // A complete read carrying only one row proves the other repaired: the
  // dismissed checkpoint forgets it, so its return alerts anew. Ticks merge
  // into the retained rows, so a reload takes the resetting first-page read.
  tags = ['SQLITE_CORRUPT']
  await page.reload(); await settled(page)
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(rows)).toHaveCount(200)
  await next(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–210 / 210')
  await expect(await card()).toHaveCount(0)
  tags = ['INVALID_RECORD', 'SQLITE_CORRUPT']
  await refreshed(page, false)
  await expect(await card()).toContainText('2 unreadable worker log row(s) isolated')
  await expect(await card()).toContainText('INVALID_RECORD')
})

test('arrivals larger than a page merge into run order and keep newest-target selection', async ({ page }) => {
  await workspace(page); await settled(page)
  const old = history().slice(0, 401)
  // The older target match is set before the first read: a continuation page
  // never refreshes the fields of an id it already holds.
  old[50] = { ...old[50], repo: 'acme/target', pr_id: '999' }
  let logs: typeof old = old
  const quarantined = [
    { index: 1, error: 'invalid terminal outcome', id: 'b'.repeat(32),
      repo: 'o/r', prId: '2', correlationId: 'claim-2', behavior: 'pr_review', sessionId: null },
    { index: 2, error: 'Caller History row 2 is unreadable (SQLITE_CORRUPT)', id: null,
      repo: null, prId: null, correlationId: null, behavior: null, sessionId: null },
  ]
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    return route.fulfill({ json: { ...paged(logs, url, 200), quarantined } })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  for (;;) {
    if (!await next(page).isEnabled()) break
    const before = await page.locator('#swarm-page').textContent()
    await next(page).click()
    await expect(page.locator('#swarm-page')).not.toHaveText(before!)
  }
  await expect(page.locator('#swarm-page')).toHaveText('401–401 / 401')
  await expect(await feedback(page)).toContainText('2 unreadable worker log row(s) isolated')
  await expect(await feedback(page)).toContainText('SQLITE_CORRUPT')
  for (const label of ['201–400 / 401', '1–200 / 401']) {
    await previous(page).click()
    await expect(page.locator('#swarm-page')).toHaveText(label)
  }
  const fresh = Array.from({ length: 300 }, (_, index) => ({
    ...old[0], id: id(7000 + index), pr_id: `new-${index + 1}`,
  }))
  const gapNewest = { ...fresh[200], repo: 'acme/target', pr_id: '999' }
  fresh[200] = gapNewest
  logs = [...fresh, ...old]
  await refreshed(page, true)
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 601+')
  const first = await page.locator(rows).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id!))
  expect(first).toEqual(logs.slice(0, 200).map(entry => entry.id))
  await next(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–400 / 701+')
  await expect(page.locator(rows)).toHaveCount(200)
  const second = await page.locator(rows).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id!))
  expect(second).toEqual(logs.slice(200, 400).map(entry => entry.id))
  expect(second[0]).toBe(gapNewest.id)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:goto-swarm-row', { detail: { repo: 'acme/target', pr_id: '999' } })))
  await expect(page.locator(`${rows}[data-id="${gapNewest.id}"]`)).toHaveClass(/agent-row-focus/)
})

test('a first continuation without overlap slots newer calls above the older cache', async ({ page }) => {
  await workspace(page); await settled(page)
  const base = Date.parse('2026-10-14T08:00:00Z')
  const at = (index: number) => new Date(base - index * 1000).toISOString()
  const old = history().slice(0, 401).map((entry, index) => ({ ...entry, started_at: at(index) }))
  let logs: typeof old = old
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    return route.fulfill({ json: paged(logs, url, 200) })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  for (;;) {
    if (!await next(page).isEnabled()) break
    const before = await page.locator('#swarm-page').textContent()
    await next(page).click()
    await expect(page.locator('#swarm-page')).not.toHaveText(before!)
  }
  await expect(page.locator('#swarm-page')).toHaveText('401–401 / 401')
  for (const label of ['201–400 / 401', '1–200 / 401']) {
    await previous(page).click()
    await expect(page.locator('#swarm-page')).toHaveText(label)
  }
  const fresh = Array.from({ length: 400 }, (_, index) => ({
    ...old[0], id: id(8000 + index), pr_id: `fresh-${index + 1}`,
    started_at: new Date(base + (400 - index) * 1000).toISOString(),
  }))
  logs = [...fresh, ...old]
  await refreshed(page, true)
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 601+')
  const first = await page.locator(rows).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id!))
  expect(first).toEqual(logs.slice(0, 200).map(entry => entry.id))
  await next(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–400 / 801+')
  await expect(page.locator(rows)).toHaveCount(200)
  const second = await page.locator(rows).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id!))
  expect(second).toEqual(logs.slice(200, 400).map(entry => entry.id))
  expect(second[0]).toBe(fresh[200].id)
})

test('a continuation repositions a running-feed row instead of anchoring to it', async ({ page }) => {
  await workspace(page); await settled(page)
  const base = history().slice(0, 250)
  const runningOld = { ...base[225], id: id(9000), status: 'running', completed_at: null, response: '', error: '', time_elapsed: '' }
  const old = base.map((entry, index) => index === 225 ? runningOld : entry)
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [runningOld] } })
    return route.fulfill({ json: paged(old, url, 200) })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 201+')
  await next(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–250 / 250')
  await expect(page.locator(rows)).toHaveCount(50)
  const second = await page.locator(rows).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id!))
  expect(second).toEqual(old.slice(200, 250).map(entry => entry.id))
  await expect(next(page)).toBeDisabled()
})

test('a straddling continuation outranks older cached ties', async ({ page }) => {
  await workspace(page); await settled(page)
  const old = history().slice(0, 401)
  let logs: typeof old = old
  await page.route('**/api/agent-logs**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('status') === 'running') return route.fulfill({ json: { logs: [] } })
    return route.fulfill({ json: paged(logs, url, 200) })
  })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  for (;;) {
    if (!await next(page).isEnabled()) break
    const before = await page.locator('#swarm-page').textContent()
    await next(page).click()
    await expect(page.locator('#swarm-page')).not.toHaveText(before!)
  }
  await expect(page.locator('#swarm-page')).toHaveText('401–401 / 401')
  for (const label of ['201–400 / 401', '1–200 / 401']) {
    await previous(page).click()
    await expect(page.locator('#swarm-page')).toHaveText(label)
  }
  // Every row shares one timestamp: only the page structure can place the
  // overlap-free continuation above the older cache it straddles.
  const fresh = Array.from({ length: 400 }, (_, index) => ({
    ...old[0], id: id(8100 + index), pr_id: `tied-${index + 1}`,
  }))
  logs = [...fresh, ...old]
  await refreshed(page, true)
  await expect(page.locator('#swarm-page')).toHaveText('1–200 / 601+')
  await next(page).click()
  await expect(page.locator('#swarm-page')).toHaveText('201–400 / 801+')
  await expect(page.locator(rows)).toHaveCount(200)
  const second = await page.locator(rows).evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.id!))
  expect(second).toEqual(logs.slice(200, 400).map(entry => entry.id))
  expect(second[0]).toBe(fresh[200].id)
})
