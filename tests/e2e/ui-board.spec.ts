import { expect, test, type Page, type Route } from '@playwright/test'

// Board in the new interface (#556 PR 3): Lanes and List over the live work,
// Assign to Poise, your cards, and what sits beside the board. GitHub, the PR
// status ledger, the chains and the running jobs are stood in for here; your
// cards are the test server's own.

const NOW = Date.now()
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

interface Record { kind: 'pr' | 'issue', repo: string, number: number, state: 'open' | 'closed' | 'merged', title: string, url: string, created_at: string, updated_at: string, merged_at: string | null }
const record = (kind: 'pr' | 'issue', number: number, title: string, patch: Partial<Record> = {}): Record => ({
  kind, repo: 'acme/site', number, state: 'open', title, url: `https://github.com/acme/site/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
  created_at: iso(3 * 1440), updated_at: iso(30), merged_at: null, ...patch,
})

interface World {
  records: Record[]
  labelled?: string[]
  prs?: { [key: string]: { number: number, url: string }[] }
  intakeFails?: boolean
  liveFails?: boolean
  assign?: 'ok' | 'refused'
  chainEnabled?: boolean
  assigned?: string[]
}

const RECORDS: Record[] = [
  record('issue', 41, 'Old issue changed today', { created_at: iso(10 * 1440), updated_at: iso(20) }),
  record('issue', 42, 'Opened today', { created_at: iso(60), updated_at: iso(50) }),
  record('issue', 43, 'Owned by Poise', { created_at: iso(5 * 1440), updated_at: iso(3 * 1440) }),
  record('pr', 44, 'A pull request', { created_at: iso(2 * 1440), updated_at: iso(2 * 1440) }),
]

async function board(page: Page, world: World, address = '/?view=board'): Promise<void> {
  world.assigned = []
  await page.route(/https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await page.route('**/api/claude-auth', (route) => route.fulfill({ json: { status: 'authenticated', reason: null, checkedAt: null, verifiedAt: null, authMethod: null, subscriptionType: null, loginInProgress: false } }))
  await page.route('**/api/notices', (route) => route.fulfill({ json: { enabled: true, notices: [] } }))
  await page.route('**/api/repos**', (route) => route.fulfill({ json: { repos: ['acme/site', 'acme/api'] } }))
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ json: { logs: [] } }))
  await page.route('**/api/behavior-ledger/pr-status**', (route) => route.fulfill({ json: { version: 2, rows: [], totalOpen: 0, truncated: false } }))
  await page.route('**/api/behavior-chains**', (route) => route.fulfill({ json: { chains: [], next: null, attention: [], capacity: {
    status: 'available', error: null, modelInvocationLimit: 4, reservedModelInvocations: 0, mode: 'v2', enabled: world.chainEnabled ?? true, intake: { seedMode: 'label', label: 'poise' },
  } } }))
  await page.route('**/api/chat/sessions', (route: Route) => route.request().method() === 'GET' ? route.fulfill({ json: { sessions: [], instance: 'test' } }) : route.fallback())
  await page.route('**/api/gh', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}') as { operation: string, updated_since?: string, repository_full_name?: string, issue_number?: number }
    if (body.operation === 'list') {
      if (world.liveFails) return route.fulfill({ status: 502, json: { error: 'GitHub answered 502' } })
      const since = body.updated_since ? Date.parse(body.updated_since) : -Infinity
      return route.fulfill({ json: { records: world.records.filter((r) => Date.parse(r.updated_at) >= since) } })
    }
    if (body.operation === 'issue_intake') {
      if (world.intakeFails) return route.fulfill({ status: 502, json: { error: 'GitHub answered 502' } })
      return route.fulfill({ json: { label: 'poise', labelled: world.labelled ?? [], prs: world.prs ?? {} } })
    }
    if (body.operation === 'assign_issue') {
      world.assigned!.push(`${body.repository_full_name}#${body.issue_number}`)
      return world.assign === 'refused'
        ? route.fulfill({ status: 403, json: { error: 'your account cannot triage acme/site' } })
        : route.fulfill({ json: { ok: true } })
    }
    if (body.operation === 'list_repo_labels') return route.fulfill({ json: { labels: [{ name: 'bug', color: 'd73a4a', description: 'Something does not work' }, { name: 'poise', color: '000000', description: 'Enters the chain' }] } })
    return route.fulfill({ status: 400, json: { error: `unexpected ${body.operation}` } })
  })
  await page.goto(address)
  await expect(page.locator('.lanes .lane')).toHaveCount(5)
}

