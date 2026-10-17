import { expect, test, type Page } from '@playwright/test'
import type { BehaviorDiagnostics } from '../../src/behaviors'
import type { Notice } from '../../src/notices'
import { freeze, resume, settled } from './fixtures/motion'

// The notification rail (src/views/notification-rail.ts): the bell and its
// count, the rail docked beside the page or floating over it, entries that
// expand in place, putting one away, opening what one is about, silencing a
// ready pull request, arrivals while it is closed, a failed behavior joined to
// its diagnostic, Behaviors' counts, and the Notifications setting. Poise's API
// is stood in for.

const T0 = Date.parse('2026-10-09T10:00:00.000Z')
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
const HELD_CALL = 'c'.repeat(32)

const WAITING: Notice = { id: 'aaaaaaaaaaaa-3', kind: 'chat_waiting', title: 'Claude Code is waiting for you', body: 'In “Refactor the relay”: allow or deny Bash(npm test).', since: iso(4), due: iso(4), silenceable: false, target: { chat: '7d6c1b1e-2a4f-4c55-9a51-0e1f2b3c4d5e' } }
const HELD: Notice = { id: 'aaaaaaaaaaaa-2', kind: 'behavior_held', title: 'Review New Pull Requests failed on acme/api#9', body: 'Open Swarm in Poise to see what happened.', since: iso(2), due: iso(2), silenceable: false, target: { swarm: HELD_CALL }, subject: { behavior: 'review-new-prs', target: 'acme/api#9' } }
const READY: Notice = { id: 'aaaaaaaaaaaa-1', kind: 'pr_ready', title: 'acme/api#7 is ready to merge', body: 'Fix the flaky retry test', since: iso(0), due: iso(30), silenceable: true, target: { pullRequest: 'https://github.com/acme/api/pull/7' } }

function failedRun(id = HELD_CALL, fields: Record<string, unknown> = {}) {
  return {
    id, repo: 'acme/api', pr_id: '9', actor: 'octo-agent', model: 'astra', behavior: 'pr_review',
    session_id: null, prompt: '', started_at: iso(0), started_at_precise: iso(0), completed_at: iso(2),
    time_elapsed: '2m', status: 'failed', outcome: 'preflight_failed', response: '',
    error: 'The provider rejected this review.', error_code: null, progress: null, ...fields,
  }
}

function diagnostics(overrides: Partial<BehaviorDiagnostics> = {}): BehaviorDiagnostics {
  return {
    status: 'ok', agentLogsError: null,
    datastore: { status: 'healthy', checkedAt: '', ageSeconds: 1, lastSuccessAt: '', error: null },
    identity: { status: 'valid', actor: 'octo-agent', error: null }, failures: [], deadLetters: [], ...overrides,
  }
}

interface Workspace {
  enabled: boolean
  notices: Notice[]
  diagnostics: BehaviorDiagnostics | null
  /** The notice actions and settings the page sent, in order. */
  sent: string[]
}

async function workspace(page: Page, notices: Notice[], options: { enabled?: boolean, accounts?: string[], diagnostics?: BehaviorDiagnostics } = {}): Promise<Workspace> {
  const accounts = options.accounts ?? ['acme']
  const state: Workspace = { enabled: options.enabled ?? true, notices: [...notices], diagnostics: options.diagnostics ?? null, sent: [] }
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'current') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await page.context().route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>GitHub</p>' }))
  const answer = () => ({ enabled: state.enabled, notices: state.enabled ? state.notices : [] })
  const settings = () => ({ org: 'acme', me: 'octocat', agentAccount: 'octo-agent', timezone: 'UTC', models: {}, notifications: { enabled: state.enabled }, organizations: accounts.map((login) => ({ login, managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null })) })
  const behavior = (extra: Record<string, unknown> = {}) => ({ owner: 'octo-agent', enabled: true, setting: null, reviewers: null, scratchpad: '', lastTriggered: null, ...extra })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    if (pathname === '/api/notices') return route.fulfill({ json: answer() })
    const action = /^\/api\/notices\/([^/]+)\/(dismiss|silence)$/.exec(pathname)
    if (action && request.method() === 'POST') {
      const id = decodeURIComponent(action[1])
      state.sent.push(`${action[2]} ${id}`)
      state.notices = state.notices.filter((notice) => notice.id !== id)
      return route.fulfill({ json: answer() })
    }
    if (pathname === '/api/settings') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as { notifications?: { enabled: boolean } }
        if (body.notifications) {
          state.enabled = body.notifications.enabled
          state.sent.push(`notifications ${state.enabled ? 'on' : 'off'}`)
        }
      }
      return route.fulfill({ json: settings() })
    }
    if (pathname === '/api/behaviors' && request.method() === 'GET') return route.fulfill({ json: {
      'review-new-prs': behavior({ setting: 'p2', reviewers: 1 }), 'approve-prs': behavior(), 'resolve-unblocking': behavior({ scratchpad: null }),
      diagnostics: state.diagnostics,
    } })
    if (pathname === '/api/workspace') return route.fulfill({ json: { mode: 'local' } })
    if (pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    if (pathname === '/api/agent-logs') return route.fulfill({ json: { logs: [failedRun()] } })
    return route.fulfill({ json: {} })
  })
  return state
}

