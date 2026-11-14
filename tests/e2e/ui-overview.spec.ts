import { expect, test, type Locator, type Page, type Route, type WebSocketRoute } from '@playwright/test'
import type { AnalyticsHealth } from '../../src/analytics-health-types'
import { BEHAVIOR_KEYS } from '../../src/behavior-types'
import { BEHAVIOR_METRICS_COVERAGE_ERROR } from '../../src/behavior-metrics'

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

interface Request { id: string, kind: 'permission' | 'question', sessionId: string, sessionTitle: string, createdAt: string, content: unknown, escalation: string | null, ownerAction: boolean }
const permission = (id: string, sessionId: string, title: string): Request => ({
  id, kind: 'permission', sessionId, sessionTitle: `Chat ${sessionId}`, createdAt: ago(3), escalation: null, ownerAction: true,
  content: { title, description: 'Open a pull request.', input: { command: 'gh pr create' }, options: [{ id: 'allow', name: 'Allow once', kind: 'allow_once' }, { id: 'deny', name: 'Deny', kind: 'reject_once' }] },
})
const question = (id: string, sessionId: string, q: { question: string, options: string[], freeText: boolean }): Request => ({
  id, kind: 'question', sessionId, sessionTitle: `Chat ${sessionId}`, createdAt: ago(5), escalation: null, ownerAction: true,
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
  /** The chain's attention rows. */
  attention?: unknown[]
  /** Put-away entries the server keeps, and what was posted to it. */
  dismissals?: { key: string, revision: string, at: string }[]
  dismissed?: unknown[]
  /** Every POST that could act on the chain. */
  chainActions?: unknown[]
  /** Behaviors' agent log error, a diagnostic with no time of its own. */
  agentLogsError?: string | null
  /** Review publications and each document's threads; a reply appends to its thread. */
  publications?: unknown[]
  threads?: Record<string, { id: string, messages: { author: string, body: string, createdAt: string }[] }[]>
  /** The chat requests read waits for this first. */
  requestsLate?: Promise<void>
  /** What /api/behavior-metrics answers. */
  metrics?: unknown
  metricsFail?: boolean
  /** The behavior-metrics reads asked, as their search parameters. */
  metricsAsked?: URLSearchParams[]
  /** The chain's tasks. */
  chains?: unknown[]
  /** Each open pull request's blocker, as /api/behavior-ledger/pr-status answers. */
  prs?: unknown[]
  /** Every read Answer here's entries come from waits for this first. */
  answersLate?: Promise<void>
  /** Behaviors' state, runs and estimates and the API quota wait for this first. */
  rightLate?: Promise<void>
  /** Each behavior's state, as /api/behaviors answers it beside its diagnostics. */
  behaviorStates?: Record<string, unknown>
  /** What /api/github-quota answers. */
  quota?: unknown
  /** /api/behavior-estimates fails. */
  estimatesFail?: boolean
  /** /api/behaviors fails. */
  behaviorsFail?: boolean
  /** The organizations /api/settings names, all ready; acme alone unless set. */
  orgs?: string[]
  /** /api/settings waits for this first. */
  settingsLate?: Promise<void>
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
    if (method === 'GET' && workspace.answersLate && ['/api/notices', '/api/chat/requests', '/api/chat/switchboard', '/api/editor/reviews', '/api/behavior-chains', '/api/behaviors',
      '/api/behavior-ledger/pr-status', '/api/answers/dismissals'].includes(path)) await workspace.answersLate
    if (path === '/api/behavior-estimates' && workspace.estimatesFail) return json(route, { error: 'estimates are unavailable' }, 503)
    if (method === 'GET' && workspace.rightLate && ['/api/behaviors', '/api/behavior-metrics', '/api/behavior-estimates', '/api/github-quota'].includes(path)) await workspace.rightLate
    if (path === '/api/notices' && method === 'GET') return json(route, { enabled: true, notices: workspace.notices })
    if (path === '/api/notices/handled') return json(route, { handled: [] })
    if (path === '/api/chat/requests') { await workspace.requestsLate; return json(route, { revision: workspace.revision, complete: true, requests: workspace.requests }) }
    if (path === '/api/chat/switchboard') return json(route, { revision: 1, status: 'live', items: workspace.decisions })
    if (/^\/api\/chat\/switchboard\/items\/\d+\/answer$/.test(path) && workspace.answerDecision) {
      await workspace.answerDecision.delay
      return json(route, workspace.answerDecision.body, workspace.answerDecision.status)
    }
    if (path === '/api/chat/sessions') return workspace.chatsFail ? json(route, { error: 'the chat service did not answer' }, 503) : json(route, { instance: 'poise-dev:test', sessions: [] })
    if (path === '/api/editor/reviews') return json(route, { publications: workspace.publications ?? [], sweep: { publications: 0, longestDelayMinutes: 15 } })
    const doc = /^\/api\/editor\/doc\/([^/]+)\/reviews(\/action)?$/.exec(path)
    if (doc) {
      const slug = decodeURIComponent(doc[1])
      const rows = (workspace.threads ??= {})[slug] ??= []
      if (doc[2] && method === 'POST') {
        const body = route.request().postDataJSON() as { id: string, body: string }
        rows.find((row) => row.id === body.id)?.messages.push({ author: 'me', body: body.body, createdAt: new Date().toISOString() })
      }
      const reviews = rows.map((row) => ({ ...row, kind: 'thread', repo: 'acme/site', site: 'site', pr: 3, prUrl: 'https://github.com/acme/site/pull/3', resolved: false, canReply: true, canResolve: true }))
      return json(route, { reviews })
    }
    if (path === '/api/behavior-chains' && method === 'POST') { (workspace.chainActions ??= []).push(route.request().postDataJSON()); return json(route, {}) }
    if (path === '/api/behavior-chains') return json(route, { chains: workspace.chains ?? [], attention: workspace.attention ?? [] })
    if (path === '/api/answers/dismissals' && method === 'POST') {
      const body = route.request().postDataJSON() as { key: string, revision: string }
      ;(workspace.dismissed ??= []).push(body)
      workspace.dismissals = [{ key: body.key, revision: body.revision, at: new Date().toISOString() }, ...(workspace.dismissals ?? []).filter((row) => row.key !== body.key)]
      return json(route, { dismissals: workspace.dismissals })
    }
    if (path === '/api/answers/dismissals/forget' && method === 'POST') {
      const { keys } = route.request().postDataJSON() as { keys: string[] }
      workspace.dismissals = (workspace.dismissals ?? []).filter((row) => !keys.includes(row.key))
      return json(route, { dismissals: workspace.dismissals })
    }
    if (path === '/api/answers/dismissals') return json(route, { dismissals: workspace.dismissals ?? [] })
    if (path === '/api/behaviors' && workspace.behaviorsFail) return json(route, { error: 'behaviors are unavailable' }, 503)
    if (path === '/api/behaviors') return json(route, { ...workspace.behaviorStates, diagnostics: { status: 'ok', agentLogsError: workspace.agentLogsError ?? null, datastore: { status: 'healthy', checkedAt: ago(1), ageSeconds: 1, lastSuccessAt: ago(1), error: null }, identity: { status: 'valid', actor: 'bot', error: null }, failures: [], deadLetters: [], holds: [] } })
    if (path === '/api/settings' && method === 'GET') await workspace.settingsLate
    if (path === '/api/settings' && method === 'GET') return json(route, { org: '', organizations: (workspace.orgs ?? ['acme']).map((login) => ({ login, managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null })), me: 'me', agentAccount: 'bot', timezone: 'UTC', manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1 } })
    if (path === '/api/analytics') return json(route, { window: { since: url.searchParams.get('since'), until: url.searchParams.get('until') }, agentAccount: 'bot', ...day, ...(url.searchParams.get('dailyBounds') ? { daily: Array.from({ length: 7 }, () => day) } : {}), errors: [] })
    if (path === '/api/analytics/history') {
      const bounds = (url.searchParams.get('bounds') ?? '').split(',')
      return json(route, { periods: bounds.slice(1).map((until, i) => ({ since: bounds[i], until, ...day })), errors: [] })
    }
    if (path === '/api/github-quota') return json(route, workspace.quota ?? { accounts: [] })
    if (path === '/api/behavior-metrics') {
      (workspace.metricsAsked ??= []).push(url.searchParams)
      return workspace.metricsFail ? json(route, { error: 'metrics refresh unavailable' }, 503) : json(route, workspace.metrics ?? { behaviors: {}, error: null })
    }
    if (path === '/api/behavior-estimates') return json(route, { estimates: [] })
    if (path === '/api/agent-logs') return workspace.runsFail ? json(route, { error: 'agent-interface did not answer' }, 503) : json(route, { logs: [] })
    if (path === '/api/gh') return json(route, { records: [], held: [], errors: [] })
    if (path === '/api/behavior-ledger/pr-status') return json(route, { rows: workspace.prs ?? [] })
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
/** A card's icons take a press once the pointer is on the card, as on Board's cards. */
async function press(card: Locator, name: string, role: 'button' | 'link' = 'button'): Promise<void> {
  await card.hover()
  await card.getByRole(role, { name, exact: true }).click()
}
/** Unfolds what Poise handles on its own, folded while anything else is listed, once its entries have been read. */
async function unfoldAuto(page: Page): Promise<void> {
  const show = answers(page).locator('[data-key="g:auto"]').getByRole('button', { name: 'Show', exact: true })
  await expect(show).toBeVisible()
  await show.click()
}

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
  await card.getByRole('button', { name: 'Other' }).click()
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
  await press(entry(page, 'notice:held:grey'), 'Open its diagnostic', 'link')
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
    { id: 'review', kind: 'review_requested', title: 'acme/site#10 requests your review', body: 'New change', since: ago(10), due: ago(10), silenceable: true, target: { pullRequest: 'https://github.com/acme/site/pull/10' } },
    { id: 'signin', kind: 'sign_in_needed', title: 'Reconnect GitHub', body: 'Sign in again', since: ago(6), due: ago(6), silenceable: false, target: { settings: 'accounts' } },
    { id: 'ledger', kind: 'ledger_queue_stalled', title: 'Behavior ledger is not draining', body: 'Queued 6 minutes.', since: ago(7), due: ago(7), silenceable: false, target: null },
    { id: 'turn', kind: 'chat_turn_finished', title: 'Codex finished', body: 'Done after 6 minutes.', since: ago(9), due: ago(9), silenceable: false, target: { chat: 's2' } },
  ]
  await open(page, { notices, requests: [], decisions: [], revision: 1 }, '/?view=overview&back=board#answer')
  await expect(page.getByRole('link', { name: 'Back to Board' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-answers]'))).toBe(true)
  await expect(page.locator('[data-bell]')).toHaveText('3')
  await expect(entry(page, 'notice:pr')).toHaveCount(0)
  await expect(entry(page, 'notice:turn')).toHaveCount(0)
  await expect(page.locator('[data-bell]')).toHaveAttribute('data-tone', 'failed')
  await expect(entry(page, 'notice:review').getByRole('link', { name: 'Open its card on Board' })).toHaveAttribute('href', '?view=board&item=acme%2Fsite%2310&back=overview')
  await expect(entry(page, 'notice:review').getByRole('button', { name: 'Approve', exact: true })).toBeVisible()

  await answers(page).getByRole('radio', { name: 'Only you' }).click()
  await expect(page.locator('[data-bell]')).toHaveText('2')
  await expect(entry(page, 'notice:signin')).toBeVisible()
  await expect(page.locator('[data-bell]')).toHaveAttribute('data-tone', 'needs-you')
  await expect(entry(page, 'notice:ledger')).toHaveCount(0)
  await page.reload()
  await expect(answers(page).getByRole('radio', { name: 'Only you' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-bell]')).toHaveText('2')
})

test('only one worker question asks the owner after the Manager escalates it', async ({ page }) => {
  const worker = { ...question('q1', 'w1', { question: 'Which release?', options: ['Stable', 'Beta'], freeText: false }), ownerAction: false }
  const workspace: Workspace = { notices: [], requests: [worker], decisions: [], revision: 1 }
  const socket = await open(page, workspace)
  await answers(page).getByRole('radio', { name: 'Only you', exact: true }).click()
  await expect(entry(page, 'request:q1')).toHaveCount(0)
  await expect(page.locator('[data-bell]')).toHaveText('0')
  workspace.requests = [{ ...worker, ownerAction: true, escalation: 'The release choice belongs to the owner.' }]
  announce(socket, workspace)
  await answers(page).getByRole('button', { name: 'Show now' }).click()
  const card = entry(page, 'request:q1')
  await expect(card).toContainText('Which release?')
  await expect(card).toContainText('The release choice belongs to the owner.')
  await expect(page.locator('[data-bell]')).toHaveText('1')
  await card.getByRole('button', { name: 'Stable' }).click()
  await expect.poll(() => socket.frames.some(frame => frame.command.type === 'question.answer' && frame.command.sessionId === 'w1')).toBe(true)
})

test('a level brings what it adds into view, or says there is none, and arrow keys keep moving it', async ({ page }) => {
  const requested = Array.from({ length: 30 }, (_, i) => ({ id: `pr${i}`, kind: 'review_requested', title: `acme/site#${i + 1} requested your review`, body: 'A pull request', since: ago(20 + i), due: ago(5), silenceable: true, target: { pullRequest: `https://github.com/acme/site/pull/${i + 1}` } }))
  const notices = [...requested, { id: 'quota', kind: 'github_quota_warning', title: 'GitHub API quota is low', body: '900 of 5000 left.', since: ago(9), due: ago(9), silenceable: false, target: null }]
  await open(page, { notices, requests: [], decisions: [], revision: 1 })
  const level = (name: string) => answers(page).getByRole('radio', { name })

  await level('Only you').click()
  await level('+ Faults').click()
  await expect(page.locator('.toast')).toHaveText('Nothing more is open at this level.')
  await level('Everything').click()
  // What Poise handles on its own comes into view, folded to its count.
  await expect(answers(page).locator('[data-key="g:auto"]')).toBeInViewport()
  await unfoldAuto(page)
  await expect(entry(page, 'notice:quota')).toBeVisible()

  await level('Everything').focus()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(level('Only you')).toHaveAttribute('aria-checked', 'true')
  await expect(level('Only you')).toBeFocused()
})

test('a card shows only what acts; its other actions wait under the pointer, as on Board', async ({ page }) => {
  const notices = [{ id: 'pr', kind: 'pr_ready', title: 'acme/site#9 is ready to merge', body: 'Fix the login', since: ago(20), due: ago(5), silenceable: true, target: { pullRequest: 'https://github.com/acme/site/pull/9' } }]
  await open(page, { notices, requests: [], decisions: [], revision: 1, prs: [{ repository: 'acme/site', number: 9, blocker: { id: 'not_eligible', line: 'outside your configured GitHub account pair', since: ago(20), sinceRestart: false, details: [] } }] })
  const card = entry(page, 'notice:pr')
  // The pull request's own title, what moves it next, and its kind, place and age.
  await expect(card.locator('.card-title')).toHaveText('Fix the login')
  await expect(card.locator('.nc-d')).toHaveText('outside your configured GitHub account pair')
  await expect(card.locator('.card-meta')).toContainText('Ready to merge')
  await expect(card.locator('.card-meta')).toContainText('acme/site #9')
  await expect(card.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0)
  const acts = card.locator('.card-acts')
  await page.mouse.move(1200, 700)
  await expect.poll(() => acts.evaluate((el) => getComputedStyle(el).opacity)).toBe('0')
  await card.hover()
  await expect.poll(() => acts.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  await expect(acts.locator('.ib')).toHaveCount(5)
  expect(await acts.locator('.ib').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual(['Open its card on Board', 'Open on GitHub', 'Show more', 'Silence reminders', 'Dismiss'])
  await expect(acts.getByRole('button', { name: 'Dismiss' })).toHaveAttribute('data-words', 'puts it away until it happens again')
})

test('a question you answer here shows whole; a long title is cut short only where More shows it whole', async ({ page }) => {
  const long = 'Which of the two release branches should carry the fix for the login timeout that customers reported on Tuesday, given that the hotfix window closes tonight and the other branch is frozen for the audit?'
  const quota = { id: 'held', kind: 'storage_low', title: long, body: 'Free space is low.', since: ago(5), due: ago(5), silenceable: false, target: null }
  await open(page, { notices: [quota], decisions: [], revision: 1, requests: [question('q1', 's1', { question: long, options: ['main', 'release'], freeText: true })] })
  const clipped = (id: string) => entry(page, id).locator('.card-title').evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(await clipped('request:q1')).toBe(false)
  await expect(entry(page, 'request:q1')).not.toHaveClass(/is-clamped/)
  expect(await clipped('notice:held')).toBe(true)
  await press(entry(page, 'notice:held'), 'Show more')
  expect(await clipped('notice:held')).toBe(false)
})

test('a pull request Poise is moving waits on nobody: it shows under Everything, not Only you', async ({ page }) => {
  const notices = [{ id: 'pr', kind: 'pr_ready', title: 'acme/site#9 is ready to merge', body: 'Fix the login', since: ago(20), due: ago(5), silenceable: true, target: { pullRequest: 'https://github.com/acme/site/pull/9' } }]
  await open(page, { notices, requests: [], decisions: [], revision: 1, prs: [{ repository: 'acme/site', number: 9, blocker: { id: 'in_queue', line: 'in merge queue since 12:12Z', since: ago(5), sinceRestart: false, details: [] } }] })
  await answers(page).getByRole('radio', { name: 'Only you', exact: true }).click()
  await expect(entry(page, 'notice:pr')).toHaveCount(0)
  await expect(page.locator('[data-ncount]')).toHaveText('0')
  await answers(page).getByRole('radio', { name: 'Everything', exact: true }).click()
  // Alone in the list, what Poise handles is not folded.
  await expect(answers(page).locator('[data-key="g:auto"]')).toContainText('Handled automatically')
  await expect(entry(page, 'notice:pr').locator('.nc-d')).toHaveText('in merge queue since 12:12Z')
})

test('Answer here paints its last read at once, quiet and unanswerable, and each fresh read replaces it', async ({ page }) => {
  let release!: () => void
  const late = new Promise<void>((resolve) => { release = resolve })
  const kept = [
    { id: 'request:p1', source: 'request', group: 'needs-you', kind: 'Permission', title: 'Run gh pr create', where: 'Chat s1', since: ago(3), detail: 'Asks before a step',
      options: ['Allow once', 'Deny'], primary: 0, open: { href: '?view=chat&chat=s1&back=overview', label: 'Open the chat' } },
    { id: 'notice:disk', source: 'notice', group: 'fault', kind: 'Storage', title: 'Workspace disk is 95% full', where: '', since: ago(30) },
  ]
  await page.addInitScript((value) => { if (!sessionStorage.getItem('kept-once')) { sessionStorage.setItem('kept-once', '1'); localStorage.setItem('poise-overview-answers-v2', value) } },
    JSON.stringify({ key: 'me|acme:ready', at: NOW - 120_000, entries: kept }))
  const workspace: Workspace = { notices: [], decisions: [], revision: 1, requests: [permission('p1', 's1', 'Run gh pr create')], answersLate: late }
  const socket = await open(page, workspace)
  // At once, before any read lands: the last read, quieter, nothing on it acting.
  const card = entry(page, 'request:p1')
  await expect(card).toHaveClass(/is-remembered/)
  await expect(entry(page, 'notice:disk')).toHaveClass(/is-remembered/)
  await expect(page.locator('[data-ncount]')).toHaveText('2')
  await expect(page.locator('[data-held]')).toContainText('Last read')
  const allow = card.getByRole('button', { name: 'Allow once' })
  await expect(allow).toHaveAttribute('aria-disabled', 'true')
  await allow.dispatchEvent('click')
  await card.hover()
  await expect(card.getByRole('button', { name: 'Dismiss' })).toHaveCount(0)
  await expect(card.getByRole('link', { name: 'Open the chat' })).toHaveCount(1)
  const box = await card.boundingBox()
  // The reads land: the request is current and answers; the disk notice has cleared since.
  release()
  await expect(card).not.toHaveClass(/is-remembered/)
  await expect(allow).not.toHaveAttribute('aria-disabled', 'true')
  await expect(entry(page, 'notice:disk')).toHaveCount(0)
  await expect(page.locator('[data-held]')).not.toContainText('Last read')
  // The same card, where it was.
  expect((await card.boundingBox())?.height).toBe(box?.height)
  expect(socket.frames.filter((frame) => frame.command.type === 'permission.respond')).toEqual([])
  // What is drawn now is kept for the next load, small: only what a card shows.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('poise-overview-answers-v2') ?? 'null')?.entries?.map((e: { id: string }) => e.id)), { timeout: 10_000 }).toEqual(['request:p1'])
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('poise-overview-answers-v2') ?? 'null'))
  expect(stored.key).toBe('me|acme:ready')
  expect(Object.keys(stored.entries[0]).sort()).toEqual(['detail', 'group', 'id', 'kind', 'open', 'options', 'primary', 'since', 'source', 'title', 'where'])
})

test('a failed read stands for nothing: its source’s last read stays, and the kept list is not overwritten', async ({ page }) => {
  const kept = { key: 'me|acme:ready', at: NOW - 60_000, entries: [
    { id: 'diagnostic:["held_result"]', source: 'diagnostic', group: 'fault', kind: 'Behaviors', title: 'The review outcome needs verification before retry.', where: 'acme/site#4', since: ago(30) }] }
  await page.addInitScript((value) => localStorage.setItem('poise-overview-answers-v2', value), JSON.stringify(kept))
  await open(page, { notices: [], decisions: [], revision: 1, requests: [], behaviorsFail: true })
  const card = page.locator('[data-notice="diagnostic:[\\"held_result\\"]"]')
  await expect(card).toHaveClass(/is-remembered/)
  // Every other source has read; Behaviors failed. Its last read stays, and nothing is written over it.
  await page.waitForTimeout(3_500)
  await expect(card).toHaveClass(/is-remembered/)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('poise-overview-answers-v2') ?? 'null')?.at)).toBe(kept.at)
})