const card = (page: Page, text: string) => page.locator('.card', { hasText: text })
const view = (page: Page, name: 'Lanes' | 'List') => page.getByRole('group', { name: 'View' }).getByRole('button', { name })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('board-spec')) { localStorage.clear(); sessionStorage.setItem('board-spec', '1') } })
})

test('List stays as you left it across a reload, and a link’s view is not remembered', async ({ page }) => {
  await board(page, { records: RECORDS })
  await view(page, 'List').click()
  await expect(page.locator('.cur')).toHaveClass(/is-list/)
  await page.reload()
  await expect(view(page, 'List')).toHaveAttribute('aria-pressed', 'true')

  await view(page, 'Lanes').click()
  await page.goto('/?view=board&layout=list')
  await expect(page.locator('.cur')).toHaveClass(/is-list/)
  await page.goto('/?view=board')
  await expect(view(page, 'Lanes')).toHaveAttribute('aria-pressed', 'true')
})

test('Today means changed today on Updated, and opened today on Opened', async ({ page }) => {
  await board(page, { records: RECORDS })
  await page.getByRole('group', { name: 'When' }).getByRole('button', { name: 'Today' }).click()
  await expect(card(page, 'Old issue changed today')).toBeVisible()
  await expect(card(page, 'Opened today')).toBeVisible()
  await expect(card(page, 'Owned by Poise')).toHaveCount(0)
  await page.getByRole('group', { name: 'Time means' }).getByRole('button', { name: 'Opened' }).click()
  await expect(card(page, 'Opened today')).toBeVisible()
  await expect(card(page, 'Old issue changed today')).toHaveCount(0)
})

test('Who shows Poise’s own work or everything else, and each open issue its closing pull request', async ({ page }) => {
  await board(page, { records: RECORDS, labelled: ['acme/site#43'], prs: { 'acme/site#41': [{ number: 44, url: 'https://github.com/acme/site/pull/44' }] } })
  await expect(card(page, 'Old issue changed today').getByRole('link', { name: 'PR #44' })).toBeVisible()
  await expect(card(page, 'Opened today').getByText('no open PR')).toBeVisible()
  await expect(card(page, 'Owned by Poise').getByRole('link', { name: 'Poise', exact: true })).toBeVisible()
  await page.getByRole('group', { name: 'Who has it' }).getByRole('button', { name: 'Poise', exact: true }).click()
  await expect(card(page, 'Owned by Poise')).toBeVisible()
  await expect(card(page, 'Opened today')).toHaveCount(0)
  await page.getByRole('group', { name: 'Who has it' }).getByRole('button', { name: 'Not Poise' }).click()
  await expect(card(page, 'Opened today')).toBeVisible()
  await expect(card(page, 'Owned by Poise')).toHaveCount(0)
})

for (const layout of ['Lanes', 'List'] as const) {
  test(`${layout}: Assign is the first action icon, restores after expiry, and adds the label after Sure?`, async ({ page }) => {
    const world: World = { records: RECORDS }
    await board(page, world)
    await view(page, layout).click()
    const issue = card(page, 'Opened today')
    const assign = issue.getByRole('button', { name: 'Assign to Poise', exact: true })
    // Resting on the card raises its tooltip over the action row, where it pins
    // itself open; moving straight to the icon keeps the click clear.
    if (layout === 'Lanes') { await issue.hover(); await assign.hover() }
    else await issue.focus()
    await expect(issue.locator('[data-act="assign"]')).toHaveCount(1)
    await expect(issue.locator('.card-state [data-act="assign"]')).toHaveCount(0)
    await expect(issue.locator('.card-acts > :first-child')).toHaveAttribute('aria-label', 'Assign to Poise')
    await expect(issue.locator('.card-acts > :nth-child(2)')).toHaveAttribute('aria-label', 'Copy')
    await expect(assign).toHaveClass('ib')
    await expect(assign).toHaveText('')
    await expect(assign.locator('svg use')).toHaveAttribute('href', '#i-handoff')
    const original = await assign.innerHTML()
    await page.clock.install()
    await assign.click()
    await expect(issue.getByRole('button', { name: 'Sure?' })).toBeVisible()
    expect(world.assigned).toEqual([])
    await page.clock.fastForward(4000)
    await expect(assign).not.toHaveClass(/is-armed/)
    expect(await assign.innerHTML()).toBe(original)
    await expect(assign).toHaveText('')
    await assign.click()
    await expect(issue.getByRole('button', { name: 'Sure?' })).toBeVisible()
    expect(world.assigned).toEqual([])
    await issue.getByRole('button', { name: 'Sure?' }).click()
    await expect(issue.getByRole('link', { name: 'Poise', exact: true })).toBeVisible()
    await expect(issue.getByRole('button', { name: /Assign to Poise|Sure\?/ })).toHaveCount(0)
    expect(world.assigned).toEqual(['acme/site#42'])
  })
}

