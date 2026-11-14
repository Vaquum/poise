import { expect, test, type Page, type Route } from '@playwright/test'
import { normalize, type LogEvent } from '../../gateway/src/diagnostics/contract'
import { gatewayDiagnostic } from '../../gateway/src/diagnostics/collectors'
import { callerDiagnostic, workspaceEnvelope } from '../../gateway/src/diagnostics/sources'

// Observe in the new interface (#556): Tasks with the chain's evidence,
// Behaviors, GitHub and Logging, on main's endpoints. The isolated server has
// no chains, runs, history or diagnostics, so each test serves them here.

const NOW = Date.now()
const minutes = (n: number) => n * 60_000
const iso = (at: number) => new Date(at).toISOString()
const hex = (length: number, seed: string) => seed.repeat(length).slice(0, length)
const eventId = (seed: string) => `evt_${hex(16, seed)}_${hex(64, seed)}`
const incidentId = (seed: string) => `inc_${hex(16, seed)}_${hex(64, seed)}`
const CALL = hex(32, 'c')

// ---------- The chain ----------
interface Invocation { id: string, behavior: string, state: string, callId?: string | null, model?: string | null, slot?: string | null, outcome?: string | null }
function chain(issue: number, over: Record<string, unknown> = {}, invocations: Invocation[] = []) {
  return { id: `acme/site#${issue}`, repository: 'acme/site', issue, branch: `poise/${issue}`, author: 'me', reviewer: 'bot', sequence: 400 + issue,
    held: null, waiting: null, mergeSha: null, supersession: null, reviewPending: null, reviewStatus: 'not-recorded',
    reconciliation: { nextObservationAt: null, waitingForOriginalResponse: false }, pullNumber: issue + 1, invocationCount: invocations.length,
    invocations: invocations.map((i) => ({ callId: null, model: 'Opus 5', slot: 'primary', outcome: null, admittedAt: NOW - minutes(30), nativeAction: null, evidence: null, ...i })), ...over }
}
const CHAINS = [
  chain(488, {}, [{ id: 'i488a', behavior: 'review-pr', state: 'started' }]),
  chain(493, { pullNumber: null, sequence: 260, waiting: 'exact-head CI is still running' }, [{ id: 'i493a', behavior: 'review-issue', state: 'settled', outcome: 'commented', callId: CALL }]),
  chain(495, {}, [{ id: 'i495a', behavior: 'repair-pr', state: 'uncertain', outcome: 'a reply may have posted' }]),
  chain(501, { held: 'queue removal requires a decision: manual (q86)' }, [{ id: 'i501a', behavior: 'merge-pr', state: 'settled', outcome: 'enqueued' }]),
]
const attention = (c: ReturnType<typeof chain>, progressAgo: number, blocker: string) => ({
  id: c.id, repository: c.repository, issue: c.issue, pullNumber: c.pullNumber, step: 'step', progressAt: NOW - progressAgo, ageMs: progressAgo, blocker,
  evidence: { state: 'fresh', checkedAt: NOW - minutes(2), gates: ['Head 2aa6f19', 'Required CI passed'] }, nextAction: 'Resolve the durable hold, then explicitly resume the chain',
  retryAt: null, reconciliation: { nextObservationAt: null, waitingForResourceRelease: false }, journal: `/api/behavior-chains?id=${encodeURIComponent(c.id)}&after=${c.sequence - 1}`,
})
// Served out of order: the page orders Needs attention by the oldest verified progress itself.
const ATTENTION = [attention(CHAINS[3], minutes(36), 'queue removal requires a decision'), attention(CHAINS[1], minutes(26 * 60), 'No verified progress for at least 24 hours'), attention(CHAINS[2], minutes(15), 'a reply may have posted')]
const JOURNAL = [
  { sequence: 100, at: NOW - minutes(26 * 60 + 30), type: 'chain.admitted' },
  { sequence: 130, at: NOW - minutes(26 * 60 + 20), type: 'chain.observed' },
  { sequence: 160, at: NOW - minutes(26 * 60), type: 'invocation.settled', invocationId: 'i493a', outcome: 'commented', callId: CALL },
  ...Array.from({ length: 6 }, (_, i) => ({ sequence: 190 + i * 10, at: NOW - minutes(60 - i), type: 'chain.observed' })),
  { sequence: 260, at: NOW - minutes(20), type: 'chain.waiting', reason: 'exact-head CI is still running' },
]