const bell = (page: Page) => page.locator('#notification-bell')
const rail = (page: Page) => page.getByRole('complementary', { name: 'Notifications' })
const card = (page: Page, id: string) => page.locator(`#notification-rail .nr-card[data-id="${id}"]`)
const reread = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')))

async function openRail(page: Page) {
  await bell(page).click()
  await expect(rail(page)).toBeVisible()
}

async function expand(page: Page, id: string) {
  await card(page, id).locator('.nr-card-head').click()
  await expect(card(page, id).locator('.nr-card-head')).toHaveAttribute('aria-expanded', 'true')
}

test('counts what needs the person on the bell and lists it by who acts', async ({ page }) => {
  await workspace(page, [WAITING, HELD, READY])
  await page.goto('/')
  await expect(bell(page)).toHaveAccessibleName('Notifications, 3 open')
  await expect(bell(page).locator('.nr-badge')).toHaveText('3')
  await expect(bell(page).locator('.nr-badge')).toHaveAttribute('data-tone', 'amber')
  await expect(rail(page)).toBeHidden()

  await openRail(page)
  await expect(rail(page).locator('.nr-title')).toBeFocused()
  const needs = rail(page).getByRole('region', { name: 'Needs you' })
  await expect(needs.locator('.nr-card')).toHaveCount(2)
  await expect(needs.locator('.nr-card-title')).toHaveText([WAITING.title, HELD.title])
  await expect(rail(page).getByRole('region', { name: 'Ready' }).locator('.nr-card-title')).toHaveText([READY.title])
  // A reminder says how long the pull request has waited.
  await expect(card(page, READY.id).locator('.nr-card-meta')).toContainText(/for \d/)

  await rail(page).getByRole('button', { name: /^Ready/ }).click()
  await expect(rail(page).locator('.nr-card')).toHaveCount(1)
  // Every filter survives the list being drawn again.
  await expect(rail(page).locator('.nr-picker button')).toHaveText(['All3', 'Needs you2', 'Faults0', 'Ready1', 'Automatic0'])
  await expect(rail(page).getByRole('button', { name: 'Ready, 1' })).toHaveAttribute('aria-pressed', 'true')
  await rail(page).getByRole('button', { name: /^All/ }).click()
  await expect(rail(page).locator('.nr-card')).toHaveCount(3)
})

test('docks beside the page on a wide window, covering nothing in any view', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await workspace(page, [WAITING])
  await page.goto('/')
  await openRail(page)
  await expand(page, WAITING.id)
  await settled(page)
  await expect(page.locator('body')).toHaveClass(/notifications-docked/)
  await page.screenshot({ path: test.info().outputPath('notification-rail-docked.png') })
  const box = (await rail(page).boundingBox())!
  // Flush with the window's right edge, as the full-width control bar is.
  const bar = (await page.locator('.view:not([hidden]) .view-header').boundingBox())!
  expect(Math.abs(box.x + box.width - (bar.x + bar.width))).toBeLessThan(1)
  for (const [view, selector] of [['Current', '.kanban'], ['Swarm', '#view-swarm main'], ['Chat', '.chat-layout'], ['Archive', '#view-main main'], ['Behaviors', '#view-behaviors main'], ['Snippets', '#view-snippets'], ['Editor', '#view-editor']] as const) {
    await page.locator('#top-nav').getByRole('button', { name: view, exact: true }).click()
    const content = page.locator(selector).first()
    await expect(content).toBeVisible()
    const bounds = (await content.boundingBox())!
    expect(bounds.x + bounds.width, `${view} reaches under the rail`).toBeLessThanOrEqual(box.x + 1)
    const header = (await page.locator('.view:not([hidden]) .view-header').boundingBox())!
    expect(box.y, `${view}: the rail starts below the control bar`).toBeGreaterThanOrEqual(header.y + header.height - 1)
    await expect(rail(page)).toBeVisible()
  }
  // Floating, by choice, it covers the page instead of moving it.
  await rail(page).getByRole('button', { name: 'Keep beside the page on a wide window' }).click()
  await expect(page.locator('body')).not.toHaveClass(/notifications-docked/)
  await expect(rail(page)).toBeVisible()
})

