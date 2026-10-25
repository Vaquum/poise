import { feedback } from './fixtures/view-feedback'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { normalize, type LogEvent } from '../../gateway/src/diagnostics/contract'
import { callerDiagnostic } from '../../gateway/src/diagnostics/sources'
import { DiagnosticStore, DEFAULT_LOG_POLICY } from '../../gateway/src/diagnostics/store'
import { workspace } from './fixtures/workspace'

const storePath = resolve('test-results/e2e/logging.db')
// Playwright retries this serial file as one group against the same logging.db,
// and local reruns skip prepare:e2e. Event ids are content-addressed but their
// payloads carry Date.now(), so re-seeding fixed ids always throws a
// conflicting-identity error and no retry could ever run. Each worker module
// therefore seeds its own component + id namespace; every query in this spec
// is already scoped by prefs.component, so earlier attempts' rows stay invisible.
const run = randomBytes(4).toString('hex')
const component = `logging-fixture-${run}`
const callId = (index: number) => run + (index + 1).toString(16).padStart(24, '0')
const fixtures: LogEvent[] = []
const lateIds: string[] = []
const prefs = { component, workspace: '', account: '', repository: '', callId: '', correlationId: '', incidentId: '',
  severities: ['critical', 'error', 'warning'], time: 'all', from: '', to: '', source: '', search: '', scope: 'workspace' }
const rows = (page: Page) => page.locator('#logging-tbody > tr.agent-row')
const status = (page: Page) => page.locator('#logging-status')
const action = (page: Page, key: string) => page.locator(`#view-logging [data-action="${key}"]`).first()
const labels: Record<string, string> = { time: 'Time', severity: 'Severity', source: 'Source', component: 'Component', workspace: 'Workspace', account: 'Account', repository: 'Repository', callId: 'Call ID', correlationId: 'Correlation ID', incidentId: 'Incident ID' }
async function openFilter(page: Page, key: string): Promise<void> {
  const trigger = page.locator('#logging-filter-button-' + key)
  if (!await trigger.count()) {
    await page.getByRole('button', { name: 'Choose diagnostic columns' }).click()
    await page.locator('#logging-columns').getByLabel(labels[key], { exact: true }).check()
    await page.keyboard.press('Escape')
  }
  const popup = page.locator('#logging-filter-' + key)
  if (!await popup.isVisible()) await trigger.click()
  await expect(popup).toBeVisible()
}
async function exactFilter(page: Page, key: string, value: string): Promise<void> {
  await openFilter(page, key)
  await page.locator('#logging-' + key).fill(value)
}
async function ready(page: Page, path?: string, timezone = 'UTC'): Promise<void> {
  await workspace(page, 'current', undefined, { preserveOnReload: true, realLogging: true, timezone })
  await page.evaluate((value) => localStorage.setItem('poise-logging-filters', JSON.stringify(value)), prefs)
  if (path) await page.goto(path)
  else {
    await page.evaluate(() => {
      const start = (event: Event) => {
        if (!(event.target instanceof Element) || !event.target.closest('#menu-popover [data-action="logging"]')) return
        document.removeEventListener('click', start, true)
        const started = performance.now()
        const observer = new MutationObserver(() => {
          const status = document.querySelector('#logging-status')
          const loader = document.querySelector<HTMLElement>('#logging-loader')
          if (!status?.textContent?.includes('matching retained events') || !loader?.hidden) return
          observer.disconnect()
          requestAnimationFrame(() => Object.assign(window, { loggingNavigationMs: performance.now() - started }))
        })
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
      }
      document.addEventListener('click', start, true)
    })
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('#menu-popover [data-action="logging"]').click()
  }
  await expect(status(page)).toContainText('matching retained events')
  await expect(page.locator('#logging-loader')).toBeHidden()
  await expect(page.locator('#menu-surface')).toBeHidden()
  await expect(page.locator('#logging-scope-label')).toBeHidden()
  await expect(page.locator('#logging-new')).toBeHidden()
}