interface Served {
  chainsFail?: boolean, posts?: unknown[], diagnostics?: ReturnType<typeof diagnostic>[],
  chains?: typeof CHAINS, attention?: typeof ATTENTION, next?: string, capacity?: Record<string, unknown> | null
}
async function serveChains(page: Page, served: Served = {}): Promise<void> {
  await page.route((url) => url.pathname === '/api/behavior-chains', async (route: Route) => {
    const url = new URL(route.request().url())
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { id: string, operation: string }
      served.posts?.push(body)
      const held = CHAINS.find((c) => c.id === body.id)!
      return route.fulfill({ json: { chain: { ...held, held: body.operation === 'hold' ? 'New invocations held by the person' : null, sequence: held.sequence + 1 } } })
    }
    if (served.chainsFail) return route.fulfill({ status: 502, json: { error: 'GitHub returned 502 reading the journal' } })
    if (url.searchParams.get('batch') === '1') {
      return route.fulfill({ json: { impacts: url.searchParams.getAll('callId').map((call) => call === CALL ? {
        impact: 'blocked', recovered: false, invocationId: 'i495a', repository: 'acme/site', behavior: 'repair-pr', callerBehavior: null,
        stage: 'repair-pr: uncertain', target: 'acme/site#496', progressAt: NOW - minutes(15), retryAt: null,
        nextAction: 'Reconcile the original invocation receipt before retrying', journal: '/api/behavior-chains?id=acme%2Fsite%23493&after=159',
      } : null) } })
    }
    const chains = served.chains ?? CHAINS
    const meta = { cutover: { sequence: 1, mode: 'v2', requestedAt: null, legacyPulls: ['acme/site#471'], support: { status: 'supported', error: null }, blockers: [] },
      settings: { enabled: true, seedMode: 'label', label: 'poise' }, runtime: [],
      capacity: served.capacity !== undefined ? served.capacity : { status: 'available', error: null, modelInvocationLimit: 8,
        reservedModelInvocations: 3, retainedModelInvocations: 1, mode: 'v2', enabled: true, intake: { seedMode: 'label', label: 'poise' } } }
    const id = url.searchParams.get('id')
    if (id) {
      const after = Number(url.searchParams.get('after') ?? 0)
      const events = (id === 'acme/site#493' ? JOURNAL : []).filter((e) => e.sequence > after).slice(0, 20)
      return route.fulfill({ json: { chain: chains.find((c) => c.id === id) ?? null, events, next: events.length === 20 ? events[19].sequence : null, ...meta } })
    }
    return route.fulfill({ json: { chains: served.next ? chains.slice(0, 1) : chains, next: served.next ?? null, attention: served.attention ?? ATTENTION, ...meta } })
  })
}

// ---------- Logging ----------
function diagnostic(seed: string, over: Record<string, unknown> = {}): LogEvent & { occurrences: number } {
  return { version: 1, id: eventId(seed), incidentId: incidentId(seed), severity: 'error', visibility: 'workspace', source: 'poise', sourceLevel: 'error',
    component: 'behavior-chain', operation: 'repair', phase: null, target: 'acme/site#496', workspace: 'local', instance: null, container: null, release: null,
    account: null, repository: 'acme/site', pr: '496', behavior: null, reviewer: null, callId: null, requestId: null, correlationId: null,
    message: `Repair could not prove its reply (${seed})`, cause: [], stderr: null, stack: null, context: {}, resources: {}, truncated: false,
    eventTime: iso(NOW - minutes(15)), ingestedAt: iso(NOW - minutes(14)), exitCode: null, signal: null, errno: null, timeoutMs: null, occurrences: 1, ...over }
}
const LINKED = diagnostic('a', { callId: CALL })
const OTHER = diagnostic('b', { severity: 'warning', message: 'Quota forecast is close to its limit', eventTime: iso(NOW - minutes(50)) })
const bounds = { retentionAfter: iso(NOW - minutes(60 * 24 * 14)), from: iso(NOW - minutes(60 * 24)), to: iso(NOW) }
const policy = { retentionMs: 1_209_600_000, maxBytes: 1_000_000, maxEvents: 100_000 }

async function serveLogging(page: Page, queries: URLSearchParams[] = [], records = [LINKED, OTHER]): Promise<void> {
  await page.route((url) => url.pathname === '/api/workspace', (route) => route.fulfill({ json: { mode: 'local' } }))
  await page.route((url) => url.pathname.startsWith('/api/logging'), (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/logging/health') {
      return route.fulfill({ json: { version: 1, status: 'connected', collection: { status: 'connected', checkedAt: iso(NOW), sources: [], lossObserved: false }, query: { status: 'connected' }, policy } })
    }
    if (url.pathname.startsWith('/api/logging/events/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop()!)
      const event = records.find((record) => record.id === id)
      return event ? route.fulfill({ json: { version: 1, event, bounds } }) : route.fulfill({ status: 404, json: { error: 'logging_event_unavailable', message: 'No permitted retained evidence.' } })
    }
    queries.push(url.searchParams)
    const incident = url.searchParams.get('incidentId')
    const events = url.searchParams.has('after') ? [] : incident ? records.filter((e) => e.incidentId === incident) : records
    return route.fulfill({ json: { version: 1, countKind: 'events', total: events.length, events, coverage: [], bounds, policy, watermark: 'w1', nextCursor: null } })
  })
}

// ---------- Runs and history ----------
function run(id: string, over: Record<string, unknown> = {}) {
  return { id, pr_id: '488', repo: 'acme/site', actor: 'bot', model: 'Claude Code · Opus 5', behavior: 'pr_review', session_id: null, source: null, prompt: '',
    started_at: iso(NOW - minutes(40)).slice(0, 19), started_at_precise: iso(NOW - minutes(40)), completed_at: iso(NOW - minutes(37)), time_elapsed: '3m 2s',
    status: 'completed', outcome: 'approved', response: null, error: '', ...over }
}
const RUNS = [
  run(hex(32, 'd'), { status: 'running', completed_at: null, outcome: null, started_at_precise: iso(NOW - minutes(2)) }),
  run(CALL, { pr_id: '493', behavior: 'issue_review', outcome: 'commented', response: 'Posted two comments.' }),
  run(hex(32, 'e'), { model: 'native-action', behavior: 'native_action', prompt: '--merge-if-ready', outcome: null, pr_id: '502' }),
  ...['f', '9'].map(seed => run(hex(32, seed), { behavior: 'issue_review', status: 'failed', outcome: 'preflight_failed',
    error_code: 'issue_revision_changed', action: 'not_started', error: 'seed issue changed during review; no comments posted',
    receipts: seed === 'f' ? null : [] })),
]
async function serveRuns(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/api/agent-logs', (route) => {
    const url = new URL(route.request().url())
    const id = url.searchParams.get('id')
    const logs = id ? RUNS.filter((r) => r.id === id) : url.searchParams.get('status') === 'running' ? RUNS.filter((r) => r.status === 'running') : RUNS
    return route.fulfill({ json: { logs, quarantined: [], total: logs.length, nextCursor: null } })
  })
  await page.route((url) => url.pathname === '/api/behavior-estimates', (route) => route.fulfill({ json: { estimates: [] } }))
  await page.route((url) => url.pathname.startsWith('/api/agent-response/'), (route) => route.fulfill({ json: { body: 'Posted two comments.' } }))
}
async function serveHistory(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/api/gh', (route) => {
    const body = route.request().postDataJSON() as { operation: string, record_type?: string, count_only?: boolean }
    const record = (kind: string, number: number, title: string, state: string) => ({ kind, repo: 'acme/site', number, title, url: `https://github.com/acme/site/${kind === 'pr' ? 'pull' : kind === 'issue' ? 'issues' : 'actions/runs'}/${number}`,
      author: 'me', state, owner_login: null, owner_avatar: null, updated_at: iso(NOW - minutes(number % 50)), merged_at: null, branch: kind === 'action' ? 'main' : undefined })
    const records = body.operation === 'actions' ? [record('action', 9121, 'CI · browser shard 3', 'failure')]
      : body.record_type === 'pull_request' ? [record('pr', 496, 'Settings: say which slot a place runs', 'open')] : [record('issue', 495, 'Settings: say which slot a place runs', 'open')]
    return route.fulfill({ json: body.count_only ? { count: records.length, errors: [] } : { records, count: records.length, errors: [] } })
  })
}