test('floats over a narrower window, closes on a click outside or Escape, and never overflows', async ({ page }) => {
  await workspace(page, [WAITING, READY])
  await page.goto('/')
  await openRail(page)
  await expect(page.locator('body')).not.toHaveClass(/notifications-docked/)
  await page.mouse.click(200, 400)
  await expect(rail(page)).toBeHidden()

  await openRail(page)
  await rail(page).locator('.nr-title').press('Escape')
  await expect(rail(page)).toBeHidden()
  await expect(bell(page)).toBeFocused()

  await page.setViewportSize({ width: 390, height: 844 })
  await openRail(page)
  await expand(page, WAITING.id)
  const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - document.documentElement.clientWidth, rail: (() => { const el = document.querySelector<HTMLElement>('#notification-rail .nr-body')!; return el.scrollWidth - el.clientWidth })() }))
  expect(overflow.page).toBeLessThanOrEqual(0)
  expect(overflow.rail).toBeLessThanOrEqual(0)
  await page.screenshot({ path: test.info().outputPath('notification-rail-narrow.png') })
})

test('expands an entry in place and keeps it open across reads, then puts a notice away', async ({ page }) => {
  const state = await workspace(page, [WAITING, READY])
  await page.goto('/')
  await openRail(page)
  await expand(page, WAITING.id)
  await expect(card(page, WAITING.id).getByRole('button', { name: 'Open the session' })).toBeVisible()
  await reread(page)
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('#notification-rail .nr-card').length)).toBe(2)
  await expect(card(page, WAITING.id).locator('.nr-card-head')).toHaveAttribute('aria-expanded', 'true')

  await card(page, WAITING.id).getByRole('button', { name: 'Dismiss' }).click()
  await expect(card(page, WAITING.id)).toHaveCount(0)
  expect(state.sent).toEqual([`dismiss ${WAITING.id}`])
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 open')
  await expect(bell(page).locator('.nr-badge')).toHaveAttribute('data-tone', 'green')
})

test('opens the exact failed run on the first click while logs load, then opens a ready PR externally', async ({ page }) => {
  const state = await workspace(page, [HELD, READY])
  let release!: () => void
  const loaded = new Promise<void>((resolve) => { release = resolve })
  let requested = false
  await page.route(/\/api\/agent-logs(?:\?.*)?$/, async (route) => {
    requested = true
    await loaded
    await route.fulfill({ json: { logs: [
      failedRun('b'.repeat(32), { behavior: 'pr_approve', started_at: iso(3), started_at_precise: iso(3) }),
      failedRun(),
    ] } })
  })
  await page.goto('/')
  await openRail(page)
  await expand(page, HELD.id)
  await card(page, HELD.id).getByRole('button', { name: 'Open the run in Swarm' }).click()
  try {
    await expect(page.locator('#view-swarm')).toBeVisible()
    // Floating, the rail steps aside for where the person is going.
    await expect(rail(page)).toBeHidden()
    await expect.poll(() => requested).toBe(true)
    await expect(page.locator('.agent-row')).toHaveCount(0)
  } finally { release() }
  const focused = page.locator(`.agent-row[data-id="${HELD_CALL}"]`)
  await expect(focused).toHaveClass(/agent-row-focus/)
  await expect(focused.getByRole('button', { name: 'Toggle detail' })).toBeFocused()
  await expect(page.locator(`.agent-expand-row[data-expand-for="${HELD_CALL}"]`)).toContainText('The provider rejected this review.')
  await expect(page.locator('.agent-row[data-id="' + 'b'.repeat(32) + '"]')).not.toHaveClass(/agent-row-focus/)
  await expect.poll(() => state.sent).toEqual([`dismiss ${HELD.id}`])

  // A ready pull request opens on GitHub, in a tab of its own.
  await openRail(page)
  await expand(page, READY.id)
  const opened = page.context().waitForEvent('page')
  await card(page, READY.id).getByRole('button', { name: 'Open on GitHub' }).click()
  await expect.poll(async () => (await opened).url()).toBe('https://github.com/acme/api/pull/7')
  await expect.poll(() => state.sent).toEqual([`dismiss ${HELD.id}`, `dismiss ${READY.id}`])
  await expect(bell(page)).toHaveAccessibleName('Notifications')
})

