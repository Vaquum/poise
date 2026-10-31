import { expect, test } from '@playwright/test'
import { NOW, session, installRoutes, installSocket, makeState, input, timersData, timerView, wakeData } from './fixtures/chat'
import type { TimerSummary } from '../../server/chat/protocol'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('chat-fixture-initialized')) {
      localStorage.clear()
      localStorage.setItem('poise-view', 'chat')
      sessionStorage.setItem('chat-fixture-initialized', '1')
    }
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
})

test('creates the Manager from the New session dialog and lists it first', async ({ page }) => {
  const state = makeState([
    session({ id: 's2', title: 'Second', createdAt: '2026-09-18T10:00:00.000Z' }),
    session(),
  ])
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: 'New session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await dialog.locator('input[name="type"][value="manager"]').check()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect.poll(() => state.calls.find(c => c.method === 'POST' && c.path === '/api/chat/sessions')?.body)
    .toMatchObject({ role: 'manager' })
  const items = page.locator('.chat-session-item:not(.pending)')
  await expect(items.first()).toContainText('Manager')
  await expect(items.first().locator('.chat-pill-manager')).toHaveText('Manager')
})

test('points to the existing Manager instead of creating a second', async ({ page }) => {
  const manager = session({ id: 'm1', title: 'Manager', role: 'manager', createdAt: NOW })
  const state = makeState([manager, session({ id: 's2', title: 'Second', createdAt: '2026-09-18T10:00:00.000Z' })])
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: 'New session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await expect(dialog.locator('input[name="type"][value="manager"]')).toBeDisabled()
  await dialog.getByRole('button', { name: 'Open the Manager' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.chat-session-item[data-id="m1"]')).toHaveClass(/active/)

  state.sessions = [session()]
  state.calls.length = 0
  await page.goto('/')
  await page.getByRole('button', { name: 'New session' }).click()
  const race = page.getByRole('dialog', { name: 'New session' })
  await race.locator('input[name="type"][value="manager"]').check()
  state.sessions.unshift(session({ id: 'winner', title: 'Manager', role: 'manager', createdAt: new Date().toISOString() }))
  await race.getByRole('button', { name: 'Create' }).click()
  const alert = page.getByRole('dialog', { name: 'New session' }).getByRole('alert')
  await expect(alert).toContainText('A Manager already exists.')
  await alert.getByRole('button', { name: 'Open it' }).click()
  await expect(page.locator('.chat-session-item[data-id="winner"]')).toHaveClass(/active/)

  await page.route('**/api/chat/sessions', async (route) => {
    if (route.request().method() !== 'POST') { await route.fallback(); return }
    await route.fulfill({ status: 409, json: { error: 'A Manager already exists.', code: 'manager_exists' } })
  })
  state.sessions = [session()]
  state.calls.length = 0
  await page.goto('/')
  await page.getByRole('button', { name: 'New session' }).click()
  const bare = page.getByRole('dialog', { name: 'New session' })
  await bare.locator('input[name="type"][value="manager"]').check()
  await bare.getByRole('button', { name: 'Create' }).click()
  const bareAlert = page.getByRole('dialog', { name: 'New session' }).getByRole('alert')
  await expect(bareAlert).toContainText('A Manager already exists.')
  await expect(bareAlert.getByRole('button', { name: 'Open it' })).toHaveCount(0)
})

test('hides Fork and Hand off for the Manager and escapes its title', async ({ page }) => {
  const evil = '<img src=x onerror=alert(1)>'
  const state = makeState([
    session({ id: 'm1', title: evil, role: 'manager', createdAt: NOW }),
    session({ id: 's2', title: 'Second', createdAt: '2026-09-18T10:00:00.000Z' }),
  ])
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  await expect(page.locator('.chat-session-item[data-id="m1"]')).toHaveClass(/active/)
  await expect(page.locator('.chat-h-fork')).toHaveCount(0)
  await expect(page.locator('.chat-h-handoff')).toHaveCount(0)
  await expect(page.locator('.chat-session-item[data-id="m1"] .chat-session-title')).toHaveText(evil)
  await expect(page.locator('.chat-session-item[data-id="m1"] img')).toHaveCount(0)
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(page.locator('.chat-session-item[data-id="s2"]')).toHaveClass(/active/)
  await expect(page.locator('.chat-h-fork')).toHaveCount(1)
  await expect(page.locator('.chat-h-handoff')).toHaveCount(1)
})

test('marks /manager as built in, edits it without a Delete, and refuses it in regular chats', async ({ page }) => {
  const evil = '<img src=x onerror=alert(1)>'
  const skills = { revision: 1, switches: [
    { name: 'manager', content: evil, revision: 1, updatedAt: NOW, snippetTrigger: ';manager' },
    { name: 'other', content: 'Other text', revision: 1, updatedAt: NOW, snippetTrigger: ';other' },
  ] }
  const state = makeState([
    session({ id: 's1', title: 'Ordinary', createdAt: NOW }),
    session({ id: 'm1', title: 'Manager', role: 'manager', createdAt: '2026-09-18T10:00:00.000Z' }),
  ])
  state.switches = skills
  state.snippets = { snippets: [{ trigger: ';manager', replace: evil }, { trigger: ';other', replace: 'Other text' }], version: 'fixture-v1', skills }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await sock.subscribed('m1')

  await page.getByRole('button', { name: 'Snippets', exact: true }).click()
  const view = page.locator('#view-snippets')
  const row = view.locator('.snip-row[data-trigger=";manager"]')
  await expect(row.locator('.snip-builtin')).toHaveText('built in')
  await expect(view.locator('.snip-builtin')).toHaveCount(1)
  await row.click()
  const editor = view.locator('.snip-expand-row')
  await expect(editor.locator('.snip-trigger-input')).toHaveAttribute('readonly', '')
  await expect(editor.locator('.snip-delete')).toHaveCount(0)
  await expect(editor.locator('.snip-builtin-note')).toContainText('Built in: the Manager\'s standing instructions')
  await expect(editor.getByRole('textbox', { name: 'Snippet instructions' })).toHaveValue(evil)
  await expect(page.locator('img')).toHaveCount(0)
  await editor.getByRole('textbox', { name: 'Snippet instructions' }).fill('Keep every chat moving')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(view.locator('.snip-expand-row')).toHaveCount(0)
  const put = state.calls.find(call => call.method === 'PUT' && call.path === '/api/snippets')
  expect(put?.body).toMatchObject({ snippets: [
    { trigger: ';manager', replace: 'Keep every chat moving' },
    { trigger: ';other', replace: 'Other text' },
  ] })

  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await page.locator('.chat-session-item[data-id="s1"]').click()
  await expect(page.locator('.chat-session-item[data-id="s1"]')).toHaveClass(/active/)
  await input(page).fill('/manager hello')
  await input(page).press('Enter')
  await expect(page.locator('.chat-notice')).toHaveText('/manager is not supported in regular chats.')
  await expect(page.locator('.chat-notice')).toHaveClass(/st-help-info/)
  await expect(input(page)).toHaveValue('/manager hello')
  expect(sock.framesOf('prompt')).toEqual([])

  await page.locator('.chat-session-item[data-id="m1"]').click()
  await expect(page.locator('.chat-session-item[data-id="m1"]')).toHaveClass(/active/)
  await input(page).fill('/manager hello')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ type: 'prompt', sessionId: 'm1', text: '/manager hello' })

  await page.locator('.chat-session-item[data-id="s1"]').click()
  await expect(page.locator('.chat-session-item[data-id="s1"]')).toHaveClass(/active/)
  await input(page).fill('/reset /manager hello')
  await input(page).press('Enter')
  await expect(page.locator('.chat-notice')).toHaveText('/manager is not supported in regular chats.')
  await expect(input(page)).toHaveValue('/reset /manager hello')
  expect(sock.framesOf('prompt')).toHaveLength(1)
  expect(sock.framesOf('context.reset')).toEqual([])
})

