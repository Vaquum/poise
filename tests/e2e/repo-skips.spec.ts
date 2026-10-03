import { expect, test, type Page } from '@playwright/test'

// Skip repositories in the Behaviors view, and a replay refused in Swarm. The
// API is played by the test so the stored state survives a reload.
const REPOS = ['acme/api', 'acme/billing', 'acme/web', 'octocat/dotfiles', 'octocat/notes']
const ACCOUNTS = ['acme', 'octocat'].map((login) => ({
  login, managed: login !== 'acme', status: 'ready', stage: 'ready', error: null, activatedAt: '2026-10-01T08:00:00Z',
}))

async function setup(page: Page) {
  const state = {
    behaviors: {
      'review-new-prs': { setting: 'p2', reviewers: 1, skipRepos: [] as string[] },
      'approve-prs': { setting: null, reviewers: null, skipRepos: [] as string[] },
      'resolve-unblocking': { setting: null, reviewers: null, skipRepos: [] as string[], scratchpad: null },
      'review-new-issues': { setting: null, reviewers: 1, repos: ['acme/api'], authors: ['octocat'] },
    } as Record<string, Record<string, unknown>>,
    writes: [] as Array<{ key: string, body: Record<string, unknown> }>,
    repoReads: 0,
    replay: { status: 409, json: { error: 'Replay refused: acme/api#7 is a draft.' } as Record<string, unknown> },
    replays: [] as Array<Record<string, unknown>>,
  }
  await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('poise-view', 'main') })
  await page.route(/https:\/\/(?:rsms\.me|fonts\.googleapis\.com|fonts\.gstatic\.com|github\.com)\//, (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : {}
    if (url.pathname === '/api/settings') return route.fulfill({ json: { org: 'acme', me: 'octocat', timezone: 'UTC', organizations: ACCOUNTS, models: {} } })
    if (url.pathname === '/api/organizations') return route.fulfill({ json: { organizations: ACCOUNTS } })
    if (url.pathname === '/api/repos') {
      state.repoReads++
      return route.fulfill({ json: { repos: REPOS } })
    }
    if (url.pathname.startsWith('/api/behaviors/')) {
      const key = url.pathname.split('/').pop()!
      state.writes.push({ key, body })
      // Stored as the server stores it: one entry per repository, sorted.
      if (Array.isArray(body.skipRepos)) body.skipRepos = [...new Set(body.skipRepos as string[])].sort()
      state.behaviors[key] = { ...state.behaviors[key], ...body }
      return route.fulfill({ json: { ok: true, enabled: false, scratchpad: '', ...state.behaviors[key] } })
    }
    if (url.pathname === '/api/behaviors') {
      const behavior = { owner: 'review-bot', enabled: false, scratchpad: '', lastTriggered: null }
      return route.fulfill({ json: {
        ...Object.fromEntries(Object.entries(state.behaviors).map(([key, value]) => [key, { ...behavior, ...value }])),
        diagnostics: { status: 'ok', agentLogsError: null, datastore: { status: 'healthy', checkedAt: new Date().toISOString(), ageSeconds: 1, lastSuccessAt: null, error: null }, identity: { status: 'valid', actor: 'review-bot', error: null }, failures: [], deadLetters: [] },
      } })
    }
    if (url.pathname === '/api/agent-logs') {
      const run = (id: string, behavior: string, repo: string, pr: string) => ({
        id: id.repeat(32), pr_id: pr, repo, actor: 'review-bot', model: 'opus-5-xhigh', behavior, session_id: null, prompt: '',
        started_at: new Date(Date.now() - 60_000).toISOString(), started_at_precise: null, completed_at: new Date().toISOString(),
        time_elapsed: '1m', status: 'completed', outcome: 'clean', response: '', error: '',
      })
      return route.fulfill({ json: { logs: [run('a', 'pr_review', 'acme/api', '7'), run('b', 'pr_review', 'acme/web', '3')], quarantined: [] } })
    }
    if (url.pathname === '/api/agent-replay') {
      state.replays.push(body)
      return route.fulfill({ status: state.replay.status, json: state.replay.json })
    }
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

test('skips repositories with Select all for an account and for everything, and keeps the list across a reload', async ({ page }) => {
  const state = await setup(page)
  await page.goto('/')
  await openBehaviors(page)
  const pill = page.locator('tr[data-behavior="approve-prs"] .behavior-triggers-btn')
  await expect(pill).toHaveText('All repos')
  // Every PR behavior has the dropdown; Review New Issues keeps its own.
  await expect(page.locator('tr[data-behavior="resolve-unblocking"] .behavior-triggers-btn')).toHaveText('All repos')
  await expect(page.locator('tr[data-behavior="review-new-issues"] .behavior-triggers-btn')).toHaveText('1 repo')

  await pill.click()
  const dialog = page.getByRole('dialog', { name: 'Setting for Approve Pull Requests' })
  await expect(dialog).toBeVisible()
  await expect(pill).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.locator('.bt-filter')).toBeFocused()
  await expect(dialog.getByLabel('Priority')).toBeHidden()
  await expect(dialog.getByLabel('Trusted authors')).toBeHidden()
  const all = dialog.getByRole('checkbox', { name: 'Select all repositories' })
  const acme = dialog.getByRole('checkbox', { name: 'Select all acme' })
  const octocat = dialog.getByRole('checkbox', { name: 'Select all octocat' })
  const repo = (name: string) => dialog.getByRole('checkbox', { name, exact: true })
  for (const name of REPOS) await expect(repo(name)).not.toBeChecked()
  expect(state.repoReads).toBe(1)

  // Select all for one account ticks just its repositories; the overall one is mixed.
  await acme.check()
  for (const name of ['acme/api', 'acme/billing', 'acme/web']) await expect(repo(name)).toBeChecked()
  for (const name of ['octocat/dotfiles', 'octocat/notes']) await expect(repo(name)).not.toBeChecked()
  await expect(all).toHaveJSProperty('indeterminate', true)
  // Unticking one repository leaves its account mixed.
  await repo('acme/billing').uncheck()
  await expect(acme).toHaveJSProperty('indeterminate', true)
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => state.writes).toEqual([{ key: 'approve-prs', body: { skipRepos: ['acme/api', 'acme/web'] } }])
  await expect(dialog).toBeHidden()
  await expect(pill).toHaveText('Skip 2')
  await expect(pill).toBeFocused()

  // The list is asked for again on every opening; Select all for everything.
  await pill.click()
  await expect(repo('acme/web')).toBeChecked()
  expect(state.repoReads).toBe(2)
  await all.check()
  for (const name of REPOS) await expect(repo(name)).toBeChecked()
  await expect(acme).toBeChecked()
  await expect(octocat).toBeChecked()
  await page.keyboard.press('Escape')
  await expect.poll(() => state.writes.length).toBe(2)
  expect(state.writes[1]).toEqual({ key: 'approve-prs', body: { skipRepos: [...REPOS].sort() } })
  await expect(pill).toHaveText('Skip 5')

  await page.reload()
  await openBehaviors(page)
  await expect(pill).toHaveText('Skip 5')
  await pill.click()
  for (const name of REPOS) await expect(repo(name)).toBeChecked()
  await expect(all).toBeChecked()

  // From the keyboard: a filter narrows what Select all covers.
  await all.uncheck()
  await dialog.locator('.bt-filter').fill('octocat')
  await expect(dialog.locator('.bt-repo')).toHaveCount(4)
  await dialog.locator('.bt-filter').press('ArrowDown')
  await expect(all).toBeFocused()
  await all.press('Space')
  await expect(octocat).toBeChecked()
  await page.keyboard.press('Escape')
  await expect.poll(() => state.writes.length).toBe(3)
  expect(state.writes[2]).toEqual({ key: 'approve-prs', body: { skipRepos: ['octocat/dotfiles', 'octocat/notes'] } })
  await expect(pill).toHaveText('Skip 2')
})

