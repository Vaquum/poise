import { expect, test, type Page, type Route } from '@playwright/test'

import { workspace } from './fixtures/workspace'

// Settings → Publishing and the Editor's Publish panel (docs/Publishing.md),
// with GitHub's side answered here: nothing reaches a repository.

const VERSION = 'a'.repeat(64)
const TEXT = '# A better question\n\nThe opening paragraph.\n'

const WRITING_FIELDS = [
  { name: 'type', kind: 'choice', required: false, default: 'essay', choices: ['essay', 'note'] },
  { name: 'title', kind: 'text', required: true, max: 220 },
  { name: 'description', kind: 'text', required: false, max: 420, lines: 'many' },
  { name: 'date', kind: 'date', required: true, default: 'today' },
  { name: 'tags', kind: 'list', required: false, suggestions: ['machine-intelligence', 'ad-fraud'] },
]
const MIKKO = {
  repo: 'mikkokotila/mikkokotila-com', state: 'ready', source: 'repository', site: 'mikkokotila.com',
  sections: [{ name: 'Writing', url: 'https://mikkokotila.com/writing/{slug}/', firstLine: 'title', fields: WRITING_FIELDS }],
}
const JOURNAL = {
  repo: 'acme/journal', state: 'ready', source: 'settings', site: 'Other Journal', description: 'version: 1\n',
  sections: [{ name: 'Posts', url: 'https://journal.example/{slug}/', fields: [{ name: 'title', kind: 'text', required: true }] }],
}
const MISSING = { repo: 'acme/journal', state: 'missing', source: null, problem: 'acme/journal has no publish.yaml. Add one to the repository, or describe the site here.' }

function publication(site: typeof MIKKO | typeof JOURNAL, number: number, values: Record<string, unknown>) {
  return {
    repo: site.repo, section: site.sections[0].name, site: site.site, slug: 'a-better-question', path: 'a-better-question.md',
    url: site.sections[0].url.replace('{slug}', 'a-better-question'), values, publishedAt: '2026-10-17T08:00:00Z', updatedAt: '2026-10-17T08:00:00Z',
    pullRequest: { number, url: `https://github.com/${site.repo}/pull/${number}`, state: 'open' }, changed: false,
  }
}

async function openEditor(page: Page, sites: unknown[], answer: (body: any) => unknown): Promise<any[]> {
  const sent: any[] = []
  await page.route('**/api/publishing/sites', (route) => route.fulfill({ json: { sites } }))
  await page.route('**/api/editor/**', async (route: Route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/editor/docs') return route.fulfill({ json: { docs: [{ slug: 'draft-1', title: 'A better question', updated_at: '2026-10-17T08:00:00Z', size: TEXT.length }] } })
    if (path === '/api/editor/doc/draft-1') return route.fulfill({ json: { slug: 'draft-1', content: TEXT, updated_at: '2026-10-17T08:00:00Z', version: VERSION } })
    if (path === '/api/editor/doc/draft-1/annotations') return route.fulfill({ json: { annotations: [], version: VERSION } })
    if (path === '/api/editor/doc/draft-1/publishing') return route.fulfill({ json: { title: 'A better question', slug: 'a-better-question', today: '2026-10-17', publications: [] } })
    if (path === '/api/editor/doc/draft-1/publish') {
      const body = request.postDataJSON()
      sent.push(body)
      return route.fulfill({ json: answer(body) })
    }
    return route.fulfill({ json: {} })
  })
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(page.locator('#editor-doc')).toContainText('The opening paragraph.')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Publish' })).toBeVisible()
  return sent
}

test('the server answers for publishing sites', async ({ page }) => {
  const response = await page.request.get('/api/publishing/sites')
  expect(response.status()).toBe(200)
  expect(await response.json()).toEqual({ sites: [] })
})