// Only this file uses the real API/store; other browser fixtures intercept it.
interface LoggingPoll { hidden: boolean; logging: boolean }
// Polls are attributed in the page at fetch time. Playwright `request` events
// arrive asynchronously, so a poll issued before the counting window could be
// counted after it (false positive), and one issued at the end of runFor could
// arrive after the assertion (false negative). A bare `after` match would also
// count unrelated endpoints such as /api/chat/sessions/:id?after=.
async function trackLoggingPolls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const polls: Array<{ hidden: boolean; logging: boolean }> = []
    const native = window.fetch.bind(window)
    Object.assign(window, { loggingPolls: polls })
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (url.pathname === '/api/logging' && url.searchParams.has('after'))
        polls.push({ hidden: document.hidden, logging: !document.getElementById('view-logging')?.hidden })
      return native(input, init)
    }) as typeof window.fetch
  })
}
const loggingPolls = (page: Page): Promise<LoggingPoll[]> =>
  page.evaluate(() => (window as unknown as { loggingPolls: LoggingPoll[] }).loggingPolls)
test.describe.configure({ mode: 'serial' })
test.beforeAll(() => {
  const now = Date.now()
  for (let index = 0; index < 120; index++) {
    const input = callerDiagnostic({ id: callId(index), completed_at: index === 60 ? null : new Date(now - (index >= 110 ? 300_000 : (120 - index) * 20_000)).toISOString(),
      behavior: component, repo: 'acme/repo', pr_id: '42', actor: 'octocat', outcome: 'failed', error: 'fetch failed\nAuthorization: Bearer fixture-secret',
      diagnostic: { version: 1, severity: 'error', operation: 'git.fetch', phase: 'checkout', stderr: 'fatal: retained stderr\nAuthorization: Bearer fixture-secret',
        context: { exit_code: 128, timeout_seconds: 15, elapsed_ms: 23, provider_started: false } } }, 'local')!
    fixtures.push(normalize({ ...input, truncated: true, condition: 'fixture-fetch', cause: ['underlying retained cause', 'x'.repeat(512)], resources: { usedBytes: 42, measuredAt: new Date(now - 1000).toISOString(), measurement: 'statfs' } }, now, ['fixture-secret'])!)
  }
  for (const level of ['critical', 'warning']) fixtures.push(normalize({ id: `fixture-${level}-${run}`, component, source: 'poise', level, operation: 'fixture', workspace: 'local', message: level + ' representative evidence' }, now)!)
  const foreign = normalize({ id: `fixture-bob-${run}`, component, source: 'caller', level: 'error', operation: 'fetch', workspace: 'bob', message: 'never reveal bob-private-evidence' }, now)!
  const db = new DiagnosticStore(storePath, DEFAULT_LOG_POLICY)
  try { for (let i = 0; i < fixtures.length; i += 100) db.append(fixtures.slice(i, i + 100)); db.append([foreign]) }
  finally { db.close() }
})

