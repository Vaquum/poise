import { expect, test, type Page, type Route, type WebSocketRoute } from '@playwright/test'
import type { AnalyticsHealth } from '../../src/analytics-health-types'

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
  /** The chats read fails from the start. */
  chatsFail?: boolean
  /** The runs read fails from the start. */
  runsFail?: boolean
  /** The chat requests read waits for this first. */
  requestsLate?: Promise<void>
  /** What /api/behavior-metrics answers. */
  metrics?: unknown
  /** The behavior-metrics reads asked, as their search parameters. */
  metricsAsked?: URLSearchParams[]
  /** The chain's tasks. */
  chains?: unknown[]
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
    if (path === '/api/chat/requests') { await workspace.requestsLate; return json(route, { revision: workspace.revision, complete: true, requests: workspace.requests }) }
    if (path === '/api/chat/switchboard') return json(route, { revision: 1, status: 'live', items: workspace.decisions })
    if (/^\/api\/chat\/switchboard\/items\/\d+\/answer$/.test(path) && workspace.answerDecision) {
      await workspace.answerDecision.delay
      return json(route, workspace.answerDecision.body, workspace.answerDecision.status)
    }
    if (path === '/api/chat/sessions') return workspace.chatsFail ? json(route, { error: 'the chat service did not answer' }, 503) : json(route, { instance: 'poise-dev:test', sessions: [] })
    if (path === '/api/editor/reviews') return json(route, { publications: [], sweep: { publications: 0, longestDelayMinutes: 15 } })
    if (path === '/api/behavior-chains') return json(route, { chains: workspace.chains ?? [], attention: [] })
    if (path === '/api/behaviors') return json(route, { diagnostics: { status: 'ok', agentLogsError: null, datastore: { status: 'healthy', checkedAt: ago(1), ageSeconds: 1, lastSuccessAt: ago(1), error: null }, identity: { status: 'valid', actor: 'bot', error: null }, failures: [], deadLetters: [], holds: [] } })
    if (path === '/api/settings' && method === 'GET') return json(route, { org: '', organizations: [{ login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }], me: 'me', agentAccount: 'bot', timezone: 'UTC', manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1 } })
    if (path === '/api/analytics') return json(route, { window: { since: url.searchParams.get('since'), until: url.searchParams.get('until') }, agentAccount: 'bot', ...day, ...(url.searchParams.get('dailyBounds') ? { daily: Array.from({ length: 7 }, () => day) } : {}), errors: [] })
    if (path === '/api/analytics/history') {
      const bounds = (url.searchParams.get('bounds') ?? '').split(',')
      return json(route, { periods: bounds.slice(1).map((until, i) => ({ since: bounds[i], until, ...day })), errors: [] })
    }
    if (path === '/api/github-quota') return json(route, { accounts: [] })
    if (path === '/api/behavior-metrics') { (workspace.metricsAsked ??= []).push(url.searchParams); return json(route, workspace.metrics ?? { behaviors: {}, error: null }) }
    if (path === '/api/behavior-estimates') return json(route, { estimates: [] })
    if (path === '/api/agent-logs') return workspace.runsFail ? json(route, { error: 'agent-interface did not answer' }, 503) : json(route, { logs: [] })
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

