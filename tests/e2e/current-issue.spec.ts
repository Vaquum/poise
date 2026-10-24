import { expect, test } from '@playwright/test'
import { workspace } from './fixtures/workspace'

test('Current retains an in-flight issue, permits an explicit failed-write retry and closes on success', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/repos', route => route.fulfill({ json: { repos: ['acme/project'] } }))
  const now = new Date().toISOString()
  const record = { repo: 'acme/project', number: 9001, title: 'Confirmed issue', kind: 'issue', state: 'open',
    url: 'https://github.com/acme/project/issues/9001', created_at: now, updated_at: now, merged_at: null }
  let writes = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/gh', async route => {
    const body = route.request().postDataJSON()
    if (body.operation !== 'open_issue') return route.fulfill({ json: body.count_only ? { count: 0 } : { records: [] } })
    writes++
    if (writes === 1) {
      await pending
      return route.fulfill({ status: 503, json: { error: 'Write unavailable' } })
    }
    return route.fulfill({ json: { record } })
  })
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
    await expect(composer).toBeVisible()
    release()
    await expect(submit).toBeEnabled()
    await expect(title).toHaveValue(record.title)
    expect(writes).toBe(1)
    await submit.click()
    await expect(composer).toHaveCount(0)
    await expect(addIssue).toBeVisible()
    await expect(page.getByRole('link', { name: record.title })).toBeVisible()
    expect(writes).toBe(2)
  } finally { release() }
})