test('real retained Caller evidence supports bounded native filters, expansion, full matching export and focus', async ({ page }) => {
  await page.addInitScript(() => {
    const tasks: number[] = []
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) tasks.push(entry.duration) }).observe({ type: 'longtask', buffered: true })
    Object.assign(window, { loggingLongTasks: tasks })
  })
  await ready(page)
  await expect(rows(page)).toHaveCount(50)
  await expect(status(page)).toContainText('122 matching retained events')
  await expect(page.locator('#view-logging')).not.toContainText('bob-private-evidence')
  const button = rows(page).filter({ hasText: 'fetch failed' }).first().getByRole('button', { name: 'Toggle diagnostic evidence' })
  await button.focus(); await page.keyboard.press('Enter')
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  const detail = page.locator('#logging-tbody > .agent-expand-row').first()
  await expect(detail.getByText('Evidence is truncated; omitted details are not retained.')).toHaveCSS('color', 'rgb(168, 121, 43)')
  await expect(detail).toContainText(fixtures[0].stderr!)
  await expect(detail).toContainText('underlying retained cause')
  await expect(detail).toContainText('Resource measurement time')
  await expect(detail).toContainText('statfs')
  await expect(detail.getByRole('link', { name: 'Open pull request' })).toHaveAttribute('href', 'https://github.com/acme/repo/pull/42')
  await action(page, 'refresh').click()
  await expect(page.locator('#logging-loader')).toBeHidden()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await button.focus();
  // Programmatic refresh keeps the row button focused.
  await page.evaluate(() => (document.querySelector('[data-action="refresh"]') as HTMLButtonElement).click())
  await expect(page.locator('#logging-loader')).toBeHidden()
  await expect(button).toBeFocused()
  await detail.getByRole('button', { name: 'Show incident', exact: true }).click()
  await expect(detail.locator('.logging-related-list li')).toHaveCount(20)
  await detail.getByRole('button', { name: 'Next 20', exact: true }).click()
  await expect(detail.locator('.logging-related-list li')).toHaveCount(20)
  await expect(detail.getByRole('button', { name: 'Previous', exact: true })).toBeEnabled()
  await detail.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(detail.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled()
  await openFilter(page, 'source')
  await page.locator('#logging-source').selectOption('caller')
  await expect(status(page)).toContainText('120 matching retained events')
  const downloadEvent = page.waitForEvent('download')
  await action(page, 'export').click()
  const download = await downloadEvent
  const lines = readFileSync((await download.path())!, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  expect(lines[0]).toMatchObject({ type: 'metadata', exported: 120, total: 120, truncated: false })
  expect(new Set(lines.slice(1).map((line) => line.event.id))).toEqual(new Set(fixtures.filter((event) => event.source === 'caller').map((event) => event.id)))
  expect(JSON.stringify(lines)).not.toContain('fixture-secret')
  await openFilter(page, 'severity')
  await page.locator('[data-level="error"]').click()
  await expect(status(page)).toContainText('0 matching retained events')
  await page.locator('[data-level="critical"]').click(); await page.locator('[data-level="warning"]').click()
  await expect(status(page)).toContainText('No severities selected')
  await expect(page.locator('#logging-empty')).toBeVisible()
  const metrics = await page.evaluate(() => ({ rows: document.querySelectorAll('#logging-table tr').length, tasks: (window as unknown as { loggingLongTasks: number[] }).loggingLongTasks, navigation: (window as unknown as { loggingNavigationMs: number }).loggingNavigationMs }))
  expect(metrics.navigation).toBeLessThan(1000)
  expect(metrics.rows).toBeLessThan(200)
  expect(Math.max(0, ...metrics.tasks)).toBeLessThan(350)
  await openFilter(page, 'severity')
  await page.locator('#view-logging [data-level="error"]').click()
  await expect(rows(page)).toHaveCount(50)
  await rows(page).first().getByRole('button', { name: 'Toggle diagnostic evidence' }).click()
  const run = page.getByRole('button', { name: 'Open Caller run in Swarm', exact: true })
  const call = await run.getAttribute('data-call')
  await run.click()
  await expect(await feedback(page)).toContainText('No run found for call ' + call)

})

test('applies every exact filter and redacted search across the retained dataset', async ({ page }) => {
  await ready(page)
  await page.locator('#logging-search').fill('never-present')
  await expect(status(page)).toContainText('0 matching retained events')
  await page.locator('#logging-search').fill('fetch failed')
  await expect(status(page)).toContainText('120 matching retained events')
  await exactFilter(page, 'account', 'octocat')
  await exactFilter(page, 'repository', 'acme/repo')
  await exactFilter(page, 'callId', fixtures[0].callId!)
  await expect(status(page)).toContainText('1 matching retained events')
  await exactFilter(page, 'callId', '')
  await exactFilter(page, 'correlationId', 'c'.repeat(32))
  await expect(status(page)).toContainText('0 matching retained events')
  await exactFilter(page, 'correlationId', '')
  await exactFilter(page, 'incidentId', fixtures[0].incidentId)
  await exactFilter(page, 'workspace', 'local')
  await expect(status(page)).toContainText('120 matching retained events')
  await page.locator('#logging-search').fill('fixture-secret')
  await expect(status(page)).toContainText('0 matching retained events')
  await exactFilter(page, 'workspace', 'bob')
  await expect(page.locator('#logging-message')).toContainText('belongs to someone else')
  await expect(rows(page)).toHaveCount(0)
  await expect(page.locator('#logging-empty')).toBeHidden()
})

test('uses Settings civil day/week boundaries across the spring DST transition', async ({ page }) => {
  await ready(page, undefined, 'Europe/Helsinki')
  await page.clock.setFixedTime(new Date('2026-03-29T12:00:00Z'))
  const query = async (preset: string) => {
    await openFilter(page, 'time')
    const response = page.waitForResponse((reply) => {
      const url = new URL(reply.url())
      return url.pathname === '/api/logging' && url.searchParams.has('from') && !url.searchParams.has('after')
    })
    await page.locator(`#view-logging [data-time="${preset}"]`).click()
    const url = new URL((await response).url())
    return [url.searchParams.get('from'), url.searchParams.get('to')]
  }
  expect(await query('today')).toEqual(['2026-03-28T22:00:00.000Z', '2026-03-29T21:00:00.000Z'])
  expect(await query('yesterday')).toEqual(['2026-03-27T22:00:00.000Z', '2026-03-28T22:00:00.000Z'])
  expect(await query('week')).toEqual(['2026-03-22T22:00:00.000Z', '2026-03-29T21:00:00.000Z'])
})

