import { expect, test, type Page } from '@playwright/test'
import { workspace } from './fixtures/workspace'
import { feedback } from './fixtures/view-feedback'

const LABELS_A = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'no-triage', color: 'cccccc', description: null },
]
const LABELS_B = [{ name: 'docs', color: '0075ca', description: null }]

interface Setup {
  bodies: Array<Record<string, unknown>>
  dropped: string[]
}

async function setup(page: Page): Promise<Setup> {
  const state: Setup = { bodies: [], dropped: [] }
  await workspace(page)
  await page.route('**/api/repos', (route) => route.fulfill({ json: { repos: ['acme/project', 'acme/other'] } }))
  await page.route('**/api/gh', async (route) => {
    const body = route.request().postDataJSON()
    if (body?.operation === 'list_repo_labels') {
      return route.fulfill({ json: { labels: body.repository_full_name === 'acme/other' ? LABELS_B : LABELS_A } })
    }
    if (body?.operation === 'open_issue') {
      state.bodies.push(body)
      const now = new Date().toISOString()
      return route.fulfill({ json: {
        record: { repo: body.repository_full_name, number: 9001, title: body.title, kind: 'issue', state: 'open',
          url: 'https://github.com/acme/project/issues/9001', created_at: now, updated_at: now, merged_at: null },
        labels_dropped: state.dropped,
      } })
    }
    return route.fulfill({ json: { records: [] } })
  })
  await page.reload()
  return state
}

async function openComposer(page: Page) {
  await page.getByRole('button', { name: 'Add an issue', exact: true }).click()
  const composer = page.locator('.composer-issue')
  await expect(composer).toBeVisible()
  return composer
}

test('picks labels behind the tag icon and sends them with the issue', async ({ page }) => {
  const state = await setup(page)
  const composer = await openComposer(page)
  await composer.locator('.issue-repo').selectOption('acme/project')
  const pop = composer.locator('.composer-labels-pop')
  await composer.getByRole('button', { name: 'Labels' }).click()
  await expect(pop).toBeVisible()
  await expect(pop.getByRole('checkbox', { name: 'bug' })).toBeVisible()
  await pop.getByRole('checkbox', { name: 'bug' }).check()
  await pop.getByRole('checkbox', { name: 'enhancement' }).check()
  await expect(composer.locator('.composer-labels-count')).toHaveText('2')
  // The filter narrows the list; Escape closes the panel, keeping the picks.
  await pop.locator('.composer-labels-filter').fill('bug')
  await expect(pop.getByRole('checkbox')).toHaveCount(1)
  await pop.locator('.composer-labels-filter').press('Escape')
  await expect(pop).toBeHidden()
  await expect(composer.locator('.composer-labels-count')).toHaveText('2')
  // Reopening keeps the selection; switching repos clears it.
  await composer.getByRole('button', { name: 'Labels' }).click()
  await expect(pop.getByRole('checkbox', { name: 'bug' })).toBeChecked()
  await pop.locator('.composer-labels-filter').press('Escape')
  await composer.locator('.issue-repo').selectOption('acme/other')
  await expect(composer.locator('.composer-labels-count')).toBeHidden()
  await composer.getByRole('button', { name: 'Labels' }).click()
  await expect(pop.getByRole('checkbox')).toHaveCount(1)
  await expect(pop.getByRole('checkbox', { name: 'docs' })).toBeVisible()
  await pop.getByRole('checkbox', { name: 'docs' }).check()
  await pop.locator('.composer-labels-filter').press('Escape')
  await composer.locator('.issue-title').fill('Labeled issue')
  await composer.getByRole('button', { name: 'Open issue', exact: true }).click()
  await expect(composer).toHaveCount(0)
  expect(state.bodies).toHaveLength(1)
  expect(state.bodies[0]).toMatchObject({ labels: ['docs'] })
  await expect(page.getByRole('link', { name: 'Labeled issue' })).toBeVisible()
})