async function open(page: Page, address: string, served: Served = {}): Promise<void> {
  await page.route(/https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.abort())
  await page.route((url) => url.pathname === '/api/claude-auth', (route) => route.fulfill({ json: { status: 'authenticated', reason: null, checkedAt: null, verifiedAt: null, authMethod: null, subscriptionType: null, loginInProgress: false } }))
  await page.route((url) => url.pathname === '/api/notices', (route) => route.fulfill({ json: { enabled: true, notices: [] } }))
  await page.route((url) => url.pathname === '/api/settings', (route) => route.fulfill({ json: { org: 'acme', me: 'me', agentAccount: 'bot', timezone: 'UTC',
    organizations: ['acme', 'umbrella'].map((login) => ({ login, managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null })) } }))
  await serveChains(page, served)
  await serveLogging(page, [], served.diagnostics)
  await serveRuns(page)
  await serveHistory(page)
  await page.goto(address)
  await expect(page.locator('.obv-tabs')).toBeVisible()
}
const query = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams)
const tasks = (page: Page) => page.locator('[data-panel="tasks"]')
const logging = (page: Page) => page.locator('[data-panel="logging"]')

test('Needs attention lists held, unconfirmed and stalled tasks at once, oldest progress first, each saying how long', async ({ page }) => {
  await open(page, '/?view=observe&part=tasks')
  await expect(tasks(page).locator('[data-ref="tk.status"]')).toContainText('v2 owns new work · 3 of 8 model slots occupied across the workspace, shared with other heavy work · 1 retained for unresolved cleanup, awaiting original resource evidence')
  await expect(tasks(page).locator('[data-ref="tk.legacy"]')).toContainText('1 pull request kept by v1 at cutover')
  await expect(tasks(page).locator('.tk-row')).toHaveCount(4)
  await tasks(page).getByRole('button', { name: 'Needs attention 3' }).click()
  const rows = tasks(page).locator('.tk-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('acme/site#493')
  await expect(rows.nth(0)).toContainText('no verified advance for 1d 2h')
  await expect(rows.nth(1)).toContainText('acme/site#501 → #502')
  await expect(rows.nth(1)).toContainText('Needs you')
  await expect(rows.nth(2)).toContainText('acme/site#495')
  await expect(rows.nth(2)).toContainText('Blocked')
  await expect(rows.nth(2)).toContainText('Not confirmed: a reply may have posted')
  await rows.nth(1).click()
  const head = tasks(page).locator('[data-tk-head]')
  await expect(head.locator('[data-ref="tk.evidence"]')).toContainText('Last verified advance')
  await expect(head.locator('[data-ref="tk.evidence"]')).toContainText('Required CI passed')
  await expect(head.locator('[data-ref="side.hold"]')).toContainText('Queue removal requires a decision')
  expect(query(page).chain).toBe('acme/site#501')
})

test('retained capacity stays workspace-wide beyond page one and attention opens its original evidence', async ({ page }) => {
  const retained = chain(999, { pullNumber: null, held: 'original cleanup handle missing' }, [
    { id: 'retained', behavior: 'implement-issue', state: 'uncertain', outcome: 'original resource release unverified' },
  ])
  const released = chain(998, { held: 'original publication receipt missing' }, [
    { id: 'released', behavior: 'implement-issue', state: 'uncertain', outcome: 'original publication receipt missing' },
  ])
  const pending = attention(retained, minutes(30), 'original cleanup handle missing; original resource release unverified')
  pending.nextAction = 'Reconcile the original invocation receipt before any retry'
  await open(page, '/?view=observe&part=tasks', { chains: [CHAINS[0], released, retained], next: CHAINS[0].id,
    attention: [attention(released, minutes(20), 'original publication receipt missing'), pending],
    capacity: { status: 'available', modelInvocationLimit: 8, reservedModelInvocations: 2, retainedModelInvocations: 1 } })
  const status = tasks(page).locator('[data-ref="tk.status"]')
  await expect(tasks(page).locator('.tk-row')).toHaveCount(1)
  await expect(status).toContainText('2 of 8 model slots occupied across the workspace')
  await expect(status).toContainText('1 retained for unresolved cleanup, awaiting original resource evidence')
  await page.locator('[data-menu="obv-org-menu"]').click()
  await page.locator('#obv-org-menu [data-org="umbrella"]').click()
  await expect(tasks(page).locator('.tk-row')).toHaveCount(0)
  await expect(status).toContainText('2 of 8 model slots occupied across the workspace')
  await expect(status).toContainText('1 retained for unresolved cleanup')
  await page.locator('[data-menu="obv-org-menu"]').click()
  await page.locator('#obv-org-menu [data-org=""]').click()
  await tasks(page).getByRole('button', { name: 'Needs attention 2' }).click()
  await expect(tasks(page).locator('.tk-row')).toHaveCount(2)
  await tasks(page).locator('.tk-row').filter({ hasText: 'acme/site#999' }).click()
  await expect(tasks(page).locator('[data-ref="tk.evidence"]')).toContainText(pending.blocker)
  await expect(tasks(page).locator('[data-ref="tk.evidence"]')).toContainText(pending.nextAction)
  await expect(tasks(page).locator('[data-ref="side.timeline"]')).toBeVisible()
  expect(query(page).chain).toBe(retained.id)
  await expect(status).toContainText('1 retained for unresolved cleanup')
})

for (const [label, capacity] of [
  ['absent', null],
  ['unavailable', { status: 'unavailable', error: 'journal unavailable', reservedModelInvocations: null, retainedModelInvocations: null }],
  ['missing retained count', { status: 'available', modelInvocationLimit: 8, reservedModelInvocations: 3 }],
] as const) {
  test(`capacity evidence is unknown when ${label}`, async ({ page }) => {
    await open(page, '/?view=observe&part=tasks', { capacity })
    const status = tasks(page).locator('[data-ref="tk.status"]')
    await expect(status).toContainText('retained cleanup count unknown')
    await expect(status).not.toContainText('0 retained')
    if (label !== 'missing retained count') await expect(status).toContainText('model capacity unavailable')
  })
}

test('a notice’s journal link opens the task’s timeline at its step, newest first, with Resume where the hold is', async ({ page }) => {
  const posts: unknown[] = []
  await open(page, '/?view=logging&chain=acme%2Fsite%23493&after=159', { posts })
  expect(query(page)).toMatchObject({ view: 'observe', part: 'tasks', chain: 'acme/site#493', after: '159' })
  const timeline = tasks(page).locator('[data-ref="side.timeline"]')
  await expect(timeline).toBeVisible()
  const from = timeline.locator('[data-ref="tk.from"]')
  await expect(from).toContainText('Issue review settled: commented')
  await expect(from.getByRole('link', { name: /^run cccccccc/ })).toHaveAttribute('href', `?view=observe&part=behaviors&call=${CALL}`)
  // Newest first: the wait is above the step, and the observations between them fold into one line.
  await expect(timeline.locator('li').first()).toContainText('Waiting: CI is still running on its head')
  await expect(timeline.locator('[data-ref="tk.observed"]')).toContainText('×6')
  await expect(tasks(page).getByRole('button', { name: 'Later events' })).toBeHidden()
  await expect(tasks(page).getByRole('button', { name: 'More events' })).toBeVisible()
  await tasks(page).getByRole('button', { name: 'More events' }).click()
  await expect(timeline.locator('li').last()).toContainText('Entered the chain')

  await tasks(page).locator('.tk-row', { hasText: 'acme/site#501' }).click()
  await tasks(page).getByRole('button', { name: 'Resume' }).click()
  await expect(tasks(page).locator('.tk-act-note')).toContainText('Resumed.')
  expect(posts).toEqual([{ id: 'acme/site#501', sequence: 901, operation: 'resume' }])
})

test('completed merged tasks retain unmet native clearance and separately identify the later GitHub approval', async ({ page }) => {
  await open(page, '/?view=observe&part=tasks')
  const head = 'a'.repeat(40)
  const completed = chain(1635, { mergeSha: 'c'.repeat(40), reviewPending: false, reviewStatus: 'complete', invocationCount: 22,
    mergedReviewWarning: { head, reviews: [{ id: 91, head, submittedAt: NOW - 7000,
      url: 'https://github.com/acme/site/pull/1636#pullrequestreview-91',
      verdict: 'Changes requested: retain the original native review clearance after merge.' }],
    githubApproval: { id: 93, head, submittedAt: NOW - 4000, url: 'https://github.com/acme/site/pull/1636#pullrequestreview-93', client: 'unknown' } } })
  const writes: string[] = []
  await page.route(url => url.pathname === '/api/behavior-chains', route => {
    if (route.request().method() !== 'GET') writes.push(route.request().method())
    const id = new URL(route.request().url()).searchParams.get('id')
    return route.fulfill({ json: id ? { chain: completed, events: [], next: null }
      : { chains: [completed], attention: [], next: null, cutover: { mode: 'v2', legacyPulls: [] } } })
  })
  await page.goto('/?view=observe&part=tasks&which=merged')
  const row = tasks(page).locator('.tk-row')
  await expect(row).toContainText('Merged as ccccccc · native review clearance unmet')
  await row.click()
  const evidence = tasks(page).locator('[data-ref="tk.evidence"]')
  await expect(evidence).toContainText(`Unmet at merge on head ${head}`)
  await expect(evidence).toContainText('Changes requested: retain the original native review clearance after merge.')
  await expect(evidence.getByRole('link', { name: 'Changes requested', exact: true })).toHaveAttribute('href', 'https://github.com/acme/site/pull/1636#pullrequestreview-91')
  await expect(evidence.getByRole('link', { name: 'Review #93' })).toHaveAttribute('href', 'https://github.com/acme/site/pull/1636#pullrequestreview-93')
  await expect(evidence).toContainText(`submitted ${iso(NOW - 4000)} · submitting client unknown`)
  await expect(tasks(page).getByRole('button', { name: /Hold new invocations|Resume/ })).toHaveCount(0)
  await page.reload()
  await expect(tasks(page).locator('[data-ref="tk.evidence"]')).toContainText('Native review clearance')
  expect(writes).toEqual([])
})

test('a settlement link names original review completion and keeps the earlier merge and run links', async ({ page }) => {
  await open(page, '/?view=observe&part=tasks')
  const completed = chain(1564, { sequence: 21, mergeSha: 'd'.repeat(40), reviewPending: false, reviewStatus: 'complete' })
  const events = [
    { sequence: 20, at: NOW - 1324, type: 'chain.merged', callId: CALL, evidence: { review_complete: false } },
    { sequence: 21, at: NOW - 1000, type: 'chain.merged', callId: CALL, evidence: { review_complete: true } },
  ]
  await page.route(url => url.pathname === '/api/behavior-chains' && url.searchParams.get('id') === completed.id, route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0)
    return route.fulfill({ json: { chain: completed, events: events.filter(event => event.sequence > after), next: null } })
  })
  await page.goto('/?view=observe&part=tasks&chain=acme%2Fsite%231564&after=20')
  const timeline = tasks(page).locator('[data-ref="side.timeline"]')
  await expect(timeline.locator('li')).toHaveCount(1)
  await expect(timeline.locator('[data-ref="tk.from"]')).toContainText('Original review evidence complete')
  await expect(timeline.getByRole('link', { name: /^run cccccccc/ })).toHaveAttribute('href', `?view=observe&part=behaviors&call=${CALL}`)
  await tasks(page).getByRole('button', { name: 'More events' }).click()
  await expect(timeline.locator('li')).toHaveCount(2)
  await expect(timeline.locator('li').first()).toContainText('Original review evidence complete')
  await expect(timeline.locator('li').last()).toContainText('Event Merged')
  await expect(timeline.getByRole('link', { name: /^run cccccccc/ })).toHaveCount(2)
  await expect(tasks(page).locator('[data-tk-head]').getByRole('link', { name: '#1565', exact: true })).toHaveAttribute('href', 'https://github.com/acme/site/pull/1565')
})

