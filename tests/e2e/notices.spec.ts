import { expect, test, type Page } from '@playwright/test'
import type { Notice } from '../../src/notices'

// The notification island at the top of the page (src/views/notice-island.ts):
// where it sits, one notice at a time, putting one away, stepping through
// them, opening what one is about, silencing a ready pull request, and the
// Notifications setting. Poise's API is stood in for.

const T0 = Date.parse('2026-10-09T10:00:00.000Z')
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()
const HELD_CALL = 'c'.repeat(32)

const WAITING: Notice = { id: 'aaaaaaaaaaaa-3', kind: 'chat_waiting', title: 'Claude Code is waiting for you', body: 'In “Refactor the relay”: allow or deny Bash(npm test).', since: iso(4), due: iso(4), silenceable: false, target: { chat: '7d6c1b1e-2a4f-4c55-9a51-0e1f2b3c4d5e' } }
const HELD: Notice = { id: 'aaaaaaaaaaaa-2', kind: 'behavior_held', title: 'Review New Pull Requests failed on acme/api#9', body: 'Open this run in Swarm to see what happened.', since: iso(2), due: iso(2), silenceable: false, target: { swarm: HELD_CALL } }
const READY: Notice = { id: 'aaaaaaaaaaaa-1', kind: 'pr_ready', title: 'acme/api#7 is ready to merge', body: 'Fix the flaky retry test', since: iso(0), due: iso(30), silenceable: true, target: { pullRequest: 'https://github.com/acme/api/pull/7' } }

function failedRun(id = HELD_CALL, fields: Record<string, unknown> = {}) {
  return {
    id, repo: 'acme/api', pr_id: '9', actor: 'octo-agent', model: 'astra', behavior: 'pr_review',
    session_id: null, prompt: '', started_at: iso(0), started_at_precise: iso(0), completed_at: iso(2),
    time_elapsed: '2m', status: 'failed', outcome: 'preflight_failed', response: '',
    error: 'The provider rejected this review.', error_code: null, progress: null, ...fields,
  }
}

interface Workspace {
  enabled: boolean
  notices: Notice[]
  /** The notice actions and settings the page sent, in order. */
  sent: string[]
}

async function workspace(page: Page, notices: Notice[], enabled = true, accounts = ['acme']): Promise<Workspace> {
  const state: Workspace = { enabled, notices: [...notices], sent: [] }
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'current') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await page.context().route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>GitHub</p>' }))
  const answer = () => ({ enabled: state.enabled, notices: state.enabled ? state.notices : [] })
  const settings = () => ({ org: 'acme', me: 'octocat', agentAccount: 'octo-agent', timezone: 'UTC', models: {}, notifications: { enabled: state.enabled }, organizations: accounts.map((login) => ({ login, managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null })) })
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
    if (pathname === '/api/workspace') return route.fulfill({ json: { mode: 'local' } })
    if (pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    if (pathname === '/api/agent-logs') return route.fulfill({ json: { logs: [failedRun()] } })
    return route.fulfill({ json: {} })
  })
  return state
}

const island = (page: Page) => page.getByRole('region', { name: 'Notifications' })
const shownTitle = (page: Page) => island(page).locator('.ni-content:not(.ni-leaving) .ni-title')

test('shows the most pressing notice at the top centre, clear of every control', async ({ page }) => {
  await workspace(page, [WAITING, HELD, READY])
  await page.goto('/')
  await expect(shownTitle(page)).toHaveText(WAITING.title)
  await expect(island(page).getByRole('button', { name: 'Show the next notification, 2 more' })).toBeVisible()

  const box = (await island(page).locator('.ni-shell').boundingBox())!
  // Centred on the band the page lays out in, as its fixed control bar is: a
  // classic scrollbar's reserved gutter is not part of it.
  const band = (await page.locator('.view:not([hidden]) .view-header').boundingBox())!
  expect(Math.abs(box.x + box.width / 2 - (band.x + band.width / 2))).toBeLessThan(2)
  // In the band every view keeps above its controls, in every view.
  for (const view of ['Current', 'Swarm', 'Chat', 'Archive', 'Behaviors', 'Snippets', 'Editor']) {
    await page.locator('#top-nav').getByRole('button', { name: view, exact: true }).click()
    const header = page.locator('.view:not([hidden]) .view-header')
    for (const control of await header.locator(':scope > *').all()) {
      const bounds = await control.boundingBox()
      if (bounds) expect(bounds.y, `${view}: a control under the island`).toBeGreaterThanOrEqual(box.y + box.height)
    }
  }
})