test('says plainly which labels GitHub did not apply', async ({ page }) => {
  const state = await setup(page)
  state.dropped = ['no-triage']
  const composer = await openComposer(page)
  await composer.locator('.issue-repo').selectOption('acme/project')
  await composer.getByRole('button', { name: 'Labels' }).click()
  const pop = composer.locator('.composer-labels-pop')
  await pop.getByRole('checkbox', { name: 'no-triage' }).check()
  await pop.locator('.composer-labels-filter').press('Escape')
  await composer.locator('.issue-title').fill('Half-labeled issue')
  await composer.getByRole('button', { name: 'Open issue', exact: true }).click()
  await expect(composer).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Half-labeled issue' })).toBeVisible()
  const rail = await feedback(page)
  await expect(rail.locator('.nr-card').filter({ hasText: 'Current item created' })).toContainText('did not apply these labels')
  await expect(rail.locator('.nr-card').filter({ hasText: 'Current item created' })).toContainText('no-triage')
})

test('keeps selected labels when another selection is hidden by the filter', async ({ page }) => {
  const state = await setup(page)
  const composer = await openComposer(page)
  await composer.locator('.issue-repo').selectOption('acme/project')
  await composer.getByRole('button', { name: 'Labels', exact: true }).click()
  const pop = composer.locator('.composer-labels-pop')
  await pop.getByRole('checkbox', { name: 'bug', exact: true }).check()
  await pop.getByRole('searchbox', { name: 'Filter labels' }).fill('enhancement')
  await pop.getByRole('checkbox', { name: 'enhancement', exact: true }).check()
  await expect(composer.locator('.composer-labels-count')).toHaveText('2')
  await pop.getByRole('searchbox', { name: 'Filter labels' }).fill('bug')
  await expect(pop.getByRole('checkbox', { name: 'bug', exact: true })).toBeChecked()
  await pop.getByRole('searchbox', { name: 'Filter labels' }).press('Escape')
  await composer.locator('.issue-title').fill('Both selected labels')
  await composer.getByRole('button', { name: 'Open issue', exact: true }).click()
  await expect(composer).toHaveCount(0)
  expect(state.bodies[0]).toMatchObject({ labels: ['bug', 'enhancement'] })
})

test('reopens labels with the first click after an outside click closes them', async ({ page }) => {
  await setup(page)
  const composer = await openComposer(page)
  await composer.locator('.issue-repo').selectOption('acme/project')
  const button = composer.getByRole('button', { name: 'Labels', exact: true })
  const pop = composer.locator('.composer-labels-pop')
  await button.click()
  await expect(pop).toBeVisible()
  await composer.locator('.issue-title').click()
  await expect(pop).toBeHidden()
  await button.click()
  await expect(pop).toBeVisible()
})

test('a failed catalogue reads as failed and still allows a label-less issue', async ({ page }) => {
  await workspace(page)
  await page.route('**/api/repos', (route) => route.fulfill({ json: { repos: ['acme/project'] } }))
  await page.route('**/api/gh', async (route) => {
    const body = route.request().postDataJSON()
    if (body?.operation === 'list_repo_labels') return route.fulfill({ status: 503, json: { error: 'Read unavailable' } })
    if (body?.operation === 'open_issue') {
      const now = new Date().toISOString()
      expect(body.labels).toBeUndefined()
      return route.fulfill({ json: {
        record: { repo: body.repository_full_name, number: 9002, title: body.title, kind: 'issue', state: 'open',
          url: 'https://github.com/acme/project/issues/9002', created_at: now, updated_at: now, merged_at: null },
        labels_dropped: [],
      } })
    }
    return route.fulfill({ json: { records: [] } })
  })
  await page.reload()
  const composer = await openComposer(page)
  await composer.locator('.issue-repo').selectOption('acme/project')
  await composer.getByRole('button', { name: 'Labels' }).click()
  const pop = composer.locator('.composer-labels-pop')
  await expect(pop.locator('.composer-labels-empty')).toContainText('Could not load labels')
  await pop.locator('.composer-labels-filter').press('Escape')
  await composer.locator('.issue-title').fill('Unlabeled issue')
  await composer.getByRole('button', { name: 'Open issue', exact: true }).click()
  await expect(composer).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Unlabeled issue' })).toBeVisible()
})