test('settings read afresh for other organizations put the last read away at once', async ({ page }) => {
  const settings = { org: '', organizations: [{ login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }], me: 'me', agentAccount: 'bot', timezone: 'UTC',
    manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1 } }
  await page.addInitScript(([last, answers]) => { localStorage.setItem('poise-last-settings', last); localStorage.setItem('poise-overview-answers-v2', answers) },
    [JSON.stringify(settings), JSON.stringify({ key: 'me|acme:ready', at: NOW - 60_000, entries: [{ id: 'request:old', source: 'request', group: 'needs-you', kind: 'Permission', title: 'From the old scope', where: 'Chat', since: ago(5) }] })])
  let release!: () => void
  let settingsRead!: () => void
  const workspace: Workspace = { notices: [], decisions: [], revision: 1, requests: [], orgs: ['acme', 'beta'], answersLate: new Promise<void>((resolve) => { release = resolve }),
    settingsLate: new Promise<void>((resolve) => { settingsRead = resolve }) }
  await open(page, workspace)
  // The page opens on the settings it remembers, and paints their last read.
  await expect(entry(page, 'request:old')).toHaveClass(/is-remembered/)
  // Read afresh, the settings name beta too: acme's last read no longer stands, though nothing else has been read.
  settingsRead()
  await expect(entry(page, 'request:old')).toHaveCount(0)
  release()
  await expect(answers(page).locator('[data-key="empty"]')).toBeVisible()
})

