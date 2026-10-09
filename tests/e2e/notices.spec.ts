import { expect, test, type Page } from '@playwright/test'
import type { Notice } from '../../src/notices'

// The notification island at the top of the page (src/views/notice-island.ts):
// where it sits, one notice at a time, putting one away, stepping through
// them, opening what one is about, silencing a ready pull request, and the
// Notifications setting. Poise's API is stood in for.

const T0 = Date.parse('2026-10-09T10:00:00.000Z')
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

const WAITING: Notice = { id: 'aaaaaaaaaaaa-3', kind: 'chat_waiting', title: 'Claude Code is waiting for you', body: 'In “Refactor the relay”: allow or deny Bash(npm test).', since: iso(4), due: iso(4), silenceable: false, target: { chat: '7d6c1b1e-2a4f-4c55-9a51-0e1f2b3c4d5e' } }
const HELD: Notice = { id: 'aaaaaaaaaaaa-2', kind: 'behavior_held', title: 'Review New Pull Requests failed on acme/api#9', body: 'Open Behaviors in Poise to see what happened.', since: iso(2), due: iso(2), silenceable: false, target: { view: 'behaviors' } }
const READY: Notice = { id: 'aaaaaaaaaaaa-1', kind: 'pr_ready', title: 'acme/api#7 is ready to merge', body: 'Fix the flaky retry test', since: iso(0), due: iso(30), silenceable: true, target: { pullRequest: 'https://github.com/acme/api/pull/7' } }

interface Workspace {
  enabled: boolean
  notices: Notice[]
  /** The notice actions and settings the page sent, in order. */
  sent: string[]
}

async function workspace(page: Page, notices: Notice[], enabled = true): Promise<Workspace> {
  const state: Workspace = { enabled, notices: [...notices], sent: [] }
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'current') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await page.context().route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>GitHub</p>' }))
  const answer = () => ({ enabled: state.enabled, notices: state.enabled ? state.notices : [] })
  const settings = () => ({ org: 'acme', me: 'octocat', agentAccount: 'octo-agent', timezone: 'UTC', models: {}, notifications: { enabled: state.enabled }, organizations: [{ login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }] })
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

test('opens what a notice is about and puts it away', async ({ page }) => {
  const state = await workspace(page, [HELD, READY])
  await page.goto('/')
  await expect(shownTitle(page)).toHaveText(HELD.title)
  await island(page).getByRole('button', { name: /Review New Pull Requests failed on acme\/api#9.*Open Behaviors/ }).click()
  await expect(page.locator('#view-behaviors')).toBeVisible()
  expect(state.sent).toEqual([`dismiss ${HELD.id}`])

  // A ready pull request opens on GitHub, in a tab of its own.
  await expect(shownTitle(page)).toHaveText(READY.title)
  await expect(island(page).locator('.ni-meta')).toHaveText(/^for \d/)
  const opened = page.context().waitForEvent('page')
  await island(page).getByRole('button', { name: /acme\/api#7 is ready to merge.*Open the pull request on GitHub/ }).click()
  await expect.poll(async () => (await opened).url()).toBe('https://github.com/acme/api/pull/7')
  expect(state.sent).toEqual([`dismiss ${HELD.id}`, `dismiss ${READY.id}`])
  await expect(island(page)).toBeHidden()
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
