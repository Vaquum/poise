import { expect, test, type Page } from '@playwright/test'

// The first line of the burger menu: the commit Poise runs, linked to it on
// autonomio/poise, and since when. Poise's API is stood in for.

const COMMIT = '46815bfcaae2aace9e2534296639b872e34f8db1'

async function workspace(page: Page, release: { commit: string | null, since: string | null }): Promise<void> {
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'current') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url())
    if (pathname === '/api/release') return route.fulfill({ json: release })
    if (pathname === '/api/settings') {
      return route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'Europe/Helsinki', models: {}, organizations: [{ login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }] } })
    }
    if (pathname === '/api/workspace') return route.fulfill({ json: { mode: 'local' } })
    if (pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    return route.fulfill({ json: {} })
  })
}

test('the menu opens on the commit Poise runs and since when', async ({ page }) => {
  await workspace(page, { commit: COMMIT, since: '2026-10-09T18:40:00Z' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Menu' }).click()
  const line = page.locator('#menu-popover .menu-release')
  await expect(line).toBeVisible()
  await expect(line).toHaveText(/^\s*46815bf · 9 Oct( 2026)? 21:40\s*$/)
  const link = line.getByRole('link', { name: 'Poise runs autonomio/poise@46815bf, since 9 October 2026 at 21:40' })
  await expect(link).toHaveAttribute('href', `https://github.com/autonomio/poise/commit/${COMMIT}`)
  await expect(link).toHaveAttribute('target', '_blank')
  // Above Settings and Typography.
  const first = await line.boundingBox()
  const settings = await page.locator('#menu-popover').getByRole('button', { name: 'Settings' }).boundingBox()
  expect(first!.y + first!.height).toBeLessThanOrEqual(settings!.y)
})

test('a build without a commit opens the menu on Settings', async ({ page }) => {
  const release: { commit: string | null, since: string | null } = { commit: null, since: null }
  await workspace(page, release)
  await page.goto('/')
  const answered = page.waitForResponse('**/api/release')
  await page.getByRole('button', { name: 'Menu' }).click()
  await answered
  // The line starts hidden: look only once the page has handled the answer.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
  await expect(page.locator('#menu-popover').getByRole('button', { name: 'Settings' })).toBeVisible()
  await expect(page.locator('#menu-popover .menu-release')).toBeHidden()
  await expect(page.locator('#menu-popover .menu-release-divider')).toBeHidden()
  // The same menu shows the line as soon as there is a commit to show.
  release.commit = COMMIT
  release.since = '2026-10-09T18:40:00Z'
  await page.keyboard.press('Escape')
  // Closed for good before it opens again: a click while it is still closing closes it.
  await expect(page.locator('#menu-popover')).toBeHidden()
  await page.getByRole('button', { name: 'Menu' }).click()
  await expect(page.locator('#menu-popover .menu-release')).toBeVisible()
  await expect(page.locator('#menu-popover .menu-release-divider')).toBeVisible()
})
