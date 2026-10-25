import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'

// Settings → General shows the workspace storage breakdown, and runs
// maintenance on demand. The server side is stood in for; the read bounds,
// the shared scan and the retry refresh are covered by
// tests/storage-maintenance.test.ts.

const BREAKDOWN = {
  at: new Date().toISOString(),
  categories: [
    { key: 'chat-workers', label: 'Chat worker workspaces', path: '/home/poise/.poise/chat/workers', bytes: 40 * 1024 ** 3, status: 'ok' },
    { key: 'pip', label: 'pip cache', path: '/home/poise/.cache/pip', bytes: 6 * 1024 ** 3, status: 'ok' },
  ],
  disk: { path: '/home/poise', totalBytes: 100 * 1024 ** 3, freeBytes: 15 * 1024 ** 3, usedPercent: 85 },
  pressure: true,
  complete: true,
  stale: false,
  lastRun: { finishedAt: '2026-10-22T20:00:00.000Z', dryRun: false, reclaimedBytes: 2 * 1024 ** 3, held: [], errors: [] },
}

const RUN = {
  reclaimedBytes: 1024 ** 3,
  removed: [{ path: '/home/poise/.poise/chat/workers/1', bytes: 1024 ** 3 }],
  pruned: [],
  caches: [],
  held: [],
  errors: [],
}

async function openGeneral(page: Page): Promise<void> {
  await page.locator('#menu-toggle').click()
  await page.locator('#menu-popover').getByRole('button', { name: 'General', exact: true }).click()
}

test('settings shows the storage breakdown and runs maintenance', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/storage*', (route) => route.fulfill({ json: BREAKDOWN }))
  await page.route('**/api/storage/maintenance', (route) => route.fulfill({ json: RUN }))
  await openGeneral(page)
  const rows = page.locator('.st-storage-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('Chat worker workspaces')
  await expect(rows.first()).toContainText('40 GB')
  await expect(page.locator('.st-storage-status')).toContainText('15 GB free of 100 GB')
  await expect(page.locator('.st-storage-status')).toContainText('Last maintenance')
  await expect(page.locator('.st-storage-status')).toContainText('Measured just now')
  await expect(page.locator('.st-storage-retry')).toBeHidden()
  await page.locator('.st-storage-dry-run').click()
  await expect(page.locator('.st-storage-status')).toContainText('Dry run reclaimed 1.0 GB')
  await expect(rows).toHaveCount(2)
})

test('a failed storage read shows an error with a retry that recovers', async ({ page }) => {
  await workspace(page)
  const urls: string[] = []
  let calls = 0
  await page.route('**/api/storage*', (route) => {
    calls += 1
    urls.push(route.request().url())
    if (calls === 1) return route.fulfill({ status: 500, json: { error: 'the walk blew up' } })
    return route.fulfill({ json: { ...BREAKDOWN, at: new Date().toISOString() } })
  })
  await openGeneral(page)
  await expect(page.locator('.st-storage-status')).toContainText('the walk blew up')
  await expect(page.locator('.st-storage-status')).not.toContainText('Loading storage…')
  const retry = page.locator('.st-storage-retry')
  await expect(retry).toBeVisible()
  // Ordinary controls stay usable while the storage read has failed.
  await page.locator('.st-theme-picker button[data-theme="dark"]').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await retry.click()
  await expect(page.locator('.st-storage-row')).toHaveCount(2)
  await expect(page.locator('.st-storage-status')).toContainText('Measured just now')
  await expect(retry).toBeHidden()
  expect(urls).toHaveLength(2)
  expect(urls[1]).toContain('fresh=1')
})

test('settings stays usable while the storage read is pending, then shows it', async ({ page }) => {
  await workspace(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/storage*', async (route) => {
    await gate
    await route.fulfill({ json: { ...BREAKDOWN, at: new Date().toISOString() } })
  })
  await openGeneral(page)
  await expect(page.locator('.st-storage-status')).toContainText('Loading storage…')
  await page.locator('.st-theme-picker button[data-theme="dark"]').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.st-save')).toBeEnabled()
  release()
  await expect(page.locator('.st-storage-row')).toHaveCount(2)
  await expect(page.locator('.st-storage-status')).toContainText('Measured just now')
})