test('a level brings what it adds into view, or says there is none, and arrow keys keep moving it', async ({ page }) => {
  const ready = Array.from({ length: 30 }, (_, i) => ({ id: `pr${i}`, kind: 'pr_ready', title: `acme/site#${i} is ready to merge`, body: 'Checks pass.', since: ago(20 + i), due: ago(5), silenceable: true, target: { pullRequest: `https://github.com/acme/site/pull/${i}` } }))
  const notices = [...ready, { id: 'turn', kind: 'chat_turn_finished', title: 'Codex finished', body: 'Done after 6 minutes.', since: ago(9), due: ago(9), silenceable: false, target: { chat: 's2' } }]
  await open(page, { notices, requests: [], decisions: [], revision: 1 })
  const level = (name: string) => answers(page).getByRole('radio', { name })

  await level('Only you').click()
  await level('+ Faults').click()
  await expect(page.locator('.toast')).toHaveText('Nothing more is open at this level.')
  await level('+ Done').click()
  await expect(entry(page, 'notice:turn')).toBeInViewport()

  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(level('Only you')).toHaveAttribute('aria-checked', 'true')
  await expect(level('Only you')).toBeFocused()
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

test('the right-hand side has one day, one search and the organization; Behaviors follows the day (#1380)', async ({ page }) => {
  const workspace: Workspace = { notices: [], requests: [], decisions: [], revision: 1, chains: [{ id: 'acme/site#7', sequence: 1, repository: 'acme/site', issue: 7, pullNumber: null,
    held: null, waiting: null, mergeSha: null, supersession: null, reviewPending: null, invocations: [] }] }
  await open(page, workspace)
  const filters = page.locator('[data-ref="ov.filters"]')
  await expect(filters.locator('[data-ref="ov.day"]')).toBeVisible()
  await expect(filters.getByRole('searchbox', { name: 'Filter this side' })).toBeVisible()
  // No time filter of its own in any panel.
  await expect(page.locator('.ova-main [data-ref="ov.range"], .ova-main [data-range]')).toHaveCount(0)
  await expect(page.locator('[data-ref="ov.behaviors.day"]')).toContainText('Today')
  await expect.poll(() => workspace.metricsAsked?.at(-1)?.get('since') ?? null).not.toBeNull()
  const today = workspace.metricsAsked!.at(-1)!

  await filters.getByRole('button', { name: 'Previous day' }).click()
  await expect(page.locator('[data-ref="ov.behaviors.day"]')).toContainText('Yesterday')
  await expect.poll(() => workspace.metricsAsked!.at(-1)!.get('until')).toBe(today.get('since'))
  await expect(page.locator('[data-livenote="motion"]')).toContainText('not for Yesterday')
  await expect(page.locator('[data-livenote="health"]')).toContainText('not for Yesterday')
  await filters.getByRole('button', { name: 'Next day' }).click()
  await expect(page.locator('[data-livenote="motion"]')).not.toContainText('not for')

  // One search narrows every panel and says so where nothing matches.
  const search = filters.getByRole('searchbox', { name: 'Filter this side' })
  await search.fill('merg')
  await expect(page.locator('[data-tile="Pull requests merged"]')).toBeVisible()
  await expect(page.locator('[data-tile="Pull requests opened"]')).toHaveCount(0)
  await expect(page.locator('[data-beh]')).toHaveCount(1)
  await expect(page.locator('[data-beh="merge-prs"]')).toBeVisible()
  await expect(page.locator('[data-worklist]')).toContainText('Nothing here matches “merg”.')
  await expect(page.locator('[data-ref="ov.h.blocked"]')).toBeHidden()
  // Tasks the search hides are not tasks that are gone.
  await expect(page.locator('[data-phases]')).toContainText('Nothing here matches “merg”.')
  await search.press('Escape')
  await expect(page.locator('[data-phases]')).toContainText('in intake')
  await expect(page.locator('[data-tile="Pull requests opened"]')).toBeVisible()
  await expect(page.locator('[data-beh]')).not.toHaveCount(1)
  await expect(page.locator('[data-ref="ov.h.blocked"]')).toBeVisible()
})

test('each Show level says how many entries it shows (#1380)', async ({ page }) => {
  const notice = (id: string, kind: string) => ({ id, kind, title: `${kind} title`, body: '', since: ago(5), due: ago(5), silenceable: false, target: null })
  await open(page, { notices: [notice('n1', 'storage_low'), notice('n2', 'ledger_queue_stalled'), notice('n3', 'chat_turn_finished')], requests: [], decisions: [], revision: 1 })
  const level = (name: string) => answers(page).getByRole('radio', { name: new RegExp(`^${name.replace('+', '\\+')},`) })
  await expect(level('Only you')).toHaveAccessibleName('Only you, 1 entry')
  await expect(level('+ Faults')).toHaveAccessibleName('+ Faults, 2 entries')
  await expect(level('+ Done')).toHaveAccessibleName('+ Done, 3 entries')
  await expect(level('Everything')).toHaveAccessibleName('Everything, 3 entries')
  await expect(level('+ Faults')).toContainText('2')
})

test('the bell on Overview brings Answer here to its first entry with the focus ring; its count follows Show (#1433)', async ({ page }) => {
  const notice = (id: string, kind: string, minutes: number) => ({ id, kind, title: `${kind} title`, body: '', since: ago(minutes), due: ago(minutes), silenceable: false, target: null })
  await open(page, { notices: [notice('n1', 'storage_low', 5), notice('n2', 'ledger_queue_stalled', 6), notice('n3', 'chat_turn_finished', 7)], requests: [], decisions: [], revision: 1 })
  const bell = page.getByRole('button', { name: /^Notifications/ })
  await expect(bell).toHaveAccessibleName(/Brings Answer here to its first entry\.$/)
  // Its count is what Show lists.
  const level = (name: string) => answers(page).getByRole('radio', { name: new RegExp(`^${name.replace('+', '\\+')},`) })
  await level('Only you').click()
  await expect(bell.locator('[data-bell]')).toHaveText('1')
  await level('+ Done').click()
  await expect(bell.locator('[data-bell]')).toHaveText('3')
  // Focus elsewhere, the list scrolled: a click brings the list to its top and focuses its first entry, ring and all.
  await page.locator('.ova-list').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.getByRole('searchbox', { name: 'Filter this side' }).focus()
  await bell.click()
  const first = answers(page).locator('[data-notice]').first()
  await expect(first).toBeFocused()
  await expect(first).toHaveAttribute('data-notice', 'notice:n1')
  expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
  expect(await page.locator('.ova-list').evaluate((el) => el.scrollTop)).toBe(0)
  expect(new URL(page.url()).searchParams.get('view')).toBe('overview')
})

test('the bell’s focus ring stays through a live redraw, and follows the first entry when the first read lands late (#1433)', async ({ page }) => {
  let release!: () => void
  // As the bell from another place opens it: Overview at #answer, before the requests have been read.
  const workspace: Workspace = { notices: [], requests: [permission('p1', 's1', 'Run gh pr create')], decisions: [], revision: 1,
    requestsLate: new Promise<void>((resolve) => { release = resolve }) }
  await open(page, workspace, '/?view=overview&back=board#answer')
  await expect(answers(page).locator('[data-key="empty"]')).toBeFocused()
  release()
  const card = entry(page, 'request:p1')
  await expect(card).toBeFocused()
  expect(await card.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
  // A live redraw keeps the ring while focus stays.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.waitForTimeout(1500)
  await expect(card).toBeFocused()
  expect(await card.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid')
})

test('with nothing at the level, the bell focuses Answer here’s empty state (#1433)', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  await page.getByRole('button', { name: /^Notifications/ }).click()
  await expect(answers(page).locator('[data-key="empty"]')).toBeFocused()
})

test('a decision whose chat is gone says so, and Dismiss puts it away', async ({ page }) => {
  const decision = (id: number, exists: boolean) => ({ id, kind: 'decision', text: `Decision ${id}`, detail: null, createdAt: ago(4), source: { sessionId: `s${id}`, title: `Chat ${id}`, agent: 'claude', model: 'opus', exists }, sourceSeq: 2, options: [{ id: 'a', label: 'Open the fix', detail: null, recommended: true }], explanation: { state: 'none' } })
  const workspace: Workspace = { notices: [], requests: [], revision: 1, decisions: [decision(7, true), decision(8, false)] }
  const sent: string[] = []
  await page.route('**/api/chat/switchboard/items/*/dismiss', (route) => {
    sent.push(new URL(route.request().url()).pathname)
    workspace.decisions = workspace.decisions.filter((item) => (item as { id: number }).id !== 8)
    return json(route, { revision: 2, status: 'live', items: workspace.decisions })
  })
  await open(page, workspace)
  await expect(entry(page, 'decision:7').getByRole('button', { name: 'Dismiss' })).toHaveCount(0)
  await expect(entry(page, 'decision:8')).toContainText('The chat that asked no longer exists, so it can no longer be answered.')
  await expect(entry(page, 'decision:8').getByRole('button', { name: /Open the fix/ })).toHaveAttribute('aria-disabled', 'true')

  await entry(page, 'decision:8').getByRole('button', { name: 'Dismiss' }).click()
  await expect(entry(page, 'decision:8')).toContainText('Dismissed')
  await expect.poll(() => sent, { timeout: 12_000 }).toEqual(['/api/chat/switchboard/items/8/dismiss'])
  await page.mouse.move(1000, 600)
  await expect(entry(page, 'decision:8')).toHaveCount(0)
  await expect(entry(page, 'decision:7')).toBeVisible()
})

for (const width of [375, 768, 1000, 1280]) {
  test(`nothing overflows the page at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await open(page, { notices: [], decisions: [], revision: 1, requests: [permission('p1', 's1', 'Run gh pr create with a long title that wraps across the narrow column')] })
    await expect(page.locator('[data-tile]').first()).toBeVisible()
    // Measured once the place has arrived: its entrance moves it by the travel distance.
    await page.waitForFunction(() => !document.querySelector('[data-place-root][data-motion-running], [data-place-root][data-flow-enter]'))
    const sizes = await page.evaluate(() => {
      const d = document.documentElement
      const ova = document.querySelector<HTMLElement>('.ova')!
      const main = document.querySelector<HTMLElement>('.ova-main')!
      return { page: [d.scrollWidth, d.clientWidth, d.scrollHeight, d.clientHeight], ova: [ova.scrollWidth, ova.clientWidth], main: [main.scrollWidth, main.clientWidth] }
    })
    expect(sizes.page[0]).toBeLessThanOrEqual(sizes.page[1])
    expect(sizes.page[2]).toBeLessThanOrEqual(sizes.page[3])
    expect(sizes.ova[0]).toBeLessThanOrEqual(sizes.ova[1])
    expect(sizes.main[0]).toBeLessThanOrEqual(sizes.main[1])
  })
}

test('System health reads its five cards live, and a failed read keeps them, with when', async ({ page }) => {
  let fail = false
  let rate: AnalyticsHealth['rate'] = { completed: 6, errors: 3, perItem: 0.5, unsettled: 0, withheld: null, items: [] }
  const now = Date.now()
  await page.route('**/api/analytics/system-health*', (route) => fail ? json(route, { error: 'evidence store unavailable' }, 503) : json(route, {
    readAt: now, window: { since: now - 86_400_000, until: now }, scope: '', limits: [],
    rate,
    blocked: { count: 3, oldestProgressAt: now - 26 * 3_600_000, largestStage: 'Repair: 2', items: [] },
    recovery: { automatic: [{}, {}], intervention: [{}], unknown: 0 },
    lastError: { error: { at: now - 15 * 60_000, work: 'autonomio/poise#496', journal: '', summary: '', callId: 'call-1', incident: EVIDENCE.incidentId, invocation: 'inv-1' }, lastObserved: false, coveredSince: now - 86_400_000, coveredUntil: now },
    coverage: [
      { name: 'Chain journal', scope: 'All configured accounts', status: 'verified v2', lastReadAt: null, intervals: null },
      { name: 'Caller receipts', scope: 'Instance-wide', status: 'ok', lastReadAt: null, intervals: [{ since: now - 100, until: now - 4, state: 'covered' }, { since: now - 4, until: now, state: 'unknown' }] },
    ],
  }))
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  const card = (ref: string) => page.locator(`[data-ref="ov.health"] [data-ref="${ref}"]`)
  await expect(card('ov.h.errors')).toContainText('0.5 per item')
  await expect(card('ov.h.errors').locator(':scope > .t-gloss')).toHaveText('3 errors across 6 items completed')
  await expect(card('ov.h.blocked')).toContainText('oldest 1d 2h without verified progress · Repair: 2')
  await expect(card('ov.h.recovery')).toContainText('1 needed outside help')
  await expect(card('ov.h.lasterror')).toContainText('at ')
  await expect(card('ov.h.lasterror')).toHaveAttribute('href', `?view=observe&part=logging&incident=${EVIDENCE.incidentId}&back=overview`)
  await expect(card('ov.h.coverage').getByRole('img')).toHaveAttribute('aria-label', '96% covered, 4% unknown')
  await expect(page.getByText('Planned · #1101')).toHaveCount(0)

  fail = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('[data-healthfail]')).toContainText('System health could not be read: evidence store unavailable. Last read at')
  await expect(card('ov.h.errors')).toContainText('0.5 per item')

  // Another organization's figures never stand for the one chosen.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('poise:organization-filter-changed')))
  await expect(card('ov.h.errors')).toContainText('—')
  await expect(page.locator('[data-healthfail]')).toContainText('Not read yet.')

  fail = false
  // Never a bare Unavailable (#1381): a rate, a lower bound, or why there is none, in words.
  const unknownMerge = 'GitHub’s merge time for acme/site#7 is unknown, so it may belong to these 24 hours'
  for (const [completed, errors, perItem, unsettled, withheld, value, note] of [
    [0, 0, null, 0, 'no v2 work merged in the last 24 hours', 'None completed', '0 errors across 0 items completed · no v2 work merged in the last 24 hours'],
    [2, 2, null, 0, unknownMerge, 'Unknown', `2 errors across 2 items completed · ${unknownMerge}`],
    [0, 0, null, 0, unknownMerge, 'Unknown', `0 errors across 0 items completed · ${unknownMerge}`],
    [2, 0, 0, 0, null, '0.0 per item', '0 errors across 2 items completed'],
    [6, 3, 0.5, 2, null, 'at least 0.5 per item', '3 errors across 6 items completed · 2 still have runs being reconciled, so the rate may rise'],
  ] as const) {
    rate = { completed, errors, perItem, unsettled, withheld, items: [] }
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect(card('ov.h.errors').locator('.osmall-v')).toHaveText(value)
    await expect(card('ov.h.errors').locator(':scope > .t-gloss')).toHaveText(note)
    await expect(card('ov.h.errors').locator(':scope > .t-gloss')).toBeVisible()
    await expect(card('ov.h.errors')).toHaveAttribute('href', '?view=observe&part=logging&back=overview')
  }
})

test('Behaviors gives every row its runs, time and success, or says why in words (#1382)', async ({ page }) => {
  const metrics = { error: 'Some worker logs are unreadable; affected behavior metrics are unavailable.', behaviors: {
    'review-new-prs': { totalRuns: 12, durationMinutes: 30, successRate: 75 },
    'resolve-unblocking': { totalRuns: 619, durationMinutes: 120, untimedRuns: 6, successRate: 16.2 },
    'close-old-prs': { totalRuns: 0, durationMinutes: 0, successRate: null },
    'implement-issues': { totalRuns: 2, durationMinutes: 5, successRate: null },
    'repair-prs': null,
  } }
  await open(page, { notices: [], requests: [], decisions: [], revision: 1, metrics })
  const row = (key: string) => page.locator(`[data-beh="${key}"]`)
  await expect(row('review-new-prs')).toContainText('75%')
  await expect(row('review-new-prs').locator('td.num').first()).toHaveText('12')
  await expect(row('resolve-unblocking')).toContainText('+ 6 untimed')
  await expect(row('close-old-prs')).toContainText('no runs')
  await expect(row('implement-issues')).toContainText('none finished')
  await expect(row('repair-prs')).toContainText('unknown: some of its run records cannot be read')
  // No value is a bare dash.
  for (const cell of await page.locator('[data-beh] td.num').allInnerTexts()) expect(cell.trim()).not.toBe('—')
})

test('a reload paints System health’s last read at once while it reads again, and never another GitHub user’s', async ({ page }) => {
  const now = Date.now()
  await page.route('**/api/analytics/system-health*', (route) => json(route, {
    readAt: now, window: { since: now - 86_400_000, until: now }, scope: '', limits: [],
    rate: { completed: 6, errors: 3, perItem: 0.5, unsettled: 0, withheld: null, items: [] },
    blocked: { count: 0, oldestProgressAt: null, largestStage: null, items: [] },
    recovery: { automatic: [], intervention: [], unknown: 0 },
    lastError: { error: null, lastObserved: false, coveredSince: now - 86_400_000, coveredUntil: now }, coverage: [],
  }))
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  const errors = page.locator('[data-ref="ov.health"] [data-ref="ov.h.errors"]')
  await expect(errors).toContainText('0.5 per item')
  // The reads are held; the reload paints the last one anyway, with nothing failed.
  await page.route('**/api/analytics/system-health*', async () => { await new Promise(() => {}) })
  await page.reload()
  await expect(errors).toContainText('0.5 per item', { timeout: 2_000 })
  await expect(page.locator('[data-healthfail]')).toBeEmpty()
  // Settings now name another GitHub user and arrive late: the page opens on the
  // remembered settings, and what was read for the first user goes once they arrive.
  let release = () => {}
  const late = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await late
    return json(route, { org: '', organizations: [{ login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }], me: 'other', agentAccount: 'bot', timezone: 'UTC', manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1 } })
  })
  await page.reload()
  await expect(errors).toContainText('0.5 per item', { timeout: 2_000 })
  release()
  await expect(errors).toContainText('Not read yet')
  await expect(errors.locator('.osmall-v')).toHaveText('—')
  // Nor does the next page open on it.
  await page.reload()
  await expect(errors).toContainText('Not read yet')
})

test('System health’s last read never stands once an organization that was not ready is removed', async ({ page }) => {
  const now = Date.now()
  const settings = (organizations: unknown[]) => ({ org: '', organizations, me: 'me', agentAccount: 'bot', timezone: 'UTC', manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1 } })
  const acme = { login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }
  const beta = { login: 'beta', managed: false, status: 'initializing', stage: 'syncing', error: null, activatedAt: null }
  await page.route('**/api/analytics/system-health*', (route) => json(route, {
    readAt: now, window: { since: now - 86_400_000, until: now }, scope: '', limits: [],
    rate: { completed: 6, errors: 3, perItem: 0.5, unsettled: 0, withheld: null, items: [] },
    blocked: { count: 0, oldestProgressAt: null, largestStage: null, items: [] },
    recovery: { automatic: [], intervention: [], unknown: 0 },
    lastError: { error: null, lastObserved: false, coveredSince: now - 86_400_000, coveredUntil: now }, coverage: [],
  }))
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  // beta, still initializing, joins acme, and All orgs is read for both, from a fresh page.
  await page.route('**/api/settings', (route) => route.request().method() !== 'GET' ? route.fallback() : json(route, settings([acme, beta])))
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  const errors = page.locator('[data-ref="ov.health"] [data-ref="ov.h.errors"]')
  await expect(errors).toContainText('0.5 per item')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('poise-overview-health'))).not.toBeNull()
  // beta is removed elsewhere; the reads are held. The first reload opens on the
  // remembered settings, the next on the fresh ones.
  await page.route('**/api/settings', (route) => route.request().method() !== 'GET' ? route.fallback() : json(route, settings([acme])))
  await page.route('**/api/analytics/system-health*', async () => { await new Promise(() => {}) })
  await page.reload()
  await expect(errors).toContainText('Not read yet')
  await page.reload()
  await expect(errors).toContainText('Not read yet')
})

test('In motion says what was never read, rather than zero or clear', async ({ page }) => {
  let ghReads = 0
  page.on('requestfinished', (request) => { if (new URL(request.url()).pathname === '/api/gh') ghReads++ })
  await open(page, { notices: [], requests: [], decisions: [], revision: 1, chatsFail: true, runsFail: true })
  await expect(page.locator('[data-counts="people"] b').first()).toHaveText('—')
  // A run never read is not Idle: once GitHub's items are read, their counts still wait for the runs going now.
  await page.waitForLoadState('networkidle')
  expect(ghReads).toBeGreaterThan(0)
  await expect(page.locator('[data-counts="items"] b').first()).toHaveText('—')
  await expect(page.locator('[data-worklist]')).toHaveText('Not read yet.')
})

test('a reload opens Overview on the settings this browser remembers, without waiting for the server’s', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  await expect(page.locator('[data-mgrbox]')).not.toContainText('Settings could not be read')
  // The server's settings answer is held; the reload opens the place anyway.
  let answer: () => void = () => {}
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await new Promise<void>((resolve) => { answer = resolve })
    return route.fallback()
  })
  await page.reload()
  await expect(page.getByRole('complementary', { name: 'Answer here' })).toBeVisible({ timeout: 2_000 })
  await expect(page.locator('.ova-main')).toBeVisible({ timeout: 2_000 })
  await expect(page.locator('[data-mgrbox]')).not.toContainText('Settings could not be read')
  answer()
  await expect(page.locator('[data-mgrbox]')).not.toContainText('Settings could not be read')
})

const SETTINGS = { org: '', organizations: [{ login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }], me: 'me', agentAccount: 'bot', timezone: 'UTC', manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1 } }

test('a failed fresh read of Settings shows on the Manager’s card, never the remembered controls', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  await expect(page.locator('[data-act="mgr-paused"]')).toBeVisible()
  await page.route('**/api/settings', (route) => route.request().method() !== 'GET' ? route.fallback() : json(route, { error: 'settings store unavailable' }, 503))
  await page.reload()
  await expect(page.locator('[data-mgrbox]')).toContainText('Settings could not be read')
  await expect(page.locator('[data-act="mgr-paused"]')).toHaveCount(0)
})

test('a focused Manager control shows the fresh settings when they land, so it acts on what it shows', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  const pause = page.locator('[data-act="mgr-paused"]')
  await expect(pause).toHaveAttribute('aria-pressed', 'false')
  // New work was paused elsewhere; the reload opens on the remembered controls while the fresh ones are held.
  let hold = true
  const held: Array<() => void> = []
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    if (hold) await new Promise<void>((resolve) => held.push(resolve))
    return json(route, { ...SETTINGS, manager: { ...SETTINGS.manager, paused: true, version: 2 } })
  })
  await page.reload()
  await expect(pause).toHaveAttribute('aria-pressed', 'false')
  await pause.focus()
  hold = false
  held.forEach((resolve) => resolve())
  await expect(pause).toHaveAttribute('aria-pressed', 'true')
  await expect(pause).toBeFocused()
})

test('a reload paints In motion’s last reads at once, while it reads them again', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  const people = page.locator('[data-counts="people"] b').first()
  const items = page.locator('[data-counts="items"] b').first()
  await expect(people).not.toHaveText('—')
  await expect(items).not.toHaveText('—')
  // GitHub's reads and the chats are held; the reload paints the last ones anyway.
  await page.route('**/api/gh', async () => { await new Promise(() => {}) })
  await page.route('**/api/chat/sessions', async () => { await new Promise(() => {}) })
  await page.reload()
  await expect(people).not.toHaveText('—', { timeout: 2_000 })
  await expect(items).not.toHaveText('—', { timeout: 2_000 })
})

test('In motion never paints another organization’s last issues and pull requests', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  const items = page.locator('[data-counts="items"] b').first()
  await expect(items).not.toHaveText('—')
  // Another organization is chosen, and GitHub's reads are held.
  await page.evaluate(() => localStorage.setItem('poise-organization', 'acme'))
  await page.route('**/api/gh', async () => { await new Promise(() => {}) })
  await page.reload()
  await expect(page.locator('[data-counts="people"] b').first()).not.toHaveText('—')
  await expect(items).toHaveText('—')
})

test('In motion keeps an organization’s last reads only from its own latest read', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  // Two organizations; all organizations' read is held, beta's answers at once with its one issue.
  const organizations = ['acme', 'beta'].map((login) => ({ login, managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }))
  await page.route('**/api/settings', (route) => route.request().method() !== 'GET' ? route.fallback() : json(route, { org: '', organizations, me: 'me', agentAccount: 'bot', timezone: 'UTC' }))
  const issue = (repo: string, number: number) => ({ kind: 'issue', repo, number, title: `Issue ${number}`, state: 'open' })
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/gh', async (route) => {
    const body = route.request().postDataJSON() as { operation: string, org?: string }
    if (body.operation !== 'list') return json(route, { records: [], held: [], errors: [] })
    if (!body.org) { await held; return json(route, { records: [issue('acme/site', 1), issue('acme/site', 2), issue('beta/api', 3)], errors: [] }) }
    return json(route, { records: [issue('beta/api', 3)], errors: [] })
  })
  await page.reload()
  await expect(page.locator('select[data-org]')).toBeVisible()
  // beta is chosen while all organizations' read is still out, and In motion reads again.
  await page.locator('select[data-org]').selectOption('beta')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  const items = page.locator('[data-counts="items"] b')
  const total = async () => (await items.allTextContents()).reduce((sum, text) => sum + (Number(text) || 0), 0)
  await expect.poll(total).toBe(1)
  // The overtaken read lands late; beta keeps its own.
  release()
  await page.waitForTimeout(500)
  expect(await total()).toBe(1)
  await page.route('**/api/gh', async () => { await new Promise(() => {}) })
  await page.reload()
  await expect.poll(total).toBe(1)
})

test('a read that lands after Overview was left keeps nothing', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  await expect(page.locator('[data-counts="people"] b').first()).not.toHaveText('—')
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/chat/sessions', async (route) => {
    await held
    return json(route, { instance: 'poise-dev:test', sessions: [{ id: 'late', title: 'Late chat', role: null, status: 'idle', agent: 'claude', createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), lastSeq: 0, pendingRequests: [] }] })
  })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.getByRole('navigation', { name: 'Poise' }).getByRole('link', { name: 'Board' }).click()
  release()
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => localStorage.getItem('poise-overview-motion'))).not.toContain('Late chat')
})

test('a reload paints the day’s last numbers at once, with when they were read, while it reads again', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  await expect(page.locator('[data-tile]').first()).toBeVisible()
  await expect(page.getByText('Reading the day’s numbers…')).toHaveCount(0)
  // The day's reads are held; the reload paints the last numbers anyway.
  await page.route(/\/api\/analytics(\?|\/history)/, async () => { await new Promise(() => {}) })
  await page.reload()
  await expect(page.locator('[data-tile]').first()).toBeVisible({ timeout: 2_000 })
  await expect(page.locator('[data-dayline]')).toContainText('until')
  await expect(page.getByText('Reading the day’s numbers…')).toHaveCount(0)
})

test('a reload never paints another GitHub user’s day', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  await expect(page.locator('[data-tile]').first()).toBeVisible()
  // Settings now name another GitHub user, and the day's reads are held.
  await page.route('**/api/settings', (route) => route.request().method() !== 'GET' ? route.fallback() : json(route, { org: '', organizations: [{ login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }], me: 'other', agentAccount: 'bot', timezone: 'UTC', manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1 } }))
  await page.route(/\/api\/analytics(\?|\/history)/, async () => { await new Promise(() => {}) })
  await page.reload()
  await expect(page.getByText('Reading the day’s numbers…')).toBeVisible()
  await expect(page.locator('[data-tile]')).toHaveCount(0)
})

test('a reload reads the 30 days again when they failed, though the year was read', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  await expect(page.locator('[data-tile]').first()).toBeVisible()
  // A first read whose 30 days fail while the year is read.
  let fail = true
  await page.route('**/api/analytics/history**', (route) => fail && (new URL(route.request().url()).searchParams.get('bounds') ?? '').split(',').length <= 31
    ? json(route, { error: 'history store unavailable' }, 503) : route.fallback())
  await page.evaluate(() => localStorage.removeItem('poise-overview-day'))
  await page.reload()
  const failed = page.locator('p.onote.is-warn', { hasText: 'The 30 days' })
  await page.locator('[data-tile]').first().click()
  await expect(failed).toBeVisible()
  // The service recovers; the next reload paints the remembered day and reads the 30 days again.
  fail = false
  await page.reload()
  await page.locator('[data-tile]').first().click()
  await expect(page.getByText(/of 30 days known/)).toBeVisible()
  await expect(failed).toHaveCount(0)
})

/** Settings as the fixture serves them, with another GitHub user or other organizations. */
const settingsAs = (as: { me?: string, logins?: string[] }) => ({ org: '', organizations: (as.logins ?? ['acme']).map((login) => ({ login, managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null })),
  me: as.me ?? 'me', agentAccount: 'bot', timezone: 'UTC', manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1 } })
const holdReads = async (page: Page) => {
  await page.route(/\/api\/analytics(\?|\/history)/, async () => { await new Promise(() => {}) })
  await page.route('**/api/gh', async () => { await new Promise(() => {}) })
}

test('the day and In motion keep nothing for an unknown GitHub user', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  await expect(page.locator('[data-tile]').first()).toBeVisible()
  // Settings name no GitHub user: what this load reads is kept for nobody.
  await page.route('**/api/settings', (route) => route.request().method() !== 'GET' ? route.fallback() : json(route, settingsAs({ me: '' })))
  await page.reload()
  await expect(page.locator('[data-tile]').first()).toBeVisible()
  await expect(page.locator('[data-counts="items"] b').first()).not.toHaveText('—')
  await holdReads(page)
  await page.reload()
  await expect(page.getByText('Reading the day’s numbers…')).toBeVisible()
  await expect(page.locator('[data-counts="items"] b').first()).toHaveText('—')
})

test('All orgs’ last reads never stand for another set of organizations', async ({ page }) => {
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  await expect(page.locator('[data-tile]').first()).toBeVisible()
  await expect(page.locator('[data-counts="items"] b').first()).not.toHaveText('—')
  // beta is added elsewhere; the day's and GitHub's reads are held.
  await page.route('**/api/settings', (route) => route.request().method() !== 'GET' ? route.fallback() : json(route, settingsAs({ logins: ['acme', 'beta'] })))
  await holdReads(page)
  await page.reload()
  await expect(page.getByText('Reading the day’s numbers…')).toBeVisible()
  await expect(page.locator('[data-counts="items"] b').first()).toHaveText('—')
  // The workspace's chats still stand.
  await expect(page.locator('[data-counts="people"] b').first()).not.toHaveText('—')
})

test('a failed day refresh after the organizations changed never files the old numbers under the new ones', async ({ page }) => {
  await page.clock.install()
  await open(page, { notices: [], requests: [], decisions: [], revision: 1 })
  await expect(page.locator('[data-tile]').first()).toBeVisible()
  // A save from the Manager's card answers with settings that now hold beta too, and the day's next refresh fails.
  const withBeta = settingsAs({ logins: ['acme', 'beta'] })
  await page.route('**/api/settings', (route) => route.request().method() === 'POST' ? json(route, { ...withBeta, manager: { ...withBeta.manager, rhythm: 6, version: 2 } }) : route.fallback())
  await page.route(/\/api\/analytics(\?|\/history)/, (route) => json(route, { error: 'analytics unavailable' }, 503))
  await page.locator('[data-act="rh-more"]').click()
  await expect(page.locator('.rh-n')).toHaveText('6')
  const failed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/analytics' && response.status() === 503)
  await page.clock.fastForward(61_000)
  await failed
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => localStorage.getItem('poise-overview-day') ?? '')).not.toContain('acme,beta')
  // The next load reads beta too; the old organizations' numbers are not restored for it.
  await page.route('**/api/settings', (route) => route.request().method() !== 'GET' ? route.fallback() : json(route, withBeta))
  await holdReads(page)
  await page.reload()
  await expect(page.getByText('Reading the day’s numbers…')).toBeVisible()
})
