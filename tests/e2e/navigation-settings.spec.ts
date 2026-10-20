import { expect, test, type Locator, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { settled } from './fixtures/motion'

async function navigation(page: Page): Promise<void> {
  await page.locator('#menu-toggle').click()
  await page.locator('#menu-popover').getByRole('button', { name: 'Navigation', exact: true }).click()
  await expect(page.locator('#settings-panel .tp-title')).toHaveText('Navigation')
  await settled(page)
}

const shortcut = (page: Page, name: string, surface: 'menu' | 'top bar') => page.getByRole('button', { name: `Arrange ${name} in ${surface}`, exact: true })
const views = ['Current', 'Swarm', 'Chat', 'Archive', 'Behaviors', 'Snippets', 'Editor', 'Analytics', 'Logging']
async function add(page: Page, name: string, surface: 'menu' | 'top bar'): Promise<void> {
  if (await shortcut(page, name, surface).count()) return
  await page.getByRole('button', { name: `Add ${name}`, exact: true }).click()
  await page.getByRole('button', { name: `Add to ${surface}`, exact: true }).click()
}

const rows = (page: Page, surface: 'menu' | 'topBar') => page.locator(`[data-list="${surface}"] .st-navigation-handle span`)
const status = (page: Page) => page.locator('[data-tab="navigation"] [role="status"]')
const settingsBody = (page: Page) => page.locator('#settings-panel .tp-body')
async function remove(page: Page, name: string, surface: 'menu' | 'top bar'): Promise<void> {
  await page.getByRole('button', { name: `Remove ${name} from ${surface}`, exact: true }).click()
}
async function beginDrag(page: Page, source: Locator): Promise<void> {
  await source.scrollIntoViewIfNeeded()
  const box = (await source.boundingBox())!
  await page.mouse.move(box.x + 15, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 22, box.y + box.height / 2, { steps: 3 })
  await expect(page.locator('.st-navigation-ghost')).toBeVisible()
}
async function before(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  const box = (await target.boundingBox())!
  await page.mouse.move(box.x + 20, box.y + 3, { steps: 12 })
}
async function watchChanges(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset.navigationEvents = '0'
    window.addEventListener('poise:navigation-changed', () => { document.documentElement.dataset.navigationEvents = String(Number(document.documentElement.dataset.navigationEvents) + 1) })
  })
}
const saved = (page: Page) => page.evaluate(() => localStorage.getItem('poise-navigation'))


test('moves views between surfaces immediately, preserves active state and persists on reload', async ({ page }) => {
  await workspace(page, 'current', undefined, { preserveOnReload: true })
  await navigation(page)
  await expect(page.locator('.st-footer')).toBeHidden()
  await add(page, 'Current', 'menu')
  await remove(page, 'Current', 'top bar')
  await add(page, 'Analytics', 'top bar')
  await add(page, 'Logging', 'top bar')
  await remove(page, 'Analytics', 'menu')
  await page.getByRole('button', { name: 'Back to menu' }).click()
  await expect(page.locator('.menu-views .menu-item')).toHaveText(['Logging', 'Current'])
  await expect(page.locator('.menu-views [data-view="current"]')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#top-nav [data-view="current"]')).toHaveCount(0)
  await page.locator('#menu-toggle').click()
  await page.locator('#top-nav').getByRole('button', { name: 'Analytics', exact: true }).click()
  await expect(page.locator('#view-analytics')).toBeVisible()
  await expect(page.locator('#top-nav [data-view="analytics"]')).toHaveAttribute('aria-current', 'page')
  await page.locator('#view-analytics').getByRole('button', { name: 'Previous day' }).click()
  await expect(page.locator('#view-analytics .analytics-date')).toHaveText('Yesterday')
  await page.locator('#top-nav').getByRole('button', { name: 'Analytics', exact: true }).click()
  await expect(page.locator('#view-analytics .analytics-date')).toHaveText('Today')
  await page.locator('#top-nav').getByRole('button', { name: 'Logging', exact: true }).click()
  await expect(page.locator('#view-logging')).toBeVisible()
  await page.reload()
  await expect(page.locator('#view-logging')).toBeVisible()
  await expect(page.locator('#top-nav [data-view="logging"]')).toHaveAttribute('aria-current', 'page')
  await navigation(page)
  await expect(shortcut(page, 'Current', 'menu')).toBeVisible()
  await expect(shortcut(page, 'Current', 'top bar')).toHaveCount(0)
  await expect(shortcut(page, 'Analytics', 'menu')).toHaveCount(0)
  await page.getByRole('button', { name: 'Restore defaults' }).click()
  await expect(shortcut(page, 'Current', 'top bar')).toBeVisible()
  await expect(shortcut(page, 'Analytics', 'top bar')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('#top-nav .nav-item')).toHaveText(['Current', 'Swarm', 'Chat', 'Archive', 'Behaviors', 'Snippets', 'Editor'])
  await page.locator('#menu-toggle').click()
  await expect(page.locator('.menu-views .menu-item')).toHaveText(['Analytics', 'Logging'])
})

test('all view shortcuts can be hidden while Settings and keyboard access remain available', async ({ page }) => {
  await workspace(page, 'current', undefined, { preserveOnReload: true })
  await navigation(page)
  for (const surface of ['menu', 'top bar'] as const) for (const name of views) {
    if (await shortcut(page, name, surface).count()) await remove(page, name, surface)
  }
  await expect(page.locator('#view-current')).toBeVisible()
  await expect(page.locator('#top-nav .nav-item')).toHaveCount(0)
  await expect(page.locator('#top-nav')).toBeHidden()
  await page.getByRole('button', { name: 'Back to menu' }).click()
  await expect(page.locator('.menu-views .menu-item')).toHaveCount(0)
  await expect(page.locator('.menu-views-divider')).toBeHidden()
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.locator('#view-current')).toBeVisible()
  await expect(page.locator('#top-nav')).toBeHidden()
  await page.goto('/?view=logging')
  await expect(page.locator('#view-logging')).toBeVisible()
  await expect(page.locator('#top-nav .nav-item')).toHaveCount(0)
  await page.locator('#menu-toggle').press('ArrowDown')
  await expect(page.getByRole('button', { name: 'General', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('#settings-panel .tp-title')).toHaveText('Navigation')
  await page.getByRole('button', { name: 'Restore defaults' }).click()
  await expect(page.locator('#top-nav .nav-item')).toHaveCount(7)
})

for (const [key, label, id] of [
  ['chat', 'Chat', 'chat'], ['main', 'Archive', 'main'], ['behaviors', 'Behaviors', 'behaviors'],
  ['snippets', 'Snippets', 'snippets'], ['editor', 'Editor', 'editor'], ['swarm', 'Swarm', 'swarm'], ['current', 'Current', 'current'],
]) test(`${label} works as a menu shortcut and marks the selected page`, async ({ page }) => {
  await workspace(page)
  await navigation(page)
  await add(page, label, 'menu')
  await page.getByRole('button', { name: 'Back to menu' }).click()
  await page.locator('.menu-views').getByRole('button', { name: label, exact: true }).click()
  await expect(page.locator(`#view-${id}`)).toBeVisible()
  await expect(page.locator('#menu-surface')).toBeHidden()
  await page.locator('#menu-toggle').click()
  await expect(page.locator(`.menu-views [data-view="${key}"]`)).toHaveAttribute('aria-current', 'page')
})

test('a storage failure reports the unsaved choice and retains the working layout', async ({ page }) => {
  await workspace(page)
  await navigation(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'poise-navigation') throw new Error('Storage is full')
      original.call(this, key, value)
    }
  })
  await remove(page, 'Current', 'top bar')
  await expect(shortcut(page, 'Current', 'top bar')).toBeVisible()
  await expect(page.locator('[data-tab="navigation"] [role="status"]')).toHaveText('Navigation was not saved: Storage is full')
  await expect(page.locator('#top-nav [data-view="current"]')).toBeVisible()
})

