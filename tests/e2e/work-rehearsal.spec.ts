import { expect, test } from '@playwright/test'
import type { RehearsalTableData } from '../../src/views/work-rehearsal-table'
import { plan, pull, HEAD } from '../fixtures/work-rehearsal'
import { input, installRoutes, installSocket, makeState, session, switchboardState, timersData } from './fixtures/chat'
import { mountRehearsalTable } from './fixtures/work-rehearsal'

function recording(manager: string | null = 'm1'): RehearsalTableData {
  const now = Date.now()
  return { manager, observedAt: now, release: null, error: null,
    rows: [{ title: 'Fix login', manager, worker: manager ? { id: 's2', title: 'Login worker', status: 'idle' } : null,
      work: { ...plan(), checkedAt: now, mode: manager ? 'interactive' : 'headless' },
      decision: { kind: 'propose', action: 'create-issue', basisRevision: 1, head: null, issueBodyRevision: null },
      history: [{ seq: 1, at: now, text: 'Plan assigned; issue publication not observed' }] }] }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('chat-fixture-initialized')) {
      localStorage.clear(); localStorage.setItem('poise-view', 'chat'); sessionStorage.setItem('chat-fixture-initialized', '1')
    }
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort())
})

for (const version of ['v1', 'v2 rehearsal'] as const) {
  test(`${version}: the same Manager draft, permission, question, timer and Stop controls`, async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 900 })
    const state = makeState([session({ id: 'm1', title: 'Manager', role: 'manager', status: 'running' }),
      session({ id: 's2', title: 'Login worker', role: 'worker' })])
    state.timers = { m1: timersData() }
    await installRoutes(page, state)
    const socket = await installSocket(page, state)
    await page.goto('/')
    await socket.subscribed('m1')
    if (version === 'v2 rehearsal') {
      const writes = state.calls.filter(call => call.method !== 'GET').length
      const frames = socket.frames.length
      await mountRehearsalTable(page, recording())
      expect(state.calls.filter(call => call.method !== 'GET')).toHaveLength(writes)
      expect(socket.frames).toHaveLength(frames)
    }
    await input(page).fill('Keep my Manager draft')
    await page.locator('.chat-session-item[data-id="s2"]').click()
    await page.locator('.chat-session-item[data-id="m1"]').click()
    await expect(input(page)).toHaveValue('Keep my Manager draft')
    socket.push('m1', { type: 'permission.requested', id: 'p1', turnId: 't1', title: 'Run tests', description: 'Run isolated tests',
      input: { command: 'npm test' }, options: [{ id: 'once', name: 'Allow once', kind: 'allow_once' }] })
    socket.push('m1', { type: 'status.changed', status: 'waiting' })
    await page.locator('.chat-permission .chat-card-btn').click()
    await expect.poll(() => socket.framesOf('permission.respond').length).toBe(1)
    expect(socket.framesOf('permission.respond')[0].command).toMatchObject({ sessionId: 'm1', id: 'p1', optionId: 'once' })
    socket.push('m1', { type: 'permission.resolved', id: 'p1', optionId: 'once', by: 'user' })
    socket.push('m1', { type: 'question.asked', id: 'q1', turnId: 't1', questions: [{ id: 'q', question: 'Target?', options: [], multiSelect: false, freeText: true }] })
    await page.locator('.chat-question .chat-q-text').fill('test fixture')
    await page.locator('.chat-question .chat-q-submit').click()
    await expect.poll(() => socket.framesOf('question.answer').length).toBe(1)
    expect(socket.framesOf('question.answer')[0].command).toMatchObject({ id: 'q1', answers: { q: 'test fixture' } })
    socket.push('m1', { type: 'question.answered', id: 'q1', answers: { q: 'test fixture' }, by: 'user' })
    socket.push('m1', { type: 'status.changed', status: 'running' })
    await page.getByRole('button', { name: 'Timers', exact: true }).click()
    const timers = page.locator('#chat-timers-pane')
    await timers.locator('.chat-timers-label').fill('Check CI')
    await timers.locator('.chat-timers-message').fill('Read the current head')
    await timers.locator('.chat-timers-minutes').fill('15')
    await timers.getByRole('button', { name: 'Add timer' }).click()
    await expect.poll(() => socket.framesOf('timer.create').length).toBe(1)
    expect(socket.framesOf('timer.create')[0].command).toMatchObject({ sessionId: 'm1', label: 'Check CI', everyMinutes: 15 })
    await timers.getByRole('button', { name: 'Hold', exact: true }).click()
    await expect.poll(() => socket.framesOf('chat.hold').length).toBe(1)
    await timers.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect.poll(() => socket.framesOf('chat.hold').length).toBe(2)
    await page.locator('.chat-h-stop').click()
    await expect.poll(() => socket.framesOf('cancel').length).toBe(1)
    await expect(input(page)).toHaveValue('Keep my Manager draft')
  })
}