test('focuses an older grouped failure while already in Swarm, clears filters, and supports repeated keyboard navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const state = await workspace(page, [HELD], { accounts: ['acme', 'beta'] })
  const newest = 'd'.repeat(32)
  const filler = Array.from({ length: 36 }, (_, index) => failedRun(index.toString(16).padStart(32, '0'), { pr_id: String(index + 20) }))
  const logs = [...filler, failedRun(newest, { started_at: iso(3), started_at_precise: iso(3) }), failedRun()]
  await page.route(/\/api\/agent-logs(?:\?.*)?$/, (route) => route.fulfill({ json: {
    logs: new URL(route.request().url()).searchParams.get('org') === 'beta'
      ? [failedRun('e'.repeat(32), { repo: 'beta/other' })] : logs,
  } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  const focused = page.locator(`.agent-row[data-id="${HELD_CALL}"]`)
  await expect(focused).toHaveCount(0)
  await expect(page.locator(`.agent-row[data-id="${newest}"]`).getByRole('button', { name: 'Show 1 identical earlier run (2 total)' })).toBeVisible()
  await page.locator('#swarm-search').fill('does-not-match-any-run')
  await expect(page.locator('#swarm-empty')).toHaveText('No runs match this filter.')
  const accountLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/agent-logs'
    && new URL(response.url()).searchParams.get('org') === 'beta')
  await page.locator('#swarm-filters').getByRole('combobox', { name: 'Account filter' }).selectOption('beta')
  await accountLoaded
  // Docked, the rail stays beside Swarm while the run is found.
  await openRail(page)
  await expand(page, HELD.id)
  const open = card(page, HELD.id).getByRole('button', { name: 'Open the run in Swarm' })
  await open.focus()
  await open.press('Enter')
  await expect(focused).toHaveClass(/agent-row-focus/)
  await expect(focused.getByRole('button', { name: 'Toggle detail' })).toBeFocused()
  await expect(page.locator('#swarm-search')).toHaveValue('')
  await expect(page.locator('#swarm-filters').getByRole('combobox', { name: 'Account filter' })).toHaveValue('')
  await expect(page.locator(`.agent-row[data-id="${newest}"]`)).not.toHaveClass(/agent-row-focus/)
  await expect(page.locator(`.agent-expand-row[data-expand-for="${HELD_CALL}"]`)).toContainText('The provider rejected this review.')
  await expect(focused).toBeInViewport()
  await expect(rail(page)).toBeVisible()
  await expect.poll(() => state.sent).toEqual([`dismiss ${HELD.id}`])

  const again: Notice = { ...HELD, id: 'aaaaaaaaaaaa-4' }
  state.notices = [again]
  await reread(page)
  await expect(card(page, again.id)).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 0))
  await expand(page, again.id)
  const second = card(page, again.id).getByRole('button', { name: 'Open the run in Swarm' })
  await second.focus()
  await second.press('Space')
  await expect(focused).toHaveClass(/agent-row-focus/)
  await expect(focused.getByRole('button', { name: 'Toggle detail' })).toBeFocused()
  await expect(focused).toBeInViewport()
  await expect.poll(() => state.sent).toEqual([`dismiss ${HELD.id}`, `dismiss ${again.id}`])
})

