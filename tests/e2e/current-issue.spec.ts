import { expect, test } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { feedback } from './fixtures/view-feedback'

for (const scenario of ['success', 'failed write', 'failed refresh', 'pending replacement'] as const) {
  test(`Current issue creation handles ${scenario} without a duplicate or false failure`, async ({ page }) => {
    await workspace(page)
    await page.route('**/api/repos', route => route.fulfill({ json: { repos: ['acme/project'] } }))
    const now = new Date().toISOString()
    const record = { repo: 'acme/project', number: 9001, title: 'Confirmed issue', kind: 'issue', state: 'open',
      url: 'https://github.com/acme/project/issues/9001', created_at: now, updated_at: now, merged_at: null }
    let writes = 0, refreshReads = 0
    let release!: () => void, releaseRefresh!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const pendingRefresh = new Promise<void>(resolve => { releaseRefresh = resolve })
    await page.route('**/api/gh', async route => {
      const body = route.request().postDataJSON()
      if (body.operation !== 'open_issue') {
        if (writes && scenario === 'failed refresh') {
          refreshReads++
          await pendingRefresh
          return route.fulfill({ status: 503, json: { error: 'Read unavailable' } })
        }
        return route.fulfill({ json: body.count_only ? { count: 0 } : { records: [] } })
      }
      writes++
      if (writes === 1) {
        await pending
        if (scenario === 'failed write') return route.fulfill({ status: 503, json: { error: 'Write unavailable' } })
      }
      return route.fulfill({ json: { record } })
    })
    if (scenario === 'pending replacement') {
      await page.route('**/api/current', route => route.fulfill({ json: { cards: [{
        id: 1, text: 'Keep this source card', lane: 'plan', position: 0, repo: 'acme/project', created_at: now, updated_at: now,
      }] } }))
      await page.reload()
    }
    try {
      const addIssue = page.getByRole('button', { name: 'Add an issue', exact: true })
      await addIssue.click()
      const composer = page.locator('.composer-issue')
      const title = composer.locator('.issue-title')
      await title.fill(record.title)
      await expect(composer.locator('.issue-repo option[value="acme/project"]')).toHaveCount(1)
      await composer.locator('.issue-repo').selectOption('acme/project')
      const submit = composer.getByRole('button', { name: 'Open issue', exact: true })
      await submit.click()
      await expect(submit).toBeDisabled()
      await title.press('ControlOrMeta+Enter')
      await title.press('ControlOrMeta+Enter')
      await composer.getByRole('button', { name: 'Cancel', exact: true }).click()
      await title.press('Escape')
      if (scenario === 'pending replacement') {
        await page.locator('.card[data-id="1"]').dragTo(page.locator('.lane[data-lane="issue"]'))
        await expect(title).toHaveValue(record.title)
      }
      await expect(composer).toBeVisible()
      expect(writes).toBe(1)
      release()
      if (scenario === 'failed write') {
        await expect(submit).toBeEnabled()
        await expect(title).toHaveValue(record.title)
        await submit.click()
      }
      await expect(composer).toHaveCount(0)
      await expect(addIssue).toBeVisible()
      await expect(addIssue).toBeEnabled()
      if (scenario === 'failed refresh') await expect.poll(() => refreshReads).toBeGreaterThan(0)
      await expect(page.getByRole('link', { name: record.title })).toBeVisible()
      releaseRefresh()
      const rail = await feedback(page)
      await expect(rail.locator('.nr-card').filter({ hasText: 'Current action needs attention' })).toHaveCount(0)
      if (scenario === 'failed refresh') await expect(rail.locator('.nr-card').filter({ hasText: 'Current item created' })).toContainText('could not refresh')
      if (scenario === 'pending replacement') await expect(page.locator('.card[data-id="1"]')).toBeVisible()
      await page.locator('#notification-bell').click()
      await addIssue.click()
      await expect(page.locator('.composer-issue .issue-title')).toHaveValue('')
      await page.locator('.composer-issue').getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(writes).toBe(scenario === 'failed write' ? 2 : 1)
    } finally { release(); releaseRefresh() }
  })
}