test('keeps Manager / task table / Switchboard together, with retained history and no model work on reads or resize', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 })
  const state = makeState([session({ id: 'm1', title: 'Manager', role: 'manager' }), session({ id: 's2', title: 'Login worker', role: 'worker' })])
  state.switchboard = switchboardState()
  await installRoutes(page, state)
  const socket = await installSocket(page, state)
  await page.goto('/')
  await socket.subscribed('m1')
  const data = recording()
  data.rows.push({ ...data.rows[0], manager: 'another-manager', title: 'Unrelated work' })
  await mountRehearsalTable(page, data)
  await page.getByRole('button', { name: /^Switchboard/ }).click()
  const table = page.getByRole('region', { name: 'Work rehearsal' })
  await expect(table).toContainText('No issue yet')
  await expect(table).not.toContainText('Unrelated work')
  await expect(page.locator('#chat-switchboard-pane')).toContainText('Start the Switchboard')
  await expect.poll(() => page.evaluate(() => {
    const left = document.querySelector('.chat-main')!.getBoundingClientRect()
    const middle = document.querySelector('.work-rehearsal-table')!.getBoundingClientRect()
    const right = document.querySelector('#chat-switchboard-pane')!.getBoundingClientRect()
    return left.right <= middle.left + 1 && middle.right <= right.left + 1
  })).toBe(true)
  const frames = socket.frames.length
  const writes = state.calls.filter(call => call.method !== 'GET').length
  const fits = () => page.evaluate(() => {
    const layout = document.querySelector('.chat-layout')!.getBoundingClientRect()
    const main = document.querySelector('.chat-main')!.getBoundingClientRect()
    const panes = [...document.querySelector('.chat-layout')!.children].filter(node => getComputedStyle(node).position !== 'absolute')
    return main.width >= 320 && panes.every(node => node.getBoundingClientRect().right <= layout.right + 1)
  })
  await expect.poll(() => page.locator('#chat-switchboard-pane').evaluate(el => el.hasAttribute('data-motion-running'))).toBe(false)
  await page.getByRole('separator', { name: 'Resize Switchboard', exact: true }).press('End')
  await expect.poll(() => page.evaluate(() => {
    const layout = document.querySelector('.chat-layout')!.getBoundingClientRect()
    const board = document.querySelector('#chat-switchboard-pane')!.getBoundingClientRect()
    const occupied = [...document.querySelector('.chat-layout')!.children]
      .filter(node => !node.classList.contains('chat-main') && node.id !== 'chat-switchboard-pane' && getComputedStyle(node).position !== 'absolute')
      .reduce((sum, node) => sum + node.getBoundingClientRect().width, 0)
    return Math.abs(board.width - (layout.width - occupied - 320)) < 2
  })).toBe(true)
  await expect.poll(fits).toBe(true)
  await page.getByRole('separator', { name: 'Resize sessions pane', exact: true }).press('End')
  await expect.poll(fits).toBe(true)
  await table.getByRole('slider', { name: 'Resize work table' }).press('ArrowLeft')
  expect((await page.locator('.chat-main').boundingBox())!.width).toBeGreaterThanOrEqual(320)
  data.rows[0].work = { ...pull(), checkedAt: Date.now(), revision: 2 }
  data.rows[0].history.unshift({ seq: 2, at: Date.now(), text: `PR published at ${HEAD}` })
  await page.evaluate(next => window.workRehearsalTable.update(next), data)
  await expect(table.getByRole('link', { name: '#17' })).toBeVisible()
  await expect(table).toContainText('Plan assigned; issue publication not observed')
  await expect(table).toContainText('PR published')
  data.error = 'recorded observation read failed'
  await page.evaluate(next => window.workRehearsalTable.update(next), data)
  await expect(table.getByRole('status')).toContainText('refresh failed')
  await expect(table.locator('tbody tr').first().locator('td').filter({ hasText: /^\?$/ })).toHaveCount(4)
  expect(socket.frames).toHaveLength(frames)
  expect(state.calls.filter(call => call.method !== 'GET')).toHaveLength(writes)
})

test('shows headless work without creating a Manager, and stays responsive with retained history', async ({ page }) => {
  const state = makeState([session()])
  await installRoutes(page, state)
  const socket = await installSocket(page, state)
  await page.goto('/')
  await socket.subscribed('s1')
  const data = recording(null)
  await mountRehearsalTable(page, data)
  await expect(page.locator('.work-rehearsal-table')).toContainText('Headless')
  data.rows = Array.from({ length: 100 }, (_, i) => ({ ...data.rows[0], title: `Task ${i}`, work: { ...data.rows[0].work, id: `work-${i}` },
    history: Array.from({ length: 20 }, (_, seq) => ({ seq, at: data.observedAt, text: `Recorded transition ${seq}` })) }))
  const elapsed = await page.evaluate(next => {
    const before = performance.now(); window.workRehearsalTable.update(next); return performance.now() - before
  }, data)
  await expect(page.locator('.work-rehearsal-table tbody tr')).toHaveCount(100)
  expect(elapsed).toBeLessThan(1000)
  await test.info().attach('rehearsal-table-metrics', { body: JSON.stringify({ rows: 100, retainedTransitions: 2000, updateMs: elapsed }), contentType: 'application/json' })
  expect(state.calls.filter(call => call.method !== 'GET')).toHaveLength(0)
  expect(socket.framesOf('prompt')).toHaveLength(0)
  expect(state.sessions.some(record => record.role === 'manager')).toBe(false)
})