test('puts a notice away and shows the next, or steps on without putting it away', async ({ page }) => {
  const state = await workspace(page, [WAITING, HELD, READY])
  await page.goto('/')
  await expect(shownTitle(page)).toHaveText(WAITING.title)

  await island(page).getByRole('button', { name: 'Show the next notification, 2 more' }).click()
  await expect(shownTitle(page)).toHaveText(HELD.title)
  expect(state.sent).toEqual([])

  await island(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(shownTitle(page)).toHaveText(WAITING.title)
  expect(state.sent).toEqual([`dismiss ${HELD.id}`])
  await expect(island(page).getByRole('button', { name: 'Show the next notification, 1 more' })).toBeVisible()
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
  await expect(shownTitle(page)).toHaveText(HELD.title)
  await island(page).getByRole('button', { name: /Review New Pull Requests failed on acme\/api#9.*Swarm/ }).click()
  try {
    await expect(page.locator('#view-swarm')).toBeVisible()
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
  await expect(shownTitle(page)).toHaveText(READY.title)
  await expect(island(page).locator('.ni-meta')).toHaveText(/^for \d/)
  const opened = page.context().waitForEvent('page')
  await island(page).getByRole('button', { name: /acme\/api#7 is ready to merge.*Open the pull request on GitHub/ }).click()
  await expect.poll(async () => (await opened).url()).toBe('https://github.com/acme/api/pull/7')
  await expect.poll(() => state.sent).toEqual([`dismiss ${HELD.id}`, `dismiss ${READY.id}`])
  await expect(island(page)).toBeHidden()
})

test('focuses an older grouped failure while already in Swarm, clears filters, and supports repeated keyboard navigation', async ({ page }) => {
  const state = await workspace(page, [HELD], true, ['acme', 'beta'])
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
  await page.evaluate((callId) => {
    document.addEventListener('animationstart', (event) => {
      const row = event.target
      if (row instanceof HTMLElement && row.dataset.id === callId && event.animationName === 'agent-row-focus-pulse') {
        row.dataset.pulses = String(Number(row.dataset.pulses ?? 0) + 1)
      }
    }, true)
  }, HELD_CALL)
  const open = island(page).getByRole('button', { name: /Review New Pull Requests failed on acme\/api#9.*Swarm/ })
  await open.focus()
  await open.press('Enter')
  await expect(focused).toHaveClass(/agent-row-focus/)
  await expect(focused).toHaveAttribute('data-pulses', '1')
  await expect(focused.getByRole('button', { name: 'Toggle detail' })).toBeFocused()
  await expect(page.locator('#swarm-search')).toHaveValue('')
  await expect(page.locator('#swarm-filters').getByRole('combobox', { name: 'Account filter' })).toHaveValue('')
  await expect(page.locator(`.agent-row[data-id="${newest}"]`)).not.toHaveClass(/agent-row-focus/)
  await expect(page.locator(`.agent-expand-row[data-expand-for="${HELD_CALL}"]`)).toContainText('The provider rejected this review.')
  await expect(focused).toBeInViewport()

  await expect.poll(() => state.sent).toEqual([`dismiss ${HELD.id}`])
  state.notices = [{ ...HELD, id: 'aaaaaaaaaaaa-4' }]
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(shownTitle(page)).toHaveText(HELD.title)
  await page.evaluate(() => window.scrollTo(0, 0))
  await open.focus()
  await open.press('Space')
  await expect(focused).toHaveClass(/agent-row-focus/)
  await expect(focused).toHaveAttribute('data-pulses', '2')
  await expect(focused.getByRole('button', { name: 'Toggle detail' })).toBeFocused()
  await expect(focused).toBeInViewport()
  await expect.poll(() => state.sent).toEqual([`dismiss ${HELD.id}`, 'dismiss aaaaaaaaaaaa-4'])
})

test('reports a missing notification run instead of opening another run on the same target', async ({ page }) => {
  const absent = 'f'.repeat(32)
  await workspace(page, [{ ...HELD, target: { swarm: absent } }])
  await page.goto('/')
  await island(page).getByRole('button', { name: /Review New Pull Requests failed on acme\/api#9.*Swarm/ }).click()
  await expect(page.locator('#view-swarm')).toBeVisible()
  await expect(page.locator('#swarm-stale')).toHaveText(`No run found for call ${absent}.`)
  await expect(page.locator('.agent-row-focus')).toHaveCount(0)
})

test('keeps the last clicked notice in control when two navigations share a pending account request', async ({ page }) => {
  const insideCall = 'e'.repeat(32)
  const inside: Notice = { ...HELD, id: 'aaaaaaaaaaaa-4', title: 'Review New Pull Requests failed on beta/other#10', target: { swarm: insideCall } }
  const state = await workspace(page, [HELD, inside], true, ['acme', 'beta'])
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
  const unfilteredBefore = allRequests
  holdSelected = true
  try {
    await island(page).getByRole('button', { name: /Review New Pull Requests failed on acme\/api#9.*Swarm/ }).click()
    await expect.poll(() => heldRequests).toBe(1)
    await expect(shownTitle(page)).toHaveText(inside.title)
    // Let each click's deferred navigation join the held request before it answers.
    await page.evaluate(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())))
    await island(page).getByRole('button', { name: /Review New Pull Requests failed on beta\/other#10.*Swarm/ }).click()
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
  await expect(shownTitle(page)).toHaveText(READY.title)
  await island(page).getByRole('button', { name: 'Silence reminders for this pull request' }).click()
  await expect(shownTitle(page)).toHaveText(WAITING.title)
  expect(state.sent).toEqual([`silence ${READY.id}`])
  await expect(island(page).getByRole('button', { name: 'Silence reminders for this pull request' })).toHaveCount(0)
})

test('is gone with nothing to show, and turns off and on from Settings', async ({ page }) => {
  const state = await workspace(page, [WAITING])
  await page.goto('/')
  await expect(shownTitle(page)).toHaveText(WAITING.title)

  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('button', { name: 'Settings' }).click()
  const picker = page.locator('#settings-panel').getByRole('group', { name: 'Show notifications' })
  await expect(picker.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true')
  await picker.getByRole('button', { name: 'Off' }).click()
  await expect(island(page)).toBeHidden()
  await expect(picker.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true')
  expect(state.sent).toEqual(['notifications off'])

  await picker.getByRole('button', { name: 'On' }).click()
  await expect(shownTitle(page)).toHaveText(WAITING.title)
  expect(state.sent).toEqual(['notifications off', 'notifications on'])

  // Put away the last notice and the island leaves the page.
  await island(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(island(page)).toBeHidden()
})