test('sets the wake interval from the Manager\'s header and Settings and shows its cost and state', async ({ page }) => {
  const manager = session({ id: 'm1', title: 'Manager', role: 'manager', createdAt: NOW })
  const state = makeState([manager, session({ id: 's2', title: 'Second', createdAt: '2026-09-18T10:00:00.000Z' })])
  state.settings.timezone = 'UTC'
  state.wake = wakeData()
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await expect(page.locator('.chat-session-item[data-id="m1"]')).toHaveClass(/active/)
  await sock.subscribed('m1')

  const wake = page.locator('#chat-manager-wake')
  const status = page.locator('#chat-manager-wake-status')
  await expect(wake).toBeVisible()
  await expect(wake.locator('option')).toHaveText(['60 min', '30 min', '15 min', '10 min', '5 min'])
  await expect(wake).toHaveValue('60')
  await expect(status).toHaveText(/Up to 24 turns a day · next \d\d:\d\d/)

  // Choosing an option saves at once, with no other click.
  await wake.selectOption('5')
  await expect.poll(() => state.calls.find(call => call.method === 'PUT' && call.path === '/api/chat/manager/wake')?.body)
    .toMatchObject({ everyMinutes: 5, revision: 1 })
  await expect(wake).toHaveValue('5')
  await expect(status).toHaveText(/Up to 288 turns a day · next \d\d:\d\d/)

  // The select stays enabled while the Manager runs.
  state.sessions[0] = { ...manager, status: 'running', lastSeq: 1 }
  sock.push('m1', { type: 'session.updated', session: state.sessions[0] })
  await expect(page.locator('.chat-h-status')).toHaveText('running')
  await expect(wake).toBeEnabled()

  // Every status line renders from its fixture state.
  const wakeSummary = (overrides: Partial<TimerSummary> = {}): TimerSummary => ({ id: 'wake-1', sessionId: 'm1',
    label: 'Scheduled wake-up', preview: 'Scheduled wake-up', schedule: { kind: 'every', minutes: 5 },
    nextAt: new Date(Date.now() + 5 * 60_000).toISOString(), notBefore: null, state: 'active',
    setBy: { kind: 'person' }, failures: 0, skipped: 0, createdAt: NOW, system: 'manager-wake', ...overrides })
  const refreshWake = async () => {
    sock.push('m1', { type: 'timer.changed', timer: wakeSummary(), change: 'updated', by: { kind: 'person' } })
  }
  state.wake = wakeData({ everyMinutes: 5, revision: 2, timer: null, pendingOn: 'charter' })
  await refreshWake()
  await expect(status).toHaveText('Up to 288 turns a day · wake-ups start when the /manager snippet has text')
  state.wake = wakeData({ everyMinutes: 5, revision: 2, timer: null, pendingOn: 'manager' })
  await refreshWake()
  await expect(status).toHaveText('Up to 288 turns a day · wake-ups start when you create a Manager')
  state.wake = wakeData({ everyMinutes: 5, revision: 2,
    timer: { id: 'wake-1', state: 'active', nextAt: new Date(Date.now() + 5 * 60_000).toISOString(), waitingFor: 'running' } })
  await refreshWake()
  await expect(status).toHaveText('Up to 288 turns a day · due now · waiting: chat is running')
  state.wake!.timer!.waitingFor = 'model'
  await refreshWake()
  await expect(status).toHaveText('Up to 288 turns a day · due now · waiting: choose a model for the Manager')
  for (const [reason, line] of [
    ['person_stopped', 'On hold: you stopped the Manager'],
    ['person_held', 'On hold: you put the Manager on hold'],
    ['all_held', 'On hold: all timers are on hold'],
  ] as const) {
    state.wake = wakeData({ everyMinutes: 5, revision: 2,
      timer: { id: 'wake-1', state: 'held', reason, nextAt: new Date(Date.now() + 5 * 60_000).toISOString() } })
    await refreshWake()
    await expect(status).toHaveText(line)
  }

  // A failed last wake shows the error and the next time.
  state.wake = wakeData({ everyMinutes: 5, revision: 2, lastFailure: { at: new Date().toISOString(), error: 'wake boom' } })
  await refreshWake()
  await expect(status).toHaveText(/Up to 288 turns a day · last wake-up failed at \d\d:\d\d: wake boom · next \d\d:\d\d/)

  // The Timers panel shows the wake-up with its note and no Cancel or Re-arm.
  state.timers = { m1: timersData({ timers: [timerView({ id: 'wake-1', sessionId: 'm1', label: 'Scheduled wake-up',
    message: 'Scheduled wake-up', schedule: { kind: 'every', minutes: 5 }, setBy: { kind: 'person' }, system: 'manager-wake' })] }) }
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  const pane = page.locator('#chat-timers-pane')
  await expect(pane).toBeVisible()
  const row = pane.locator('.chat-timer[data-timer="wake-1"]')
  await expect(row.locator('.chat-timer-label')).toHaveText('Scheduled wake-up')
  await expect(row.locator('.chat-timer-system-note')).toHaveText("Interval set in the Manager's header")
  await expect(row.locator('.chat-timer-cancel')).toHaveCount(0)
  await expect(row.locator('.chat-timer-rearm')).toHaveCount(0)

  // The new transcript notes render escaped.
  sock.push('m1', { type: 'timer.changed', timer: wakeSummary(), change: 'updated', by: { kind: 'person' } })
  await expect(page.locator('.chat-note').filter({ hasText: 'changed by you' }).last())
    .toHaveText('Timer "Scheduled wake-up" changed by you · every 5 min')
  sock.push('m1', { type: 'timer.changed', timer: wakeSummary(), change: 'failed', by: { kind: 'person' }, error: '<b>x</b>' })
  const failed = page.locator('.chat-note').filter({ hasText: 'The next wake-up follows at the interval' }).last()
  await expect(failed).toHaveText('Timer "Scheduled wake-up" failed: <b>x</b>. The next wake-up follows at the interval.')
  await expect(failed.locator('b')).toHaveCount(0)

  // An unreadable view keeps the select usable for a repair; any other
  // failure disables it until the view reads again.
  state.wakeGetFailure = { status: 500, json: { error: 'The Manager wake interval could not be read. Choose an interval to replace it.' } }
  await refreshWake()
  await expect(status).toHaveText('The Manager wake interval could not be read. Choose an interval to replace it.')
  await expect(wake).toHaveValue('60')
  await expect(wake).toBeEnabled()
  state.wakeGetFailure = { status: 503, json: { error: 'wake store is down' } }
  await refreshWake()
  await expect(status).toHaveText('Wake interval unavailable: wake store is down')
  await expect(wake).toBeDisabled()
  state.wakeGetFailure = undefined
  await refreshWake()
  await expect(wake).toHaveValue('5')
  await expect(wake).toBeEnabled()

  // A 409 keeps its note while the saved value reloads; a 400 shows the
  // message with the select back on the saved value.
  state.wakePutFailure = { status: 409, json: { error: 'The wake interval changed in another tab. Your choice has not replaced it.' } }
  await wake.selectOption('10')
  await expect(status).toHaveText('The wake interval changed in another tab.')
  await expect(wake).toHaveValue('5')
  state.wakePutFailure = { status: 400, json: { error: 'everyMinutes must be 5, 10, 15, 30 or 60' } }
  await wake.selectOption('10')
  await expect(status).toHaveText('everyMinutes must be 5, 10, 15, 30 or 60')
  await expect(wake).toHaveValue('5')

  // An ordinary chat's header has no such control.
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(page.locator('.chat-session-item[data-id="s2"]')).toHaveClass(/active/)
  await expect(page.locator('#chat-manager-wake')).toHaveCount(0)

  // Settings mirrors the control on the same routes.
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('[data-settings="general"]').click()
  const mirror = page.locator('#st-manager-wake')
  await expect(mirror).toBeVisible()
  await expect(mirror).toHaveValue('5')
  await expect(page.locator('#settings-panel')).toContainText("The Manager's standing instructions are the /manager snippet, edited in Snippets.")
  await mirror.selectOption('30')
  await expect.poll(() => state.calls.filter(call => call.method === 'PUT' && call.path === '/api/chat/manager/wake').at(-1)?.body)
    .toMatchObject({ everyMinutes: 30, revision: 2 })
  await expect(mirror).toHaveValue('30')

  // The New session dialog names the wake-up while no Manager exists.
  state.sessions = [session({ id: 's1', title: 'Only', createdAt: NOW })]
  state.wake = wakeData({ everyMinutes: 60, revision: 1 })
  state.calls.length = 0
  await page.goto('/')
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.locator('.chat-dialog-manager-wake'))
    .toHaveText("Wakes every 60 minutes (up to 24 turns a day). Change it in the Manager's header.")
})

test('shows the retired-model notice in the Manager header', async ({ page }) => {
  const manager = session({ id: 'm1', title: 'Manager', role: 'manager', retiredModel: 'opus-4-max', createdAt: NOW })
  const state = makeState([manager])
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await expect(page.locator('.chat-session-item[data-id="m1"]')).toHaveClass(/active/)
  await expect(page.locator('.chat-retired-model'))
    .toHaveText('The Manager\'s model opus-4-max was retired. Choose another model to continue.')
  await expect(page.locator('.chat-send')).toBeDisabled()
  await sock.subscribed('m1')
  const cleared = { ...manager, retiredModel: undefined, lastSeq: 1 }
  state.sessions[0] = cleared
  sock.push('m1', { type: 'session.updated', session: cleared })
  await expect(page.locator('.chat-retired-model')).toHaveCount(0)
})
