import { expect, test, type Page } from '@playwright/test'

import { workspace } from './fixtures/workspace'
import { settled as motionSettled } from './fixtures/motion'

async function open(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('#menu-popover').getByRole('button', { name, exact: true }).click()
  await expect(page.locator('#menu-surface')).toHaveClass('open')
}

async function attached(page: Page): Promise<void> {
  await expect.poll(async () => {
    const burger = await page.locator('#menu-toggle').boundingBox()
    const frame = await page.locator('#menu-surface').boundingBox()
    return burger && frame ? Math.abs(frame.y - (burger.y + burger.height - 1)) + Math.abs(frame.x + frame.width - burger.x - burger.width) : 100
  }).toBeLessThan(2)
}

async function settled(page: Page): Promise<void> {
  await motionSettled(page)
  await expect(page.locator('#menu-surface')).toHaveCSS('opacity', '1')
  await page.locator('#menu-surface').evaluate(async (element) => {
    // The width transition schedules a final height measurement. Wait for
    // that frame too, so visual evidence shows the finished surface.
    for (let i = 0; i < 3; i++) {
      await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished))
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    }
  })
}

test('opens Settings destinations directly on one frame and returns to the menu', async ({ page }) => {
  await workspace(page)
  await page.locator('#menu-toggle').click()
  await expect(page.locator('#menu-popover .menu-group-label')).toHaveText('Settings')
  await expect(page.locator('#menu-popover .menu-item:not([hidden])')).toHaveText(['Analytics', 'Logging', 'General', 'Models', 'Accounts', 'Publishing', 'Typography'])
  await attached(page)
  for (const section of ['General', 'Models', 'Accounts', 'Publishing', 'Typography']) {
    await page.locator('#menu-popover').getByRole('button', { name: section, exact: true }).click()
    await expect(page.locator('#menu-surface .menu-panel.open .tp-title')).toHaveText(section)
    await expect(page.locator('#menu-surface .tp-close')).toHaveCount(0)
    await expect(page.locator('#settings-panel [role="tablist"]')).toHaveCount(0)
    if (section === 'General') await page.getByLabel('Branch prefix', { exact: true }).fill('scratch/')
    if (section === 'Models') expect(await page.locator('#settings-panel .tp-body').evaluate((body) => body.scrollTop)).toBe(0)
    await expect(page.locator('#menu-toggle')).toHaveAttribute('aria-expanded', 'true')
    await attached(page)
    await page.getByRole('button', { name: 'Back to menu' }).click()
    await expect(page.locator('#menu-popover')).toBeVisible()
    await expect(page.locator('#menu-surface .menu-panel.open')).toHaveCount(0)
    await attached(page)
  }
  await page.locator('#menu-popover').getByRole('button', { name: 'General', exact: true }).click()
  await expect(page.getByLabel('Branch prefix', { exact: true })).toHaveValue('scratch/')
  await page.locator('#menu-toggle').click()
  await expect(page.locator('#settings-panel')).toHaveAttribute('inert', '')
  await expect(page.locator('#menu-toggle')).toBeFocused()
  await expect(page.locator('#menu-toggle')).toHaveAttribute('aria-expanded', 'false')
})