test('a failed read keeps what was read, says when, and stops Hold and Resume until a read succeeds', async ({ page }) => {
  const served: Served = {}
  await open(page, '/?view=observe&part=tasks&chain=acme%2Fsite%23488', served)
  const hold = tasks(page).getByRole('button', { name: 'Hold new invocations' })
  await expect(hold).toBeEnabled()
  await expect(hold).not.toHaveAttribute('aria-disabled', 'true')
  served.chainsFail = true
  await page.evaluate(() => dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(tasks(page).locator('[data-ref="tk.status"]')).toContainText('Tasks could not be refreshed: GitHub returned 502 reading the journal. Showing what was read at')
  await expect(tasks(page).locator('.tk-row')).toHaveCount(4)
  await expect(hold).toHaveAttribute('aria-disabled', 'true')
  served.chainsFail = false
  await page.evaluate(() => dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(tasks(page).locator('[data-ref="tk.status"]')).toContainText('v2 owns new work')
  await expect(hold).not.toHaveAttribute('aria-disabled', 'true')
})

test('Logging’s entry addresses open the exact diagnostic, an incident or say the link is invalid', async ({ page }) => {
  const from = iso(NOW - minutes(30)), to = iso(NOW)
  await open(page, `/?view=logging&event=${LINKED.id}&from=${from}&to=${to}`)
  expect(query(page)).toMatchObject({ view: 'observe', part: 'logging', event: LINKED.id, from, to })
  await expect(logging(page).locator('[data-ref="lg.linked"]')).toContainText('Linked diagnostic.')
  await expect(logging(page).locator(`tr[data-ev="${LINKED.id}"]`)).toHaveClass(/is-linked/)
  await expect(logging(page).locator(`#lg-detail-${LINKED.id}`)).toBeVisible()

  await page.goto(`/?view=logging&incident=${LINKED.incidentId}`)
  await expect(logging(page).locator('[data-ref="lg.linked"]')).toContainText('Linked diagnostic')
  await expect(logging(page).locator(`#lg-detail-${LINKED.id}`)).toBeVisible()

  await page.goto('/?view=logging&event=evt_nope')
  await expect(logging(page).locator('[data-ref="lg.linked"]')).toContainText('The diagnostic link is invalid.')
})

test('Logging shows workspace disk usage and budget in the existing Warning detail', async ({ page }) => {
  const event = normalize(gatewayDiagnostic('warn', 'disk.workspace.over_budget', {
    handle: 'local', bytes: 189628338659, budget: 53687091200,
  }), NOW)!
  await open(page, `/?view=observe&part=logging&event=${event.id}`, { diagnostics: [{ ...event, occurrences: 1 }] })
  const row = logging(page).locator(`tr[data-ev="${event.id}"]`)
  await expect(row.locator('[data-ref="lg.severity"]')).toHaveText('Warning')
  const detail = logging(page).locator(`#lg-detail-${event.id}`)
  await expect(detail).toBeVisible()
  const context = detail.locator('.lg-ev', { has: page.getByRole('heading', { name: 'Context · as recorded', exact: true }) }).locator('pre')
  await expect(context).toContainText('"bytes": 189628338659')
  await expect(context).toContainText('"budget": 53687091200')
})

test('Logging keeps review deadline group and budget causes in the existing event detail', async ({ page }) => {
  const cases = [
    { phase: 'overall', message: 'Review reached its total time limit; needs attention',
      cause: 'Incomplete analysis in file group 1 of 4: overall deadline; elapsed 1144.8s; remaining analysis 0.0s.' },
    { phase: 'file_group', message: 'Review file-group time limit reached; incomplete analysis; reduce the review scope',
      cause: 'Incomplete analysis in file group 2 of 4: file_group deadline; elapsed 60.0s; remaining analysis 78.4s.' },
    { phase: null, message: 'Review reached its total time limit; needs attention', cause: null },
  ]
  const records = cases.map(({ phase, message, cause }, index) => ({
    ...workspaceEnvelope(normalize(callerDiagnostic({ id: String(index + 1).repeat(32), status: 'failed', behavior: 'pr_review',
      completed_at: iso(NOW - minutes(15)), repo: 'acme/site', pr_id: '496', error: message,
      diagnostic: phase ? { version: 1, severity: 'error', operation: 'provider.review', phase, stderr: '',
        context: { message: cause + '\nAuthorization: Bearer private-review-credential' } } : null,
    }, 'local')!, NOW)!, 'local', NOW, []), occurrences: 1,
  }))
  await open(page, `/?view=observe&part=logging&event=${records[0].id}`, { diagnostics: records })
  await expect(logging(page).locator('[data-ref="lg.row"]')).toHaveCount(3)
  for (const [index, record] of records.entries()) {
    const row = logging(page).locator(`tr[data-ev="${record.id}"]`)
    await expect(row).toContainText(cases[index].message)
    await expect(row.locator('[data-ref="lg.severity"]')).toHaveText('Error')
    if (index) await row.getByRole('button', { name: 'Show the evidence' }).click()
    const detail = logging(page).locator(`#lg-detail-${record.id}`)
    await expect(detail).toBeVisible()
    const cause = detail.locator('.lg-ev', { has: page.getByRole('heading', { name: 'Cause chain', exact: true }) }).locator('pre')
    await expect(cause).toHaveText(cases[index].cause ? cases[index].cause + '\n[redacted header]' : 'Not recorded')
    await expect(detail.locator('[data-ref="lg.facts"] div').filter({ has: page.locator('dt', { hasText: /^Phase$/ }) }).locator('dd'))
      .toHaveText(cases[index].phase ?? 'Not recorded')
    await expect(detail).not.toContainText('private-review-credential')
  }
})

test('Logging’s Work impact shows on the row and in the detail, and opens its task at that step; Back returns with the interval and filters intact', async ({ page }) => {
  const saved = { component: '', workspace: '', account: '', repository: '', callId: '', correlationId: '', incidentId: '', columns: ['time', 'impact', 'severity', 'source', 'component', 'repository', 'target', 'message', 'occurrences'],
    severities: ['critical', 'error'], time: 'week', from: '', to: '', source: '', search: '', scope: 'workspace' }
  await page.addInitScript((value) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('poise-logging-filters', JSON.stringify(value)); sessionStorage.setItem('seeded', '1') } }, saved)
  const from = iso(NOW - minutes(40)), to = iso(NOW - minutes(5))
  await open(page, `/?view=observe&part=logging&event=${LINKED.id}&from=${from}&to=${to}&back=overview`)
  const row = logging(page).locator(`tr[data-ev="${LINKED.id}"]`)
  await expect(row.locator('[data-ref="lg.impact"]')).toHaveText('blocked · acme/site#496 · repair-pr: uncertain')
  await expect(logging(page).locator(`tr[data-ev="${OTHER.id}"] [data-ref="lg.impact"]`)).toHaveText('unknown')
  const impact = logging(page).locator(`#lg-detail-${LINKED.id} [data-ref="lg.workimpact"]`)
  await expect(impact).toContainText('Reconcile the original invocation receipt before retrying')
  const task = impact.getByRole('link', { name: 'Open its task at this step' })
  await expect(task).toHaveAttribute('href', '?view=observe&part=tasks&chain=acme%2Fsite%23493&after=159&back=overview')
  // The link's interval is applied, and the saved filters stay as they were.
  await expect(logging(page).locator('#lg-filter-button-time')).toHaveClass(/is-on/)
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('poise-logging-filters') ?? '{}'))).toMatchObject({ time: 'week', severities: ['critical', 'error'] })

  await task.click()
  await expect(tasks(page).locator('[data-ref="tk.from"]')).toContainText('Issue review settled')
  await expect(page.getByRole('link', { name: 'Back to Overview' })).toBeVisible()
  await page.goBack()
  expect(query(page)).toMatchObject({ part: 'logging', event: LINKED.id, from, to, back: 'overview' })
  await expect(logging(page).locator('[data-ref="lg.linked"]')).toContainText('Linked diagnostic.')
  await expect(logging(page).locator('#lg-filter-button-time')).toHaveClass(/is-on/)
  await logging(page).getByRole('button', { name: 'Restore saved filters' }).click()
  await expect(logging(page).locator('[data-ref="lg.linked"]')).toBeHidden()
  expect(query(page).event).toBeUndefined()
  await page.getByRole('link', { name: 'Back to Overview' }).click()
  expect(query(page).view).toBe('overview')
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('poise-logging-filters') ?? '{}'))).toMatchObject({ time: 'week', severities: ['critical', 'error'] })
})

