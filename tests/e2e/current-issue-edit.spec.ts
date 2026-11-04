import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { feedback } from './fixtures/view-feedback'

async function setup(page: Page, failure?: number) {
  await workspace(page)
  const before = new Date(Date.now() - 60_000).toISOString()
  const record = { kind: 'issue', repo: 'acme/project', number: 42, state: 'open', title: 'Existing issue',
    url: 'https://github.com/acme/project/issues/42', created_at: before, updated_at: before, merged_at: null }
  const writes: Array<Record<string, unknown>> = []
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/repos', route => route.fulfill({ json: { repos: ['acme/project'] } }))
  await page.route('**/api/gh', async route => {
    const body = route.request().postDataJSON()
    if (body.operation === 'read_issue') {
      expect(body).toMatchObject({ repository_full_name: 'acme/project', issue_number: 42 })
      return route.fulfill({ json: { issue: { number: 42, title: record.title, body: 'Current issue body' } } })
    }
    if (body.operation === 'edit_issue') {
      writes.push(body)
      await pending
      if (failure) return route.fulfill({ status: failure, json: { error: failure === 409 ? 'The issue changed on GitHub' : 'Save unavailable' } })
      return route.fulfill({ json: { record: { ...record, title: body.title, updated_at: new Date().toISOString() } } })
    }
    expect(body.operation).not.toBe('open_issue')
    // Deliberately stale after the write: the existing cache has not caught up yet.
    return route.fulfill({ json: { records: body.item_type === 'pr' || body.operation === 'green_pr' ? [] : [record] } })
  })
  await page.reload()
  await expect(page.getByRole('link', { name: /Existing issue/ })).toBeVisible()
  await page.locator('.card-live').filter({ hasText: 'Existing issue' }).hover()
  return { writes, release }
}

test('edits an existing issue once, preserves a pending draft, and survives a stale cache read', async ({ page }) => {
  const state = await setup(page)
  await page.getByRole('button', { name: 'Edit issue acme/project#42', exact: true }).click()
  const composer = page.locator('.composer-issue-edit')
  await expect(composer.getByLabel('Issue title', { exact: true })).toHaveValue('Existing issue')
  await expect(composer.getByLabel('Issue body', { exact: true })).toHaveValue('Current issue body')
  await expect(composer.locator('.issue-repo')).toBeDisabled()
  await expect(composer.getByRole('button', { name: 'Labels', exact: true })).toBeHidden()
  await composer.getByLabel('Issue title', { exact: true }).fill('Edited existing issue')
  await composer.getByLabel('Issue body', { exact: true }).fill('Updated body\nwith another line')
  await composer.getByRole('button', { name: 'Save issue', exact: true }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  await expect(composer.getByRole('button', { name: 'Save issue', exact: true })).toBeDisabled()
  await composer.getByRole('button', { name: 'Cancel', exact: true }).click()
  await composer.getByLabel('Issue body', { exact: true }).press('Control+Enter')
  await expect(composer).toBeVisible()
  expect(state.writes).toHaveLength(1)
  state.release()
  await expect(composer).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Edited existing issue/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Existing issue/ })).toHaveCount(0)
  expect(state.writes[0]).toMatchObject({ operation: 'edit_issue', repository_full_name: 'acme/project', issue_number: 42,
    title: 'Edited existing issue', body: 'Updated body\nwith another line', expected_title: 'Existing issue', expected_body: 'Current issue body' })
})

for (const status of [409, 503]) {
  test(`retains the issue edit after a ${status} refusal`, async ({ page }) => {
    const state = await setup(page, status)
    await page.getByRole('button', { name: 'Edit issue acme/project#42', exact: true }).click()
    const composer = page.locator('.composer-issue-edit')
    await composer.getByLabel('Issue title', { exact: true }).fill('Retain my edit')
    await composer.getByLabel('Issue body', { exact: true }).fill('Keep this body')
    state.release()
    await composer.getByRole('button', { name: 'Save issue', exact: true }).click()
    const rail = await feedback(page)
    await expect(rail.locator('.nr-card').filter({ hasText: 'Current action needs attention' })).toContainText(status === 409 ? 'issue changed' : 'Save unavailable')
    await expect(composer.getByLabel('Issue title', { exact: true })).toHaveValue('Retain my edit')
    await expect(composer.getByLabel('Issue body', { exact: true })).toHaveValue('Keep this body')
    await expect(composer.getByRole('button', { name: 'Save issue', exact: true })).toBeEnabled()
    await expect(page.getByRole('link', { name: /Existing issue/ })).toBeVisible()
    expect(state.writes).toHaveLength(1)
  })
}

test('retains the draft when a save acknowledgement names another issue', async ({ page }) => {
  await setup(page)
  await page.route('**/api/gh', async route => {
    if (route.request().postDataJSON().operation !== 'edit_issue') return route.fallback()
    return route.fulfill({ json: { record: { kind: 'issue', repo: 'acme/project', number: 43, title: 'Wrong target' } } })
  })
  await page.getByRole('button', { name: 'Edit issue acme/project#42', exact: true }).click()
  const composer = page.locator('.composer-issue-edit')
  await composer.getByLabel('Issue title', { exact: true }).fill('Retain this title')
  await composer.getByRole('button', { name: 'Save issue', exact: true }).click()
  const rail = await feedback(page)
  await expect(rail.locator('.nr-card').filter({ hasText: 'Current action needs attention' })).toContainText('did not confirm the edited issue')
  await expect(composer.getByLabel('Issue title', { exact: true })).toHaveValue('Retain this title')
  await expect(page.getByRole('link', { name: /Existing issue/ })).toBeVisible()
})