test('Settings → Publishing lists each site with its state, adds, describes and removes one', async ({ page }, info) => {
  await workspace(page)
  let sites: unknown[] = [MIKKO, MISSING]
  const requests: Array<{ method: string, path: string, body: unknown }> = []
  await page.route('**/api/publishing/sites**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    requests.push({ method: request.method(), path, body: request.postDataJSON() })
    if (request.method() === 'POST') {
      const added = { ...MIKKO, repo: 'acme/notes', site: 'Notes' }
      sites = [...sites, added]
      return route.fulfill({ json: { site: added } })
    }
    if (request.method() === 'PUT') return route.fulfill({ json: { site: JOURNAL } })
    if (request.method() === 'DELETE') return route.fulfill({ json: { ok: true } })
    return route.fulfill({ json: { sites } })
  })

  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('#menu-popover').getByRole('button', { name: 'Publishing', exact: true }).click()
  const panel = page.locator('#settings-panel')
  await expect(panel.locator('.tp-title')).toHaveText('Publishing')
  await expect(panel.locator('.st-footer')).toBeHidden()
  const rows = panel.locator('.pb-site')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('mikkokotila.com')
  await expect(rows.nth(0)).toContainText('mikkokotila/mikkokotila-com')
  await expect(rows.nth(0).locator('.pb-site-state')).toHaveText('Ready')
  await expect(rows.nth(1).locator('.pb-site-state')).toHaveText(MISSING.problem)
  await expect(rows.nth(0).getByRole('button', { name: 'Describe' })).toHaveCount(0)

  await panel.getByLabel('Repository to publish to').fill('acme/notes')
  await panel.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(2)).toContainText('Notes')
  expect(requests.find((r) => r.method === 'POST')?.body).toEqual({ repo: 'acme/notes' })

  await rows.nth(1).getByRole('button', { name: 'Describe' }).click()
  const description = rows.nth(1).getByLabel('publish.yaml for acme/journal')
  await expect(description).toHaveValue(/^version: 1\nsite: journal\n/)
  await page.screenshot({ path: info.outputPath('settings-publishing.png') })
  await rows.nth(1).getByRole('button', { name: 'Save' }).click()
  await expect(rows.nth(1).locator('.pb-site-state')).toHaveText('Ready · described here')
  expect(requests.find((r) => r.method === 'PUT')).toMatchObject({ path: '/api/publishing/sites/acme/journal/description' })

  const remove = rows.nth(2).getByRole('button', { name: 'Remove' })
  await remove.click()
  await expect(rows.nth(2).getByRole('button', { name: 'Confirm remove' })).toBeVisible()
  await rows.nth(2).getByRole('button', { name: 'Confirm remove' }).click()
  await expect(rows).toHaveCount(2)
  expect(requests.find((r) => r.method === 'DELETE')?.path).toBe('/api/publishing/sites/acme/notes')
})

test('the Editor publishes to two sites at once and shows both pull requests', async ({ page }, info) => {
  await workspace(page)
  const sent = await openEditor(page, [MIKKO, JOURNAL], (body) => ({ results: body.destinations.map((d: any) => ({
    repo: d.repo, section: d.section, ok: true,
    publication: d.repo === MIKKO.repo ? publication(MIKKO, 101, d.values) : publication(JOURNAL, 7, d.values),
  })) }))
  const dialog = page.getByRole('dialog', { name: 'Publish' })
  await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled()
  await dialog.getByLabel('mikkokotila.com').check()
  await dialog.getByLabel('Other Journal').check()
  await expect(dialog.getByLabel('Title')).toHaveValue('A better question')
  await expect(dialog.getByLabel('Slug')).toHaveCount(2)
  await expect(dialog.getByLabel('Slug').first()).toHaveValue('a-better-question')
  await dialog.getByLabel('Title').fill('A better question, asked')
  await expect(dialog.getByLabel('Slug').first()).toHaveValue('a-better-question-asked')
  await dialog.getByLabel('Description').fill('One or two sentences.')
  await dialog.getByRole('button', { name: 'ad-fraud' }).click()
  await expect(dialog.getByLabel('tags')).toHaveValue('ad-fraud')
  await page.screenshot({ path: info.outputPath('editor-publish.png') })

  await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(dialog.getByRole('link', { name: 'Pull request #101' })).toHaveAttribute('href', 'https://github.com/mikkokotila/mikkokotila-com/pull/101')
  await expect(dialog.getByRole('link', { name: 'Pull request #7' })).toBeVisible()
  await expect(dialog.locator('.ep-pr')).toHaveText(['#101 open', '#7 open'])
  await expect(dialog.getByRole('button', { name: 'Update', exact: true })).toBeEnabled()
  expect(sent).toEqual([{ destinations: [
    { repo: MIKKO.repo, section: 'Writing', slug: 'a-better-question-asked', values: { type: 'essay', tags: ['ad-fraud'], title: 'A better question, asked', description: 'One or two sentences.', date: '2026-10-17' } },
    { repo: JOURNAL.repo, section: 'Posts', slug: 'a-better-question-asked', values: { title: 'A better question, asked' } },
  ] }])
  await page.screenshot({ path: info.outputPath('editor-published.png') })

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeFocused()
})

test('a change made on the site is replaced only when asked', async ({ page }) => {
  await workspace(page)
  const sent = await openEditor(page, [MIKKO], (body) => ({ results: [body.replace
    ? { repo: MIKKO.repo, section: 'Writing', ok: true, publication: publication(MIKKO, 101, body.destinations[0].values) }
    : { repo: MIKKO.repo, section: 'Writing', ok: false, conflicts: ['the text'], error: 'Changed on mikkokotila.com since you published: the text. Publish again to replace it with this document\'s version.' }] }))
  const dialog = page.getByRole('dialog', { name: 'Publish' })
  // One site: it is chosen already.
  await expect(dialog.getByLabel('mikkokotila.com')).toBeChecked()
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Changed on mikkokotila.com since you published: the text.')
  await dialog.getByRole('button', { name: 'Replace with mine' }).click()
  await expect(dialog.getByRole('link', { name: 'Pull request #101' })).toBeVisible()
  expect(sent.map((body) => body.replace ?? false)).toEqual([false, true])
})

test('with no sites, the panel points to Settings → Publishing', async ({ page }) => {
  await workspace(page)
  await openEditor(page, [], () => ({ results: [] }))
  await page.getByRole('dialog', { name: 'Publish' }).getByRole('button', { name: 'Add one in Settings → Publishing' }).click()
  await expect(page.locator('#settings-panel .tp-title')).toHaveText('Publishing')
})