test('a stale issue review shows supersession while uncertain posting remains a failure', async ({ page }) => {
  await open(page, '/?view=observe&part=behaviors')
  const behaviors = page.locator('[data-panel="behaviors"]')
  const stale = behaviors.locator(`tr[data-run="${hex(32, 'f')}"] [data-ref="bh.status"]`)
  await expect(stale).toContainText('Superseded')
  await expect(stale).toContainText('Issue changed')
  await expect(behaviors.locator(`tr[data-run="${hex(32, '9')}"] [data-ref="bh.status"]`)).toContainText('Failed · Preflight failed')
})

test('Logging shows confirmed handoffs as Warning while keeping an absent successor or current hold at Error', async ({ page }) => {
  await open(page, '/?view=observe&part=logging')
  const event = diagnostic('d', { source: 'caller', operation: 'provider.review.handoff', phase: 'analysis', callId: CALL,
    behavior: 'pr_review', context: { errorCode: 'review_budget_exhausted', submission: 'none' },
    message: 'Analysis time limit; handing off to the next model' })
  let impact: 'unknown' | 'retrying' | 'recovered' | 'blocked' = 'unknown'
  await page.route(url => url.pathname === '/api/logging', route => route.fulfill({ json: {
    version: 1, countKind: 'events', total: 1, events: [event], coverage: [], bounds, policy, watermark: 'w1', nextCursor: null,
  } }))
  await page.route(url => url.pathname === '/api/behavior-chains', route => {
    if (!new URL(route.request().url()).searchParams.has('batch')) return route.fallback()
    return route.fulfill({ json: { impacts: [{ impact, recovered: impact === 'recovered' || impact === 'blocked',
      invocationId: 'i495a', repository: 'acme/site', behavior: 'review-pr', callerBehavior: 'pr_review',
      stage: 'review-pr: started', target: 'acme/site#496', progressAt: NOW - minutes(15), retryAt: null,
      nextAction: impact === 'blocked' ? 'Resolve the hold: recovery exhausted' : 'Await the successor verdict',
      journal: '/api/behavior-chains?id=acme%2Fsite%23493&after=159' }] } })
  })
  for (const state of ['unknown', 'retrying', 'recovered', 'blocked'] as const) {
    impact = state
    await page.reload()
    const row = logging(page).locator(`tr[data-ev="${event.id}"]`)
    await expect(row.locator('[data-ref="lg.severity"]')).toHaveText(state === 'retrying' || state === 'recovered' ? 'Warning' : 'Error')
    await expect(row.locator('[data-ref="lg.impact"]')).toContainText(state)
  }
  await logging(page).locator(`tr[data-ev="${event.id}"]`).getByRole('button', { name: /evidence/i }).click()
  await expect(logging(page).locator(`#lg-detail-${event.id}`)).toContainText('Resolve the hold: recovery exhausted')
  await expect(logging(page).locator(`#lg-detail-${event.id} dt`).filter({ hasText: 'Source severity' }).locator('..')).toContainText('error')
})