test('another tab updates both the navigation and its settings controls', async ({ page, context }) => {
  await workspace(page)
  await navigation(page)
  const other = await context.newPage()
  await other.route('**/navigation-tab', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Navigation preferences</title>' }))
  await other.goto('/navigation-tab')
  await page.locator('#top-nav [data-view="current"]').focus()
  await other.evaluate(() => localStorage.setItem('poise-navigation', JSON.stringify({ current: { menu: true, topBar: false }, analytics: { menu: false, topBar: true }, topBarOrder: ['analytics', 'swarm'] })))
  await expect(shortcut(page, 'Current', 'top bar')).toHaveCount(0)
  await expect(page.locator('#menu-toggle')).toBeFocused()
  await expect(shortcut(page, 'Current', 'menu')).toBeVisible()
  await expect(page.locator('#top-nav [data-view="analytics"]')).toBeVisible()
  await expect(page.locator('#top-nav .nav-item').first()).toHaveText('Analytics')
  await page.locator('#top-nav [data-view="swarm"]').focus()
  await other.evaluate(() => localStorage.removeItem('poise-navigation'))
  await expect(shortcut(page, 'Current', 'top bar')).toBeVisible()
  await expect(page.locator('#top-nav [data-view="swarm"]')).toBeFocused()
  await expect(page.locator('#top-nav [data-view="analytics"]')).toHaveCount(0)
})

for (const width of [420, 640, 900]) test(`all top bar shortcuts fit at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 820 })
  await workspace(page)
  await navigation(page)
  for (const name of views) await add(page, name, 'top bar')
  await expect(shortcut(page, 'Logging', 'top bar')).toBeFocused()
  await page.locator('#menu-toggle').click()
  await expect(page.locator('#top-nav .nav-item')).toHaveCount(9)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  const logging = page.locator('#top-nav').getByRole('button', { name: 'Logging', exact: true })
  await logging.click()
  await expect(page.locator('#view-logging')).toBeVisible()
  await expect(page.locator('#menu-toggle')).toBeInViewport()
})

test('orders both surfaces independently, keeps keyboard focus and saves order across reloads', async ({ page }) => {
  await workspace(page, 'current', undefined, { preserveOnReload: true })
  await navigation(page)
  await shortcut(page, 'Logging', 'menu').press('Space')
  const controller = page.locator('[data-keyboard]')
  await controller.press('ArrowUp')
  await controller.press('Enter')
  await expect(shortcut(page, 'Logging', 'menu')).toBeFocused()
  await expect(rows(page, 'menu')).toHaveText(['Logging', 'Analytics'])
  await shortcut(page, 'Current', 'top bar').press('Enter')
  await controller.press('ArrowDown')
  await controller.press('ArrowDown')
  await controller.press('Space')
  await expect(shortcut(page, 'Current', 'top bar')).toBeFocused()
  await expect(rows(page, 'topBar')).toHaveText(['Swarm', 'Chat', 'Current', 'Archive', 'Behaviors', 'Snippets', 'Editor'])
  await expect(status(page)).toHaveText('Current placed in top bar, position 3.')
  await expect(page.locator('#top-nav .nav-item')).toHaveText(['Swarm', 'Chat', 'Current', 'Archive', 'Behaviors', 'Snippets', 'Editor'])
  await expect(page.locator('#view-current')).toBeVisible()
  await expect(page.locator('#top-nav [data-view="current"]')).toHaveAttribute('aria-current', 'page')
  await page.reload()
  await page.locator('#menu-toggle').click()
  await expect(page.locator('.menu-views .menu-item')).toHaveText(['Logging', 'Analytics'])
  await expect(page.locator('#top-nav .nav-item')).toHaveText(['Swarm', 'Chat', 'Current', 'Archive', 'Behaviors', 'Snippets', 'Editor'])
  await page.locator('#menu-popover').getByRole('button', { name: 'Navigation', exact: true }).click()
  await page.getByRole('button', { name: 'Restore defaults' }).click()
  await expect(rows(page, 'menu')).toHaveText(['Analytics', 'Logging'])
  await expect(rows(page, 'topBar')).toHaveText(['Current', 'Swarm', 'Chat', 'Archive', 'Behaviors', 'Snippets', 'Editor'])
})

test('a full menu scrolls on a short phone viewport and still reaches Navigation', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 500 })
  await workspace(page)
  await navigation(page)
  for (const name of views) await add(page, name, 'menu')
  await page.getByRole('button', { name: 'Back to menu' }).click()
  await expect(page.locator('.menu-views .menu-item')).toHaveCount(9)
  await expect.poll(() => page.locator('#menu-popover').evaluate((menu) => menu.scrollHeight - menu.clientHeight)).toBeGreaterThan(0)
  await page.locator('#menu-popover').getByRole('button', { name: 'Navigation', exact: true }).click()
  await expect(page.locator('#settings-panel .tp-title')).toHaveText('Navigation')
})

test('the live status region is exposed before the first announcement', async ({ page }) => {
  await workspace(page)
  await navigation(page)
  const status = page.locator('[data-tab="navigation"] [role="status"]')
  await expect(status).toBeEmpty()
  await expect(status).not.toHaveAttribute('hidden')
  await expect(status).toHaveAttribute('aria-live', 'polite')
  await expect(status).toHaveAttribute('aria-atomic', 'true')
  await expect(status).toHaveCSS('display', 'block')
  await shortcut(page, 'Logging', 'menu').press('Space')
  await page.locator('[data-keyboard]').press('ArrowUp')
  await page.locator('[data-keyboard]').press('Enter')
  await expect(status).toHaveText('Logging placed in menu, position 1.')
  await expect(status).not.toHaveAttribute('hidden')
  await page.getByRole('button', { name: 'Restore defaults' }).click()
  await expect(status).toHaveText('Navigation reset.')
})

for (const width of [821, 900]) test(`large text and nine shortcuts leave local controls reachable at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 })
  await workspace(page)
  await page.evaluate(() => { document.documentElement.style.fontSize = '20px' })
  await navigation(page)
  for (const name of views) await add(page, name, 'top bar')
  await page.locator('#menu-toggle').click()
  for (const view of ['Current', 'Archive', 'Analytics']) {
    await page.locator('#top-nav').getByRole('button', { name: view, exact: true }).click()
    await expect.poll(() => page.locator('.view:not([hidden]) .view-header').evaluate((header) => {
      const global = header.querySelector('#app-bar-global')!
      return [...header.querySelectorAll<HTMLElement>('button, input, select')].filter((control) => {
        if (global.contains(control) || control.matches(':disabled')) return false
        const box = control.getBoundingClientRect()
        if (!box.width || !box.height || getComputedStyle(control).visibility === 'hidden') return false
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return !hit || !control.contains(hit)
      }).map((control) => control.getAttribute('aria-label') || control.textContent?.trim() || control.tagName)
    })).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: info.outputPath(`navigation-${width}-${view.toLowerCase()}.png`) })
  }
})

