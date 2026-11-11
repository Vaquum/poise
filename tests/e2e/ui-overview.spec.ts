import { expect, test, type Page, type Route, type WebSocketRoute } from './fixtures/ui'

// Overview in the new interface (#556, PRD Support → Tests): Answer here with
// a request answered elsewhere while held or focused, several requests at
// once, a free-text-only question and an answer that fails while newer typing
// is kept; a notice's link to an exact diagnostic; no layout shift when an
// entry arrives while the pointer is in Answer here; and no page-level
// overflow at 375, 768 and 1000 pixels. The isolated server has none of this
// data, so every read Overview makes is answered here.

const NOW = Date.now()
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
const hex = (c: string, n: number) => c.repeat(n)
const EVIDENCE = { eventId: `evt_${hex('a', 16)}_${hex('b', 64)}`, incidentId: `inc_${hex('a', 16)}_${hex('d', 64)}`, from: '2026-11-10T08:00:00.000Z', to: '2026-11-11T08:00:00.000Z' }

interface Request { id: string, kind: 'permission' | 'question', sessionId: string, sessionTitle: string, createdAt: string, content: unknown, escalation: null }
const permission = (id: string, sessionId: string, title: string): Request => ({
  id, kind: 'permission', sessionId, sessionTitle: `Chat ${sessionId}`, createdAt: ago(3), escalation: null,
  content: { title, description: 'Open a pull request.', input: { command: 'gh pr create' }, options: [{ id: 'allow', name: 'Allow once', kind: 'allow_once' }, { id: 'deny', name: 'Deny', kind: 'reject_once' }] },
})
const question = (id: string, sessionId: string, q: { question: string, options: string[], freeText: boolean }): Request => ({
  id, kind: 'question', sessionId, sessionTitle: `Chat ${sessionId}`, createdAt: ago(5), escalation: null,
  content: { questions: [{ id: `${id}-q`, question: q.question, options: q.options.map((label) => ({ label })), multiSelect: false, freeText: q.freeText }] },
})

interface Workspace {
  notices: unknown[]
  requests: Request[]
  revision: number
  decisions: unknown[]
  /** How the Switchboard answers an answer: delay, then status and body. */
  answerDecision?: { delay: Promise<void>, status: number, body: unknown }
}

interface Socket { ws: WebSocketRoute | null, frames: { id: string, command: Record<string, unknown> }[] }

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

const pr = { opened: 4, closedUnmerged: 1, merged: 3, mergedByAgent: 1, firstReview: { count: 2, medianMs: 600_000 }, commentsPerPr: 2, medianCommentsPerPr: 2, lines: { total: 120, median: 40, counted: 3 }, behaviors: { perPr: 1, medianPerPr: 1, approvals: 2, reviews: 3, changesRequested: 1 }, averageTimeToMergeMs: 3_600_000, medianTimeToMergeMs: 3_600_000 }
const day = { issues: { opened: 2, closed: 1 }, pullRequests: pr }