test('a run link opens that run unfolded in Behaviors, and a chain’s own GitHub action names what it did with no model', async ({ page }) => {
  await open(page, `/?view=observe&part=behaviors&call=${CALL}`)
  const behaviors = page.locator('[data-panel="behaviors"]')
  const row = behaviors.locator(`tr[data-run="${CALL}"]`)
  await expect(row.locator('[data-ref="bh.status"]')).toContainText('Done · Commented')
  await expect(behaviors.locator(`tr[data-detail-for="${CALL}"]`)).toContainText('Posted two comments.')
  await expect(behaviors.locator(`tr[data-detail-for="${CALL}"]`).getByRole('link', { name: 'See it on Board' })).toHaveAttribute('href', '?view=board&item=acme%2Fsite%23493&back=observe')
  const native = behaviors.locator(`tr[data-run="${hex(32, 'e')}"]`)
  await expect(native.locator('[data-ref="bh.behavior"]')).toHaveText('Merge if ready')
  await expect(native.locator('[data-ref="bh.model"]')).toHaveText('—')
  // Stop asks Sure? first.
  const running = behaviors.locator(`tr[data-run="${hex(32, 'd')}"]`)
  await running.getByRole('button', { name: 'Stop this run' }).click()
  await expect(running.getByRole('button', { name: 'Confirm stopping this run' })).toHaveText('Sure?')
})

