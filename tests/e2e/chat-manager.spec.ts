import { expect, test } from '@playwright/test'
import { NOW, session, installRoutes, installSocket, makeState } from './fixtures/chat'

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