test('reports a missing notification run instead of opening another run on the same target', async ({ page }) => {
  const absent = 'f'.repeat(32)
  await workspace(page, [{ ...HELD, target: { swarm: absent } }])
  await page.goto('/')
  await openRail(page)
  await expand(page, HELD.id)
  await card(page, HELD.id).getByRole('button', { name: 'Open the run in Swarm' }).click()
  await expect(page.locator('#view-swarm')).toBeVisible()
  await expect(page.locator('#swarm-stale')).toHaveText(`No run found for call ${absent}.`)
  await expect(page.locator('.agent-row-focus')).toHaveCount(0)
})

test('keeps the last opened notice in control when two navigations share a pending account request', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const insideCall = 'e'.repeat(32)
  const inside: Notice = { ...HELD, id: 'aaaaaaaaaaaa-4', title: 'Review New Pull Requests failed on beta/other#10', target: { swarm: insideCall }, subject: { behavior: 'review-new-prs', target: 'beta/other#10' } }
  const state = await workspace(page, [HELD, inside], { accounts: ['acme', 'beta'] })
  const insideRun = failedRun(insideCall, { repo: 'beta/other', pr_id: '10' })
  let holdSelected = false
  let heldRequests = 0
  let allRequests = 0
  let release!: () => void
  const loaded = new Promise<void>((resolve) => { release = resolve })
  await page.route(/\/api\/agent-logs(?:\?.*)?$/, async (route) => {
    const selected = new URL(route.request().url()).searchParams.get('org') === 'beta'
    if (!selected) allRequests += 1
    if (selected && holdSelected) {
      heldRequests += 1
      await loaded
    }
    await route.fulfill({ json: { logs: selected ? [insideRun] : [failedRun(), insideRun] } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await expect(page.locator(`.agent-row[data-id="${HELD_CALL}"]`)).toBeVisible()
  const accountLoaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/agent-logs'
    && new URL(response.url()).searchParams.get('org') === 'beta')
  const account = page.locator('#swarm-filters').getByRole('combobox', { name: 'Account filter' })
  await account.selectOption('beta')
  await accountLoaded
  await expect(page.locator(`.agent-row[data-id="${insideCall}"]`)).toBeVisible()
  await openRail(page)
  await expand(page, HELD.id)
  await expand(page, inside.id)
  const unfilteredBefore = allRequests
  holdSelected = true
  try {
    await card(page, HELD.id).getByRole('button', { name: 'Open the run in Swarm' }).click()
    await expect.poll(() => heldRequests).toBe(1)
    // Let each click's deferred navigation join the held request before it answers.
    await page.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))
    await card(page, inside.id).getByRole('button', { name: 'Open the run in Swarm' }).click()
    await page.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))
    await expect.poll(() => state.sent).toEqual([`dismiss ${HELD.id}`, `dismiss ${inside.id}`])
  } finally { release() }
  const focused = page.locator(`.agent-row[data-id="${insideCall}"]`)
  await expect(focused).toHaveClass(/agent-row-focus/)
  await expect(focused.getByRole('button', { name: 'Toggle detail' })).toBeFocused()
  await expect(account).toHaveValue('beta')
  await expect(page.locator('#swarm-stale')).toBeHidden()
  await expect(page.locator(`.agent-row[data-id="${HELD_CALL}"]`)).toHaveCount(0)
  expect(allRequests).toBe(unfilteredBefore)
  expect(heldRequests).toBe(1)
})

test('silences a pull request ready to merge, and offers that for nothing else', async ({ page }) => {
  const state = await workspace(page, [READY, WAITING])
  await page.goto('/')
  await openRail(page)
  await expand(page, READY.id)
  await expand(page, WAITING.id)
  await expect(card(page, WAITING.id).getByRole('button', { name: 'Silence reminders' })).toHaveCount(0)
  await card(page, READY.id).getByRole('button', { name: 'Silence reminders' }).click()
  await expect(card(page, READY.id)).toHaveCount(0)
  expect(state.sent).toEqual([`silence ${READY.id}`])
})