test('another GitHub user’s or organizations’ last read never paints', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('poise-overview-answers-v2', JSON.stringify({ key: 'someone-else|acme:ready', at: Date.now(), entries: [
    { id: 'request:x', source: 'request', group: 'needs-you', kind: 'Permission', title: 'Not yours', where: 'Chat x', since: null }] })))
  let release!: () => void
  const workspace: Workspace = { notices: [], decisions: [], revision: 1, requests: [], answersLate: new Promise<void>((resolve) => { release = resolve }) }
  await open(page, workspace)
  await expect(entry(page, 'request:x')).toHaveCount(0)
  release()
  await expect(answers(page).locator('[data-key="empty"]')).toBeVisible()
})

test('Dismiss waits eight seconds in the tab, with Undo', async ({ page }) => {
  const notices = [{ id: 'disk', kind: 'storage_low', title: 'Workspace disk is 95% full', body: '4.6 GB free.', since: ago(30), due: ago(30), silenceable: false, target: { settings: 'general' } }]
  const sent: string[] = []
  await page.route('**/api/notices/*/dismiss', (route) => { sent.push(route.request().url()); return json(route, { enabled: true, notices: [] }) })
  await open(page, { notices, requests: [], decisions: [], revision: 1 })
  await press(entry(page, 'notice:disk'), 'Dismiss')
  await expect(entry(page, 'notice:disk')).toContainText('Dismissed')
  await entry(page, 'notice:disk').getByRole('button', { name: 'Undo' }).click()
  await expect(entry(page, 'notice:disk').getByRole('button', { name: 'Dismiss' })).toBeVisible()
  expect(sent).toEqual([])
})