test('discards a delayed older filter response and stops polling in a hidden document', async ({ page }) => {
  await trackLoggingPolls(page)
  await ready(page)
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  let held!: () => void
  const holding = new Promise<void>((resolve) => { held = resolve })
  await page.route('**/api/logging?**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('search') !== 'fetch failed') return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    held(); await released; await route.fulfill({ json: body })
  })
  try {
    await page.locator('#logging-search').fill('fetch failed')
    await holding
    await page.locator('#logging-search').fill('critical representative')
    await expect(status(page)).toContainText('1 matching retained events')
    release()
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('critical representative')
    await page.clock.install()
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    const mark = (await loggingPolls(page)).length
    await page.clock.runFor(45_000)
    const held = await loggingPolls(page)
    expect(held.length).toBe(mark)
    expect(held.some((poll) => poll.hidden)).toBe(false)
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await expect.poll(async () => (await loggingPolls(page)).filter((poll) => !poll.hidden).length).toBeGreaterThan(mark)
  } finally { release() }
})

test('a paused Logging refresh stays neutral while failed reads and exports remain red', async ({ page }) => {
  await ready(page)
  let release!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  let held!: () => void
  const holding = new Promise<void>(resolve => { held = resolve })
  let fail = false
  await page.route('**/api/logging?**', async route => {
    if (new URL(route.request().url()).searchParams.has('after')) return route.continue()
    if (fail) return route.fulfill({ status: 503, json: { error: 'logging_unavailable', message: 'Fixture read unavailable' } })
    const response = await route.fetch()
    const body = await response.json()
    held(); await released; await route.fulfill({ json: body })
  })
  try {
    await action(page, 'refresh').click(); await holding
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
    release()
    const polled = page.waitForResponse(response => new URL(response.url()).pathname === '/api/logging' && new URL(response.url()).searchParams.has('after'))
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
    await polled
    const note = page.locator('#logging-message')
    await expect(note).toHaveText('The pending read was paused when this tab became hidden.')
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
      await expect(note).toHaveCSS('color', 'rgb(142, 149, 158)')
    }
    fail = true
    await action(page, 'refresh').click()
    await expect(note).toContainText('Fixture read unavailable')
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
      await expect(note).toHaveCSS('color', 'rgb(184, 80, 72)')
    }
    await page.route('**/api/logging/export**', route => route.fulfill({ status: 503, json: { error: 'logging_unavailable', message: 'Fixture export unavailable' } }))
    await action(page, 'export').click()
    await expect(note).toContainText('Export failed; no complete download was produced.')
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
      await expect(note).toHaveCSS('color', 'rgb(184, 80, 72)')
    }
  } finally { release() }
})

test('cold links reveal an event outside the first page, widen bounds, persist view and restore saved filters', async ({ page }) => {
  const target = fixtures[0]
  const path = '/?' + new URLSearchParams({ view: 'logging', event: target.id, from: new Date(Date.now() + 3_600_000).toISOString() })
  await ready(page, path)
  await expect(page.locator('#logging-linked-heading')).toBeFocused()
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('poise-logging-filters')!))
  await page.getByRole('button', { name: 'Choose diagnostic columns' }).click()
  await page.locator('#logging-columns').getByLabel('Account', { exact: true }).check()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Choose diagnostic columns' })).toBeFocused()
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('poise-logging-filters')!))
  expect(after).toMatchObject(saved)
  expect(after.columns).toContain('account')
  await expect(page.locator('#logging-link')).toContainText('widened visibly')
  await expect(page.locator('#logging-link')).toContainText('outside the current page')
  await expect(page.locator('#logging-link')).toContainText(target.callId!)
  expect(page.url()).toContain(target.id)
  await page.reload()
  await expect(page.locator('#logging-link')).toContainText('widened visibly')
  await page.getByRole('button', { name: 'Restore saved filters', exact: true }).click()
  await expect(status(page)).toContainText('122 matching retained events')
  await expect(page.locator('#logging-component')).toHaveValue(component)
  await page.reload()
  await expect(page.locator('#view-logging')).toBeVisible()
  await expect(page.locator('#view-logging .view-header')).toBeFocused()
})