async function open(page: Page, workspace: Workspace, address = '/?view=overview'): Promise<Socket> {
  const socket: Socket = { ws: null, frames: [] }
  await page.route(/https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await page.routeWebSocket('**/ws/chat', (ws) => {
    socket.ws = ws
    ws.send(JSON.stringify({ kind: 'hello', instance: 'poise-dev:test', serverStartedAt: new Date(NOW).toISOString() }))
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Socket['frames'][number]
      socket.frames.push(frame)
      ws.send(JSON.stringify({ kind: 'ack', id: frame.id, ok: true }))
    })
  })
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const path = url.pathname
    if (path === '/api/notices' && method === 'GET') return json(route, { enabled: true, notices: workspace.notices })
    if (path === '/api/notices/handled') return json(route, { handled: [] })
    if (path === '/api/chat/requests') return json(route, { revision: workspace.revision, complete: true, requests: workspace.requests })
    if (path === '/api/chat/switchboard') return json(route, { revision: 1, status: 'live', items: workspace.decisions })
    if (/^\/api\/chat\/switchboard\/items\/\d+\/answer$/.test(path) && workspace.answerDecision) {
      await workspace.answerDecision.delay
      return json(route, workspace.answerDecision.body, workspace.answerDecision.status)
    }
    if (path === '/api/chat/sessions') return json(route, { instance: 'poise-dev:test', sessions: [] })
    if (path === '/api/editor/reviews') return json(route, { publications: [], sweep: { publications: 0, longestDelayMinutes: 15 } })
    if (path === '/api/behavior-chains') return json(route, { chains: [], attention: [] })
    if (path === '/api/behaviors') return json(route, { diagnostics: { status: 'ok', agentLogsError: null, datastore: { status: 'healthy', checkedAt: ago(1), ageSeconds: 1, lastSuccessAt: ago(1), error: null }, identity: { status: 'valid', actor: 'bot', error: null }, failures: [], deadLetters: [], holds: [] } })
    if (path === '/api/settings' && method === 'GET') return json(route, { org: '', organizations: [{ login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }], me: 'me', agentAccount: 'bot', timezone: 'UTC', manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1 } })
    if (path === '/api/analytics') return json(route, { window: { since: url.searchParams.get('since'), until: url.searchParams.get('until') }, agentAccount: 'bot', ...day, ...(url.searchParams.get('dailyBounds') ? { daily: Array.from({ length: 7 }, () => day) } : {}), errors: [] })
    if (path === '/api/analytics/history') {
      const bounds = (url.searchParams.get('bounds') ?? '').split(',')
      return json(route, { periods: bounds.slice(1).map((until, i) => ({ since: bounds[i], until, ...day })), errors: [] })
    }
    if (path === '/api/github-quota') return json(route, { accounts: [] })
    if (path === '/api/behavior-metrics') return json(route, { behaviors: {}, error: null })
    if (path === '/api/behavior-estimates') return json(route, { estimates: [] })
    if (path === '/api/agent-logs') return json(route, { logs: [] })
    if (path === '/api/gh') return json(route, { records: [], held: [], errors: [] })
    if (path === '/api/claude-auth') return json(route, { status: 'authenticated', reason: null, checkedAt: null, verifiedAt: null, authMethod: null, subscriptionType: null, loginInProgress: false })
    return route.fallback()
  })
  await page.goto(address)
  await expect(page.getByRole('complementary', { name: 'Answer here' })).toBeVisible()
  await expect.poll(() => socket.ws !== null).toBe(true)
  return socket
}

/** The open requests changed, as the chat server announces it. */
function announce(socket: Socket, workspace: Workspace): void {
  workspace.revision += 1
  socket.ws!.send(JSON.stringify({ kind: 'chatRequests.updated', revision: workspace.revision }))
}

const entry = (page: Page, id: string) => page.locator(`[data-notice="${id}"]`)
const answers = (page: Page) => page.getByRole('complementary', { name: 'Answer here' })

test('several requests at once are separate entries, each answered through the chat by its own id', async ({ page }) => {
  const workspace: Workspace = { notices: [], decisions: [], revision: 1, requests: [permission('p1', 's1', 'Run gh pr create'), permission('p2', 's2', 'Push the branch'), question('q1', 's3', { question: 'Which note stays?', options: ['The first', 'The repro'], freeText: false })] }
  const socket = await open(page, workspace)
  await expect(entry(page, 'request:p1')).toContainText('Run gh pr create')
  await expect(entry(page, 'request:p2')).toContainText('Push the branch')
  await expect(entry(page, 'request:q1')).toContainText('Which note stays?')
  await expect(page.locator('[data-ncount]')).toHaveText('3')
  await expect(page.locator('[data-bell]')).toHaveText('3')

  await entry(page, 'request:p2').getByRole('button', { name: /Allow once/ }).click()
  await expect.poll(() => socket.frames.find((f) => f.command.type === 'permission.respond')?.command).toEqual({ type: 'permission.respond', sessionId: 's2', id: 'p2', optionId: 'allow' })
  await expect(entry(page, 'request:p2')).toContainText('Sent · waiting for the chat to record it')
  // The chat records it: the request leaves the open list, and the answer settles where it was.
  workspace.requests = workspace.requests.filter((r) => r.id !== 'p2')
  announce(socket, workspace)
  await expect(entry(page, 'request:p2')).toContainText('Recorded in the chat')
  await expect(entry(page, 'request:p1').getByRole('button', { name: /Allow once/ })).not.toHaveAttribute('aria-disabled', 'true')

  await entry(page, 'request:q1').getByRole('button', { name: /The repro/ }).click()
  await expect.poll(() => socket.frames.find((f) => f.command.type === 'question.answer')?.command).toEqual({ type: 'question.answer', sessionId: 's3', id: 'q1', answers: { 'q1-q': 'The repro' } })
})