test('pointer previews stay local, cross the gutter and commit one complete transfer', async ({ page }) => {
  await workspace(page, 'current', undefined, { preserveOnReload: true })
  await navigation(page)
  await watchChanges(page)
  const original = await saved(page)
  await beginDrag(page, shortcut(page, 'Logging', 'menu'))
  await before(page, shortcut(page, 'Current', 'top bar'))
  await expect(page.locator('[data-list="topBar"] .st-navigation-gap')).toBeVisible()
  await expect(page.locator('#top-nav .nav-item')).toHaveText(views.slice(0, 7))
  expect(await saved(page)).toBe(original)
  await expect(page.locator('html')).toHaveAttribute('data-navigation-events', '0')
  const a = (await page.locator('[data-list="topBar"]').boundingBox())!
  const b = (await page.locator('[data-list="menu"]').boundingBox())!
  await page.mouse.move((a.x + a.width + b.x) / 2, a.y + 12, { steps: 5 })
  await expect(page.locator('.st-navigation-gap')).toHaveCount(0)
  await expect(page.locator('.st-navigation-ghost')).toBeVisible()
  await before(page, shortcut(page, 'Current', 'top bar'))
  await page.mouse.up()
  await expect(page.locator('#top-nav .nav-item').first()).toHaveText('Logging')
  await expect(rows(page, 'menu')).toHaveText(['Analytics'])
  await expect(shortcut(page, 'Logging', 'top bar')).toBeFocused()
  await expect(page.locator('html')).toHaveAttribute('data-navigation-events', '1')
  await expect(page.locator('.st-navigation-ghost, .st-navigation-gap')).toHaveCount(0)
  const persisted = JSON.parse((await saved(page))!)
  expect(persisted.logging).toEqual({ menu: false, topBar: true })
  await page.reload()
  await navigation(page)
  await expect(rows(page, 'menu')).toHaveText(['Analytics'])
  await expect(rows(page, 'topBar').first()).toHaveText('Logging')
})

