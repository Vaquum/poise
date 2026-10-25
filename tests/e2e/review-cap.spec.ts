import { expect, test, type Page } from '@playwright/test'

// The review-round cap in the Behaviors view: Approve Pull Requests chooses
// the round from which a run files its findings as one follow-up issue and
// approves. The API is played by the test so the stored cap survives a reload.
const REPOS = ['acme/api', 'acme/web']
const ACCOUNTS = ['acme'].map((login) => ({
  login, managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: '2026-10-01T08:00:00Z',
}))

async function setup(page: Page) {
  const state = {
    behaviors: {
      'review-new-prs': { setting: 'p2', reviewers: 1, skipRepos: [] as string[] },
      'approve-prs': { setting: null, reviewers: null, reviewCap: null as number | null, skipRepos: [] as string[] },
      'resolve-unblocking': { setting: null, reviewers: null, skipRepos: [] as string[], scratchpad: null },
      'review-new-issues': { setting: null, reviewers: 1, repos: ['acme/api'], authors: ['octocat'] },
    } as Record<string, Record<string, unknown>>,
    writes: [] as Array<{ key: string, body: Record<string, unknown> }>,
  }
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : {}
    if (url.pathname === '/api/settings') return route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', organizations: ACCOUNTS, models: {} } })
    if (url.pathname === '/api/organizations') return route.fulfill({ json: { organizations: ACCOUNTS } })
    if (url.pathname === '/api/repos') return route.fulfill({ json: { repos: REPOS } })
    if (url.pathname.startsWith('/api/behaviors/')) {
      const key = url.pathname.split('/').pop()!
      state.writes.push({ key, body })
      state.behaviors[key] = { ...state.behaviors[key], ...body }
      return route.fulfill({ json: { ok: true, enabled: false, scratchpad: '', ...state.behaviors[key] } })
    }
    if (url.pathname === '/api/behaviors') {
      const behavior = { owner: 'review-bot', enabled: false, scratchpad: '', lastTriggered: null }
      return route.fulfill({ json: {
        ...Object.fromEntries(Object.entries(state.behaviors).map(([key, value]) => [key, { ...behavior, ...value }])),
        diagnostics: { status: 'ok', agentLogsError: null, datastore: { status: 'healthy', checkedAt: new Date().toISOString(), ageSeconds: 1, lastSuccessAt: null, error: null }, identity: { status: 'valid', actor: 'review-bot', error: null }, failures: [], deadLetters: [], holds: [] },
      } })
    }
    if (url.pathname === '/api/agent-logs') return route.fulfill({ json: { logs: [], quarantined: [] } })
    if (url.pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    if (url.pathname === '/api/gh') return route.fulfill({ json: body.count_only ? { count: 0 } : { records: [] } })
    return route.fulfill({ json: {} })
  })
  return state
}

async function openBehaviors(page: Page) {
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await expect(page.locator('tr[data-behavior="approve-prs"] .behavior-triggers-btn')).toBeVisible()
}

test('saves the review cap from the Approve dropdown and keeps it across a reload', async ({ page }) => {
  const state = await setup(page)
  await page.goto('/')
  await openBehaviors(page)
  const pill = page.locator('tr[data-behavior="approve-prs"] .behavior-triggers-btn')
  await expect(pill).toHaveText('All repos')

  await pill.click()
  const dialog = page.getByRole('dialog', { name: 'Setting for Approve Pull Requests' })
  const cap = dialog.getByLabel('Review cap')
  await expect(cap).toBeVisible()
  await expect(cap).toBeFocused()
  await expect(cap).toHaveValue('')
  await expect(dialog.getByLabel('Priority')).toBeHidden()
  await cap.selectOption('5')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => state.writes).toEqual([{ key: 'approve-prs', body: { reviewCap: 5 } }])
  await expect(dialog).toBeHidden()
  await expect(pill).toHaveText('Cap 5')

  await page.reload()
  await openBehaviors(page)
  await expect(pill).toHaveText('Cap 5')
  await pill.click()
  await expect(dialog.getByLabel('Review cap')).toHaveValue('5')
  await dialog.getByLabel('Review cap').selectOption('')
  await page.keyboard.press('Escape')
  await expect.poll(() => state.writes.length).toBe(2)
  expect(state.writes[1]).toEqual({ key: 'approve-prs', body: { reviewCap: null } })
  await expect(pill).toHaveText('All repos')
})