test('saves Review New Pull Requests\' ceiling and skipped repositories together from one dropdown', async ({ page }) => {
  const state = await setup(page)
  await page.goto('/')
  await openBehaviors(page)
  const pill = page.locator('tr[data-behavior="review-new-prs"] .behavior-triggers-btn')
  await expect(pill).toHaveText('<=p2')
  await pill.click()
  const dialog = page.getByRole('dialog', { name: 'Setting for Review New Pull Requests' })
  const priority = dialog.getByLabel('Priority')
  await expect(priority).toBeFocused()
  await expect(priority).toHaveValue('p2')
  await priority.selectOption('p3')
  await dialog.getByRole('checkbox', { name: 'acme/web', exact: true }).check()
  // A refresh while the dropdown is open keeps what is being chosen.
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(dialog.getByRole('checkbox', { name: 'acme/web', exact: true })).toBeChecked()
  await expect(priority).toHaveValue('p3')
  await page.keyboard.press('Escape')
  await expect.poll(() => state.writes).toEqual([{ key: 'review-new-prs', body: { skipRepos: ['acme/web'], setting: 'p3' } }])
  await expect(pill).toHaveText('<=p3, skip 1')
  await expect(pill).toHaveAttribute('title', 'Priority <=p3 · Skipped: acme/web')
  // The rest of the row is untouched by the dropdown.
  await expect(page.getByLabel('Reviewers for review-new-prs')).toHaveValue('1')
  await expect(page.getByLabel('Edit memory for review-new-prs')).toBeVisible()
})

test('shows why a replay was refused on its row until it is dismissed', async ({ page }) => {
  const state = await setup(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Swarm', exact: true }).click()
  const row = page.locator(`#swarm-tbody tr.agent-row[data-id="${'a'.repeat(32)}"]`)
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Replay this run' }).click()
  const notice = page.locator(`#swarm-tbody tr.agent-refusal-row[data-refusal-for="${'a'.repeat(32)}"]`)
  await expect(notice.getByRole('alert')).toHaveText('Replay refused: acme/api#7 is a draft.')
  expect(state.replays).toEqual([{ behavior: 'pr_review', repo: 'acme/api', pr_id: '7' }])
  // Directly under the row it answers, not on any other.
  await expect(row.locator('xpath=following-sibling::tr[1]')).toHaveClass('agent-refusal-row')
  await expect(page.locator('#swarm-tbody tr.agent-refusal-row')).toHaveCount(1)
  // A refresh keeps it in place.
  await page.evaluate(() => window.dispatchEvent(new Event('poise:refresh-tick')))
  await expect(notice).toBeVisible()
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
  await expect(row.getByRole('button', { name: 'Replay this run' })).toBeFocused()

  // A replay the server accepts clears an earlier refusal.
  await row.getByRole('button', { name: 'Replay this run' }).click()
  await expect(notice).toBeVisible()
  state.replay = { status: 200, json: { ok: true, source: 'poise:replay', correlationId: 'c-1' } }
  await row.getByRole('button', { name: 'Replay this run' }).click()
  await expect(notice).toHaveCount(0)
  expect(state.replays).toHaveLength(3)
})
