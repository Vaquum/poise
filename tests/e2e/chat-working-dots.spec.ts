import { expect, test, type Page } from '@playwright/test'
import { installRoutes, installSocket, makeState, session } from './fixtures/chat'
import { settled } from './fixtures/motion'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('poise-view', 'chat')
  })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
})

async function runningTurn(page: Page): Promise<Awaited<ReturnType<typeof installSocket>>> {
  const state = makeState([session({ id: 's1', status: 'idle' })], { s1: [] })
  await installRoutes(page, state)
  const sock = await installSocket(page, state)
  await page.goto('/')
  await sock.subscribed('s1')
  return sock
}

test('the running turn dots pulse while the agent works and stop with the turn', async ({ page }) => {
  const sock = await runningTurn(page)
  sock.push('s1', { type: 'turn.started', turnId: 't1', prompt: { text: 'Do it', attachments: [], mentions: [] } })
  sock.push('s1', { type: 'status.changed', status: 'running' })
  const dots = page.locator('.chat-thinking.is-live')
  await expect(dots).toBeVisible()
  const dot = dots.locator('span').first()
  await expect.poll(() => dot.evaluate((el) => getComputedStyle(el).animationName)).toBe('chat-pulse')
  // A screenshot or visibility assertion would miss a frozen pulse: the
  // opacity itself must move over time.
  const opacities = new Set<string>()
  for (let i = 0; i < 3; i++) {
    opacities.add(await dot.evaluate((el) => getComputedStyle(el).opacity))
    await page.waitForTimeout(450)
  }
  expect(opacities.size).toBeGreaterThan(1)
  // The infinite pulse must not hold the motion gate: settling waits out
  // finite motion only.
  await settled(page)
  sock.push('s1', { type: 'turn.finished', turnId: 't1', stopReason: 'end_turn' })
  await expect(page.locator('.chat-thinking')).toHaveCount(0)
})

test('the dots hold still while the agent waits on the person', async ({ page }) => {
  const sock = await runningTurn(page)
  sock.push('s1', { type: 'turn.started', turnId: 't1', prompt: { text: 'Do it', attachments: [], mentions: [] } })
  sock.push('s1', { type: 'status.changed', status: 'waiting' })
  const dots = page.locator('.chat-thinking')
  await expect(dots).toBeVisible()
  await expect(dots).not.toHaveClass(/is-live/)
  await expect.poll(() => dots.locator('span').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  // Back to work without recreating the dots: the pulse resumes in place.
  sock.push('s1', { type: 'status.changed', status: 'running' })
  await expect(dots).toHaveClass(/is-live/)
  await expect.poll(() => dots.locator('span').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('chat-pulse')
})

test('reduced motion stills the working pulse', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const sock = await runningTurn(page)
  sock.push('s1', { type: 'turn.started', turnId: 't1', prompt: { text: 'Do it', attachments: [], mentions: [] } })
  sock.push('s1', { type: 'status.changed', status: 'running' })
  const dots = page.locator('.chat-thinking.is-live')
  await expect(dots).toBeVisible()
  await expect.poll(() => dots.locator('span').first().evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
})
