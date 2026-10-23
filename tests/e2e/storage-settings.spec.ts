import { expect, test } from '@playwright/test'
import { workspace } from './fixtures/workspace'

// Settings → General shows the workspace storage breakdown, and runs
// maintenance on demand. The server side is stood in for; the run itself is
// covered by tests/storage-maintenance.test.ts.

const BREAKDOWN = {
  at: '2026-10-22T21:00:00.000Z',
  categories: [
    { key: 'chat-workers', label: 'Chat worker workspaces', path: '/home/poise/.poise/chat/workers', bytes: 40 * 1024 ** 3 },
    { key: 'pip', label: 'pip cache', path: '/home/poise/.cache/pip', bytes: 6 * 1024 ** 3 },
  ],
  disk: { path: '/home/poise', totalBytes: 100 * 1024 ** 3, freeBytes: 15 * 1024 ** 3, usedPercent: 85 },
  pressure: true,
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

test('settings shows the storage breakdown and runs maintenance', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/storage', (route) => route.fulfill({ json: BREAKDOWN }))
  await page.route('**/api/storage/maintenance', (route) => route.fulfill({ json: RUN }))
  await page.locator('#menu-toggle').click()
  await page.locator('#menu-popover').getByRole('button', { name: 'General', exact: true }).click()
  const rows = page.locator('.st-storage-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('Chat worker workspaces')
  await expect(rows.first()).toContainText('40 GB')
  await expect(page.locator('.st-storage-status')).toContainText('15 GB free of 100 GB')
  await expect(page.locator('.st-storage-status')).toContainText('Last maintenance')
  await page.locator('.st-storage-dry-run').click()
  await expect(page.locator('.st-storage-status')).toContainText('Dry run reclaimed 1.0 GB')
  await expect(rows).toHaveCount(2)
})