test('late older ingestions stay behind an explicit control and pagination retains its snapshot', async ({ page }) => {
  await trackLoggingPolls(page)
  await ready(page)
  await page.clock.install()
  const initial = await rows(page).evaluateAll((items) => items.map((row) => (row as HTMLElement).dataset.id))
  const late = normalize({ id: `browser-late-${run}`, time: new Date(Date.now() - 86_400_000).toISOString(), source: 'poise', component, workspace: 'local', level: 'warning', operation: 'late', message: 'late older evidence' })!
  const db = new DiagnosticStore(storePath)
  try { db.append([late]); lateIds.push(late.id) } finally { db.close() }
  await action(page, 'next').click()
  await expect(page.locator('#logging-page')).toContainText('51–100 /')
  await page.clock.runFor(15_000)
  await expect(status(page)).toContainText('122 matching retained events')
  await expect(page.locator('#logging-new')).toBeHidden()
  await action(page, 'previous').click()
  expect(await rows(page).evaluateAll((items) => items.map((row) => (row as HTMLElement).dataset.id))).toEqual(initial)
  await page.clock.runFor(15_000)
  await expect(action(page, 'new')).toHaveText('1 new diagnostics')
  expect(await rows(page).evaluateAll((items) => items.map((row) => (row as HTMLElement).dataset.id))).toEqual(initial)
  await action(page, 'new').click()
  await expect(status(page)).toContainText('123 matching retained events')
  await page.getByRole('button', { name: 'Current', exact: true }).click()
  await expect(page.locator('#view-logging')).toBeHidden()
  const mark = (await loggingPolls(page)).length
  await page.clock.runFor(45_000)
  const polls = await loggingPolls(page)
  expect(polls.length).toBe(mark)
  expect(polls.some((poll) => !poll.logging)).toBe(false)
})

test('custom interval drafts survive refresh, use zoned civil bounds, and reject invalid ranges honestly', async ({ page }) => {
  await ready(page, undefined, 'Europe/Helsinki')
  await openFilter(page, 'time')
  await page.locator('#view-logging [data-time="custom"]').click()
  await page.locator('#logging-from').fill('2026-03-29T00:00:00+02:00')
  await page.locator('#logging-to').fill('2026-03-30T00:00:00+03:00')
  await action(page, 'refresh').click()
  await expect(page.locator('#logging-loader')).toBeHidden()
  await expect(page.locator('#logging-from')).toHaveValue('2026-03-29T00:00:00+02:00')
  await expect(page.locator('#logging-to')).toHaveValue('2026-03-30T00:00:00+03:00')
  const response = page.waitForResponse((reply) => reply.url().includes('/api/logging?') && reply.url().includes('2026-03-28'))
  await openFilter(page, 'time')
  await page.getByRole('button', { name: 'Apply interval' }).click()
  expect((await response).url()).toContain('to=2026-03-29T21%3A00%3A00.000Z')
  await expect(page.locator('#logging-empty')).toBeVisible()
  await page.locator('#logging-from').fill('2026-02-30T00:00:00Z')
  await openFilter(page, 'time')
  await page.getByRole('button', { name: 'Apply interval' }).click()
  await expect(page.locator('#logging-message')).toContainText('Invalid diagnostic filters')
  await expect(page.locator('#logging-empty')).toBeHidden()
})

