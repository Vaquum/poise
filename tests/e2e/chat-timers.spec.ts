import { expect, test } from '@playwright/test'
import { NOW, input, installRoutes, installSocket, makeState, session, timersData, timerView } from './fixtures/chat'
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

function summary(timer: ReturnType<typeof timerView>): TimerSummary {
  return { id: timer.id, sessionId: timer.sessionId, label: timer.label, preview: timer.preview, schedule: timer.schedule,
    nextAt: timer.nextAt, notBefore: timer.notBefore, state: timer.state, reason: timer.reason, setBy: timer.setBy,
    failures: timer.failures, skipped: timer.skipped, createdAt: timer.createdAt }
}

test('opens the Timers pane, adds and cancels a timer, and holds and resumes the chat', async ({ page }) => {
  const one = timerView({ id: 'timer-1', label: 'Check CI' })
  const two = timerView({ id: 'timer-2', label: 'Nightly', schedule: { kind: 'once', delayMinutes: 60 } })
  const early = timerView({ id: 'timer-early', sessionId: 's2', label: 'Early', nextAt: '2026-09-18T13:05:00.000Z' })
  const late = timerView({ id: 'timer-late', sessionId: 's2', label: 'Late', nextAt: '2026-09-18T14:35:00.000Z' })
  const state = makeState([
    session({ id: 's1', timers: [summary(one), summary(two)] }),
    session({ id: 's2', title: 'Paused', status: 'interrupted', createdAt: '2026-09-18T10:00:00.000Z', timers: [summary(late), summary(early)] }),
  ])
  state.settings.timezone = 'UTC'
  state.timers = { s1: timersData({ timers: [one, two] }) }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await page.locator('.chat-session-item[data-id="s1"]').click()
  await expect(page.locator('.chat-session-item[data-id="s1"]')).toHaveClass(/active/)

  const timersButton = page.getByRole('button', { name: 'Timers', exact: true })
  await expect(timersButton).toContainText('Timers 2')
  await timersButton.click()
  const pane = page.locator('#chat-timers-pane')
  await expect(pane).toBeVisible()
  await expect(pane.locator('.chat-timer')).toHaveCount(2)
  await expect(pane.locator('.chat-timer[data-timer="timer-1"] .chat-timer-meta')).toHaveText('every 30 min · set by Manager')
  await expect(pane.locator('.chat-timer[data-timer="timer-1"] .chat-timer-status')).toHaveText('next 18 Sept 14:35')

  await pane.locator('.chat-timers-label').fill('Heartbeat')
  await pane.locator('.chat-timers-message').fill('Are we green?')
  await pane.locator('.chat-timers-minutes').fill('15')
  await pane.getByRole('button', { name: 'Add timer' }).click()
  await expect.poll(() => sock.framesOf('timer.create').length).toBe(1)
  expect(sock.framesOf('timer.create')[0].command).toMatchObject(
    { type: 'timer.create', sessionId: 's1', label: 'Heartbeat', message: 'Are we green?', everyMinutes: 15 })
  await expect(pane.locator('.chat-timer')).toHaveCount(3)
  await expect(pane.locator('.chat-timers-label')).toHaveValue('')
  await expect(pane.locator('.chat-timers-message')).toHaveValue('')
  await expect(pane.locator('.chat-timers-minutes')).toHaveValue('')
  await pane.getByRole('button', { name: 'Add timer' }).click()
  expect(sock.framesOf('timer.create')).toHaveLength(1)

  await pane.locator('.chat-timer[data-timer="timer-1"] .chat-timer-cancel').click()
  await expect.poll(() => sock.framesOf('timer.cancel').length).toBe(1)
  expect(sock.framesOf('timer.cancel')[0].command).toMatchObject({ type: 'timer.cancel', timerId: 'timer-1' })
  await expect(pane.locator('.chat-timer[data-timer="timer-1"] .chat-timer-status')).toHaveText('cancelled')

  const hold = pane.getByRole('button', { name: 'Hold', exact: true })
  await hold.click()
  await expect.poll(() => sock.framesOf('chat.hold').length).toBe(1)
  expect(sock.framesOf('chat.hold')[0].command).toMatchObject({ type: 'chat.hold', sessionId: 's1', held: true })
  await expect(pane.getByRole('button', { name: 'Resume', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(pane.locator('.chat-timers-add')).toContainText('On hold: new timers start when you resume.')
  await expect(timersButton).toContainText('on hold')

  await pane.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect.poll(() => sock.framesOf('chat.hold').length).toBe(2)
  expect(sock.framesOf('chat.hold')[1].command).toMatchObject({ type: 'chat.hold', sessionId: 's1', held: false })
  await expect(pane.getByRole('button', { name: 'Hold', exact: true })).toHaveAttribute('aria-pressed', 'false')

  // A refused create surfaces the server's error in the pane's alert.
  sock.autoAck = false
  await pane.locator('.chat-timers-label').fill('Too much')
  await pane.locator('.chat-timers-message').fill('Ping')
  await pane.locator('.chat-timers-minutes').fill('5')
  await pane.getByRole('button', { name: 'Add timer' }).click()
  await expect.poll(() => sock.framesOf('timer.create').length).toBe(2)
  sock.ack(sock.framesOf('timer.create')[1], false, 'this chat already has 5 timers')
  await expect(pane.getByRole('alert')).toHaveText('this chat already has 5 timers')

  // An interrupted chat's placeholder names its earliest wake.
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(input(page)).toHaveAttribute('placeholder', 'Interrupted — Resume to continue, or /reset to start fresh · Timer "Early" wakes it at 18 Sept 13:05')
})

test('holds and resumes all timers, shows scheduler outages, and refetches every 30 seconds', async ({ page }) => {
  // The 30-second refetch needs longer than the default test timeout.
  test.setTimeout(90_000)
  const one = timerView({ id: 'timer-1', label: 'Check CI' })
  const state = makeState([session({ id: 's1' })])
  state.settings.timezone = 'UTC'
  state.timers = { s1: timersData({ timers: [one] }) }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  const pane = page.locator('#chat-timers-pane')
  await expect(pane.locator('.chat-timer')).toHaveCount(1)
  const timersGets = () => state.calls.filter(c => c.method === 'GET' && c.path === '/api/chat/sessions/s1/timers').length
  expect(timersGets()).toBe(1)

  await pane.getByRole('button', { name: 'Hold all timers' }).click()
  await expect.poll(() => sock.framesOf('timers.holdAll').length).toBe(1)
  expect(sock.framesOf('timers.holdAll')[0].command).toMatchObject({ type: 'timers.holdAll', held: true })
  await expect(pane.getByRole('button', { name: 'Resume all timers' })).toHaveAttribute('aria-pressed', 'true')
  await expect(pane.locator('.chat-timer-status')).toHaveText('on hold: all timers are on hold')

  // A scheduler outage replaces the list's calm with its error.
  state.timers!.s1.scheduler = { running: false, lastTickAt: null, error: 'startup reconciliation failed' }
  sock.push('s1', { type: 'timer.changed', timer: summary(one), change: 'held' })
  await expect(pane.locator('.chat-timers-down')).toHaveText('Timers are not running: startup reconciliation failed')
  state.timers!.s1.scheduler = { running: true, lastTickAt: new Date().toISOString() }
  sock.push('s1', { type: 'timer.changed', timer: summary(one), change: 'released' })
  await expect(pane.locator('.chat-timers-down')).toHaveCount(0)

  // Nothing else touches the pane now: only the 30-second interval refetches it.
  const before = timersGets()
  await expect.poll(() => timersGets(), { timeout: 40_000 }).toBeGreaterThan(before)
})

test('keeps a new timer draft typed while the previous add is pending', async ({ page }) => {
  const state = makeState([session({ id: 's1' })])
  state.timers = { s1: timersData() }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  const pane = page.locator('#chat-timers-pane')
  await pane.locator('.chat-timers-label').fill('First')
  await pane.locator('.chat-timers-message').fill('First message')
  await pane.locator('.chat-timers-minutes').fill('15')
  sock.autoAck = false
  await pane.getByRole('button', { name: 'Add timer' }).click()
  await expect.poll(() => sock.framesOf('timer.create').length).toBe(1)
  await pane.locator('.chat-timers-label').fill('Next')
  await pane.locator('.chat-timers-message').fill('Next message')
  await pane.locator('.chat-timers-minutes').fill('30')
  const created = timerView({ id: 'first', sessionId: 's1', label: 'First', message: 'First message', schedule: { kind: 'every', minutes: 15 } })
  state.timers!.s1.timers.push(created)
  sock.ack(sock.framesOf('timer.create')[0], true, '', undefined, { timer: created })
  await expect(pane.locator('.chat-timer')).toHaveCount(1)
  await expect(pane.locator('.chat-timers-label')).toHaveValue('Next')
  await expect(pane.locator('.chat-timers-message')).toHaveValue('Next message')
  await expect(pane.locator('.chat-timers-minutes')).toHaveValue('30')
})

test('blocks duplicate timer adds across refetches and chat switches until acknowledgement', async ({ page }) => {
  const state = makeState([session({ id: 's1' }), session({ id: 's2', title: 'Other chat' })])
  state.timers = { s1: timersData(), s2: timersData() }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await page.locator('.chat-session-item[data-id="s1"]').click()
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  const pane = page.locator('#chat-timers-pane')
  await pane.locator('.chat-timers-label').fill('Once')
  await pane.locator('.chat-timers-message').fill('One recurring wakeup')
  await pane.locator('.chat-timers-minutes').fill('15')
  sock.autoAck = false
  // Also exercise submission without the disabled button's browser guard.
  await pane.locator('form').evaluate((form: HTMLFormElement) => { form.requestSubmit(); form.requestSubmit() })
  await expect.poll(() => sock.framesOf('timer.create').length).toBe(1)
  await expect(pane.getByRole('button', { name: 'Add timer' })).toBeDisabled()
  state.timers!.s1.scheduler = { running: false, lastTickAt: null, error: 'Refetched while adding' }
  sock.push('s1', { type: 'timer.changed', timer: summary(timerView()), change: 'held' })
  await expect(pane.locator('.chat-timers-down')).toContainText('Refetched while adding')
  await expect(pane.getByRole('button', { name: 'Add timer' })).toBeDisabled()
  await pane.locator('form').evaluate((form: HTMLFormElement) => { form.requestSubmit() })
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(pane).toBeHidden()
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  await expect(pane.getByRole('button', { name: 'Add timer' })).toBeEnabled()
  await page.locator('.chat-session-item[data-id="s1"]').click()
  await expect(pane).toBeHidden()
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  await expect(pane.getByRole('button', { name: 'Add timer' })).toBeDisabled()
  await pane.locator('.chat-timers-label').fill('Next')
  await pane.locator('.chat-timers-message').fill('Next draft')
  await pane.locator('.chat-timers-minutes').fill('30')
  await pane.locator('form').evaluate((form: HTMLFormElement) => { form.requestSubmit() })
  expect(sock.framesOf('timer.create')).toHaveLength(1)
  const created = timerView({ id: 'once', sessionId: 's1', label: 'Once', message: 'One recurring wakeup' })
  state.timers!.s1.timers.push(created)
  sock.ack(sock.framesOf('timer.create')[0], true, '', undefined, { timer: created })
  await expect(pane.locator('.chat-timer')).toHaveCount(1)
  await expect(pane.getByRole('button', { name: 'Add timer' })).toBeEnabled()
  await expect(pane.locator('.chat-timers-label')).toHaveValue('Next')
  await expect(pane.locator('.chat-timers-message')).toHaveValue('Next draft')
  await expect(pane.locator('.chat-timers-minutes')).toHaveValue('30')
  expect(sock.framesOf('timer.create')).toHaveLength(1)
})

test('re-enables timer add after a rejected create without clearing its draft', async ({ page }) => {
  const state = makeState([session({ id: 's1' })])
  state.timers = { s1: timersData() }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  const pane = page.locator('#chat-timers-pane')
  await pane.locator('.chat-timers-label').fill('Retry')
  await pane.locator('.chat-timers-message').fill('Keep until accepted')
  await pane.locator('.chat-timers-minutes').fill('15')
  sock.autoAck = false
  await pane.getByRole('button', { name: 'Add timer' }).click()
  await expect.poll(() => sock.framesOf('timer.create').length).toBe(1)
  await expect(pane.getByRole('button', { name: 'Add timer' })).toBeDisabled()
  sock.ack(sock.framesOf('timer.create')[0], false, 'Timer refused')
  await expect(pane.getByRole('alert')).toHaveText('Timer refused')
  await expect(pane.getByRole('button', { name: 'Add timer' })).toBeEnabled()
  await expect(pane.locator('.chat-timers-label')).toHaveValue('Retry')
  await expect(pane.locator('.chat-timers-message')).toHaveValue('Keep until accepted')
  await expect(pane.locator('.chat-timers-minutes')).toHaveValue('15')
  await pane.getByRole('button', { name: 'Add timer' }).click()
  await expect.poll(() => sock.framesOf('timer.create').length).toBe(2)
  const created = timerView({ id: 'retry', sessionId: 's1', label: 'Retry', message: 'Keep until accepted' })
  state.timers!.s1.timers.push(created)
  sock.ack(sock.framesOf('timer.create')[1], true, '', undefined, { timer: created })
  await expect(pane.locator('.chat-timer')).toHaveCount(1)
  await expect(pane.getByRole('button', { name: 'Add timer' })).toBeEnabled()
  await expect(pane.locator('.chat-timers-label')).toHaveValue('')
})

test('keeps the add draft when closing and reopening timers on the same chat', async ({ page }) => {
  const state = makeState([session({ id: 's1' })])
  state.timers = { s1: timersData() }
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  const toggle = page.getByRole('button', { name: 'Timers', exact: true })
  await toggle.click()
  const pane = page.locator('#chat-timers-pane')
  await pane.locator('.chat-timers-label').fill('Unsent')
  await pane.locator('.chat-timers-message').fill('Keep this timer draft')
  await pane.locator('.chat-timers-minutes').fill('15')
  await toggle.click()
  await expect(pane).toBeHidden()
  await toggle.click()
  await expect(pane.locator('.chat-timers-label')).toHaveValue('Unsent')
  await expect(pane.locator('.chat-timers-message')).toHaveValue('Keep this timer draft')
  await expect(pane.locator('.chat-timers-minutes')).toHaveValue('15')
})

test("replaces another chat's timer controls while its new pane is loading", async ({ page }) => {
  const old = timerView({ id: 'old', sessionId: 's1', label: 'Old chat timer' })
  const next = timerView({ id: 'next', sessionId: 's2', label: 'Next chat timer' })
  const state = makeState([session({ id: 's1' }), session({ id: 's2', title: 'Next chat' })])
  state.timers = { s1: timersData({ timers: [old] }), s2: timersData({ timers: [next] }) }
  await installRoutes(page, state)
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requested = new Promise<void>(resolve => { entered = resolve })
  await page.route('**/api/chat/sessions/s2/timers', async route => { entered(); await held; await route.fallback() })
  const sock = await installSocket(page, state)
  await page.goto('/')
  await page.locator('.chat-session-item[data-id="s1"]').click()
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  const pane = page.locator('#chat-timers-pane')
  await expect(pane.locator('.chat-timer-label')).toHaveText('Old chat timer')
  await sock.subscribed('s1')
  sock.autoAck = false
  await pane.getByRole('button', { name: 'Cancel timer Old chat timer' }).click()
  await expect.poll(() => sock.framesOf('timer.cancel').length).toBe(1)
  await page.locator('.chat-session-item[data-id="s2"]').click()
  await expect(page.locator('.chat-session-item[data-id="s2"]')).toHaveClass(/active/)
  await sock.subscribed('s2')
  await expect(pane).toBeHidden()
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  await requested
  try {
    await expect(pane.locator('.chat-timer')).toHaveCount(0)
    await expect(pane.locator('.chat-timers-add')).toHaveCount(0)
    await expect(pane.getByRole('button', { name: 'Hold', exact: true })).toHaveCount(0)
  } finally { release() }
  await expect(pane.locator('.chat-timer-label')).toHaveText('Next chat timer')
  sock.ack(sock.framesOf('timer.cancel')[0], false, 'Old chat cancellation failed')
  sock.push('s2', { type: 'session.updated', session: { ...state.sessions.find(item => item.id === 's2')!, status: 'running' } })
  await expect(page.locator('.chat-h-status')).toHaveText('running')
  await expect(pane.getByRole('alert')).toBeHidden()
  expect(sock.framesOf('timer.create')).toHaveLength(0)
  expect(sock.framesOf('chat.hold')).toHaveLength(0)
})

test('shows a pending timer action failure in the pane after a refetch rerenders it', async ({ page }) => {
  const one = timerView({ id: 'one', sessionId: 's1', label: 'Check CI' })
  const state = makeState([session({ id: 's1' })])
  state.timers = { s1: timersData({ timers: [one] }) }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  const pane = page.locator('#chat-timers-pane')
  await expect(pane.locator('.chat-timer')).toHaveCount(1)
  sock.autoAck = false
  await pane.getByRole('button', { name: 'Cancel timer Check CI' }).click()
  await expect.poll(() => sock.framesOf('timer.cancel').length).toBe(1)
  state.timers!.s1.scheduler = { running: false, lastTickAt: null, error: 'scheduler changed while cancelling' }
  sock.push('s1', { type: 'timer.changed', timer: summary(one), change: 'held' })
  await expect(pane.locator('.chat-timers-down')).toContainText('scheduler changed while cancelling')
  sock.ack(sock.framesOf('timer.cancel')[0], false, 'Cancellation refused')
  await expect(pane.locator('.chat-timers-error')).toHaveText('Cancellation refused')
  await expect(pane.locator('.chat-timers-error')).toBeVisible()
})

test('ignores a pre-Resume refetch that arrives after the resumed timer data', async ({ page }) => {
  await page.addInitScript(() => {
    const observed = window as Window & { timerJsonReads?: number }
    observed.timerJsonReads = 0
    const request = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const response = await request(...args)
      if (!new URL(response.url, location.href).pathname.endsWith('/timers')) return response
      const read = response.json.bind(response)
      response.json = async () => {
        const data: unknown = await read()
        // The consumer's await continuation runs before this next task.
        setTimeout(() => { observed.timerJsonReads = (observed.timerJsonReads ?? 0) + 1 }, 0)
        return data
      }
      return response
    }
  })
  const one = timerView({ id: 'one', sessionId: 's1', label: 'Check CI', state: 'held', reason: 'person_held' })
  const state = makeState([session({ id: 's1' })])
  state.timers = { s1: timersData({ timers: [one], holds: [{ sessionId: 's1', cause: 'held', since: NOW }] }) }
  await installRoutes(page, state)
  let holdNext = false
  let entered!: () => void
  let release!: () => void
  const requested = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/chat/sessions/s1/timers', async route => {
    if (!holdNext) return route.fallback()
    holdNext = false
    const old = structuredClone(state.timers!.s1)
    entered()
    await held
    await route.fulfill({ json: old })
  })
  const sock = await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  const pane = page.locator('#chat-timers-pane')
  await expect(pane.getByRole('button', { name: 'Resume', exact: true })).toBeVisible()
  holdNext = true
  sock.push('s1', { type: 'timer.changed', timer: summary(one), change: 'held' })
  await requested
  try {
    await pane.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(pane.getByRole('button', { name: 'Hold', exact: true })).toHaveAttribute('aria-pressed', 'false')
  } finally { release() }
  await expect.poll(() => page.evaluate(() => (window as Window & { timerJsonReads?: number }).timerJsonReads)).toBeGreaterThanOrEqual(3)
  await expect(pane.getByRole('button', { name: 'Hold', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(pane.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0)
  await expect(pane.locator('.chat-timer-status')).not.toContainText('on hold')
})

test('recovers timer controls after a failed refetch returns unchanged data', async ({ page }) => {
  const one = timerView({ id: 'timer-1', label: 'Check CI' })
  const state = makeState([session({ id: 's1' })])
  state.timers = { s1: timersData({ timers: [one] }) }
  await installRoutes(page, state)
  let unavailable = false
  await page.route('**/api/chat/sessions/s1/timers', route => unavailable
    ? route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } }) : route.fallback())
  const sock = await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  const pane = page.locator('#chat-timers-pane')
  await expect(pane.locator('.chat-timer')).toHaveCount(1)
  await pane.locator('.chat-timers-label').fill('Unsent label')
  await pane.locator('.chat-timers-message').fill('Unsent message')
  await pane.locator('.chat-timers-kind').selectOption('once')
  await pane.locator('.chat-timers-minutes').fill('25')
  unavailable = true
  sock.push('s1', { type: 'timer.changed', timer: summary(one), change: 'held' })
  await expect(pane.getByRole('alert')).toContainText('Timers could not be loaded')
  await expect(pane.locator('.chat-timers-label')).toHaveValue('Unsent label')
  await expect(pane.locator('.chat-timers-message')).toHaveValue('Unsent message')
  await expect(pane.locator('.chat-timers-kind')).toHaveValue('once')
  await expect(pane.locator('.chat-timers-minutes')).toHaveValue('25')
  await pane.locator('.chat-timers-message').fill('Still composing after failure')
  unavailable = false
  sock.push('s1', { type: 'timer.changed', timer: summary(one), change: 'released' })
  await expect(pane.locator('.chat-timer')).toHaveCount(1)
  await expect(pane.locator('.chat-timers-add')).toBeVisible()
  await expect(pane.getByRole('alert')).toBeHidden()
  await expect(pane.locator('.chat-timers-label')).toHaveValue('Unsent label')
  await expect(pane.locator('.chat-timers-message')).toHaveValue('Still composing after failure')
  await expect(pane.locator('.chat-timers-kind')).toHaveValue('once')
  await expect(pane.locator('.chat-timers-minutes')).toHaveValue('25')
})