test('a request answered elsewhere turns unavailable at once, with the reason, while its entry is focused or held', async ({ page }) => {
  const workspace: Workspace = { notices: [], decisions: [], revision: 1, requests: [permission('p1', 's1', 'Run gh pr create'), permission('p2', 's2', 'Push the branch')] }
  const socket = await open(page, workspace)
  // Held: the pointer is in the list; the entry stays where it is, with its reason.
  await entry(page, 'request:p2').hover()
  workspace.requests = workspace.requests.filter((r) => r.id !== 'p2')
  announce(socket, workspace)
  await expect(entry(page, 'request:p2').locator('[data-ref="ov.gone"]')).toContainText('No longer open: it was answered elsewhere')
  await expect(entry(page, 'request:p2').getByRole('button', { name: /Deny/ })).toHaveAttribute('aria-disabled', 'true')

  // Focused: the same, and the focus stays on it.
  await entry(page, 'request:p1').focus()
  workspace.requests = []
  announce(socket, workspace)
  await expect(entry(page, 'request:p1').locator('[data-ref="ov.gone"]')).toBeVisible()
  await expect(entry(page, 'request:p1').getByRole('button', { name: /Allow once/ })).toHaveAttribute('aria-disabled', 'true')
  await expect(entry(page, 'request:p1')).toBeFocused()
  // Looking away lets them go.
  await page.mouse.move(1000, 600)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(entry(page, 'request:p1')).toHaveCount(0)
  await expect(entry(page, 'request:p2')).toHaveCount(0)
})

test('a free-text-only question is answered in your own words', async ({ page }) => {
  const workspace: Workspace = { notices: [], decisions: [], revision: 1, requests: [question('q1', 's1', { question: 'What should the release be called?', options: [], freeText: true })] }
  const socket = await open(page, workspace)
  const box = entry(page, 'request:q1').getByRole('textbox')
  await expect(box).toBeVisible()
  const send = entry(page, 'request:q1').getByRole('button', { name: 'Send answer' })
  await expect(send).toHaveAttribute('aria-disabled', 'true')
  await box.fill('Calm harbour')
  await send.click()
  await expect.poll(() => socket.frames.find((f) => f.command.type === 'question.answer')?.command).toEqual({ type: 'question.answer', sessionId: 's1', id: 'q1', answers: { 'q1-q': 'Calm harbour' } })
})

test('an answer that fails shows the service’s reason, and keeps what was typed since', async ({ page }) => {
  let release!: () => void
  const workspace: Workspace = {
    notices: [], requests: [], revision: 1,
    decisions: [{ id: 7, kind: 'decision', text: 'Which filter wins?', detail: null, createdAt: ago(4), source: { sessionId: 'w3', title: 'W3', agent: 'claude', model: 'opus', exists: true }, sourceSeq: 2, options: [{ id: 'a', label: 'Archive’s dates', detail: null, recommended: true }], explanation: { state: 'none' } }],
    answerDecision: { delay: new Promise<void>((resolve) => { release = resolve }), status: 409, body: { error: 'The Switchboard is stopped; restart it to answer.' } },
  }
  await open(page, workspace)
  const card = entry(page, 'decision:7')
  await card.getByRole('button', { name: 'Something else…' }).click()
  const box = card.getByRole('textbox')
  await box.fill('Keep both')
  await card.getByRole('button', { name: 'Send answer' }).click()
  await expect(card.locator('[data-ref="life"]')).toContainText('Accepted')
  await box.pressSequentially(', with a note')
  release()
  await expect(card).toContainText('Failed: The Switchboard is stopped; restart it to answer.')
  await expect(box).toHaveValue('Keep both, with a note')
  await expect(card.getByRole('button', { name: 'Send answer' })).not.toHaveAttribute('aria-disabled', 'true')
})

test('a notice links to its exact diagnostic, interval included, and the route back', async ({ page }) => {
  const notice = { id: 'held:grey', kind: 'behavior_held', title: 'Rerun Grey CI is held on acme/site#4', body: 'GitHub’s API limit.', since: ago(40), due: ago(40), silenceable: false, target: { swarm: 'call-1' }, subject: { behavior: 'rerun-grey-ci', target: 'acme/site#4' }, evidence: EVIDENCE }
  await open(page, { notices: [notice], requests: [], decisions: [], revision: 1 })
  const link = entry(page, 'notice:held:grey').getByRole('link', { name: 'Open its diagnostic' })
  await link.click()
  const query = Object.fromEntries(new URL(page.url()).searchParams)
  expect(query).toEqual({ view: 'observe', part: 'logging', event: EVIDENCE.eventId, from: EVIDENCE.from, to: EVIDENCE.to, back: 'overview' })
  await expect(page.getByRole('navigation', { name: 'Poise' }).getByRole('link', { name: 'Observe' })).toHaveAttribute('aria-current', 'page')
})