test('arming a second Assign disarms the first, and a rearmed Assign restores its icon', async ({ page }) => {
  const world: World = { records: RECORDS }
  await board(page, world)
  const first = card(page, 'Opened today')
  const second = card(page, 'Old issue changed today')
  const firstAssign = first.getByRole('button', { name: 'Assign to Poise' })
  const secondAssign = second.getByRole('button', { name: 'Assign to Poise' })
  await first.hover()
  await firstAssign.hover()
  await page.clock.install()
  await firstAssign.click()
  await expect(first.getByRole('button', { name: 'Sure?' })).toBeVisible()
  await second.hover()
  await secondAssign.hover()
  await secondAssign.click()
  await expect(second.getByRole('button', { name: 'Sure?' })).toBeVisible()
  await expect(first.getByRole('button', { name: 'Assign to Poise' })).toBeVisible()
  await expect(first.getByRole('button', { name: 'Sure?' })).toHaveCount(0)
  await page.clock.fastForward(4000)
  await expect(second.getByRole('button', { name: 'Assign to Poise' })).toBeVisible()
  await first.hover()
  const assign = first.getByRole('button', { name: 'Assign to Poise', exact: true })
  await assign.hover()
  const original = await assign.innerHTML()
  await assign.click()
  await expect(first.getByRole('button', { name: 'Sure?' })).toBeVisible()
  await page.clock.fastForward(4000)
  expect(await assign.innerHTML()).toBe(original)
  await expect(assign).toHaveText('')
  await expect(assign.locator('svg use')).toHaveAttribute('href', '#i-handoff')
  expect(world.assigned).toEqual([])
  await assign.click()
  await expect(first.getByRole('button', { name: 'Sure?' })).toBeVisible()
  expect(world.assigned).toEqual([])
})

test('a refused assignment keeps its reason on the row, and the chain being off is said', async ({ page }) => {
  await board(page, { records: RECORDS, assign: 'refused', chainEnabled: false })
  const issue = card(page, 'Opened today')
  await issue.hover()
  await issue.getByRole('button', { name: 'Assign to Poise' }).hover()
  await expect(issue.getByRole('button', { name: 'Assign to Poise' })).toHaveAttribute('title', /chain is off/)
  await issue.getByRole('button', { name: 'Assign to Poise' }).click()
  await issue.getByRole('button', { name: 'Sure?' }).click()
  await expect(issue.getByRole('alert')).toContainText('your account cannot triage acme/site')
  await expect(issue.getByRole('button', { name: 'Assign to Poise' })).toBeVisible()
})

test('a failed intake read shows no label, Assign or pull request, and says so', async ({ page }) => {
  await board(page, { records: RECORDS, intakeFails: true })
  await expect(page.getByRole('status').filter({ hasText: 'Board is not updating' })).toContainText('Could not load which issues are assigned to Poise')
  await expect(page.getByRole('button', { name: 'Assign to Poise' })).toHaveCount(0)
  await expect(page.locator('.intake')).toHaveCount(0)
})

test('a card is added at the top of its lane, edited in place, and deleted after Sure?', async ({ page }) => {
  await board(page, { records: RECORDS })
  const idea = page.locator('.lane[data-lane="idea"]')
  await idea.getByRole('button', { name: 'Add' }).click()
  await idea.getByRole('textbox', { name: 'Card text' }).fill('A thought worth keeping')
  await idea.getByRole('button', { name: 'Add', exact: true }).last().click()
  await expect(card(page, 'A thought worth keeping')).toBeVisible()

  await card(page, 'A thought worth keeping').locator('.card-text').click()
  const editor = page.getByRole('textbox', { name: 'Card text' })
  await editor.fill('A thought, edited')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(card(page, 'A thought, edited')).toBeVisible()
  await page.reload()
  await expect(card(page, 'A thought, edited')).toBeVisible()

  // A card's actions show while you are on it.
  await card(page, 'A thought, edited').hover()
  await card(page, 'A thought, edited').getByRole('button', { name: 'Delete card' }).click()
  await card(page, 'A thought, edited').getByRole('button', { name: /^Sure\?/ }).click()
  await expect(card(page, 'A thought, edited')).toHaveCount(0)
})