for (const state of ['unavailable', 'missing-file', 'incomplete']) {
  test(`a response-less run displays its response read as ${state}`, async ({ page }) => {
    await open(page, '/?view=observe&part=behaviors')
    const id = hex(32, 'd')
    await page.route(`/api/agent-response/${id}`, route => state === 'missing-file'
      ? route.fulfill({ status: 502, json: { error: 'promised response file is missing' } })
      : route.fulfill({ json: state === 'unavailable'
        ? { id, disposition: 'unavailable', reason: 'The Call is still running' } : {} }))
    const behaviors = page.locator('[data-panel="behaviors"]')
    await behaviors.locator(`tr[data-run="${id}"]`).getByRole('button', { name: 'Show detail' }).click()
    const detail = behaviors.locator(`tr[data-detail-for="${id}"]`)
    if (state === 'unavailable') {
      await expect(detail).toContainText('Unavailable: The Call is still running')
      await expect(detail.locator('.is-warn, .is-error')).toHaveCount(0)
      await expect(detail.getByRole('heading', { name: 'Error', exact: true })).toHaveCount(0)
    } else {
      await expect(detail.locator('.is-warn')).toContainText(state === 'missing-file'
        ? 'promised response file is missing' : 'the answer is incomplete')
    }
  })
}

test('a detail opened while running rereads its unavailable reason after the run ends without a response', async ({ page }) => {
  await open(page, '/?view=observe&part=behaviors')
  const id = hex(32, 'd')
  let reads = 0
  await page.route(`/api/agent-response/${id}`, route => route.fulfill({ json: ++reads === 1
    ? { id, disposition: 'unavailable', reason: 'The Call is still running' }
    : { id, disposition: 'unavailable', reason: 'The Call ended without a response' } }))
  const behaviors = page.locator('[data-panel="behaviors"]')
  await behaviors.locator(`tr[data-run="${id}"]`).getByRole('button', { name: 'Show detail' }).click()
  const detail = behaviors.locator(`tr[data-detail-for="${id}"]`)
  await expect(detail).toContainText('Unavailable: The Call is still running')
  const finished = { ...RUNS[0], status: 'completed', completed_at: iso(NOW - minutes(1)), outcome: 'approved', time_elapsed: '3m 1s' }
  await page.route((url) => url.pathname === '/api/agent-logs', route => {
    const url = new URL(route.request().url())
    const wanted = url.searchParams.get('id')
    const logs = wanted ? [finished].filter((r) => r.id === wanted)
      : url.searchParams.get('status') === 'running' ? [] : [finished, RUNS[1], RUNS[2]]
    return route.fulfill({ json: { logs, quarantined: [], total: logs.length, nextCursor: null } })
  })
  await page.evaluate(() => dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(detail).toContainText('Unavailable: The Call ended without a response')
  expect(reads).toBe(2)
})

test('a detail whose run ends while its response read is pending rereads without a second refresh', async ({ page }) => {
  await open(page, '/?view=observe&part=behaviors')
  const id = hex(32, 'd')
  let reads = 0
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  await page.route(`/api/agent-response/${id}`, async (route) => {
    reads += 1
    if (reads === 1) await firstGate
    return route.fulfill({ json: reads === 1
      ? { id, disposition: 'unavailable', reason: 'The Call is still running' }
      : { id, disposition: 'unavailable', reason: 'The Call ended without a response' } })
  })
  const behaviors = page.locator('[data-panel="behaviors"]')
  const row = behaviors.locator(`tr[data-run="${id}"]`)
  await row.getByRole('button', { name: 'Show detail' }).click()
  await expect.poll(() => reads).toBe(1)
  const finished = { ...RUNS[0], status: 'completed', completed_at: iso(NOW - minutes(1)), outcome: 'approved', time_elapsed: '3m 1s' }
  await page.route((url) => url.pathname === '/api/agent-logs', (route) => {
    const url = new URL(route.request().url())
    const wanted = url.searchParams.get('id')
    const logs = wanted ? [finished].filter((r) => r.id === wanted)
      : url.searchParams.get('status') === 'running' ? [] : [finished, RUNS[1], RUNS[2]]
    return route.fulfill({ json: { logs, quarantined: [], total: logs.length, nextCursor: null } })
  })
  await page.evaluate(() => dispatchEvent(new CustomEvent('poise:refresh-tick')))
  await expect(row.getByRole('button', { name: 'Stop this run' })).toHaveCount(0)
  releaseFirst()
  const detail = behaviors.locator(`tr[data-detail-for="${id}"]`)
  await expect(detail).toContainText('Unavailable: The Call ended without a response')
  expect(reads).toBe(2)
})

test('a GitHub link opens its row, widening the filters for that visit only', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('poise-observe-github', JSON.stringify({ types: ['action'], ci: 'failed', status: 'open', time: 'today' })) })
  await open(page, '/?view=observe&part=github&item=acme/site%23496')
  const github = page.locator('[data-panel="github"]')
  await expect(github.locator('tr[data-key="acme/site#496"]')).toBeVisible()
  await expect(github.locator('tr[data-key="acme/site#496"] [data-ref="gh.board"]')).toHaveAttribute('href', '?view=board&item=acme%2Fsite%23496&back=observe')
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('poise-observe-github') ?? '{}'))).toEqual({ types: ['action'], ci: 'failed', status: 'open', time: 'today' })
})

