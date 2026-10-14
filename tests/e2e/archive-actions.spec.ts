import { expect, test } from '@playwright/test'
import { workspace } from './fixtures/workspace'

const failedRun = {
  kind: 'action', repo: 'acme/site', number: 42, title: 'Deploy · Release after merge',
  url: 'https://github.com/acme/site/actions/runs/42', author: 'octocat', state: 'failure',
  branch: 'main', event: 'push', updated_at: '2026-10-14T08:00:00Z',
}

for (const width of [1280, 1920]) {
  test(`failed Actions are the default and Archive follows Swarm at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const requests: Record<string, unknown>[] = []
    await workspace(page, 'swarm')
    const swarmBox = await page.locator('#view-swarm main').boundingBox()
    await page.route('**/api/gh', route => {
      const body = route.request().postDataJSON() as Record<string, unknown>
      requests.push(body)
      return route.fulfill({ json: body.count_only ? { count: 1 } : { records: [failedRun] } })
    })
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect(page.locator('#tbody')).toContainText('Deploy · Release after merge')
    expect(requests.every(body => body.operation === 'actions' && body.record_state === 'failed')).toBe(true)
    await expect(page.locator('#filter-type [data-filter="action"]')).toHaveClass('active')
    await expect(page.locator('#filter-status [data-status="failed"]')).toHaveClass('active')
    await expect(page.locator('#tbody .agent-org')).toHaveText('acme')
    await expect(page.locator('#tbody .repo-name')).toHaveText('site')
    await expect(page.locator('#tbody .repo-name')).toHaveAttribute('title', 'acme/site')
    await expect(page.locator('#tbody .title-cell a')).toHaveAttribute('href', failedRun.url)
    await expect(page.locator('#tbody .branch-cell')).toHaveText('main')
    await expect(page.locator('#tbody .agent-status.bad')).toHaveText('Failure')
    await expect(page.locator('#tbody .review-btn')).toHaveCount(0)
    const archiveBox = await page.locator('#view-main main').boundingBox()
    expect(archiveBox!.x).toBeCloseTo(swarmBox!.x)
    expect(archiveBox!.width).toBeCloseTo(swarmBox!.width)
    expect(await page.locator('#table th').first().evaluate(el => getComputedStyle(el).position)).toBe('sticky')
    await page.screenshot({ path: `test-results/archive-actions-${width}.png` })
  })
}

test('outcomes, issue history and persistent filters remain selectable', async ({ page }) => {
  await workspace(page, 'swarm', undefined, { preserveOnReload: true })
  await page.route('**/api/gh', route => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    const action = body.operation === 'actions'
    const records = action ? [{ ...failedRun, state: body.record_state === 'all' ? 'success' : 'failure' }]
      : [{ ...failedRun, kind: 'issue', state: 'open', title: 'Issue history', url: 'https://github.com/acme/site/issues/42', owner_login: null, owner_avatar: null, merged_at: null }]
    return route.fulfill({ json: body.count_only ? { count: 1 } : { records } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await page.locator('#filter-status [data-status="all"]').click()
  await expect(page.locator('#tbody .agent-status.ok')).toHaveText('Success')
  await page.locator('#filter-type [data-filter="issue"]').click()
  await expect(page.locator('#tbody')).toContainText('Issue history')
  await expect(page.locator('#table .col-owner')).toHaveText('Owner')
  await expect(page.locator('#filter-status [data-status="failed"]')).toBeHidden()
  await page.reload()
  await expect(page.locator('#tbody')).toContainText('Issue history')
  await page.locator('#filter-type [data-filter="action"]').click()
  await expect(page.locator('#tbody .agent-status.bad')).toHaveText('Failure')
})

test('partial history and a failed refresh remain visible, and recovered failures disappear', async ({ page }) => {
  await workspace(page, 'swarm')
  let failed = false
  let recovered = false
  await page.route('**/api/gh', route => {
    if (failed) return route.fulfill({ status: 502, json: { error: 'Actions offline' } })
    const body = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({ json: {
      ...(body.count_only ? { count: recovered ? 0 : 1 } : { records: recovered ? [] : [failedRun] }),
      warnings: ['acme/site: showing the latest 100 of 130 failed runs. Open GitHub for older runs.'],
    } })
  })
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(page.locator('#main-load-error')).toContainText('latest 100 of 130')
  failed = true
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(page.locator('#main-load-error')).toContainText('Not updating')
  await expect(page.locator('#tbody')).toContainText('Deploy')
  failed = false
  recovered = true
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(page.locator('#tbody tr')).toHaveCount(0)
})


test('empty Actions report no failures and account changes while hidden do not read workflows', async ({ page }) => {
  await workspace(page, 'main')
  await expect(page.locator('#empty')).toHaveText('No failed workflow runs for the current filters.')
  let reads = 0
  await page.route('**/api/gh', route => { reads++; return route.fulfill({ json: { records: [], count: 0 } }) })
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:organization-filter-changed')))
  await page.waitForTimeout(150)
  expect(reads).toBe(0)
  await page.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect.poll(() => reads).toBeGreaterThan(0)
})


test('returning to Archive resumes pagination after a hidden page finishes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 })
  await workspace(page, 'swarm')
  let releaseInitial!: () => void
  let releaseRefresh!: () => void
  const initial = new Promise<void>(resolve => { releaseInitial = resolve })
  const refresh = new Promise<void>(resolve => { releaseRefresh = resolve })
  let firstPageReads = 0
  await page.route('**/api/gh', async route => {
    const body = route.request().postDataJSON() as { count_only?: boolean, offset: number }
    if (body.count_only) return route.fulfill({ json: { count: 40 } })
    if (body.offset === 0) {
      firstPageReads++
      await (firstPageReads === 1 ? initial : refresh)
    }
    return route.fulfill({ json: { records: Array.from({ length: 20 }, (_, i) => ({ ...failedRun, number: body.offset + i + 1 })) } })
  })
  try {
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect.poll(() => firstPageReads).toBe(1)
    await page.getByRole('button', { name: 'Swarm', exact: true }).click()
    releaseInitial()
    await expect(page.locator('#tbody tr')).toHaveCount(20)
    await expect(page.locator('#loader')).toBeHidden()
    await page.getByRole('button', { name: 'Archive', exact: true }).click()
    await expect.poll(() => firstPageReads).toBe(2)
    // Let the sentinel's entrance notification occur while refresh is pending.
    await page.waitForTimeout(150)
    releaseRefresh()
    await expect(page.locator('#tbody tr')).toHaveCount(40)
  } finally { releaseInitial(); releaseRefresh() }
})