test('choosing a live item opens it beside the board, and a card’s chat opens in the side pane', async ({ page }) => {
  await board(page, { records: RECORDS })
  await card(page, 'A pull request').locator('.card-meta').click()
  const beside = page.getByRole('complementary', { name: 'Beside the board' })
  await expect(beside).toBeVisible()
  await expect(beside).toContainText('A pull request')
  await expect(beside.getByRole('link', { name: 'Its row in GitHub' })).toHaveAttribute('href', /view=observe&part=github&item=acme%2Fsite%2344/)
  await beside.getByRole('button', { name: 'Close' }).click()
  await expect(beside).toBeHidden()

  await card(page, 'Opened today').locator('.card-meta').click()
  await expect(beside.getByRole('button', { name: 'Assign to Poise' })).toHaveText('Assign to Poise')
  await beside.getByRole('button', { name: 'Close' }).click()

  await card(page, 'Opened today').hover()
  await card(page, 'Opened today').getByRole('button', { name: 'Chat about this, beside the board' }).hover()
  await card(page, 'Opened today').getByRole('button', { name: 'Chat about this, beside the board' }).click()
  await expect(page.locator('#chat-side-pane .chat-title')).toContainText('acme/site#42')
})

for (const width of [375, 768, 1000]) {
  test(`nothing overflows the page at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await board(page, { records: RECORDS })
    for (const layout of ['Lanes', 'List'] as const) {
      await view(page, layout).click()
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    }
  })
}

test('while the pointer is on the board, a changed item repaints in place, and the update is held', async ({ page }) => {
  await board(page, { records: RECORDS })
  await card(page, 'A pull request').hover()
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ json: { logs: [{ status: 'running', repo: 'acme/site', pr_id: 44, behavior: 'review-prs', started_at: iso(10), started_at_precise: iso(10) }] } }))
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(card(page, 'A pull request').locator('.card-state')).toContainText('Review running')
  await expect(card(page, 'A pull request')).toHaveClass(/is-changed/)
  await expect(page.locator('[data-ref="cur.held"]')).toHaveText('1 update held')
})

test('opening an issue keeps its writer open and guarded until GitHub answers', async ({ page }) => {
  let answer: () => void = () => {}
  await board(page, { records: RECORDS })
  await page.route('**/api/gh', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}') as { operation: string }
    if (body.operation !== 'open_issue') return route.fallback()
    await new Promise<void>((resolve) => { answer = resolve })
    return route.fulfill({ json: { record: record('issue', 45, 'A new issue', { created_at: iso(0), updated_at: iso(0) }), labels_dropped: [] } })
  })
  await page.getByRole('button', { name: 'Add issue' }).click()
  await page.getByLabel('Issue title').fill('A new issue')
  await page.getByRole('button', { name: 'Open issue' }).click()
  await expect(page.getByRole('button', { name: 'Open issue' })).toHaveAttribute('aria-disabled', 'true')
  // It says where it is, where it was asked, and its unavailable buttons look it.
  await expect(page.locator('[data-writer="issue"] [data-ref="life"]')).toContainText('Executing · opening on GitHub')
  await expect(page.getByRole('button', { name: 'Open issue' })).toHaveCSS('opacity', '0.45')
  // Neither a new writer, Cancel nor more typing takes the one whose answer is on its way.
  await page.getByRole('button', { name: 'Add issue' }).click()
  await expect(page.locator('[data-writer="issue"]').getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByLabel('Issue title')).not.toBeEditable()
  await expect(page.getByLabel('Issue title')).toHaveValue('A new issue')
  await expect(page.getByRole('button', { name: 'Open issue' })).toHaveAttribute('aria-disabled', 'true')
  answer()
  await expect(page.locator('[data-writer="issue"]')).toHaveCount(0)
  await expect(card(page, 'A new issue')).toBeVisible()
})

test('a GitHub read that never succeeded reads as not read, never as zero', async ({ page }) => {
  await board(page, { records: RECORDS, liveFails: true })
  await expect(page.locator('.lane[data-lane="issue"] .empty')).toHaveText('Not read yet.')
  await expect(page.locator('.lane[data-lane="issue"] [data-ref="lane.count"]')).toHaveText('—')
  await expect(page.locator('[data-ref="cur.count"] .n').first()).toHaveText('—')
})

test('a held repaint leaves an armed Assign armed', async ({ page }) => {
  const world: World = { records: RECORDS.map((r) => ({ ...r })) }
  await board(page, world)
  await card(page, 'Opened today').hover()
  await card(page, 'Opened today').getByRole('button', { name: 'Assign to Poise' }).hover()
  await card(page, 'Opened today').getByRole('button', { name: 'Assign to Poise' }).click()
  await expect(card(page, 'Opened today').getByRole('button', { name: 'Sure?' })).toBeVisible()
  await card(page, 'A pull request').focus()
  world.records = world.records.map((r) => (r.number === 42 ? { ...r, title: 'Opened today, retitled' } : r))
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(page.locator('[data-ref="cur.held"]')).toHaveText('1 update held')
  await expect(card(page, 'Opened today').getByRole('button', { name: 'Sure?' })).toBeVisible()
})

test('a failed read of the runs going now keeps the last runs, never a guessed state', async ({ page }) => {
  await board(page, { records: RECORDS })
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ json: { logs: [{ status: 'running', repo: 'acme/site', pr_id: 44, behavior: 'review-prs', started_at: iso(10), started_at_precise: iso(10) }] } }))
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(card(page, 'A pull request').locator('.card-state')).toContainText('Review running')
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ status: 502, json: { error: 'agent-interface did not answer' } }))
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(page.locator('[data-ref="cur.partial"]')).toContainText('the runs going now')
  await expect(card(page, 'A pull request').locator('.card-state')).toContainText('Review running')
})

test('Board scrolls inside itself, so its header and In motion stay in view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await board(page, { records: [...RECORDS, ...Array.from({ length: 40 }, (_, i) => record('issue', 100 + i, `Issue ${100 + i}`))] })
  await expect(card(page, 'Issue 139')).toHaveCount(1)
  // Measured once the place has arrived: its entrance moves it by the travel distance.
  await page.waitForFunction(() => !document.querySelector('[data-place-root][data-motion-running], [data-place-root][data-flow-enter]'))
  const sizes = await page.evaluate(() => {
    const d = document.documentElement
    const lane = document.querySelector<HTMLElement>('.lane[data-lane="issue"] .lane-body')!
    return { page: [d.scrollHeight, d.clientHeight], lane: [lane.scrollHeight, lane.clientHeight] }
  })
  expect(sizes.page[0]).toBeLessThanOrEqual(sizes.page[1])
  expect(sizes.lane[0]).toBeGreaterThan(sizes.lane[1])
})

test('at 375 pixels Board’s header and lanes keep the narrow gutter', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 })
  await board(page, { records: RECORDS })
  const pads = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.paddingLeft = 'var(--sp-3)'
    document.body.append(probe)
    const gutter = getComputedStyle(probe).paddingLeft
    probe.remove()
    return { gutter, head: getComputedStyle(document.querySelector('.cur-head')!).paddingLeft, lanes: getComputedStyle(document.querySelector('.lanes')!).paddingLeft }
  })
  expect(pads.head).toBe(pads.gutter)
  expect(pads.lanes).toBe(pads.gutter)
})

test('another organization’s runs never stand for the one chosen', async ({ page }) => {
  const organizations = ['acme', 'beta'].map((login) => ({ login, managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }))
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    return route.fulfill({ response, json: { ...(await response.json()), organizations } })
  })
  const beta = record('issue', 50, 'Beta’s own issue', { repo: 'beta/api', url: 'https://github.com/beta/api/issues/50' })
  await board(page, { records: [...RECORDS, beta] })
  const pick = async (org: string) => {
    await page.locator('[data-menu="board-org-menu"]').click()
    await page.locator(`#board-org-menu [data-org="${org}"]`).click()
  }
  // acme's runs are read; then All orgs is chosen and its runs cannot be read.
  await pick('acme')
  await expect(card(page, 'Old issue changed today')).toHaveAttribute('data-state', 'idle')
  await page.route('**/api/agent-logs**', (route) => route.fulfill({ status: 502, json: { error: 'agent-interface did not answer' } }))
  await pick('')
  await expect(page.locator('[data-ref="cur.partial"]')).toContainText('the runs going now')
  await expect(card(page, 'Beta’s own issue')).toHaveAttribute('data-state', '')
})