test('failed refreshes are stale and lookup failures never become an ordinary empty table', async ({ page }) => {
  await ready(page)
  const saved = await rows(page).count()
  await page.route('**/api/logging?**', (route) => route.fulfill({ status: 503, json: { error: 'logging_unavailable', message: 'Fixture sink unavailable' } }))
  await action(page, 'refresh').click()
  await expect(status(page)).toContainText('Stale results')
  await expect(status(page)).toContainText('Snapshot read')
  await expect(rows(page)).toHaveCount(saved)
  await page.unroute('**/api/logging?**')
  for (const [code, text] of [[404, 'evidence is unavailable'], [410, 'evidence has expired'], [503, 'query service is unavailable']] as const) {
    await page.route('**/api/logging/events/**', (route) => route.fulfill({ status: code, json: { error: 'logging_unavailable', message: 'Fixture evidence state', bounds: { from: null, to: null, retentionAfter: '2026-09-19T00:00:00Z' } } }))
    await page.goto('/?view=logging&event=' + fixtures[0].id)
    await expect(page.locator('#logging-link')).toContainText(text)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
      await expect(page.locator('#logging-link .st-help')).toHaveCSS('color', code === 503 ? 'rgb(184, 80, 72)' : 'rgb(168, 121, 43)')
    }
    await expect(page.locator('#logging-empty')).toBeHidden()
    await page.getByRole('button', { name: 'Diagnostic data details' }).click()
    await expect(page.locator('#logging-health')).toContainText('Retention boundary')
    await page.keyboard.press('Escape')
    const retried = page.waitForResponse((reply) => new URL(reply.url()).pathname.startsWith('/api/logging/events/'))
    await action(page, 'refresh').click()
    await retried
    await expect(page.locator('#logging-link')).toContainText(text)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
      await expect(page.locator('#logging-link .st-help')).toHaveCSS('color', code === 503 ? 'rgb(184, 80, 72)' : 'rgb(168, 121, 43)')
    }
    await expect(page.locator('#logging-empty')).toBeHidden()
    await page.unroute('**/api/logging/events/**')
  }
  await page.goto('/?view=logging&event=invalid')
  await expect(page.locator('#logging-link')).toContainText('link is invalid')
  await action(page, 'refresh').click()
  await expect(page.locator('#logging-link')).toContainText('link is invalid')
  await expect(page.locator('#logging-empty')).toBeHidden()
})

for (const theme of ['light', 'dark']) test(`uses native table styles and bounded desktop/narrow layout in ${theme}`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await ready(page)
  await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
  const native = await rows(page).first().evaluate((row) => ({ font: getComputedStyle(row).fontFamily, size: getComputedStyle(row).fontSize, class: row.className }))
  expect(native.class).toBe('agent-row')
  expect(native.font.length).toBeGreaterThan(0)
  const tableStyle = (selector: string) => page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element)
    return { font: style.fontFamily, size: style.fontSize, padding: style.padding, border: style.borderBottom, color: style.color }
  })
  const loggingStyle = await tableStyle('#logging-table th')
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ json: { logs: [{
    id: fixtures[0].callId, repo: 'acme/repo', pr_id: '42', actor: 'octocat', model: 'fixture', behavior: 'pr-review',
    session_id: null, prompt: 'Fixture review', started_at: fixtures[0].ingestedAt, started_at_precise: fixtures[0].ingestedAt,
    completed_at: fixtures[0].ingestedAt, time_elapsed: '1ms', status: 'completed', outcome: 'failed', response: '', error: fixtures[0].message,
  }] } }))
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator('#swarm-table')).toBeVisible()
  expect(await tableStyle('#swarm-table th')).toEqual(loggingStyle)
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('#menu-popover [data-action="logging"]').click()
  await expect(rows(page)).toHaveCount(50)
  const scrollport = page.locator('.logging-table-wrap')
  await scrollport.evaluate((element) => { element.scrollTop = 300 })
  const headerTop = await page.locator('#logging-table thead th').first().boundingBox()
  const scrollBox = await scrollport.boundingBox()
  expect(Math.abs(headerTop!.y - scrollBox!.y)).toBeLessThan(2)
  await action(page, 'refresh').click()
  await expect(page.locator('#logging-loader')).toBeHidden()
  expect(await scrollport.evaluate((element) => element.scrollTop)).toBeCloseTo(300, 0)
  await scrollport.evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: info.outputPath(`${theme}-logging-table.png`), fullPage: true })
  await openFilter(page, 'source')
  await page.screenshot({ path: info.outputPath(`${theme}-logging-filter.png`), fullPage: false })
  await expect(page.locator('#logging-filter-source')).toBeVisible()
  await page.keyboard.press('Escape')
  await rows(page).first().getByRole('button', { name: 'Toggle diagnostic evidence' }).click()
  await page.screenshot({ path: info.outputPath(`${theme}-logging-desktop.png`), fullPage: true })
  await page.setViewportSize({ width: 420, height: 820 })
  await page.screenshot({ path: info.outputPath(`${theme}-logging-narrow.png`), fullPage: true })
  await openFilter(page, 'component')
  const popup = await page.locator('#logging-filter-component').boundingBox()
  expect(popup!.x).toBeGreaterThanOrEqual(0)
  expect(popup!.x + popup!.width).toBeLessThanOrEqual(420)
  await page.screenshot({ path: info.outputPath(`${theme}-logging-narrow-filter.png`), fullPage: false })
  await page.keyboard.press('Escape')
  const sizes = await page.evaluate(() => ({ width: innerWidth, body: document.documentElement.scrollWidth, rows: document.querySelectorAll('#logging-table tr').length }))
  const fact = await page.locator('#logging-tbody .logging-facts dt').first().boundingBox()
  expect(fact!.x).toBeGreaterThanOrEqual(0)
  expect(fact!.x + fact!.width).toBeLessThanOrEqual(420)
  expect(sizes.body).toBeLessThanOrEqual(sizes.width + 1)
  expect(sizes.rows).toBeLessThan(200)
  expect(await rows(page).first().evaluate((row) => getComputedStyle(row).fontFamily)).toBe(native.font)
  expect(lateIds.length).toBe(1)
})