test('nothing moves when an entry arrives while the pointer is in Answer here; it waits, counted', async ({ page }) => {
  const workspace: Workspace = { notices: [], decisions: [], revision: 1, requests: [permission('p1', 's1', 'Run gh pr create'), permission('p2', 's2', 'Push the branch')] }
  const socket = await open(page, workspace)
  await expect(entry(page, 'request:p2')).toBeVisible()
  await entry(page, 'request:p2').hover()
  const boxes = () => page.locator('[data-notice]').evaluateAll((cards) => cards.map((card) => { const b = card.getBoundingClientRect(); return [card.getAttribute('data-notice'), Math.round(b.top), Math.round(b.height)] }))
  const before = await boxes()
  workspace.requests = [permission('p0', 's0', 'Delete the old branch'), ...workspace.requests]
  announce(socket, workspace)
  await expect(page.locator('[data-held]')).toContainText('1 new')
  expect(await boxes()).toEqual(before)
  await expect(page.locator('[data-ncount]')).toHaveText('3')

  await page.mouse.move(1000, 600)
  await expect(entry(page, 'request:p0')).toContainText('New')
  await expect(page.locator('[data-held]')).toHaveClass(/is-none/)
})

test('the level decides what shows and what the bell counts, and is remembered', async ({ page }) => {
  const notices = [
    { id: 'pr', kind: 'pr_ready', title: 'acme/site#9 is ready to merge', body: 'Checks pass.', since: ago(20), due: ago(5), silenceable: true, target: { pullRequest: 'https://github.com/acme/site/pull/9' } },
    { id: 'ledger', kind: 'ledger_queue_stalled', title: 'Behavior ledger is not draining', body: 'Queued 6 minutes.', since: ago(7), due: ago(7), silenceable: false, target: null },
    { id: 'turn', kind: 'chat_turn_finished', title: 'Codex finished', body: 'Done after 6 minutes.', since: ago(9), due: ago(9), silenceable: false, target: { chat: 's2' } },
  ]
  await open(page, { notices, requests: [], decisions: [], revision: 1 }, '/?view=overview&back=board#answer')
  await expect(page.getByRole('link', { name: 'Back to Board' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-answers]'))).toBe(true)
  await expect(page.locator('[data-bell]')).toHaveText('3')
  await expect(page.locator('[data-bell]')).toHaveAttribute('data-tone', 'failed')
  await expect(entry(page, 'notice:pr').getByRole('link', { name: 'Open its card on Board' })).toHaveAttribute('href', '?view=board&item=acme%2Fsite%239&back=overview')

  await answers(page).getByRole('radio', { name: 'Only you' }).click()
  await expect(page.locator('[data-bell]')).toHaveText('1')
  await expect(page.locator('[data-bell]')).toHaveAttribute('data-tone', 'needs-you')
  await expect(entry(page, 'notice:ledger')).toHaveCount(0)
  await page.reload()
  await expect(answers(page).getByRole('radio', { name: 'Only you' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-bell]')).toHaveText('1')
})

test('Dismiss waits eight seconds in the tab, with Undo', async ({ page }) => {
  const notices = [{ id: 'disk', kind: 'storage_low', title: 'Workspace disk is 95% full', body: '4.6 GB free.', since: ago(30), due: ago(30), silenceable: false, target: { settings: 'general' } }]
  const sent: string[] = []
  await page.route('**/api/notices/*/dismiss', (route) => { sent.push(route.request().url()); return json(route, { enabled: true, notices: [] }) })
  await open(page, { notices, requests: [], decisions: [], revision: 1 })
  await entry(page, 'notice:disk').getByRole('button', { name: 'Dismiss' }).click()
  await expect(entry(page, 'notice:disk')).toContainText('Dismissed')
  await entry(page, 'notice:disk').getByRole('button', { name: 'Undo' }).click()
  await expect(entry(page, 'notice:disk').getByRole('button', { name: 'Dismiss' })).toBeVisible()
  expect(sent).toEqual([])
})

for (const width of [375, 768, 1000]) {
  test(`nothing overflows the page at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await open(page, { notices: [], decisions: [], revision: 1, requests: [permission('p1', 's1', 'Run gh pr create with a long title that wraps across the narrow column')] })
    await expect(page.locator('[data-tile]').first()).toBeVisible()
    // Measured once the place has arrived: its entrance moves it by the travel distance.
    await page.waitForFunction(() => !document.querySelector('[data-place-root][data-motion-running], [data-place-root][data-flow-enter]'))
    const sizes = await page.evaluate(() => {
      const d = document.documentElement
      const ova = document.querySelector<HTMLElement>('.ova')!
      return { page: [d.scrollWidth, d.clientWidth, d.scrollHeight, d.clientHeight], ova: [ova.scrollWidth, ova.clientWidth] }
    })
    expect(sizes.page[0]).toBeLessThanOrEqual(sizes.page[1])
    expect(sizes.page[2]).toBeLessThanOrEqual(sizes.page[3])
    expect(sizes.ova[0]).toBeLessThanOrEqual(sizes.ova[1])
  })
}