test('a storage read that never answers times out with a retry', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/storage*', () => {
    // Never answers: the client must give up on its own bound.
  })
  await openGeneral(page)
  await expect(page.locator('.st-storage-status')).toContainText('timed out after 15 seconds', { timeout: 25_000 })
  await expect(page.locator('.st-storage-retry')).toBeVisible()
  await page.unroute('**/api/storage*')
  await page.route('**/api/storage*', (route) => route.fulfill({ json: { ...BREAKDOWN, at: new Date().toISOString() } }))
  await page.locator('.st-storage-retry').click()
  await expect(page.locator('.st-storage-row')).toHaveCount(2)
})

test('a failed reread after maintenance keeps the run line and offers a retry', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/storage*', (route) => route.fulfill({ json: { ...BREAKDOWN, at: new Date().toISOString() } }))
  await page.route('**/api/storage/maintenance', (route) => route.fulfill({ json: RUN }))
  await openGeneral(page)
  await expect(page.locator('.st-storage-row')).toHaveCount(2)
  await page.unroute('**/api/storage*')
  await page.route('**/api/storage*', (route) => route.fulfill({ status: 500, json: { error: 'reread blew up' } }))
  await page.locator('.st-storage-dry-run').click()
  await expect(page.locator('.st-storage-status')).toContainText('Dry run reclaimed 1.0 GB')
  const retry = page.locator('.st-storage-retry')
  await expect(retry).toBeVisible()
  await page.unroute('**/api/storage*')
  await page.route('**/api/storage*', (route) => route.fulfill({ json: { ...BREAKDOWN, at: new Date().toISOString() } }))
  await retry.click()
  await expect(page.locator('.st-storage-row')).toHaveCount(2)
  await expect(retry).toBeHidden()
})

test('partial and stale results read as dated, with unavailable told apart from zero', async ({ page }) => {
  await workspace(page)
  let calls = 0
  await page.route('**/api/storage*', (route) => {
    calls += 1
    if (calls === 1) {
      return route.fulfill({
        json: {
          at: new Date(Date.now() - 5 * 60_000).toISOString(),
          categories: [
            { key: 'chat-workers', label: 'Chat worker workspaces', path: '/w', bytes: 0, status: 'ok' },
            { key: 'pip', label: 'pip cache', path: '/p', bytes: null, status: 'unavailable', error: 'EACCES: permission denied' },
            { key: 'uv', label: 'uv cache', path: '/u', bytes: 2048, status: 'partial', error: 'the storage scan timed out' },
          ],
          disk: { path: '/home/poise', totalBytes: 100 * 1024 ** 3, freeBytes: 15 * 1024 ** 3, usedPercent: 85 },
          pressure: false,
          complete: false,
          stale: false,
          lastRun: null,
        },
      })
    }
    return route.fulfill({
      json: {
        ...BREAKDOWN,
        at: new Date(Date.now() - 2 * 60_000).toISOString(),
        stale: true,
        error: 'the refresh blew up',
      },
    })
  })
  await openGeneral(page)
  const rows = page.locator('.st-storage-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('0 bytes')
  await expect(rows.nth(1)).toContainText('unavailable')
  await expect(rows.nth(1)).toHaveAttribute('title', 'EACCES: permission denied')
  await expect(rows.nth(2)).toContainText('2.0 KB (partial)')
  await expect(page.locator('.st-storage-status')).toContainText('Measured 5 minutes ago')
  await expect(page.locator('.st-storage-status')).toContainText('Some categories could not be measured')
  await expect(page.locator('.st-storage-retry')).toBeVisible()
  // Reopening Settings reads again and shows the dated stale observation.
  await page.keyboard.press('Escape')
  await openGeneral(page)
  await expect(page.locator('.st-storage-status')).toContainText('Showing the last update, measured 2 minutes ago')
  await expect(page.locator('.st-storage-status')).toContainText('Could not refresh: the refresh blew up')
  await expect(page.locator('.st-storage-retry')).toBeVisible()
  expect(calls).toBe(2)
})