test('never presents cached connected health as current after query transport failure', async ({ page }, info) => {
  await ready(page)
  const data = page.getByRole('button', { name: 'Diagnostic data details' })
  const fact = (name: string) => page.locator('#logging-health dt').filter({ hasText: name }).locator('xpath=following-sibling::dd[1]')
  await data.click()
  await expect(fact('Query service')).toHaveText('Connected')
  await page.keyboard.press('Escape')
  await page.route('**/api/logging**', (route) => route.fulfill({ status: 503, json: { error: 'logging_unavailable', message: 'Actual read transport unavailable' } }))
  await action(page, 'refresh').click()
  await expect(status(page)).toContainText('Stale results')
  await expect(rows(page)).toHaveCount(50)
  await data.click()
  await expect(fact('Query service')).toHaveText('Unavailable')
  await expect(fact('Collection now')).toHaveText('Stale')
  await expect(data).toHaveAttribute('title', 'Data and collection · Query unavailable')
  await page.screenshot({ path: info.outputPath('logging-query-unavailable.png'), fullPage: false })
  await page.keyboard.press('Escape')
  await page.unroute('**/api/logging**')
  await page.route('**/api/logging?**', (route) => route.fulfill({ status: 503, json: { error: 'logging_unavailable', message: 'List read still unavailable' } }))
  const health = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/logging/health')
  await action(page, 'refresh').click(); await health
  await data.click()
  await expect(fact('Collection now')).not.toHaveText('Stale')
  await expect(fact('Query service')).toHaveText('Unavailable')
  await page.keyboard.press('Escape')
  await page.unroute('**/api/logging?**')
  await action(page, 'refresh').click()
  await expect(status(page)).not.toContainText('Stale results')
  await data.click()
  await expect(fact('Query service')).toHaveText('Connected')
  await expect(data).not.toHaveAttribute('title', 'Data and collection · Query unavailable')
})

