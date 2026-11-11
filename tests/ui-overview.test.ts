import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTICE_KINDS, LOCAL_NOTICE_KINDS, type Notice } from '../src/notices'
import type { NotificationItem } from '../src/notification-items'
import { bellTally, DEFAULT_LEVEL, LEVEL_KEY, noticeGroup, readLevel, saveLevel, setAnswerGroups, shownAt, tally } from '../src/ui/places/overview/level'
import { chatOpening, diagnosticHref, itemOf, journalStep, targetOpening, timelineHref } from '../src/ui/places/overview/targets'
import { chatState, countStates, issueState, pullState, taskPhase, taskState, type ChainLike } from '../src/ui/places/overview/states'
import { decisionEntries, foldWaiting, itemEntries, ordered, requestEntries, requestsFrom, type OpenRequest } from '../src/ui/places/overview/entries'
import { countPair, moveTile, tileOrder } from '../src/ui/places/overview/day'
import type { AnalyticsReport } from '../src/analytics-format'

// Overview's pure mappings (#556, PRD Support → Tests): the level, where a
// notice's target opens, and the work in the seven states. No page, no server.

const memory = new Map<string, string>()
beforeEach(() => {
  memory.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => { memory.set(key, String(value)) },
    removeItem: (key: string) => { memory.delete(key) },
  }
})
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
  setAnswerGroups(null)
})

const notice = (kind: Notice['kind'], extra: Partial<Notice> = {}): Notice => ({
  id: `${kind}:1`, kind, title: `${kind} title`, body: `${kind} body`, since: '2026-11-11T08:00:00Z', due: '2026-11-11T08:00:00Z', silenceable: false, target: null, ...extra,
})

describe('the level', () => {
  it('opens on + Done, keeps a choice, and refuses what is not a level', () => {
    expect(readLevel()).toBe(DEFAULT_LEVEL)
    saveLevel(0)
    expect(readLevel()).toBe(0)
    memory.set(LEVEL_KEY, '7')
    expect(readLevel()).toBe(DEFAULT_LEVEL)
    memory.set(LEVEL_KEY, 'not json')
    expect(readLevel()).toBe(DEFAULT_LEVEL)
  })

  it('includes each group before it', () => {
    expect(shownAt('needs-you', 0)).toBe(true)
    expect(shownAt('fault', 0)).toBe(false)
    expect(shownAt('fault', 1)).toBe(true)
    expect(shownAt('ready', 1)).toBe(false)
    expect(shownAt('auto', 2)).toBe(false)
    expect(shownAt('auto', 3)).toBe(true)
  })

  it('counts what the level shows, never what Poise handles on its own, in the most urgent colour', () => {
    const groups = ['needs-you', 'fault', 'ready', 'auto', 'auto'] as const
    expect(tally(groups, 0)).toEqual({ count: 1, tone: 'needs-you' })
    expect(tally(groups, 1)).toEqual({ count: 2, tone: 'failed' })
    expect(tally(groups, 2)).toEqual({ count: 3, tone: 'failed' })
    expect(tally(groups, 3)).toEqual({ count: 3, tone: 'failed' })
    expect(tally(['ready'], 2)).toEqual({ count: 1, tone: 'done' })
    expect(tally(['ready'], 1)).toEqual({ count: 0, tone: '' })
    expect(tally([], 3)).toEqual({ count: 0, tone: '' })
  })

  it('groups every notice kind by who acts, as #556 maps them', () => {
    for (const kind of [...NOTICE_KINDS, ...LOCAL_NOTICE_KINDS]) expect(['needs-you', 'fault', 'ready']).toContain(noticeGroup(kind))
    expect(noticeGroup('pr_ready')).toBe('needs-you')
    expect(noticeGroup('github_quota_warning')).toBe('needs-you')
    expect(noticeGroup('github_quota_exhausted')).toBe('fault')
    expect(noticeGroup('ledger_capture_loss')).toBe('fault')
    expect(noticeGroup('read_failed')).toBe('fault')
    expect(noticeGroup('chat_turn_finished')).toBe('ready')
  })

  it('has the bell count the notices elsewhere, and Overview’s own entries while it is mounted', () => {
    const notices = [notice('pr_ready'), notice('chat_turn_finished'), notice('ledger_queue_stalled')]
    expect(bellTally(notices)).toEqual({ count: 3, tone: 'failed' })
    saveLevel(0)
    expect(bellTally(notices)).toEqual({ count: 1, tone: 'needs-you' })
    setAnswerGroups(() => ['needs-you', 'needs-you', 'needs-you'])
    expect(bellTally(notices)).toEqual({ count: 3, tone: 'needs-you' })
  })
})