test('palette drops copy and reposition existing shortcuts, and transfer merges an existing copy', async ({ page }) => {
  await workspace(page)
  await navigation(page)
  await beginDrag(page, page.getByRole('button', { name: 'Add Current', exact: true }))
  await before(page, shortcut(page, 'Analytics', 'menu'))
  await page.mouse.up()
  await expect(rows(page, 'menu')).toHaveText(['Current', 'Analytics', 'Logging'])
  await expect(shortcut(page, 'Current', 'top bar')).toBeVisible()
  await beginDrag(page, page.getByRole('button', { name: 'Add Logging', exact: true }))
  await before(page, shortcut(page, 'Current', 'menu'))
  await page.mouse.up()
  await expect(rows(page, 'menu')).toHaveText(['Logging', 'Current', 'Analytics'])
  await beginDrag(page, shortcut(page, 'Current', 'top bar'))
  await before(page, shortcut(page, 'Logging', 'menu'))
  await page.mouse.up()
  await expect(rows(page, 'menu')).toHaveText(['Current', 'Logging', 'Analytics'])
  await expect(shortcut(page, 'Current', 'top bar')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Add Current', exact: true })).toBeVisible()
  await remove(page, 'Current', 'menu')
  await expect(shortcut(page, 'Current', 'menu')).toHaveCount(0)
  await add(page, 'Current', 'top bar')
  await add(page, 'Current', 'menu')
  await remove(page, 'Current', 'menu')
  await expect(shortcut(page, 'Current', 'top bar')).toBeVisible()
})

test('unchanged and outside drops never write or publish the last preview', async ({ page }) => {
  await workspace(page)
  await navigation(page)
  await watchChanges(page)
  await beginDrag(page, shortcut(page, 'Current', 'top bar'))
  const gap = (await page.locator('.st-navigation-gap').boundingBox())!
  await page.mouse.move(gap.x + 20, gap.y + 15)
  await page.mouse.up()
  expect(await saved(page)).toBeNull()
  await expect(page.locator('html')).toHaveAttribute('data-navigation-events', '0')
  await beginDrag(page, shortcut(page, 'Logging', 'menu'))
  await before(page, shortcut(page, 'Current', 'top bar'))
  const header = (await page.locator('#settings-panel .tp-header').boundingBox())!
  await page.mouse.move(header.x + 80, header.y + 10, { steps: 5 })
  await page.mouse.up()
  expect(await saved(page)).toBeNull()
  await expect(page.locator('html')).toHaveAttribute('data-navigation-events', '0')
  await expect(rows(page, 'menu')).toHaveText(['Analytics', 'Logging'])
  await expect(page.locator('.st-navigation-ghost, .st-navigation-gap')).toHaveCount(0)
  await expect(shortcut(page, 'Logging', 'menu')).toBeFocused()
})

test('click-only copy, reorder, transfer and empty-area placement work without holding', async ({ page }) => {
  await workspace(page)
  await navigation(page)
  await add(page, 'Current', 'menu')
  await shortcut(page, 'Logging', 'menu').click()
  await expect(status(page)).toContainText('Click in either area to place')
  await shortcut(page, 'Analytics', 'menu').click({ position: { x: 30, y: 3 } })
  await expect(rows(page, 'menu')).toHaveText(['Logging', 'Analytics', 'Current'])
  await shortcut(page, 'Logging', 'menu').click()
  await shortcut(page, 'Current', 'top bar').click({ position: { x: 30, y: 3 } })
  await expect(rows(page, 'topBar').first()).toHaveText('Logging')
  await remove(page, 'Analytics', 'menu')
  await remove(page, 'Current', 'menu')
  await expect(page.getByRole('button', { name: 'Add Current', exact: true })).toBeFocused()
  await shortcut(page, 'Logging', 'top bar').click()
  await page.locator('[data-list="menu"]').click({ position: { x: 20, y: 20 } })
  await expect(rows(page, 'menu')).toHaveText(['Logging'])
  await expect(shortcut(page, 'Logging', 'menu')).toBeFocused()
})

test('keyboard transfer enters an empty area, reveals the target and owns Escape before settings', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 500 })
  await workspace(page)
  await navigation(page)
  await remove(page, 'Analytics', 'menu')
  await remove(page, 'Logging', 'menu')
  await shortcut(page, 'Current', 'top bar').press('Space')
  const controller = page.locator('[data-keyboard]')
  await expect(controller).toBeFocused()
  await controller.press('ArrowRight')
  await expect(page.locator('.st-navigation-gap')).toBeInViewport()
  await expect(status(page)).toHaveText('Current, position 1 in menu.')
  await controller.press('Enter')
  await expect(shortcut(page, 'Current', 'menu')).toBeFocused()
  await expect(rows(page, 'menu')).toHaveText(['Current'])
  const original = await saved(page)
  await shortcut(page, 'Current', 'menu').press('Space')
  await controller.press('ArrowLeft')
  await controller.press('End')
  await controller.press('Escape')
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await expect(shortcut(page, 'Current', 'menu')).toBeFocused()
  expect(await saved(page)).toBe(original)
  await shortcut(page, 'Current', 'menu').press('Space')
  await controller.press('Tab')
  await expect(page.locator('.st-navigation-gap')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove Current from menu', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings-panel')).toHaveAttribute('inert', '')
  await expect(page.locator('#menu-toggle')).toBeFocused()
})

