import { expect, test } from '@playwright/test'

test('grey CI recovery starts off, persists opt-in and skips, and links its last merge', async ({ page }) => {
  let enabled = false
  let skipRepos: string[] = []
  const writes: Array<Record<string, unknown>> = []
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const body = route.request().method() === 'POST' ? route.request().postDataJSON() as Record<string, unknown> : {}
    if (url.pathname === '/api/settings') return route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', models: {} } })
    if (url.pathname === '/api/repos') return route.fulfill({ json: { repos: ['acme/app', 'acme/skip'] } })
    if (url.pathname === '/api/organizations') return route.fulfill({ json: { organizations: [{ login: 'acme', status: 'ready', stage: 'ready', managed: false }] } })
    if (url.pathname === '/api/behaviors/rerun-grey-ci') {
      writes.push(body)
      if (typeof body.enabled === 'boolean') enabled = body.enabled
      if (Array.isArray(body.skipRepos)) skipRepos = body.skipRepos as string[]
      return route.fulfill({ json: { ok: true, enabled, skipRepos } })
    }
    if (url.pathname === '/api/behaviors') {
      const behavior = { owner: 'review-bot', enabled: false, setting: null, reviewers: null, scratchpad: null, skipRepos: [], lastTriggered: null }
      return route.fulfill({ json: {
        'review-new-prs': { ...behavior, setting: 'p2', reviewers: 1, scratchpad: '' },
        'approve-prs': { ...behavior, scratchpad: '' },
        'resolve-unblocking': behavior,
        'merge-prs': behavior,
        'rerun-grey-ci': { ...behavior, enabled, skipRepos, lastTriggered: { at: new Date().toISOString(), target: 'acme/app#7', url: 'https://github.com/acme/app/actions/runs/100' } },
        'review-new-issues': { ...behavior, reviewers: 1, repos: [], authors: ['octocat'], scratchpad: '' },
        diagnostics: { status: 'ok', agentLogsError: null, failures: [], deadLetters: [], holds: [],
          datastore: { status: 'healthy', checkedAt: new Date().toISOString(), ageSeconds: 1, lastSuccessAt: null, error: null },
          identity: { status: 'valid', actor: 'review-bot', error: null } },
      } })
    }
    if (url.pathname === '/api/claude-auth') return route.fulfill({ json: { status: 'authenticated', loginInProgress: false } })
    if (url.pathname === '/api/gh') return route.fulfill({ json: body.count_only ? { count: 0 } : { records: [] } })
    return route.fulfill({ json: {} })
  })
  const row = page.locator('tr[data-behavior="rerun-grey-ci"]')
  const toggle = row.locator('input[type="checkbox"]')
  await page.goto('/')
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await expect(row).toContainText('Rerun Grey CI')
  await expect(toggle).toBeEnabled()
  await expect(toggle).not.toBeChecked()
  await expect(row.locator('.behavior-memory-btn')).toHaveCount(0)
  await expect(row.locator('.behavior-reviewers')).toHaveCount(0)
  await expect(row.locator('.behavior-last-link')).toHaveAttribute('href', 'https://github.com/acme/app/actions/runs/100')
  await row.locator('.toggle').click()
  await expect(toggle).toBeChecked()
  await expect.poll(() => enabled).toBe(true)
  await row.locator('.behavior-triggers-btn').click()
  const dialog = page.getByRole('dialog', { name: 'Setting for Rerun Grey CI' })
  await dialog.getByRole('checkbox', { name: 'acme/skip', exact: true }).check()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => skipRepos).toEqual(['acme/skip'])
  await page.reload()
  await page.getByRole('button', { name: 'Behaviors', exact: true }).click()
  await expect(toggle).toBeChecked()
  await expect(row.locator('.behavior-triggers-btn')).toHaveText('Skip 1')
  await row.locator('.toggle').click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(() => enabled).toBe(false)
  expect(writes).toEqual([{ enabled: true }, { skipRepos: ['acme/skip'] }, { enabled: false }])
})