describe('where a notice’s target opens in the new places', () => {
  it('maps each of classic’s targets with a route back to Overview', () => {
    expect(targetOpening({ view: 'behaviors' })).toEqual({ href: '?view=settings&settings=behaviors&back=overview', label: 'Open Settings, Behaviors' })
    expect(targetOpening({ swarm: 'call-1' })).toEqual({ href: '?view=observe&part=behaviors&call=call-1&back=overview', label: 'Open the run in Observe' })
    expect(targetOpening({ settings: 'general' }).href).toBe('?view=settings&settings=general&back=overview')
    expect(targetOpening({ settings: 'accounts' })).toEqual({ href: '?view=settings&settings=accounts&back=overview', label: 'Open Settings, Accounts' })
    expect(targetOpening({ chat: 's1' })).toEqual({ href: '?view=chat&chat=s1&back=overview', label: 'Open the chat' })
    expect(targetOpening({ pullRequest: 'https://github.com/acme/site/pull/14' })).toEqual({ href: '?view=board&item=acme%2Fsite%2314&back=overview', label: 'Open its card on Board' })
  })

  it('opens a worker and the Manager in the Manager place', () => {
    expect(targetOpening({ chat: 'w1' }, () => 'worker').href).toBe('?view=manager&peek=w1&back=overview')
    expect(chatOpening('m1', 'manager').href).toBe('?view=manager&back=overview')
  })

  it('names the exact diagnostic, interval included, and a chain’s timeline at its step', () => {
    const ref = { eventId: 'evt_1', incidentId: 'inc_1', from: '2026-11-10T00:00:00Z', to: '2026-11-11T00:00:00Z' }
    expect(Object.fromEntries(new URLSearchParams(diagnosticHref(ref)))).toEqual({ view: 'observe', part: 'logging', event: 'evt_1', from: ref.from, to: ref.to, back: 'overview' })
    expect(timelineHref('c502', 38)).toBe('?view=observe&part=tasks&chain=c502&after=38&back=overview')
    expect(journalStep('/api/behavior-chains?id=c502&after=38')).toEqual({ chain: 'c502', after: 38 })
    expect(journalStep('/api/behavior-chains?after=1')).toBeNull()
    expect(itemOf('https://github.com/acme/site/issues/7')).toBe('acme/site#7')
    expect(itemOf('https://example.com/acme/site/pull/7')).toBeNull()
  })
})

describe('the work in the seven states', () => {
  it('maps a chat session as #556’s table does', () => {
    expect(chatState({ status: 'starting' })).toEqual({ state: 'running', note: 'Starting' })
    expect(chatState({ status: 'running' }).state).toBe('running')
    expect(chatState({ status: 'stopping' })).toEqual({ state: 'running', note: 'Stopping…' })
    expect(chatState({ status: 'waiting', pendingRequests: ['a', 'b'] })).toEqual({ state: 'needs-you', note: '2 requests wait for you' })
    expect(chatState({ status: 'queued', queuedBehind: 'waiting for a free agent slot' })).toEqual({ state: 'waiting', note: 'waiting for a free agent slot' })
    expect(chatState({ status: 'interrupted' }).state).toBe('needs-you')
    expect(chatState({ status: 'idle' }).state).toBe('idle')
    expect(chatState({ status: 'closed' })).toEqual({ state: 'idle', note: 'Closed' })
    expect(chatState({ status: 'error' }).state).toBe('failed')
    expect(chatState({ status: 'idle', role: 'worker', stall: { repos: [{}, {}] } })).toEqual({ state: 'blocked', note: 'left work behind in 2 repositories' })
    // A chat that is not a worker keeps its own state.
    expect(chatState({ status: 'idle', stall: { repos: [{}] } }).state).toBe('idle')
  })

  const chain = (extra: Partial<ChainLike> = {}): ChainLike => ({
    id: 'c1', repository: 'acme/site', issue: 7, pullNumber: null, held: null, waiting: null, mergeSha: null, supersession: null, reviewPending: null, invocations: [], ...extra,
  })
  it('maps a task from the chain’s journal, with its phase and round', () => {
    expect(taskPhase(chain())).toEqual({ phase: 'Intake', round: null })
    expect(taskState(chain({ invocations: [{ behavior: 'implement-issue', state: 'started', outcome: null }] }))).toEqual({ state: 'running', note: 'Implementation' })
    const repairing = chain({ invocations: [{ behavior: 'repair-pr', state: 'settled', outcome: 'x' }, { behavior: 'review-pr', state: 'settled', outcome: 'x' }, { behavior: 'repair-pr', state: 'started', outcome: null }] })
    expect(taskPhase(repairing)).toEqual({ phase: 'Repair', round: 2 })
    expect(taskState(repairing)).toEqual({ state: 'running', note: 'Repair · round 2' })
    expect(taskState(chain({ held: 'Removed from the merge queue by hand' }))).toEqual({ state: 'needs-you', note: 'Removed from the merge queue by hand' })
    expect(taskState(chain({ invocations: [{ behavior: 'review-pr', state: 'uncertain', outcome: 'a reply may have posted' }] })).state).toBe('blocked')
    expect(taskState(chain({ waiting: 'waiting for memory' }))).toEqual({ state: 'waiting', note: 'waiting for memory' })
    expect(taskState(chain({ mergeSha: 'abc' }))).toEqual({ state: 'done', note: 'Merged' })
    expect(taskState(chain({ mergeSha: 'abc', reviewPending: true })).state).toBe('waiting')
    expect(taskState(chain({ supersession: { by: 1 } }))).toEqual({ state: 'done', note: 'Superseded' })
  })

  it('maps a pull request and an issue as Board shows them', () => {
    expect(pullState({})).toBeNull()
    expect(pullState({ status: 'green' })).toEqual({ state: 'needs-you', note: 'Ready to merge' })
    expect(pullState({ status: 'yellow', reasons: ['checks_running'] })?.state).toBe('waiting')
    expect(pullState({ status: 'yellow', reasons: ['checks_failing'], failing: ['lint', 'e2e'] })).toEqual({ state: 'failed', note: 'failing: lint, e2e' })
    expect(pullState({ status: 'yellow', reasons: ['changes_requested'] })?.state).toBe('needs-you')
    expect(pullState({ status: 'yellow', reasons: ['conflict'] })?.state).toBe('blocked')
    expect(pullState({ status: 'yellow', reasons: ['draft'] })).toEqual({ state: 'idle', note: 'Draft' })
    expect(pullState({ status: 'yellow', reasons: ['unknown'], running: true })?.state).toBe('running')
    expect(pullState({ status: 'yellow', reasons: [] })?.state).toBe('idle')
    expect(issueState({ running: true }).state).toBe('running')
    expect(issueState({}).state).toBe('idle')
    expect(countStates([{ state: 'idle' }, { state: 'idle' }, { state: 'failed' }])).toMatchObject({ idle: 2, failed: 1, running: 0 })
  })
})