test('rapid close and reopen never loses the menu, and keyboard navigation reaches a panel', async ({ page }) => {
  await workspace(page)
  const toggle = page.locator('#menu-toggle')
  await toggle.click()
  await toggle.click()
  await toggle.click()
  await expect(page.locator('#menu-popover')).toBeVisible()
  await page.keyboard.press('Escape')
  await toggle.press('ArrowDown')
  await expect(page.getByRole('button', { name: 'Analytics', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('button', { name: 'Logging', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('button', { name: 'General', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings-panel')).toHaveAttribute('inert', '')
  await expect(toggle).toBeFocused()
})

test('Analytics leaves the menu for a view of its own and returns focus to the burger', async ({ page }) => {
  await workspace(page)
  const toggle = page.locator('#menu-toggle')
  await toggle.press('ArrowDown')
  await expect(page.getByRole('button', { name: 'Analytics', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#view-analytics')).toBeVisible()
  await expect(page.locator('#view-current')).toBeHidden()
  await expect(page.locator('#view-analytics .analytics-tile')).toHaveCount(13)
  await expect(page.locator('#menu-surface')).toBeHidden()
  await expect(page.locator('#menu-surface .menu-panel.open')).toHaveCount(0)
  await expect(toggle).toBeFocused()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(await toggle.evaluate((burger) => burger.closest('.view')?.id)).toBe('view-analytics')
  // Settings still open over Analytics, and closing them leaves it in place.
  await open(page, 'General')
  await toggle.click()
  await expect(page.locator('#settings-panel')).toHaveAttribute('inert', '')
  await expect(page.locator('#view-analytics')).toBeVisible()
})

test('separates GitHub sign-ins and keeps command details out of the account rows', async ({ page }) => {
  await workspace(page)
  await open(page, 'Accounts')
  const ai = page.getByRole('region', { name: 'AI accounts' })
  const github = page.getByRole('region', { name: 'GitHub accounts' })
  await expect(ai.locator('[data-account="codex"]')).toBeVisible()
  await expect(ai.locator('[data-account="gh"]')).toHaveCount(0)
  await expect(github.locator('[data-account="gh"]')).toBeVisible()
  await expect(github).toContainText('Your GitHub automation account octo-agent is not signed in')
  await expect(page.locator('.st-account-login')).toHaveCount(0)
  await expect(page.locator('.st-footer')).toBeHidden()
})

test('shows full contextual help after 500 ms on hover and keyboard focus, then dismisses it', async ({ page }) => {
  await workspace(page)
  await open(page, 'General')
  await settled(page)
  const start = Date.now()
  await page.clock.install({ time: new Date(start) })
  await page.clock.pauseAt(new Date(start + 1000))
  const label = page.locator('label[for="st-agent-account"]')
  const tip = page.getByRole('tooltip')
  await label.hover()
  await page.clock.runFor(499)
  await expect(tip).toBeHidden()
  await page.clock.runFor(1)
  await expect(tip).toHaveText('The GitHub account that posts automated reviews and comments. Connect it under Accounts.')
  await expect(label).toHaveAttribute('aria-describedby', 'poise-icon-tooltip')
  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()
  await label.focus()
  await page.clock.runFor(500)
  await expect(tip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tip).toBeHidden()
  await expect(label).not.toHaveAttribute('aria-describedby', /poise-icon-tooltip/)
  await expect(page.locator('#settings-panel')).toHaveAttribute('inert', '')
  await expect(page.locator('#settings-panel')).not.toContainText('Applies instantly')
})

for (const theme of ['light', 'dark']) test(`fits every destination at a narrow width and large text in ${theme} mode`, async ({ page }, info) => {
  await page.setViewportSize({ width: 420, height: 820 })
  await workspace(page)
  await page.evaluate((chosen) => {
    document.documentElement.dataset.theme = chosen
    document.documentElement.style.fontSize = '20px'
  }, theme)
  await page.locator('#menu-toggle').click()
  await attached(page)
  await settled(page)
  await page.screenshot({ path: info.outputPath(`${theme}-menu.png`) })
  for (const section of ['General', 'Models', 'Accounts', 'Publishing', 'Typography']) {
    await page.locator('#menu-popover').getByRole('button', { name: section, exact: true }).click()
    const panel = page.locator('#menu-surface .menu-panel.open')
    await expect(panel.locator('.tp-close')).toHaveCount(0)
    if (section === 'Accounts') await expect(panel.locator('.st-account')).toHaveCount(2)
    await attached(page)
    const sizes = await panel.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }))
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1)
    const body = panel.locator('.tp-body')
    const overflow = await body.evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    await settled(page)
    await page.screenshot({ path: info.outputPath(`${theme}-${section.toLowerCase()}.png`) })
    await panel.getByRole('button', { name: 'Back to menu' }).click()
  }
})

test('uses reduced motion and retains the close control after reset, view changes and Writer mode', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await workspace(page)
  await open(page, 'Typography')
  const durations = await page.locator('#menu-surface').evaluate((element) => getComputedStyle(element).transitionDuration.split(',').map(parseFloat))
  expect(Math.max(...durations)).toBeLessThan(0.01)
  await page.getByRole('button', { name: 'Reset to defaults' }).click()
  await expect(page.locator('#menu-surface #typo-panel')).toHaveClass(/open/)
  await expect(page.getByRole('button', { name: 'Back to menu' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await attached(page)
  await expect(page.locator('#menu-surface .tp-close')).toHaveCount(0)
  await page.locator('#menu-toggle').click()
  await expect(page.locator('#typo-panel')).toHaveAttribute('inert', '')
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  const writer = page.getByRole('button', { name: 'Toggle writer mode' })
  const toggle = page.locator('#menu-toggle')
  for (const section of ['Typography', 'General']) {
    await open(page, section)
    await writer.click()
    await expect(writer).toHaveAttribute('aria-pressed', 'true')
    await expect(toggle).toBeVisible()
    await expect(page.locator('#top-nav')).toBeHidden()
    await attached(page)
    await toggle.click()
    await expect(page.locator('#menu-surface')).toBeHidden()
    await expect(page.locator('#menu-surface .menu-panel.open')).toHaveCount(0)
    await expect(toggle).toBeHidden()
    await writer.click()
    await expect(toggle).toBeVisible()
  }
})