test('renders timer turns, timer changes and every wait cause with escaped labels', async ({ page }) => {
  const evil = '<b>x</b>'
  const state = makeState([session({ id: 's1' })])
  state.settings.timezone = 'UTC'
  const message = `${'a'.repeat(199)}👍b`
  const preview = timerView({ id: 'timer-9', message })
  const waits: Array<{ id: string, waitingFor: NonNullable<NonNullable<TimerSummary['pending']>['waitingFor']> }> = [
    { id: 'w-starting', waitingFor: 'starting' }, { id: 'w-queued', waitingFor: 'queued' }, { id: 'w-running', waitingFor: 'running' },
    { id: 'w-waiting', waitingFor: 'waiting' }, { id: 'w-stopping', waitingFor: 'stopping' }, { id: 'w-maintenance', waitingFor: 'maintenance' },
    { id: 'w-queue', waitingFor: 'queue' }, { id: 'w-reopening', waitingFor: 'reopening' }, { id: 'w-model', waitingFor: 'model' },
    { id: 'w-person', waitingFor: 'person' }, { id: 'w-update', waitingFor: 'update' }, { id: 'w-backoff', waitingFor: 'backoff' },
  ]
  state.timers = { s1: timersData({ timers: [preview, ...waits.map((w, i) => timerView({
    id: w.id, label: `Wait ${i}`, nextAt: null, notBefore: '2026-09-18T14:50:00.000Z',
    pending: { since: '2026-09-18T12:05:00.000Z', missed: 0, waitingFor: w.waitingFor },
  }))] }) }
  state.sessions[0].queuedBehind = 'a queued model change'
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await sock.subscribed('s1')

  // A timer turn names its timer, setter and collapsed firings.
  sock.push('s1', { type: 'turn.started', turnId: 'turn-1',
    prompt: { text: 'Shown text', attachments: [], mentions: [] },
    source: { kind: 'timer', timerId: 'timer-1', label: evil, setBy: { kind: 'chat', sessionId: 'm1', title: 'Manager', role: 'manager' }, missed: 3, dueAt: NOW, seq: 7 } })
  const source = page.locator('.chat-msg-source')
  await expect(source).toHaveText(`Timer "${evil}" · set by Manager · 3 earlier firings collapsed`)
  await expect(page.locator('.chat-msg-source b')).toHaveCount(0)

  // A trip lands as a note with its last error.
  sock.push('s1', { type: 'timer.changed', timer: summary(timerView({ id: 'timer-1', label: 'Check CI' })), change: 'tripped', error: 'native start failed' })
  await expect(page.locator('.chat-note').last()).toHaveText('Timer "Check CI" stopped after 3 failed turns: native start failed. Re-arm it from Timers.')

  // A person-stopped turn reads Stopped by you.
  sock.push('s1', { type: 'turn.finished', turnId: 'turn-1', stopReason: 'cancelled', stoppedBy: { kind: 'person' } })
  await expect(page.locator('.chat-turn').last()).toContainText('Stopped by you')

  // The pane cuts a preview at 200 code points without splitting the emoji.
  await page.getByRole('button', { name: 'Timers', exact: true }).click()
  const pane = page.locator('#chat-timers-pane')
  await expect(pane.locator('.chat-timer[data-timer="timer-9"] .chat-timer-preview')).toHaveText(`${'a'.repeat(199)}👍…`)

  const status = (id: string) => pane.locator(`.chat-timer[data-timer="${id}"] .chat-timer-status`)
  await expect(status('w-starting')).toContainText('waiting: chat is starting')
  await expect(status('w-queued')).toContainText('waiting: chat is queued (a queued model change)')
  await expect(status('w-running')).toContainText('waiting: chat is running')
  await expect(status('w-waiting')).toContainText('waiting: chat is waiting for an answer or permission')
  await expect(status('w-stopping')).toContainText('waiting: chat is stopping')
  await expect(status('w-maintenance')).toContainText('waiting: chat is resetting or compacting')
  await expect(status('w-queue')).toContainText('waiting for queued tasks')
  await expect(status('w-reopening')).toContainText('waiting: reopening the chat')
  await expect(status('w-model')).toContainText('waiting: choose a model for the Manager')
  await expect(status('w-person')).toContainText('waiting: you were just here')
  await expect(status('w-update')).toContainText('waiting: Poise is updating')
  await expect(status('w-backoff')).toContainText('waiting: retry after 18 Sept 14:50')
  for (const w of waits) await expect(status(w.id)).toContainText('waiting since')
})
