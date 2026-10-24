import { expect, test } from '@playwright/test'
import { NOW, session, installRoutes, installSocket, makeState, input } from './fixtures/chat'

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

test('offers Worker and Manager as exclusive choices with neither selected, and lists a worker with its pill', async ({ page }) => {
  const state = makeState([
    session({ id: 's2', title: 'Second', createdAt: '2026-09-18T10:00:00.000Z' }),
    session(),
  ])
  await installRoutes(page, state)
  await installSocket(page, state)
  await page.goto('/')
  await page.getByRole('button', { name: 'New session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await expect(dialog.locator('input[name="type"][value="chat"]')).toBeChecked()
  await expect(dialog.locator('input[name="type"][value="worker"]')).not.toBeChecked()
  await expect(dialog.locator('input[name="type"][value="manager"]')).not.toBeChecked()
  await dialog.locator('input[name="type"][value="manager"]').check()
  await expect(dialog.locator('input[name="type"][value="worker"]')).not.toBeChecked()
  await dialog.locator('input[name="type"][value="worker"]').check()
  await expect(dialog.locator('input[name="type"][value="manager"]')).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect.poll(() => state.calls.find(c => c.method === 'POST' && c.path === '/api/chat/sessions')?.body)
    .toMatchObject({ role: 'worker' })
  const worker = page.locator('.chat-session-item[data-id="new-3"]')
  await expect(worker.locator('.chat-pill-worker')).toHaveText('Worker')
})

test('marks /worker as built in, edits it without a Delete, and refuses it in non-worker chats', async ({ page }) => {
  const evil = '<img src=x onerror=alert(1)>'
  const skills = { revision: 1, switches: [
    { name: 'worker', content: evil, revision: 1, updatedAt: NOW, snippetTrigger: ';worker' },
    { name: 'other', content: 'Other text', revision: 1, updatedAt: NOW, snippetTrigger: ';other' },
  ] }
  const state = makeState([
    session({ id: 's1', title: 'Ordinary', createdAt: NOW }),
    session({ id: 'm1', title: 'Manager', role: 'manager', createdAt: '2026-09-18T10:00:00.000Z' }),
    session({ id: 'w1', title: 'Ticket work', role: 'worker', createdAt: '2026-09-17T10:00:00.000Z' }),
  ])
  state.switches = skills
  state.snippets = { snippets: [{ trigger: ';worker', replace: evil }, { trigger: ';other', replace: 'Other text' }], version: 'fixture-v1', skills }
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await sock.subscribed('m1')

  await expect(page.locator('.chat-session-item[data-id="w1"] .chat-pill-worker')).toHaveText('Worker')

  await page.getByRole('button', { name: 'Snippets', exact: true }).click()
  const view = page.locator('#view-snippets')
  const row = view.locator('.snip-row[data-trigger=";worker"]')
  await expect(row.locator('.snip-builtin')).toHaveText('built in')
  await expect(view.locator('.snip-builtin')).toHaveCount(1)
  await row.click()
  const editor = view.locator('.snip-expand-row')
  await expect(editor.locator('.snip-trigger-input')).toHaveAttribute('readonly', '')
  await expect(editor.locator('.snip-delete')).toHaveCount(0)
  await expect(editor.locator('.snip-builtin-note')).toContainText('Built in: a worker\'s standing instructions')
  await expect(editor.getByRole('textbox', { name: 'Snippet instructions' })).toHaveValue(evil)
  await expect(page.locator('img')).toHaveCount(0)
  await editor.getByRole('textbox', { name: 'Snippet instructions' }).fill('Work the ticket')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(view.locator('.snip-expand-row')).toHaveCount(0)
  const put = state.calls.find(call => call.method === 'PUT' && call.path === '/api/snippets')
  expect(put?.body).toMatchObject({ snippets: [
    { trigger: ';worker', replace: 'Work the ticket' },
    { trigger: ';other', replace: 'Other text' },
  ] })

  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  for (const id of ['s1', 'm1']) {
    await page.locator(`.chat-session-item[data-id="${id}"]`).click()
    await expect(page.locator(`.chat-session-item[data-id="${id}"]`)).toHaveClass(/active/)
    await input(page).fill('/worker hello')
    await input(page).press('Enter')
    await expect(page.locator('.chat-notice')).toHaveText('/worker is not supported in non-worker chats.')
    await expect(page.locator('.chat-notice')).toHaveClass(/st-help-info/)
    await expect(input(page)).toHaveValue('/worker hello')
  }
  expect(sock.framesOf('prompt')).toEqual([])

  await page.locator('.chat-session-item[data-id="s1"]').click()
  await input(page).fill('/reset /worker hello')
  await input(page).press('Enter')
  await expect(page.locator('.chat-notice')).toHaveText('/worker is not supported in non-worker chats.')
  await expect(input(page)).toHaveValue('/reset /worker hello')
  expect(sock.framesOf('prompt')).toEqual([])
  expect(sock.framesOf('context.reset')).toEqual([])

  await page.locator('.chat-session-item[data-id="w1"]').click()
  await expect(page.locator('.chat-session-item[data-id="w1"]')).toHaveClass(/active/)
  await input(page).fill('/worker hello')
  await input(page).press('Enter')
  await expect.poll(() => sock.framesOf('prompt').length).toBe(1)
  expect(sock.framesOf('prompt')[0].command).toMatchObject({ type: 'prompt', sessionId: 'w1', text: '/worker hello' })
})