describe('Answer here’s entries', () => {
  const role = (chat: string) => (chat === 'w1' ? 'worker' : null)
  const request = (extra: Partial<OpenRequest>): OpenRequest => ({ id: 'r1', kind: 'permission', sessionId: 's1', sessionTitle: 'Muse', createdAt: '2026-11-11T08:00:00Z', content: null, escalation: null, ...extra })

  it('reads only what it can draw', () => {
    expect(requestsFrom({ revision: 4, complete: true, requests: [request({}), { id: 2 }] })?.requests).toHaveLength(1)
    expect(requestsFrom({ requests: [] })).toBeNull()
  })

  it('gives a permission its own options, in its order', () => {
    const [entry] = requestEntries([request({ content: { title: 'Run gh pr create', input: { command: 'gh pr create' }, options: [{ id: 'allow', name: 'Allow once', kind: 'allow_once' }, { id: 'deny', name: 'Deny', kind: 'reject_once' }] } })], role)
    expect(entry).toMatchObject({ id: 'request:r1', kind: 'Permission', title: 'Run gh pr create', group: 'needs-you', request: { kind: 'permission', sessionId: 's1' } })
    expect(entry.options.map((o) => [o.key, o.label])).toEqual([['allow', 'Allow once'], ['deny', 'Deny']])
    expect(entry.code).toContain('gh pr create')
  })

  it('answers one choice with a press, free text in your words, and several questions with Chat’s form', () => {
    const one = requestEntries([request({ kind: 'question', content: { questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false, freeText: true }] } })], role)[0]
    expect(one.options.map((o) => o.key)).toEqual(['A', 'B'])
    expect(one.freeText?.label).toBe('Something else…')
    expect(one.questions).toBeUndefined()
    const free = requestEntries([request({ kind: 'question', content: { questions: [{ id: 'q', question: 'Why?', options: [], multiSelect: false, freeText: true }] } })], role)[0]
    expect(free.options).toEqual([])
    expect(free.freeText?.label).toBe('Answer…')
    expect(free.request?.options).toEqual(['q'])
    const form = requestEntries([request({ kind: 'question', content: { questions: [{ id: 'a', question: 'Which?', options: [{ label: 'X' }], multiSelect: true, freeText: false }, { id: 'b', question: 'And?', options: [], multiSelect: false, freeText: true }] } })], role)[0]
    expect(form.questions?.map((q) => q.id)).toEqual(['a', 'b'])
    expect(form.title).toBe('2 questions')
    expect(requestEntries([request({ content: { title: 'broken' } })], role)).toEqual([])
  })

  it('folds a chat’s waiting notice into its request entries', () => {
    const items = [{ id: 'n1', group: 'needs', tone: 'blue', icon: 'chat', title: 'Muse is waiting', body: '', source: 'Chat', scope: null, when: null, meta: '', details: [], behaviors: [], notice: notice('chat_waiting', { id: 'n1', target: { chat: 's1' } }) } as NotificationItem]
    const asking = requestEntries([request({ content: { title: 'Run it', options: [{ id: 'a', name: 'Allow' }] } })], role)
    expect(foldWaiting([...itemEntries(items, role, new Map()), ...asking]).map((entry) => entry.id)).toEqual(['request:r1'])
    expect(foldWaiting(itemEntries(items, role, new Map())).map((entry) => entry.id)).toEqual(['notice:n1'])
  })

  it('offers Merge on a ready pull request, and groups by who acts', () => {
    const items = (['pr_ready', 'ledger_queue_stalled', 'chat_turn_finished'] as const).map((kind) => ({
      id: kind, group: 'needs', tone: 'amber', icon: 'merge', title: kind, body: '', source: 'GitHub', scope: null, when: null, meta: '', details: [], behaviors: [],
      notice: notice(kind, { id: kind, target: kind === 'pr_ready' ? { pullRequest: 'https://github.com/acme/site/pull/14' } : null }),
    }) as NotificationItem)
    const entries = itemEntries(items, role, new Map())
    expect(entries.map((entry) => entry.group)).toEqual(['needs-you', 'fault', 'ready'])
    expect(entries[0].options).toEqual([{ key: 'merge', label: 'Merge', primary: true }])
    expect(entries[0].pull).toEqual({ repo: 'acme/site', number: 14, url: 'https://github.com/acme/site/pull/14' })
    expect(entries[1].state).toBe('failed')
    expect(ordered([entries[2], entries[1], entries[0]]).map((entry) => entry.group)).toEqual(['needs-you', 'fault', 'ready'])
  })

  it('puts a decision’s recommendation first, with Something else…', () => {
    const [entry] = decisionEntries([
      { id: 3, kind: 'decision', text: 'Which filter wins?', detail: null, createdAt: '2026-11-11T08:00:00Z', source: { sessionId: 'w1', title: 'W3', exists: true }, options: [{ id: 'a', label: 'A', detail: null, recommended: false }, { id: 'b', label: 'B', detail: null, recommended: true }] },
      { id: 4, kind: 'decision', text: 'Answered', detail: null, createdAt: '2026-11-11T08:00:00Z', source: { sessionId: 'w1', title: 'W3', exists: true }, answer: { label: 'A', freeText: false, at: '2026-11-11T08:01:00Z', relay: 'delivered' } },
    ], role)
    expect(entry.options.map((o) => o.key)).toEqual(['b', 'a'])
    expect(entry.freeText?.label).toBe('Something else…')
    expect(entry.open?.href).toBe('?view=manager&peek=w1&back=overview')
  })
})