test('shows a notice that arrives while the rail is closed as a card that tucks into the bell', async ({ page }) => {
  const state = await workspace(page, [READY])
  await page.goto('/')
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 open')
  // What stood before the page is counted, not announced.
  await expect(page.locator('.nr-toast')).toHaveCount(0)
  await page.locator('#top-nav').getByRole('button', { name: 'Archive', exact: true }).focus()
  state.notices = [WAITING, READY]
  await reread(page)
  const toast = page.locator('.nr-toast')
  await expect(toast).toHaveCount(1)
  await expect(toast.locator('.nr-toast-title')).toHaveText(WAITING.title)
  await expect(page.locator('.nr-live')).toHaveText(`Notification: ${WAITING.title}. ${WAITING.body}`)
  // It never takes focus.
  await expect(page.locator('#top-nav').getByRole('button', { name: 'Archive', exact: true })).toBeFocused()
  await expect(bell(page)).toHaveAccessibleName('Notifications, 2 open')
  // Untouched, it tucks into the bell.
  await expect(toast).toHaveCount(0, { timeout: 9000 })

  // Show opens the rail on it, expanded.
  state.notices = [{ ...READY, due: iso(45) }, WAITING]
  await reread(page)
  await expect(toast).toHaveCount(1)
  await expect(toast.locator('.nr-toast-title')).toHaveText(READY.title)
  await toast.getByRole('button', { name: 'Show' }).click()
  await expect(rail(page)).toBeVisible()
  await expect(card(page, READY.id).locator('.nr-card-head')).toHaveAttribute('aria-expanded', 'true')
  await expect(toast).toHaveCount(0)
})

test('keeps at most three arrival cards, tucking each extra one away once', async ({ page }) => {
  const state = await workspace(page, [])
  await page.goto('/')
  await expect(bell(page)).toHaveAccessibleName('Notifications')
  const arrival = (n: number): Notice => ({ ...WAITING, id: `arrival-${n}`, title: `Arrival ${n}`, since: iso(10 + n), due: iso(10 + n) })
  const staying = page.locator('.nr-toast:not([data-leaving="true"]) .nr-toast-title')
  const going = page.locator('.nr-toast[data-leaving="true"] .nr-toast-title')
  // Held mid-flight, a card tucking into the bell is not tucked again.
  await freeze(page)
  state.notices = [1, 2, 3, 4].map(arrival)
  await reread(page)
  await expect(staying).toHaveText(['Arrival 4', 'Arrival 3', 'Arrival 2'])
  await expect(going).toHaveText(['Arrival 1'])
  state.notices = [1, 2, 3, 4, 5].map(arrival)
  await reread(page)
  await expect(staying).toHaveText(['Arrival 5', 'Arrival 4', 'Arrival 3'])
  await expect(going).toHaveText(['Arrival 2', 'Arrival 1'])
  await resume(page)
  await settled(page)
  await expect(page.locator('.nr-toast .nr-toast-title')).toHaveText(['Arrival 5', 'Arrival 4', 'Arrival 3'])
  await expect(bell(page)).toHaveAccessibleName('Notifications, 5 open')
})

test('never tucks away an arrival card the person is using', async ({ page }) => {
  const state = await workspace(page, [])
  await page.goto('/')
  await expect(bell(page)).toHaveAccessibleName('Notifications')
  const arrival = (n: number): Notice => ({ ...WAITING, id: `arrival-${n}`, title: `Arrival ${n}`, since: iso(10 + n), due: iso(10 + n) })
  state.notices = [arrival(1)]
  await reread(page)
  const first = page.locator('.nr-toast').filter({ hasText: 'Arrival 1' })
  await first.getByRole('button', { name: 'Show' }).focus()
  state.notices = [1, 2, 3, 4].map(arrival)
  await reread(page)
  await expect(page.locator('.nr-toast')).toHaveCount(4)
  await expect(first).not.toHaveAttribute('data-leaving', 'true')
  await expect(first.getByRole('button', { name: 'Show' })).toBeFocused()
})

