import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { settled } from './fixtures/motion'

async function accounts(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('#menu-popover').getByRole('button', { name: 'Accounts', exact: true }).click()
}

test('a page left over from the previous release reloads once when its lazy chunk is gone', async ({ page }) => {
  await workspace(page)
  await settled(page)
  // A release switch after the page loaded: the lazy terminal chunk and this
  // page's own entry are gone from the new release. Only the staleness check
  // must see the switch; the reload itself loads fine.
  let entryReads = 0
  await page.route('**/assets/index-*.js', async route => {
    if (++entryReads === 1) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' })
    return route.continue()
  })
  await page.route('**/*terminal-panel*.js', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' }))
  let loads = 0
  page.on('load', () => { loads++ })

  await accounts(page)
  await page.getByRole('button', { name: 'Reconnect Codex', exact: true }).click()
  await expect(page.locator('.up-backdrop')).toContainText('Updating to the latest version')
  await expect.poll(() => loads).toBe(1)

  // The chunk is still missing, but the reloaded page is current: opening the
  // terminal fails honestly instead of reloading again.
  await accounts(page)
  await page.getByRole('button', { name: 'Reconnect Codex', exact: true }).click()
  await expect(page.locator('.st-accounts-status')).toContainText('Could not open the terminal')
  await page.waitForTimeout(2500)
  expect(loads).toBe(1)
})