test('keeps filters in visible headers, preserves keyboard focus and restores visible filtered identities', async ({ page }) => {
  await ready(page)
  await expect(page.locator('#logging-status')).toHaveCSS('clip-path', 'inset(50%)')
  await expect(page.locator('#logging-heading')).toHaveCSS('clip-path', 'inset(50%)')
  await expect(page.locator('.logging-more')).toHaveCount(0)
  await expect(page.locator('#logging-health')).toBeEmpty()
  await expect(page.locator('#logging-count')).toHaveText(/^[\d,]+$/)
  await expect(page.locator('#logging-column-account')).toHaveCount(0)
  await exactFilter(page, 'account', 'octocat')
  await expect(status(page)).toContainText('120 matching retained events')
  await expect(page.locator('#logging-column-account')).toHaveText('Account')
  await expect(rows(page).first().locator('.logging-cell-account')).toHaveText('octocat')
  await page.keyboard.press('Escape')
  const trigger = page.locator('#logging-filter-button-account')
  await trigger.focus(); await page.keyboard.press('Enter')
  await expect(page.locator('#logging-account')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await page.getByRole('button', { name: 'Choose diagnostic columns' }).click()
  await expect(page.locator('#logging-columns').getByLabel('Account', { exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(status(page)).toContainText('120 matching retained events')
  await expect(page.locator('#logging-column-account')).toBeVisible()
  await openFilter(page, 'account')
  await page.locator('#logging-filter-account [data-action="clear-filter"]').click()
  await expect(status(page)).toContainText(/12[23] matching retained events/)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Choose diagnostic columns' }).click()
  await page.locator('#logging-columns').getByLabel('Account', { exact: true }).uncheck()
  await expect(page.locator('#logging-column-account')).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('poise-logging-filters')!).account)).toBe('')
})

test('shows recovered history only on inspection and identifies actual current collection failure', async ({ page }, info) => {
  await ready(page)
  const at = new Date().toISOString()
  const sources = [{ id: 'application', source: 'poise', workspace: 'local', status: 'partial', currentStatus: 'connected', observedAt: at, ingestedAt: at, availableFrom: at, error: null as string | null,
    gaps: [{ from: '2026-10-18T10:00:00Z', to: '2026-10-18T10:00:10Z', reason: 'Recovered restart interval' }] }]
  let current = 'connected'
  await page.route('**/api/logging/health?**', (route) => route.fulfill({ json: { version: 1, status: 'partial', collection: { status: 'partial', currentStatus: current, checkedAt: at, lossObserved: false, sources }, query: { status: 'connected' }, policy: DEFAULT_LOG_POLICY,
    bounds: { from: at, to: at, retentionAfter: '2026-09-19T00:00:00Z' } } }))
  await action(page, 'refresh').click()
  await expect(page.locator('#logging-data-button')).toHaveAttribute('title', 'Data and collection · Connected')
  await expect(page.locator('#logging-data-button')).not.toHaveClass(/has-issue/)
  await expect(page.locator('#logging-health')).toBeEmpty()
  await page.getByRole('button', { name: 'Diagnostic data details' }).click()
  await expect(page.locator('#logging-data')).toContainText('Collection now')
  await expect(page.locator('#logging-data')).toContainText('Connected')
  await expect(page.locator('#logging-data')).toContainText('1 gaps')
  await page.screenshot({ path: info.outputPath('logging-data-inspection.png'), fullPage: false })
  await page.locator('#logging-data summary').click()
  await expect(page.locator('#logging-data')).toContainText('Recovered restart interval')
  await page.keyboard.press('Escape')
  current = 'partial'; sources[0].currentStatus = 'unavailable'; sources[0].error = 'Fixture transport disconnected'
  await action(page, 'refresh').click()
  await expect(page.locator('#logging-data-button')).toHaveClass(/has-issue/)
  await page.getByRole('button', { name: 'Diagnostic data details' }).click()
  await expect(page.locator('#logging-data')).toContainText('Fixture transport disconnected')
  await expect(page.locator('#logging-data')).toContainText('Unavailable')
})


test('auxiliary Logging failures warn while primary evidence remains usable', async ({ page }) => {
  await ready(page)
  const saved = await rows(page).count()
  await page.route('**/api/logging?**', route => {
    const params = new URL(route.request().url()).searchParams
    return params.has('incidentId') ? route.fulfill({ status: 503, json: { error: 'logging_unavailable', message: 'Fixture related read unavailable' } }) : route.continue()
  })
  const button = rows(page).filter({ hasText: 'fetch failed' }).first().getByRole('button', { name: 'Toggle diagnostic evidence' })
  await button.click()
  const detail = page.locator('#logging-tbody > .agent-expand-row').first()
  await detail.getByRole('button', { name: 'Show incident', exact: true }).click()
  const related = detail.getByRole('status')
  await expect(related).toContainText('Fixture related read unavailable')
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await expect.soft(related).toHaveCSS('color', 'rgb(168, 121, 43)')
  }
  await page.route('**/api/logging/health?**', route => route.fulfill({ status: 503, json: { error: 'logging_unavailable', message: 'Fixture health unavailable' } }))
  const health = page.waitForResponse(response => new URL(response.url()).pathname === '/api/logging/health')
  await action(page, 'refresh').click(); await health
  await expect(rows(page)).toHaveCount(saved)
  await expect(page.locator('#logging-loader')).toBeHidden()
  await page.getByRole('button', { name: 'Diagnostic data details' }).click()
  const note = page.locator('#logging-health .st-help').filter({ hasText: 'Fixture health unavailable' })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => document.documentElement.dataset.theme = value, theme)
    await expect.soft(note).toHaveCSS('color', 'rgb(168, 121, 43)')
  }
})