describe('the day’s tiles', () => {
  it('keeps the remembered order, and moves a tile within it', () => {
    const labels = ['A', 'B', 'C', 'D']
    expect(tileOrder(['C', 'gone', 'A'], labels)).toEqual(['C', 'A', 'B', 'D'])
    expect(tileOrder('broken', labels)).toEqual(labels)
    expect(moveTile(labels, 'A', 1)).toEqual(['B', 'A', 'C', 'D'])
    expect(moveTile(labels, 'D', 4)).toEqual(labels)
    expect(moveTile(labels, 'C', -4)).toEqual(['C', 'A', 'B', 'D'])
  })

  it('compares a count with typical by now, and has nothing to say without seven known days', () => {
    const pr = { opened: 4, closedUnmerged: 0, merged: 2, mergedByAgent: 1, firstReview: { count: 0, medianMs: null }, commentsPerPr: null, lines: { total: 10, median: 5, counted: 2 }, behaviors: { perPr: null, approvals: 0, reviews: 0, changesRequested: 0 }, averageTimeToMergeMs: null, medianTimeToMergeMs: null }
    const report: AnalyticsReport = { window: { since: null, until: null }, agentAccount: null, issues: { opened: 3, closed: 1 }, pullRequests: pr, errors: [] }
    const baseline: AnalyticsReport = { ...report, daily: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ issues: { opened: n, closed: 0 }, pullRequests: pr })) }
    expect(countPair('Issues opened', report, baseline, 0.5)).toEqual({ current: 3, typical: 2 })
    expect(countPair('Issues opened', report, baseline, undefined)).toEqual({ current: 3, typical: 4 })
    expect(countPair('Time to merge', report, baseline, 0.5)).toBeNull()
    expect(countPair('Issues opened', report, report, 0.5)).toBeNull()
  })
})
