import { expect, test } from '@playwright/test'
import { session, installRoutes, installSocket, env, makeState } from './fixtures/chat'

// The sessions pane as a live work log: the tools toggle, the working
// indicator, drag-to-pin ordering, and the header's running duration.

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

test('the tools toggle hides tool cards but keeps text, and survives a reload', async ({ page }) => {
  const history = [
    env('s1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'go', attachments: [], mentions: [] } }),
    env('s1', 2, { type: 'text.delta', turnId: 't1', messageId: 'm1', delta: 'Working on it.' }),
    env('s1', 3, { type: 'tool.started', turnId: 't1', id: 'x1', kind: 'execute', title: 'npm test' }),
    env('s1', 4, { type: 'tool.finished', turnId: 't1', id: 'x1', status: 'completed' }),
    env('s1', 5, { type: 'turn.finished', turnId: 't1', stopReason: 'end_turn', durationMs: 1000 }),
  ]
  const state = makeState([session({ lastSeq: 5 })], { s1: history })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  const tool = page.locator('.chat-tool').filter({ hasText: 'npm test' })
  await expect(tool).toBeVisible()
  await expect(page.locator('.chat-msg-agent')).toContainText('Working on it.')
  const toggle = page.getByRole('button', { name: 'Hide tools' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(tool).toBeHidden()
  await expect(page.locator('.chat-msg-agent')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Show tools' })).toHaveAttribute('aria-pressed', 'false')
  await page.reload()
  await expect(page.locator('.chat-tool').filter({ hasText: 'npm test' })).toBeHidden()
  await expect(page.locator('.chat-msg-agent')).toContainText('Working on it.')
})

test('the working indicator shows only while a turn runs', async ({ page }) => {
  const state = makeState([session({ status: 'running' })], { s1: [env('s1', 1, { type: 'turn.started', turnId: 't1', prompt: { text: 'go', attachments: [], mentions: [] } })] })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  sock.seq = 1
  await expect(page.locator('.chat-thinking')).toBeVisible()
  // Still there after text and tool output stream in.
  sock.push('s1', { type: 'text.delta', turnId: 't1', messageId: 'm1', delta: 'Halfway there.' })
  sock.push('s1', { type: 'tool.started', turnId: 't1', id: 'x1', kind: 'execute', title: 'npm test' })
  await expect(page.locator('.chat-msg-agent')).toContainText('Halfway there.')
  await expect(page.locator('.chat-tool')).toBeVisible()
  await expect(page.locator('.chat-thinking')).toBeVisible()
  // Gone when the turn ends.
  sock.push('s1', { type: 'tool.finished', turnId: 't1', id: 'x1', status: 'completed' })
  sock.push('s1', { type: 'turn.finished', turnId: 't1', stopReason: 'end_turn', durationMs: 1000 })
  sock.push('s1', { type: 'status.changed', status: 'idle' })
  await expect(page.locator('.chat-thinking')).toHaveCount(0)
})

test('dragging a chat pins it, and a later status change does not move it', async ({ page }) => {
  const state = makeState([
    session({ id: 's2', title: 'Second', createdAt: '2026-09-18T10:00:00.000Z', updatedAt: '2026-09-18T10:00:00.000Z' }),
    session(),
  ])
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  const items = page.locator('.chat-session-item')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toContainText('Second')
  // Drag the second row above the first: a synthetic DataTransfer travels
  // through the real drag handlers.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.chat-session-item')]
    const dt = new DataTransfer()
    rows[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: rows[0].getBoundingClientRect().top + 2, dataTransfer: dt }))
    rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    rows[1].dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })
  await expect(items.nth(0)).toContainText('Fix the login bug')
  await expect(items.nth(0).locator('.chat-session-pin')).toBeVisible()
  // A newer change on the other chat does not move the pin.
  const other = state.sessions.find((s) => s.id === 's2')!
  other.status = 'running'
  sock.seq = 10
  sock.push('s2', { type: 'status.changed', status: 'running' })
  await expect(items.nth(0)).toContainText('Fix the login bug')
  await expect(items.nth(1)).toContainText('Second')
  // The pin survives a reload.
  await page.reload()
  await expect(page.locator('.chat-session-item').nth(0)).toContainText('Fix the login bug')
  await expect(page.locator('.chat-session-item').nth(0).locator('.chat-session-pin')).toBeVisible()
})

test('keeps the Manager above dragged, keyboard-moved and restored pins', async ({ page }) => {
  const state = makeState([
    session({ id: 'manager', title: 'Manager', role: 'manager' }),
    session({ id: 's2', title: 'Second', updatedAt: '2026-09-18T10:00:00.000Z' }),
    session(),
  ])
  await installRoutes(page, state)
  await installSocket(page)
  await page.goto('/')
  const items = page.locator('.chat-session-item')
  await expect(items).toHaveCount(3)
  await expect(items.first()).toHaveAttribute('data-id', 'manager')
  await page.evaluate(() => {
    const manager = document.querySelector<HTMLElement>('.chat-session-item[data-id="manager"]')!
    const ordinary = document.querySelector<HTMLElement>('.chat-session-item[data-id="s1"]')!
    const dt = new DataTransfer()
    ordinary.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
    manager.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: manager.getBoundingClientRect().top + 2, dataTransfer: dt }))
    manager.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    ordinary.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
  })
  await expect(items.first()).toHaveAttribute('data-id', 'manager')
  await expect(items.nth(1)).toHaveAttribute('data-id', 's1')
  await expect(items.nth(1).locator('.chat-session-pin')).toBeVisible()
  await items.first().press('Alt+ArrowDown')
  await expect(items.first()).toHaveAttribute('data-id', 'manager')
  await expect(items.first()).toHaveAttribute('draggable', 'false')
  await expect(items.first().locator('.chat-session-pin')).toHaveCount(0)
  await page.evaluate(() => {
    localStorage.setItem('poise-chat-pinned', JSON.stringify(['s1', 'manager']))
    localStorage.setItem('poise-chat-sidebar-order', JSON.stringify(['s1', 's2', 'manager']))
  })
  await page.reload()
  await expect(items.first()).toHaveAttribute('data-id', 'manager')
  await expect(items.first().locator('.chat-session-pin')).toHaveCount(0)
  await expect(items.nth(1)).toHaveAttribute('data-id', 's1')
})

test('the top bar shows how long the turn has run during a scripted long turn', async ({ page }) => {
  // Date is fixed while timers keep running, so the header's one-second tick runs on wall time.
  await page.clock.setFixedTime(new Date('2026-10-21T17:00:00Z'))
  const go = { text: 'go', attachments: [], mentions: [] }
  const state = makeState([session({ status: 'running' })], { s1: [
    { seq: 1, sessionId: 's1', at: '2026-10-21T16:48:00.000Z', event: { type: 'turn.started', turnId: 't1', prompt: go } },
  ] })
  await installRoutes(page, state)
  const sock = await installSocket(page)
  await page.goto('/')
  await sock.subscribed('s1')
  const since = page.locator('.chat-h-since')
  await expect(page.locator('.chat-h-status')).toHaveText('running')
  await expect(since).toHaveText('· since 12m')
  // Live: the label advances with the clock, with no new events.
  await page.clock.setFixedTime(new Date('2026-10-21T17:01:00Z'))
  await expect(since).toHaveText('· since 13m')
  // Settled chats show no duration.
  sock.seq = 1
  sock.push('s1', { type: 'turn.finished', turnId: 't1', stopReason: 'end_turn', durationMs: 1000 })
  sock.push('s1', { type: 'status.changed', status: 'idle' })
  await expect(since).toHaveCount(0)
})