test('Answer here lists the newest first, and every card can be put away without acting on it (#1379)', async ({ page }) => {
  const attention = (issue: number, minutes: number) => ({ id: `autonomio/poise#${issue}`, repository: 'autonomio/poise', issue, pullNumber: null, step: 'repair-pr: uncertain',
    progressAt: NOW - minutes * 60_000, ageMs: minutes * 60_000, blocker: 'Original outcome requires reconciliation', evidence: { state: 'open', checkedAt: null, gates: [] },
    nextAction: 'reconcile', retryAt: null, journal: `/api/behavior-chains?id=${encodeURIComponent(`autonomio/poise#${issue}`)}&after=3`,
    reconciliation: { nextObservationAt: null, waitingForResourceRelease: false } })
  const decision = { id: 9, kind: 'decision', text: 'Which repair goes first?', detail: null, createdAt: ago(1), source: { sessionId: 'm1', title: 'Manager', agent: 'claude', model: 'opus', exists: true }, sourceSeq: 2,
    options: [{ id: 'a', label: 'The failing check', detail: null, recommended: true }], explanation: { state: 'none' } }
  const workspace: Workspace = { notices: [], decisions: [decision], revision: 1, requests: [permission('p1', 's1', 'Run gh pr create')], attention: [attention(898, 4 * 1440), attention(1169, 60)] }
  const socket = await open(page, workspace)
  await answers(page).getByRole('radio', { name: 'Everything' }).click()
  await unfoldAuto(page)
  const ids = () => page.locator('[data-answers] [data-notice]').evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.notice))
  // Newest first within who acts: the decision (1 min) and the permission (3 min) wait on you; the chain still for
  // four days is stuck, a fault; the one that moved an hour ago is Poise's, handled automatically.
  await expect.poll(ids).toEqual(['decision:9', 'request:p1', 'chain:autonomio/poise#898', 'chain:autonomio/poise#1169'])

  // A Manager's prompt with options answers with them or Other, in your own words; it has no Dismiss.
  await expect(entry(page, 'decision:9').getByRole('button', { name: 'Dismiss' })).toHaveCount(0)
  await entry(page, 'decision:9').getByRole('button', { name: 'Other' }).click()
  await expect(entry(page, 'decision:9').getByRole('textbox')).toBeFocused()
  // Every other card's Dismiss says what it does, in its tip.
  await expect(entry(page, 'request:p1').getByRole('button', { name: 'Dismiss' })).toHaveAttribute('data-words', 'hides it here; the chat still waits for your answer in Chat')
  await expect(entry(page, 'chain:autonomio/poise#898').getByRole('button', { name: 'Dismiss' })).toHaveAttribute('data-words', /hides it until the chain moves/)

  await press(entry(page, 'chain:autonomio/poise#1169'), 'Dismiss')
  await expect(entry(page, 'chain:autonomio/poise#1169')).toContainText('Dismissed')
  await expect.poll(() => workspace.dismissed, { timeout: 12_000 }).toEqual([{ key: 'chain:autonomio/poise#1169',
    revision: `${new Date(NOW - 60 * 60_000).toISOString()}|autonomio/poise#1169 · repair-pr: uncertain|Original outcome requires reconciliation`, title: 'autonomio/poise #1169 · Original outcome requires reconciliation' }])
  await page.mouse.move(1000, 600)
  await expect(entry(page, 'chain:autonomio/poise#1169')).toHaveCount(0)
  // The heading counts what waits on you and what is stuck, never what Poise handles.
  await expect(page.locator('[data-ncount]')).toHaveText('3')
  // Putting it away sent nothing to any chat and resumed nothing.
  expect(socket.frames.map((frame) => frame.command.type).filter((type) => /respond|answer|resume|message|send|prompt/i.test(String(type)))).toEqual([])
  expect(workspace.chainActions ?? []).toEqual([])
})