test('shows a failed behavior and its diagnostic as one entry, and counts it on its Behaviors row', async ({ page }) => {
  await workspace(page, [HELD], { diagnostics: diagnostics({ deadLetters: [
    { id: 'letter', behavior: 'review-new-prs', target: 'acme/api#9', error: 'The reviewer stopped before posting.', createdAt: iso(2), attemptCount: 3, callId: HELD_CALL },
    { id: 'other', behavior: 'approve-prs', target: 'acme/web#3', error: 'Approval worker returned no verdict.', createdAt: iso(3), attemptCount: 1, diagnostic: { severity: 'error', code: 'invalid_agent_result' } },
  ] }) })
  await page.goto('/')
  // Until Behaviors' diagnostics are read, the bell counts the notice alone;
  // opening the rail reads them.
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 open')
  await openRail(page)
  await expect(bell(page)).toHaveAccessibleName('Notifications, 2 open')
  await expect(bell(page).locator('.nr-badge')).toHaveAttribute('data-tone', 'red')
  await expect(rail(page).locator('.nr-card')).toHaveCount(2)
  const held = card(page, HELD.id)
  await expect(held.locator('.nr-card-body')).toHaveText('The review outcome needs verification before retry.')
  await expand(page, HELD.id)
  await expect(held.locator('.nr-history')).toContainText('review-new-prs acme/api#9: The reviewer stopped before posting. (3 attempts)')
  await expect(held.getByRole('button', { name: 'Open the run in Swarm' })).toBeVisible()
  await expect(rail(page).getByRole('region', { name: 'Poise faults' })).toContainText('Poise could not reconcile the worker result.')

  await rail(page).getByRole('button', { name: 'Close notifications' }).click()
  await page.locator('#top-nav').getByRole('button', { name: 'Behaviors', exact: true }).click()
  await expect(page.locator('#behavior-diagnostics')).toHaveCount(0)
  const counts = page.locator('tr[data-behavior="review-new-prs"] .behavior-notifications')
  await expect(counts.getByRole('button')).toHaveText(['1 needs you'])
  await expect(page.locator('tr[data-behavior="approve-prs"] .behavior-notifications').getByRole('button')).toHaveText(['1 Poise fault'])
  await counts.getByRole('button', { name: '1 needs you' }).click()
  await expect(rail(page)).toBeVisible()
  await expect(rail(page).locator('.nr-tag')).toContainText('Review New Pull Requests')
  await expect(rail(page).locator('.nr-card')).toHaveCount(1)
  await expect(held.locator('.nr-card-head')).toHaveAttribute('aria-expanded', 'true')
  await rail(page).getByRole('button', { name: 'Show every notification' }).click()
  await expect(rail(page).locator('.nr-card')).toHaveCount(2)
})

test('counts Behaviors’ diagnostics on the bell once the page has settled, with one read and the rail closed', async ({ page }) => {
  await workspace(page, [WAITING], { diagnostics: diagnostics({ agentLogsError: 'agent-interface --logs exited with status 1' }) })
  let reads = 0
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/behaviors') reads += 1 })
  await page.goto('/')
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 open')
  expect(reads).toBe(0)
  await expect(bell(page)).toHaveAccessibleName('Notifications, 2 open', { timeout: 20_000 })
  expect(reads).toBe(1)
  await expect(rail(page)).toBeHidden()
})

test('turns notices off and on from Settings, keeping Behaviors’ activity in the rail', async ({ page }) => {
  const state = await workspace(page, [WAITING], { diagnostics: diagnostics({ agentLogsError: 'agent-interface --logs exited with status 1' }) })
  await page.goto('/')
  await openRail(page)
  await expect(bell(page)).toHaveAccessibleName('Notifications, 2 open')
  await rail(page).getByRole('button', { name: 'Close notifications' }).click()

  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'General', exact: true }).click()
  const picker = page.locator('#settings-panel').getByRole('group', { name: 'Notifications', exact: true })
  await expect(picker.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true')
  await picker.getByRole('button', { name: 'Off' }).click()
  await expect(bell(page)).toHaveAccessibleName('Notifications, 1 open')
  await expect(picker.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true')
  expect(state.sent).toEqual(['notifications off'])

  await picker.getByRole('button', { name: 'On' }).click()
  await expect(bell(page)).toHaveAccessibleName('Notifications, 2 open')
  expect(state.sent).toEqual(['notifications off', 'notifications on'])
  // Turning them on announces nothing that stood meanwhile.
  await expect(page.locator('.nr-toast')).toHaveCount(0)

  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await openRail(page)
  await expand(page, WAITING.id)
  await card(page, WAITING.id).getByRole('button', { name: 'Dismiss' }).click()
  await expect(rail(page).locator('.nr-card')).toHaveCount(1)
  await expect(rail(page).locator('.nr-card-meta')).toHaveText('Behaviors · Agent log')
  state.diagnostics = diagnostics()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(rail(page).locator('.nr-empty-title')).toHaveText('Nothing needs you')
  await expect(bell(page)).toHaveAccessibleName('Notifications')
})
