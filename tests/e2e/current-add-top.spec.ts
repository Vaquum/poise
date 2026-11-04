import { expect, test } from '@playwright/test'
import { workspace } from './fixtures/workspace'

const NOW = '2026-09-18T09:00:00.000Z'

// The lane's Add control sits directly under the header — in the first
// viewport on a long lane — and the composer opens in that spot, so the
// created item lands next to where it was composed.
test('Add and its composer sit above the lane, and a created issue lands in view', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/repos', (route) => route.fulfill({ json: { repos: ['acme/project'] } }))
  const issues = Array.from({ length: 30 }, (_, i) => ({
    kind: 'issue', repo: 'acme/project', number: 100 + i, state: 'open', title: `Older issue ${i + 1}`,
    url: `https://github.com/acme/project/issues/${100 + i}`, created_at: NOW, updated_at: NOW, merged_at: null,
  }))
  // Fresh timestamps: reconcilePending drops an optimistic entry older than its TTL.
  const fresh = new Date().toISOString()
  const record = { repo: 'acme/project', number: 9001, title: 'Fresh from the top', kind: 'issue', state: 'open',
    url: 'https://github.com/acme/project/issues/9001', created_at: fresh, updated_at: fresh, merged_at: null }
  await page.route('**/api/gh', async (route) => {
    const body = route.request().postDataJSON()
    if (body?.operation === 'open_issue') return route.fulfill({ json: { record } })
    return route.fulfill({ json: { records: issues } })
  })
  await page.reload()
  const lane = page.locator('.lane[data-lane="issue"]')
  await expect(lane.locator('.card')).toHaveCount(30)
  const viewport = page.viewportSize()!
  const addIssue = lane.getByRole('button', { name: 'Add an issue', exact: true })
  const addBox = (await addIssue.boundingBox())!
  const firstCardBox = (await lane.locator('.card').first().boundingBox())!
  // In the first viewport on a lane that scrolls far past it…
  expect(addBox.y).toBeGreaterThanOrEqual(0)
  expect(addBox.y + addBox.height).toBeLessThanOrEqual(viewport.height)
  // …and above the first card in DOM order, so keyboard navigation agrees.
  expect(addBox.y + addBox.height).toBeLessThanOrEqual(firstCardBox.y)
  await addIssue.click()
  const composer = page.locator('.composer-issue')
  await expect(composer).toBeVisible()
  const composerBox = (await composer.boundingBox())!
  expect(composerBox.y + composerBox.height).toBeLessThanOrEqual((await lane.locator('.card').first().boundingBox())!.y)
  await composer.locator('.issue-title').fill(record.title)
  await composer.locator('.issue-repo').selectOption('acme/project')
  await composer.getByRole('button', { name: 'Open issue', exact: true }).click()
  await expect(composer).toHaveCount(0)
  const created = lane.getByRole('link', { name: record.title })
  await expect(created).toBeVisible()
  // …with no scrolling: the new card is inside the viewport it was made in.
  const createdBox = (await created.boundingBox())!
  expect(createdBox.y).toBeGreaterThanOrEqual(0)
  expect(createdBox.y + createdBox.height).toBeLessThanOrEqual(viewport.height)
})

test('manual lanes compose at the top and still append at the bottom', async ({ page }) => {
  await workspace(page)
  const cards = [
    { id: 1, text: 'First thought', lane: 'idea', position: 0, repo: null, created_at: NOW, updated_at: NOW },
    { id: 2, text: 'Second thought', lane: 'idea', position: 1, repo: null, created_at: NOW, updated_at: NOW },
  ]
  await page.route('**/api/current', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      return route.fulfill({ json: { id: 3, text: body.text, lane: body.lane, position: 2, repo: body.repo ?? null, created_at: NOW, updated_at: NOW } })
    }
    return route.fulfill({ json: { cards } })
  })
  await page.reload()
  const lane = page.locator('.lane[data-lane="idea"]')
  await expect(lane.locator('.card')).toHaveCount(2)
  const add = lane.getByRole('button', { name: 'Add a card to Idea', exact: true })
  const addBox = (await add.boundingBox())!
  expect(addBox.y + addBox.height).toBeLessThanOrEqual((await lane.locator('.card').first().boundingBox())!.y)
  await add.click()
  const composer = lane.locator('.composer')
  await expect(composer).toBeVisible()
  expect((await composer.boundingBox())!.y + (await composer.boundingBox())!.height)
    .toBeLessThanOrEqual((await lane.locator('.card').first().boundingBox())!.y)
  await composer.locator('textarea').fill('Appended thought')
  await composer.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(composer).toHaveCount(0)
  // Only the control moved: manual cards keep their append order.
  await expect(lane.locator('.card').last()).toContainText('Appended thought')
})