test('drop write failure restores both areas, exposes the error, and recovers on the next drop', async ({ page }) => {
  await workspace(page)
  await navigation(page)
  await watchChanges(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'poise-navigation' && !document.documentElement.hasAttribute('data-storage-recovered')) throw new DOMException('Storage is full', 'QuotaExceededError')
      original.call(this, key, value)
    }
  })
  await beginDrag(page, shortcut(page, 'Logging', 'menu'))
  await before(page, shortcut(page, 'Current', 'top bar'))
  await page.mouse.up()
  await expect(status(page)).toHaveText('Navigation was not saved: Storage is full')
  await expect(rows(page, 'menu')).toHaveText(['Analytics', 'Logging'])
  await expect(page.locator('#top-nav .nav-item')).toHaveText(views.slice(0, 7))
  await expect(shortcut(page, 'Logging', 'menu')).toBeFocused()
  await expect(page.locator('.st-navigation-ghost, .st-navigation-gap')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-navigation-events', '0')
  expect(await saved(page)).toBeNull()
  await page.evaluate(() => document.documentElement.setAttribute('data-storage-recovered', ''))
  await beginDrag(page, shortcut(page, 'Logging', 'menu'))
  await before(page, shortcut(page, 'Current', 'top bar'))
  await page.mouse.up()
  await expect(rows(page, 'menu')).toHaveText(['Analytics'])
  await expect(page.locator('#top-nav .nav-item').first()).toHaveText('Logging')
  await expect(page.locator('html')).toHaveAttribute('data-navigation-events', '1')
})

for (const operation of ['write', 'remove', 'clear'] as const) test(`external ${operation} wins over an active pickup without a stale drop`, async ({ page, context }) => {
  await workspace(page)
  await navigation(page)
  await add(page, 'Current', 'menu')
  await watchChanges(page)
  const other = await context.newPage()
  await other.route('**/navigation-external', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Navigation external tab</title>' }))
  await other.goto('/navigation-external')
  await page.bringToFront()
  if (operation === 'remove') {
    await shortcut(page, 'Current', 'menu').press('Space')
    await page.locator('[data-keyboard]').press('ArrowLeft')
  } else {
    await beginDrag(page, shortcut(page, 'Current', 'top bar'))
    await before(page, shortcut(page, 'Analytics', 'menu'))
  }
  await other.evaluate(operation => {
    if (operation === 'clear') localStorage.clear()
    else if (operation === 'remove') localStorage.removeItem('poise-navigation')
    else localStorage.setItem('poise-navigation', JSON.stringify({ current: { menu: false, topBar: false }, analytics: { menu: false, topBar: true }, topBarOrder: ['analytics'] }))
  }, operation)
  await expect(status(page)).toHaveText('Navigation changed in another tab. Move cancelled.')
  await page.mouse.up()
  await expect(page.locator('.st-navigation-ghost, .st-navigation-gap')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-navigation-events', '0')
  if (operation === 'write') {
    await expect(page.locator('#top-nav .nav-item').first()).toHaveText('Analytics')
    await expect(shortcut(page, 'Current', 'top bar')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add Current', exact: true })).toBeFocused()
  } else {
    expect(await saved(page)).toBeNull()
    await expect(rows(page, 'menu')).toHaveText(['Analytics', 'Logging'])
  }
})

for (const cause of ['blur', 'beforeprint', 'resize', 'typography', 'fonts', 'visibility', 'capture', 'pointercancel', 'back', 'close', 'section'] as const) test(`${cause} discards a held move and its capture`, async ({ page }) => {
  await workspace(page)
  await navigation(page)
  await watchChanges(page)
  await beginDrag(page, shortcut(page, 'Logging', 'menu'))
  await before(page, shortcut(page, 'Current', 'top bar'))
  if (cause === 'back' || cause === 'section') {
    await page.getByRole('button', { name: 'Back to menu' }).press('Enter')
    if (cause === 'section') await page.locator('#menu-popover').getByRole('button', { name: 'General', exact: true }).click()
  } else if (cause === 'close') await page.locator('#menu-toggle').press('Enter')
  else if (cause === 'resize') await page.setViewportSize({ width: 1000, height: 700 })
  else await page.evaluate(cause => {
    if (cause === 'typography') document.documentElement.style.setProperty('--typo-size', '18px')
    else if (cause === 'fonts') document.fonts.dispatchEvent(new Event('loadingdone'))
    else if (cause === 'visibility') { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) }
    else if (cause === 'capture') document.querySelector('[data-tab="navigation"]')!.releasePointerCapture(1)
    else if (cause === 'pointercancel') document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }))
    else window.dispatchEvent(new Event(cause))
  }, cause)
  await expect(page.locator('.st-navigation-ghost, .st-navigation-gap')).toHaveCount(0)
  await page.mouse.up()
  expect(await saved(page)).toBeNull()
  await expect(page.locator('html')).toHaveAttribute('data-navigation-events', '0')
})