for (const width of [375, 768, 1000]) {
  test(`no part of Observe overflows the page at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await open(page, '/?view=observe&part=tasks&chain=acme%2Fsite%23493')
    for (const part of ['Tasks', 'Behaviors', 'GitHub', 'Logging']) {
      await page.getByRole('tab', { name: new RegExp(`^${part}`) }).click()
      await expect(page.locator(`[data-panel="${part.toLowerCase()}"]`)).toBeVisible()
      await page.waitForTimeout(150)
      const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)
      expect(overflow, `${part} at ${width}`).toBeLessThanOrEqual(0)
    }
    // The part chosen last is remembered when the address names none.
    await page.goto('/?view=observe')
    await expect(page.getByRole('tab', { name: /^Logging/ })).toHaveAttribute('aria-selected', 'true')
  })
}

test('System health’s coverage link opens Logging with Data and collection open', async ({ page }) => {
  await open(page, '/?view=observe&part=logging&data=1&back=overview')
  await expect(page.locator('#lg-data')).toBeVisible()
})

test('an organization the fresh settings no longer hold stops being read', async ({ page }) => {
  await open(page, '/?view=observe&part=tasks')
  await page.locator('[data-menu="obv-org-menu"]').click()
  await page.locator('#obv-org-menu [data-org="umbrella"]').click()
  await expect(page.locator('[data-org-label]')).toHaveText('umbrella')
  // umbrella is removed elsewhere; the reload opens on the remembered settings, then the fresh ones land.
  let release = () => {}
  const fresh = new Promise<void>((resolve) => { release = resolve })
  await page.route((url) => url.pathname === '/api/settings', async (route) => {
    await fresh
    return route.fulfill({ json: { org: 'acme', me: 'me', agentAccount: 'bot', timezone: 'UTC', organizations: [{ login: 'acme', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null }] } })
  })
  await page.reload()
  await expect(page.locator('[data-org-label]')).toHaveText('umbrella')
  release()
  await expect(page.locator('[data-org-label]')).toHaveText('All orgs')
})
