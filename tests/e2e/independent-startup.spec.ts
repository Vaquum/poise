import { expect, test } from '@playwright/test'
import { input, installRoutes, installSocket, makeState, session } from './fixtures/chat'

test('Chat paints its catalogue before global settings and preserves the draft after they arrive', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('poise-view', 'chat')
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => route.abort())
  await installRoutes(page, makeState([session({ id: 'ready', title: 'Ready conversation' })]))
  const socket = await installSocket(page)
  let release!: () => void
  const settings = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/settings', async route => {
    await settings
    await route.fallback()
  })
  try {
    const start = Date.now()
    await page.goto('/')
    const selected = page.locator('.chat-session-item.active')
    await expect(selected).toContainText('Ready conversation', { timeout: 2000 })
    await socket.subscribed('ready')
    await input(page).fill('Unsent startup draft')
    const actor = await input(page).elementHandle()
    console.log(`Chat first session: ${Date.now() - start}ms; global settings still held`)
    const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings')
    release()
    await (await received).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(selected).toContainText('Ready conversation')
    await expect(input(page)).toHaveValue('Unsent startup draft')
    expect(await actor!.evaluate(node => node.isConnected && document.activeElement === node)).toBe(true)
  } finally { release() }
})