for (const reduced of [false, true]) test(`drag geometry and motion remain usable with reduced motion ${reduced}`, async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
  await workspace(page)
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, reduced ? 'dark' : 'light')
  await navigation(page)
  await beginDrag(page, shortcut(page, 'Logging', 'menu'))
  const target = shortcut(page, 'Analytics', 'menu')
  await target.scrollIntoViewIfNeeded()
  const box = (await target.boundingBox())!
  await page.mouse.move(box.x + 20, box.y + 3)
  await expect(page.locator('[data-list="menu"] .st-navigation-gap')).toBeVisible()
  if (reduced) await expect(page.locator('.st-navigation-row[data-motion-running]')).toHaveCount(0)
  else await expect(page.locator('.st-navigation-row[data-motion-running]')).not.toHaveCount(0)
  await page.screenshot({ path: info.outputPath(`navigation-held-${reduced ? 'reduced' : 'normal'}.png`) })
  await page.mouse.up()
  await expect(rows(page, 'menu')).toHaveText(['Logging', 'Analytics'])
  await settled(page)
  await expect(page.locator('.st-navigation-row[data-motion-running]')).toHaveCount(0)
})

for (const [width, fontSize, theme] of [[320, 32, 'light'], [420, 20, 'dark'], [640, 16, 'light'], [1280, 16, 'dark']] as const) test(`full areas and controls remain reachable at ${width}px, ${fontSize}px text in ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 820 })
  await workspace(page)
  await page.evaluate(({ fontSize, theme }) => { document.documentElement.style.fontSize = `${fontSize}px`; document.documentElement.dataset.theme = theme }, { fontSize, theme })
  await navigation(page)
  for (const name of views) for (const surface of ['menu', 'top bar'] as const) await add(page, name, surface)
  await expect(rows(page, 'menu')).toHaveCount(9)
  await expect(rows(page, 'topBar')).toHaveCount(9)
  for (const name of ['Remove Logging from menu', 'Remove Logging from top bar', 'Add Logging', 'Restore defaults']) {
    const button = page.getByRole('button', { name, exact: true })
    await button.scrollIntoViewIfNeeded()
    const reachable = await button.evaluate(element => { const b = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) })
    expect(reachable).toBe(true)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
  expect(await settingsBody(page).evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath(`navigation-full-${width}-${theme}.png`) })
  await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
  await expect(rows(page, 'menu')).toHaveText(['Analytics', 'Logging'])
})

test('native touch scrolls content, drags through the gutter and taps close without picking up', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium provides native CDP touch input.')
  await page.setViewportSize({ width: 640, height: 820 })
  await workspace(page)
  await navigation(page)
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await settingsBody(page).evaluate(element => { element.scrollTop = 0 })
    const origin = (await shortcut(page, 'Logging', 'menu').boundingBox())!
    const target = (await shortcut(page, 'Current', 'top bar').boundingBox())!
    const point = (x: number, y: number) => [{ x, y, id: 1 }]
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(origin.x + 20, origin.y + 15) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(origin.x + 28, origin.y + 15) })
    await expect(page.locator('.st-navigation-ghost')).toBeVisible()
    const menu = (await page.locator('[data-list="menu"]').boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(menu.x - 6, target.y + 3) })
    await expect(page.locator('.st-navigation-gap')).toHaveCount(0)
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(target.x + 20, target.y + 3) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(page.locator('#top-nav .nav-item').first()).toHaveText('Logging')
    await settled(page)
    const removeButton = page.getByRole('button', { name: 'Remove Logging from top bar', exact: true })
    const close = (await removeButton.boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(close.x + close.width / 2, close.y + close.height / 2) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(shortcut(page, 'Logging', 'top bar')).toHaveCount(0)
    await expect(page.locator('.st-navigation-ghost')).toHaveCount(0)
    const palette = page.getByRole('button', { name: 'Add Logging', exact: true })
    await palette.scrollIntoViewIfNeeded()
    const p = (await palette.boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(p.x + 20, p.y + 15) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(p.x + 28, p.y + 15) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(p.x + 36, p.y + 15) })
    await expect(page.locator('.st-navigation-ghost')).toBeVisible()
    await shortcut(page, 'Analytics', 'menu').scrollIntoViewIfNeeded()
    const destination = (await shortcut(page, 'Analytics', 'menu').boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(destination.x + 20, destination.y + 3) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(rows(page, 'menu')).toHaveText(['Logging', 'Analytics'])
    const originTap = (await shortcut(page, 'Logging', 'menu').boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(originTap.x + 20, originTap.y + 15) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(status(page)).toContainText('Click in either area to place')
    const targetTap = (await shortcut(page, 'Current', 'top bar').boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(targetTap.x + 20, targetTap.y + 3) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(page.locator('#top-nav .nav-item').first()).toHaveText('Logging')
  } finally { await client.detach() }
})

test('native touch scrolls a short settings body without moving the page', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium provides native CDP touch input.')
  await page.setViewportSize({ width: 420, height: 500 })
  await workspace(page)
  await navigation(page)
  const client = await page.context().newCDPSession(page)
  const point = (x: number, y: number) => [{ x, y, id: 1 }]
  try {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    const viewport = (await settingsBody(page).boundingBox())!
    const swipeX = viewport.x + viewport.width - 8 // Panel padding stays pannable beside stacked lists.
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(swipeX, viewport.y + viewport.height - 20) })
    for (let step = 1; step <= 6; step++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(swipeX, viewport.y + viewport.height - 20 - step * (viewport.height - 40) / 6) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => settingsBody(page).evaluate(element => element.scrollTop)).toBeGreaterThan(30)
    expect(await page.evaluate(() => scrollY)).toBe(0)
  } finally { await client.detach() }
})

test('native touch and stationary edge scrolling stay inside a short settings body', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium provides native CDP touch input.')
  await page.setViewportSize({ width: 420, height: 500 })
  await workspace(page)
  await navigation(page)
  const client = await page.context().newCDPSession(page)
  const point = (x: number, y: number) => [{ x, y, id: 1 }]
  try {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    const viewport = (await settingsBody(page).boundingBox())!
    // A fresh page keeps native swipe momentum out of the drag's scroll proof.
    const first = (await shortcut(page, 'Current', 'top bar').boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(first.x + 20, first.y + 15) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(first.x + 28, first.y + 15) })
    await expect(page.locator('.st-navigation-ghost')).toBeVisible()
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(first.x + 28, viewport.y + viewport.height - 4) })
    await expect.poll(() => settingsBody(page).evaluate(element => element.scrollTop)).toBeGreaterThan(80)
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
    await expect(page.locator('.st-navigation-ghost, .st-navigation-gap')).toHaveCount(0)
    const stopped = await settingsBody(page).evaluate(element => element.scrollTop)
    await page.waitForTimeout(100)
    expect(await settingsBody(page).evaluate(element => element.scrollTop)).toBe(stopped)
    const source = page.getByRole('button', { name: 'Add Analytics', exact: true })
    await source.scrollIntoViewIfNeeded()
    const sourceBox = (await source.boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(sourceBox.x + 20, sourceBox.y + 15) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(sourceBox.x + 28, sourceBox.y + 15) })
    const top = (await page.locator('[data-list="topBar"]').boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(top.x + 30, viewport.y + 4) })
    await expect.poll(() => settingsBody(page).evaluate(element => element.scrollTop)).toBeLessThan(1)
    const current = (await shortcut(page, 'Current', 'top bar').boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(current.x + 20, current.y + 3) })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(page.locator('#top-nav .nav-item').first()).toHaveText('Analytics')
    await expect(shortcut(page, 'Analytics', 'menu')).toBeVisible()
    expect(await page.evaluate(() => scrollY)).toBe(0)
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).focus()
    await expect(page.getByRole('button', { name: 'Restore defaults', exact: true })).toBeInViewport()
  } finally { await client.detach() }
})

test('failed addition keeps the initiating choice focused and reset aborts a keyboard pickup', async ({ page }) => {
  await workspace(page)
  await navigation(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'poise-navigation' && !document.documentElement.hasAttribute('data-storage-recovered')) throw new Error('Storage is full')
      original.call(this, key, value)
    }
  })
  await page.getByRole('button', { name: 'Add Current', exact: true }).click()
  const choice = page.getByRole('button', { name: 'Add to menu', exact: true })
  await choice.click()
  await expect(choice).toBeFocused()
  await expect(status(page)).toHaveText('Navigation was not saved: Storage is full')
  await expect(shortcut(page, 'Current', 'menu')).toHaveCount(0)
  await page.evaluate(() => document.documentElement.setAttribute('data-storage-recovered', ''))
  await choice.click()
  await expect(shortcut(page, 'Current', 'menu')).toBeFocused()
  await shortcut(page, 'Logging', 'menu').press('Space')
  await page.locator('[data-keyboard]').press('ArrowLeft')
  const reset = page.getByRole('button', { name: 'Restore defaults', exact: true })
  await reset.press('Enter')
  await expect(reset).toBeFocused()
  await expect(status(page)).toHaveText('Navigation reset.')
  await expect(page.locator('.st-navigation-ghost, .st-navigation-gap')).toHaveCount(0)
  await expect(rows(page, 'menu')).toHaveText(['Analytics', 'Logging'])
})

for (const mode of ['pointer', 'click'] as const) test(`${mode} pickup keeps Escape inside Settings before idle dismissal`, async ({ page }) => {
  await workspace(page)
  await navigation(page)
  await watchChanges(page)
  if (mode === 'pointer') await beginDrag(page, shortcut(page, 'Logging', 'menu'))
  else await shortcut(page, 'Logging', 'menu').click()
  await expect(page.locator('[data-keyboard]')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings-panel')).toHaveClass(/open/)
  await expect(shortcut(page, 'Logging', 'menu')).toBeFocused()
  await expect(status(page)).toHaveText('Navigation move cancelled.')
  await expect(page.locator('.st-navigation-ghost, .st-navigation-gap')).toHaveCount(0)
  await page.mouse.up()
  expect(await saved(page)).toBeNull()
  await expect(page.locator('html')).toHaveAttribute('data-navigation-events', '0')
  await page.keyboard.press('Escape')
  await expect(page.locator('#settings-panel')).toHaveAttribute('inert', '')
  await expect(page.locator('#menu-toggle')).toBeFocused()
})

test('external removal before the pickup threshold clears the pending pointer', async ({ page, context }) => {
  await workspace(page)
  await navigation(page)
  await watchChanges(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const other = await context.newPage()
  await other.route('**/navigation-pending', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Navigation pending</title>' }))
  await other.goto('/navigation-pending')
  await page.bringToFront()
  const box = (await shortcut(page, 'Current', 'top bar').boundingBox())!
  await page.mouse.move(box.x + 20, box.y + 15)
  await page.mouse.down()
  await other.evaluate(() => localStorage.setItem('poise-navigation', JSON.stringify({ current: { menu: false, topBar: false } })))
  await expect(shortcut(page, 'Current', 'top bar')).toHaveCount(0)
  const incoming = await saved(page)
  await page.mouse.move(box.x + 45, box.y + 15, { steps: 5 })
  await page.mouse.up()
  expect(await saved(page)).toBe(incoming)
  await expect(page.locator('.st-navigation-ghost, .st-navigation-gap')).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-navigation-events', '0')
  expect(errors).toEqual([])
})

for (const failure of ['corrupt', 'unreadable'] as const) test(`${failure} preferences surface a notice and recover through Restore defaults`, async ({ page }) => {
  await workspace(page, 'current', undefined, { preserveOnReload: true })
  if (failure === 'corrupt') await page.evaluate(() => localStorage.setItem('poise-navigation', '{'))
  else await page.addInitScript(() => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = function (key) {
      if (key === 'poise-navigation' && !document.documentElement.hasAttribute('data-navigation-read-recovered')) throw new Error('Navigation storage is unavailable')
      return original.call(this, key)
    }
  })
  await page.reload()
  await page.locator('#notification-bell').click()
  await expect(page.locator('#notification-rail')).toContainText('Navigation preferences could not be read')
  await page.locator('#notification-bell').click()
  await navigation(page)
  await page.evaluate(() => document.documentElement.setAttribute('data-navigation-read-recovered', ''))
  await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
  await expect(rows(page, 'menu')).toHaveText(['Analytics', 'Logging'])
  await expect(page.locator('#top-nav .nav-item')).toHaveText(views.slice(0, 7))
  expect(JSON.parse((await saved(page))!).menuOrder.slice(0, 2)).toEqual(['analytics', 'logging'])
  await page.locator('#menu-toggle').click()
  await page.locator('#notification-bell').click()
  await expect(page.locator('#notification-rail')).toBeVisible()
  await expect(page.locator('#notification-rail')).not.toContainText('Navigation preferences could not be read')
})

test('native tap transfers exclude an existing destination copy from insertion indices in both directions', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium provides native CDP touch input.')
  await page.setViewportSize({ width: 640, height: 820 })
  await workspace(page)
  await navigation(page)
  await add(page, 'Current', 'menu')
  await shortcut(page, 'Current', 'menu').press('Space')
  await page.locator('[data-keyboard]').press('Home')
  await page.locator('[data-keyboard]').press('Enter')
  await expect(rows(page, 'menu')).toHaveText(['Current', 'Analytics', 'Logging'])
  const client = await page.context().newCDPSession(page)
  const tap = async (target: Locator, y: number) => {
    await target.scrollIntoViewIfNeeded()
    const box = (await target.boundingBox())!
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 25, y: box.y + y, id: 1 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  try {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await tap(shortcut(page, 'Current', 'top bar'), 15)
    await tap(shortcut(page, 'Analytics', 'menu'), 3)
    await expect(rows(page, 'menu')).toHaveText(['Current', 'Analytics', 'Logging'])
    await expect(shortcut(page, 'Current', 'top bar')).toHaveCount(0)
    await add(page, 'Current', 'top bar')
    await shortcut(page, 'Current', 'top bar').press('Space')
    await page.locator('[data-keyboard]').press('Home')
    await page.locator('[data-keyboard]').press('Enter')
    await tap(shortcut(page, 'Current', 'menu'), 15)
    await tap(shortcut(page, 'Swarm', 'top bar'), 3)
    await expect(rows(page, 'topBar')).toHaveText(views.slice(0, 7))
    await expect(rows(page, 'menu')).toHaveText(['Analytics', 'Logging'])
  } finally { await client.detach() }
})