test('a put-away diagnostic with no time of its own shows again when it recurs after clearing (#1379)', async ({ page }) => {
  const workspace: Workspace = { notices: [], requests: [], decisions: [], revision: 1, agentLogsError: 'agent-interface --logs failed: database is locked' }
  await open(page, workspace)
  const card = answers(page).locator('[data-notice^="diagnostic:"]')
  await expect(card).toHaveCount(1)
  await press(card, 'Dismiss')
  await expect.poll(() => workspace.dismissals?.length ?? 0, { timeout: 12_000 }).toBe(1)
  await page.mouse.move(1000, 600)
  await expect(card).toHaveCount(0)
  const reread = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  // It clears: its dismissal is forgotten.
  workspace.agentLogsError = null
  await reread()
  await expect.poll(() => workspace.dismissals?.length ?? 0, { timeout: 15_000 }).toBe(0)
  // It happens again, word for word: it shows again.
  workspace.agentLogsError = 'agent-interface --logs failed: database is locked'
  await reread()
  await expect(card).toHaveCount(1, { timeout: 15_000 })
})

test('a review thread answered here stays settled though the reply changes what it reports (#1379)', async ({ page }) => {
  const workspace: Workspace = { notices: [], requests: [], decisions: [], revision: 1,
    publications: [{ slug: 'notes', site: 'site', repo: 'acme/site', pr: 3, prUrl: '', checkedAt: ago(2), active: true, stale: false, problems: [], openThreads: 1 }],
    threads: { notes: [{ id: 't1', messages: [{ author: 'ann', body: 'Typo in the title', createdAt: ago(10) }] }] } }
  await open(page, workspace)
  const card = entry(page, 'thread:notes:t1')
  await expect(card).toHaveCount(0)
  await answers(page).getByRole('radio', { name: 'Everything' }).click()
  await expect(page.locator('[data-bell]')).toHaveText('0')
  await card.getByRole('button', { name: 'Reply…' }).click()
  await card.getByRole('textbox').fill('Fixed, thanks')
  await card.getByRole('button', { name: 'Send reply' }).click()
  await expect(card).toContainText('Replied on GitHub, as you')
  await expect(card.getByRole('button', { name: 'Reply…' })).toHaveCount(0)
  await page.mouse.move(1000, 600)
  await expect(card).toHaveCount(0)
  expect(workspace.threads!.notes[0].messages).toHaveLength(2)
})

test('a chain card whose report changes while it is being put away comes back with the new report, and the old one is not sent (#1379)', async ({ page }) => {
  const attention = (minutes: number) => ({ id: 'autonomio/poise#1169', repository: 'autonomio/poise', issue: 1169, pullNumber: null, step: 'repair-pr: uncertain',
    progressAt: NOW - minutes * 60_000, ageMs: minutes * 60_000, blocker: 'Original outcome requires reconciliation', evidence: { state: 'open', checkedAt: null, gates: [] },
    nextAction: 'reconcile', retryAt: null, journal: `/api/behavior-chains?id=${encodeURIComponent('autonomio/poise#1169')}&after=3`,
    reconciliation: { nextObservationAt: null, waitingForResourceRelease: false } })
  // Still for five hours it is stuck, a fault; once it moves it is Poise's, handled automatically: Everything shows both.
  const workspace: Workspace = { notices: [], decisions: [], revision: 1, requests: [], attention: [attention(300)] }
  await open(page, workspace)
  await answers(page).getByRole('radio', { name: 'Everything', exact: true }).click()
  const card = entry(page, 'chain:autonomio/poise#1169')
  await press(card, 'Dismiss')
  await expect(card).toContainText('Dismissed')
  // The chain advances during the eight seconds.
  workspace.attention = [attention(2)]
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(card.getByRole('button', { name: 'Dismiss' })).toBeVisible()
  await expect(card).not.toContainText('Dismissed')
  await page.waitForTimeout(9_000)
  expect(workspace.dismissed ?? []).toEqual([])
  await expect(card).toBeVisible()
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

test('Show has three levels, each visibly changing the list, and the heading counts what it shows', async ({ page }) => {
  const notice = (id: string, kind: string) => ({ id, kind, title: `${kind} title`, body: '', since: ago(5), due: ago(5), silenceable: false, target: null })
  await open(page, { notices: [notice('n1', 'sign_in_needed'), notice('n2', 'storage_low'), notice('n3', 'chat_turn_finished'), notice('n4', 'github_quota_warning')], requests: [], decisions: [], revision: 1 })
  const level = (name: string) => answers(page).getByRole('radio', { name, exact: true })
  await expect(answers(page).getByRole('radio')).toHaveText(['Only you', '+ Faults', 'Everything'])
  const listed = () => answers(page).locator('[data-notice]').evaluateAll((cards) => cards.map((card) => (card as HTMLElement).dataset.notice))
  await level('Only you').click()
  await expect.poll(listed).toEqual(['notice:n1'])
  await expect(page.locator('[data-ncount]')).toHaveText('1')
  await level('+ Faults').click()
  await expect.poll(listed).toEqual(['notice:n1', 'notice:n2'])
  await expect(page.locator('[data-ncount]')).toHaveText('2')
  await level('Everything').click()
  await unfoldAuto(page)
  await expect.poll(listed).toEqual(['notice:n1', 'notice:n2', 'notice:n4'])
  await expect(page.locator('[data-ncount]')).toHaveText('2')
  // Finished work is never listed.
  await expect(entry(page, 'notice:n3')).toHaveCount(0)
})

for (const width of [1440, 1000, 375]) {
  test(`Show's three levels fit Answer here's row at ${width} pixels (#1439)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const notice = (id: number) => ({ id: `n${id}`, kind: 'storage_low', title: `Disk ${id}`, body: '', since: ago(id), due: ago(id), silenceable: false, target: null })
    await open(page, { notices: Array.from({ length: 120 }, (_, i) => notice(i + 1)), requests: [], decisions: [], revision: 1 })
    const seg = answers(page).locator('.olevel')
    await expect(seg.getByRole('radio', { name: 'Everything', exact: true })).toBeVisible()
    const fit = await seg.evaluate((el) => {
      const row = el.closest<HTMLElement>('.ova-level')!.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      return { inside: box.left >= row.left - 0.5 && box.right <= row.right + 0.5, buttons: [...el.querySelectorAll('button')].every((button) => button.scrollWidth <= button.clientWidth + 0.5) }
    })
    expect(fit).toEqual({ inside: true, buttons: true })
  })
}

test('the bell on Overview brings Answer here to its first entry with the focus ring; its count follows Show (#1433)', async ({ page }) => {
  const notice = (id: string, kind: string, minutes: number) => ({ id, kind, title: `${kind} title`, body: '', since: ago(minutes), due: ago(minutes), silenceable: false, target: null })
  await open(page, { notices: [notice('n1', 'sign_in_needed', 5), notice('n2', 'ledger_queue_stalled', 6), notice('n3', 'chat_turn_finished', 7)], requests: [], decisions: [], revision: 1 })
  const bell = page.getByRole('button', { name: /^Notifications/ })
  await expect(bell).toHaveAccessibleName(/Brings Answer here to its first entry\.$/)
  // Its count is what Show lists.
  const level = (name: string) => answers(page).getByRole('radio', { name, exact: true })
  await level('Only you').click()
  await expect(bell.locator('[data-bell]')).toHaveText('1')
  await level('Everything').click()
  await expect(bell.locator('[data-bell]')).toHaveText('2')
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

test('a decision whose chat is gone leaves Only you', async ({ page }) => {
  const decision = (id: number, exists: boolean) => ({ id, kind: 'decision', text: `Decision ${id}`, detail: null, createdAt: ago(4), source: { sessionId: `s${id}`, title: `Chat ${id}`, agent: 'claude', model: 'opus', exists }, sourceSeq: 2, options: [{ id: 'a', label: 'Open the fix', detail: null, recommended: true }], explanation: { state: 'none' } })
  const workspace: Workspace = { notices: [], requests: [], revision: 1, decisions: [decision(7, true), decision(8, false)] }
  await open(page, workspace)
  await expect(entry(page, 'decision:7').getByRole('button', { name: 'Dismiss' })).toHaveCount(0)
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

test('a reload paints Behaviors’ and the API quota’s last reads at once; a switch waits for the fresh read', async ({ page }) => {
  const quota = { accounts: [{ login: 'me', roles: ['user'], checkedAt: ago(1), error: null, buckets: [{ resource: 'core', label: 'REST', limit: 5000, used: 1200, remaining: 3800,
    resetAt: new Date(NOW + 30 * 60_000).toISOString(), perMinute: 4, riskPercent: 0, history: [] }] }] }
  const workspace: Workspace = { notices: [], requests: [], decisions: [], revision: 1, quota, behaviorStates: { 'review-new-prs': { enabled: true, lastTriggered: { at: ago(10), target: 'acme/site#42' } } },
    metrics: { error: null, behaviors: { 'review-new-prs': { totalRuns: 12, durationMinutes: 30, successRate: 75 } } } }
  await open(page, workspace)
  const row = page.locator('[data-beh="review-new-prs"]')
  const toggle = row.locator('[data-act="beh-toggle"]')
  await expect(row.locator('td.num').first()).toHaveText('12')
  await expect(page.locator('[data-quota]')).toContainText('1,200 of 5,000 used')
  // Read afresh, they are kept for the next load: only what the panels draw.
  await expect.poll(() => page.evaluate(() => [localStorage.getItem('poise-overview-behaviors'), localStorage.getItem('poise-overview-quota')].map((value) => value ? JSON.parse(value).key : null)))
    .toEqual(['me|acme:ready', 'me|bot'])
  // The next load, with every read held back: the last reads paint at once, the switch as it was but taking no press.
  let release!: () => void
  workspace.rightLate = new Promise<void>((resolve) => { release = resolve })
  workspace.metrics = { error: null, behaviors: { 'review-new-prs': { totalRuns: 13, durationMinutes: 31, successRate: 80 } } }
  const posts: string[] = []
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/behaviors')) posts.push(request.url()) })
  await page.reload()
  await expect(row.locator('td.num').first()).toHaveText('12')
  await expect(page.locator('[data-quota]')).toContainText('1,200 of 5,000 used')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAttribute('aria-disabled', 'true')
  await expect(toggle).toHaveAttribute('data-why', /Reading what is current/)
  await toggle.dispatchEvent('click')
  // The search finds what a row shows, its remembered last run included.
  await page.getByRole('searchbox', { name: 'Filter this side' }).fill('site#42')
  await expect(row).toBeVisible()
  await expect(page.locator('[data-beh="approve-prs"]')).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Filter this side' }).fill('')
  // The fresh reads replace them, and the switch works.
  release()
  await expect(row.locator('td.num').first()).toHaveText('13')
  await expect(toggle).not.toHaveAttribute('aria-disabled', 'true')
  expect(posts).toEqual([])
})

test('Behaviors’ last reads never stand once settings read afresh name other organizations', async ({ page }) => {
  const settings = { org: '', organizations: [{ login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }], me: 'me', agentAccount: 'bot', timezone: 'UTC',
    manager: { rhythm: 5, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1 } }
  const kept = { key: 'me|acme:ready', at: NOW - 60_000, since: '1970-01-01T00:00:00.000Z', state: { 'review-new-prs': { on: true, paused: null, last: null } },
    metrics: { error: null, behaviors: {} }, estimates: [{ id: 'r1', behavior: 'pr_review', startedAt: ago(2), estimate: null }] }
  await page.addInitScript(([last, behaviors]) => { localStorage.setItem('poise-last-settings', last); localStorage.setItem('poise-overview-behaviors', behaviors) }, [JSON.stringify(settings), JSON.stringify(kept)])
  let settingsRead!: () => void
  const workspace: Workspace = { notices: [], decisions: [], revision: 1, requests: [], orgs: ['acme', 'beta'], rightLate: new Promise<void>(() => {}), estimatesFail: true,
    settingsLate: new Promise<void>((resolve) => { settingsRead = resolve }) }
  await open(page, workspace)
  const toggle = page.locator('[data-beh="review-new-prs"] [data-act="beh-toggle"]')
  // Opened on the remembered settings, the switch shows its last state, taking no press.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAttribute('data-why', /Reading what is current/)
  // What was running, as last read, stands though its fresh read failed.
  const lastRun = page.locator('[data-beh="review-new-prs"] td').nth(1)
  await expect(lastRun).toContainText('Running')
  // Read afresh, the settings name beta too: the last state and runs no longer stand, though Behaviors has not been read.
  settingsRead()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toHaveAttribute('data-why', /could not be read/)
  await expect(lastRun).not.toContainText('Running')
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

test('Today’s coverage gap is an immediate stable fault until its range is verified (#1436)', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-13T12:00:30Z') })
  const empty = { behaviors: Object.fromEntries(BEHAVIOR_KEYS.map((key) => [key, { totalRuns: 0, durationMinutes: 0, successRate: null }])), error: null }
  const workspace: Workspace = { notices: [], requests: [], decisions: [], revision: 1, metrics: empty }
  await open(page, workspace)
  const row = (key: string) => page.locator(`[data-beh="${key}"]`)
  const fault = answers(page).locator('.nc.is-fault').filter({ hasText: 'Today’s behavior metrics lack evidence' })
  await expect(row('repair-prs')).toContainText('no runs')
  await expect(fault).toHaveCount(0)
  const error = `${BEHAVIOR_METRICS_COVERAGE_ERROR} Range: [2026-11-13T00:00:00.000Z, 2026-11-14T00:00:00.000Z). Behaviors: repair-prs. Metrics: totalRuns, durationMinutes, successRate.\nHistory row: 1436 · Call: ${'a'.repeat(32)} · Correlation: gap-call · Target: acme/site#7 · agent-interface log record has invalid status`
  const incomplete = { behaviors: { ...empty.behaviors,
    'repair-prs': null, 'review-new-prs': { totalRuns: 12, durationMinutes: 30, successRate: 75 },
    'merge-prs': { totalRuns: 2, durationMinutes: 1, untimedRuns: 1, successRate: null },
  }, error }
  workspace.metrics = incomplete
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(fault).toBeVisible()
  await expect(answers(page).locator('[data-key="g:fault"]')).toContainText('Faults')
  await expect(page.locator('[data-bell]')).toHaveText('1')
  await expect(page.locator('[data-bell]')).toHaveAttribute('data-tone', 'failed')
  await expect(row('repair-prs')).toContainText('unknown: some of its run records cannot be read')
  await expect(row('review-new-prs')).toContainText('75%')
  await expect(row('review-new-prs').locator('td.num').first()).toHaveText('12')
  await expect(row('merge-prs')).toContainText('+ 1 untimed')
  await press(fault, 'Show more')
  for (const detail of ['2026-11-13T00:00:00.000Z', 'repair-prs', 'totalRuns, durationMinutes, successRate', 'History row: 1436', 'a'.repeat(32), 'gap-call', 'invalid status']) await expect(fault).toContainText(detail)
  await page.mouse.move(1000, 600)
  const id = await fault.getAttribute('data-notice')
  const since = await fault.locator('time').getAttribute('datetime')
  const reads = workspace.metricsAsked!.length
  await page.clock.fastForward(61_000)
  await expect.poll(() => workspace.metricsAsked!.length).toBeGreaterThan(reads)
  await expect(fault).toHaveAttribute('data-notice', id!)
  await expect(fault.locator('time')).toHaveAttribute('datetime', since!)
  workspace.metricsFail = true
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('[data-ref="ov.behaviors"]')).toContainText('metrics refresh unavailable')
  await expect(fault).toHaveAttribute('data-notice', id!)
  workspace.metricsFail = false
  workspace.metrics = empty
  await page.locator('[data-ref="ov.filters"]').getByRole('button', { name: 'Previous day' }).click()
  await expect(row('repair-prs')).toContainText('no runs')
  await expect(fault).toHaveAttribute('data-notice', id!)
  await page.getByRole('navigation', { name: 'Poise' }).getByRole('link', { name: 'Board' }).click()
  await expect(page.locator('[data-bell]')).toHaveText('1')
  workspace.metrics = incomplete
  await page.getByRole('navigation', { name: 'Poise' }).getByRole('link', { name: 'Overview' }).click()
  await expect(fault).toHaveAttribute('data-notice', id!)
  workspace.metrics = empty
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(row('repair-prs')).toContainText('no runs')
  await expect(fault).toHaveCount(0)
  await expect(page.locator('[data-bell]')).toHaveText('0')
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
