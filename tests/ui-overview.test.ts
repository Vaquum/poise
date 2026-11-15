import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTICE_KINDS, LOCAL_NOTICE_KINDS, type Notice } from '../src/notices'
import type { NotificationItem } from '../src/notification-items'
import { bellTally, DEFAULT_LEVEL, LEVEL_KEY, noticeGroup, readLevel, saveLevel, setAnswerGroups, shownAt, tally } from '../src/ui/places/overview/level'
import { chatOpening, diagnosticHref, itemOf, journalStep, targetOpening, timelineHref } from '../src/ui/places/overview/targets'
import { chatState, countStates, issueState, pullState, taskPhase, taskState, type ChainLike } from '../src/ui/places/overview/states'
import { decisionEntries, diagnosticGroup, itemEntries, keepEntries, ordered, prGroup, prStatusesFrom, requestEntries, requestsFrom, restoreEntries, threadEntries, undismissed, type OpenRequest } from '../src/ui/places/overview/entries'
import { STALLED_MESSAGE } from '../src/behavior-diagnostics'
import type { ChainAttentionRow } from '../src/notification-items'
import type { PrStatus } from '../src/ui/places/board/model'
import { countPair, moveTile, tileOrder, workTypeRows } from '../src/ui/places/overview/day'
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
  it('opens on + Faults, keeps a choice, and refuses what is not a level', () => {
    expect(readLevel()).toBe(DEFAULT_LEVEL)
    expect(DEFAULT_LEVEL).toBe(1)
    saveLevel(0)
    expect(readLevel()).toBe(0)
    memory.set(LEVEL_KEY, '7')
    expect(readLevel()).toBe(DEFAULT_LEVEL)
    memory.set(LEVEL_KEY, 'not json')
    expect(readLevel()).toBe(DEFAULT_LEVEL)
  })

  it('carries a choice made among the four old levels to the three: + Done shows what + Faults shows now', () => {
    for (const [old, now] of [['0', 0], ['1', 1], ['2', 1], ['3', 2]] as const) {
      memory.clear()
      memory.set('poise-overview-level', old)
      expect(readLevel()).toBe(now)
    }
  })

  it('includes each group before it', () => {
    expect(shownAt('needs-you', 0)).toBe(true)
    expect(shownAt('fault', 0)).toBe(false)
    expect(shownAt('fault', 1)).toBe(true)
    expect(shownAt('auto', 1)).toBe(false)
    expect(shownAt('auto', 2)).toBe(true)
  })

  it('counts what the level shows, never what Poise handles on its own, in the most urgent colour', () => {
    const groups = ['needs-you', 'fault', 'auto', 'auto'] as const
    expect(tally(groups, 0)).toEqual({ count: 1, tone: 'needs-you' })
    expect(tally(groups, 1)).toEqual({ count: 2, tone: 'failed' })
    expect(tally(groups, 2)).toEqual({ count: 2, tone: 'failed' })
    expect(tally(['auto'], 2)).toEqual({ count: 0, tone: '' })
    expect(tally([], 2)).toEqual({ count: 0, tone: '' })
  })

  // Only you is what stays put until you act; Poise's own work is a fault when
  // stuck and automatic while it moves; finished work is not listed.
  it('groups every notice kind by who acts', () => {
    for (const kind of [...NOTICE_KINDS, ...LOCAL_NOTICE_KINDS]) expect(['needs-you', 'fault', 'auto', null]).toContain(noticeGroup(kind))
    for (const kind of ['sign_in_needed', 'review_requested'] as const) expect(noticeGroup(kind)).toBe('needs-you')
    for (const kind of ['storage_low', 'action_needed', 'action_failed', 'pr_conflict', 'behavior_held', 'ledger_queue_stalled', 'ledger_capture_loss'] as const) expect(noticeGroup(kind)).toBe('fault')
    for (const kind of ['pr_ready', 'datastore_sync_failing', 'github_quota_warning', 'github_quota_exhausted', 'read_failed'] as const) expect(noticeGroup(kind)).toBe('auto')
    for (const kind of ['chat_waiting', 'worker_idle', 'chat_turn_finished', 'action_finished'] as const) expect(noticeGroup(kind)).toBeNull()
  })

  it('has the bell count what the level shows: the same sources elsewhere, Overview’s own entries while it is mounted', () => {
    const away = () => [notice('review_requested'), notice('chat_turn_finished'), notice('ledger_queue_stalled')].flatMap((value) => noticeGroup(value.kind) ?? [])
    expect(bellTally(away)).toEqual({ count: 2, tone: 'failed' })
    saveLevel(0)
    expect(bellTally(away)).toEqual({ count: 1, tone: 'needs-you' })
    setAnswerGroups(() => ['needs-you', 'needs-you', 'needs-you'])
    expect(bellTally(away)).toEqual({ count: 3, tone: 'needs-you' })
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

  it('opens a worker in Chat and the Manager in the Manager place', () => {
    expect(targetOpening({ chat: 'w1' }, () => 'worker').href).toBe('?view=chat&chat=w1&back=overview')
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
    expect(chatState({ status: 'waiting', ownerRequests: ['a', 'b'] })).toEqual({ state: 'needs-you', note: '2 requests wait for you' })
    expect(chatState({ status: 'waiting', ownerRequests: [] })).toEqual({ state: 'waiting', note: 'Awaiting an answer' })
    expect(chatState({ status: 'queued', queuedBehind: 'waiting for a free agent slot' })).toEqual({ state: 'waiting', note: 'waiting for a free agent slot' })
    expect(chatState({ status: 'queued', queuedBehind: 'Fix the login' })).toEqual({ state: 'waiting', note: 'queued behind Fix the login' })
    expect(chatState({ status: 'interrupted' }).state).toBe('blocked')
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
    expect(taskState(chain({ held: 'Removed from the merge queue by hand' }))).toEqual({ state: 'blocked', note: 'Removed from the merge queue by hand' })
    expect(taskState(chain({ invocations: [{ behavior: 'review-pr', state: 'uncertain', outcome: 'a reply may have posted' }] })).state).toBe('blocked')
    expect(taskState(chain({ waiting: 'waiting for memory' }))).toEqual({ state: 'waiting', note: 'waiting for memory' })
    expect(taskState(chain({ mergeSha: 'abc' }))).toEqual({ state: 'done', note: 'Merged' })
    expect(taskState(chain({ mergeSha: 'abc', reviewPending: true })).state).toBe('waiting')
    expect(taskState(chain({ supersession: { by: 1 } }))).toEqual({ state: 'done', note: 'Superseded' })
  })

  it('maps a pull request and an issue as Board shows them', () => {
    expect(pullState({})).toBeNull()
    expect(pullState({ status: 'green' })).toEqual({ state: 'waiting', note: 'Ready to merge' })
    expect(pullState({ reviewRequested: true })).toEqual({ state: 'needs-you', note: 'GitHub requested your review' })
    expect(pullState({ status: 'yellow', reasons: ['checks_running'] })?.state).toBe('waiting')
    expect(pullState({ status: 'yellow', reasons: ['checks_failing'], failing: ['lint', 'e2e'] })).toEqual({ state: 'failed', note: 'failing: lint, e2e' })
    expect(pullState({ status: 'yellow', reasons: ['changes_requested'] })?.state).toBe('waiting')
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
  const request = (extra: Partial<OpenRequest>): OpenRequest => ({ id: 'r1', kind: 'permission', sessionId: 's1', sessionTitle: 'Muse', createdAt: '2026-11-11T08:00:00Z', content: null, escalation: null, ownerAction: true, ...extra })

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
    expect(one.freeText?.label).toBe('Other')
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

  it('shows only live requests for the person and drops generic chat waiting notices', () => {
    const items = [{ id: 'n1', group: 'needs', tone: 'blue', icon: 'chat', title: 'Muse is waiting', body: '', source: 'Chat', scope: null, when: null, meta: '', details: [], behaviors: [], notice: notice('chat_waiting', { id: 'n1', target: { chat: 's1' } }) } as NotificationItem]
    const worker = request({ sessionId: 'w1', kind: 'question', ownerAction: false,
      content: { questions: [{ id: 'q', question: 'Which branch?', options: [], freeText: true }] } })
    expect(requestEntries([worker], role)).toEqual([])
    expect(requestEntries([{ ...worker, ownerAction: true, escalation: 'Choose the release branch' }], role)[0])
      .toMatchObject({ group: 'needs-you', why: 'Choose the release branch' })
    expect(itemEntries(items, role, new Map())).toEqual([])
  })

  it('shows a ready pull request as status without asking the owner to merge it', () => {
    const items = (['pr_ready', 'ledger_queue_stalled', 'chat_turn_finished'] as const).map((kind) => ({
      id: kind, group: 'needs', tone: 'amber', icon: 'merge', title: kind, body: kind === 'pr_ready' ? 'Fix the login' : '', source: 'GitHub', scope: null, when: null, meta: '', details: [], behaviors: [],
      notice: notice(kind, { id: kind, body: kind === 'pr_ready' ? 'Fix the login' : '', target: kind === 'pr_ready' ? { pullRequest: 'https://github.com/acme/site/pull/14' } : null }),
    }) as NotificationItem)
    const entries = itemEntries(items, role, new Map())
    expect(entries.map((entry) => entry.group)).toEqual(['auto', 'fault'])
    expect(entries[0].options).toEqual([])
    expect(entries[0].pull).toEqual({ repo: 'acme/site', number: 14, url: 'https://github.com/acme/site/pull/14' })
    // The pull request's own title; its kind and where say the rest.
    expect(entries[0]).toMatchObject({ title: 'Fix the login', where: 'acme/site #14', kind: 'Ready to merge' })
    expect(entries[1].state).toBe('failed')
    expect(ordered([entries[1], entries[0]]).map((entry) => entry.group)).toEqual(['fault', 'auto'])
  })

  const pullNotice = (kind: 'pr_ready' | 'pr_conflict', when: string | null = null) => ({
    id: kind, group: 'needs', tone: 'amber', icon: 'merge', title: kind, body: 'Fix the login', source: 'GitHub', scope: null, when, meta: '', details: [], behaviors: [],
    notice: notice(kind, { id: kind, target: { pullRequest: 'https://github.com/Acme/Site/pull/14' } }),
  }) as NotificationItem
  const status = (id: PrStatus['blocker']['id'], line: string = id, chainId?: string): PrStatus =>
    ({ repository: 'acme/site', number: 14, blocker: { id, line, since: '2026-11-13T08:00:00Z', sinceRestart: false, details: [] }, ownership: chainId ? { engine: 'v2', chainId } : { engine: 'v1' } })
  const byStatus = (row: PrStatus | null, kind: 'pr_ready' | 'pr_conflict' = 'pr_ready') =>
    itemEntries([pullNotice(kind)], role, new Map(), new Map(row ? [['acme/site#14', row]] : []))[0]

  it('puts a pull request’s notice with whoever moves the pull request next', () => {
    // A behavior or the chain moves it: Poise handles it.
    for (const id of ['review_running', 'awaiting_review', 'ci_pending', 'behind', 'approved_not_enqueued', 'in_queue'] as const) expect(byStatus(status(id)).group).toBe('auto')
    expect(byStatus(status('conflicting', 'merge conflict on abc', 'acme/site#9')).group).toBe('auto')
    expect(byStatus(status('ci_failing', 'CI failing on abc · grey rerun pending')).group).toBe('auto')
    for (const id of ['awaiting_author', 'conflicting', 'unresolved_threads', 'blocked', 'not_eligible'] as const) expect(byStatus(status(id), 'pr_conflict').group).toBe('fault')
    expect(byStatus(status('ci_failing', 'CI failing on abc')).group).toBe('fault')
    expect(byStatus(status('awaiting_review', 'awaiting review of abc · cap 5/5 · cap reached')).group).toBe('fault')
    expect(byStatus(status('approved_not_enqueued', 'approved, not enqueued: merge-prs disabled')).group).toBe('fault')
    expect(byStatus(status('unknown')).group).toBe('auto')
    expect(byStatus(null)).toMatchObject({ group: 'auto', detail: 'Behavior status unavailable' })
    // A behavior held on it: stuck.
    expect(byStatus(status('held', 'held: merge-prs merge_failed since 08:00')).group).toBe('fault')
    // What moves it next is the line under its title.
    expect(byStatus(status('awaiting_author', 'changes requested on abc need author action'), 'pr_conflict')).toMatchObject({ detail: 'changes requested on abc need author action', kind: 'Merge conflict' })
    expect(prGroup(undefined)).toBe('auto')
  })

  it('makes automatic work that has not moved for four hours a fault', () => {
    const now = Date.parse('2026-11-13T12:00:00Z')
    const quota = (when: string) => itemEntries([{ ...pullNotice('pr_ready'), id: 'q', body: '', when, notice: notice('github_quota_exhausted', { id: 'q' }) } as NotificationItem], role, new Map(), new Map(), now)[0].group
    expect(quota('2026-11-13T09:00:00Z')).toBe('auto')
    expect(quota('2026-11-13T08:00:00Z')).toBe('fault')
    const queued = itemEntries([pullNotice('pr_ready', '2026-11-13T07:30:00Z')], role, new Map(), new Map([['acme/site#14', status('in_queue')]]), now)[0]
    expect(queued.group).toBe('fault')
  })

  it('never puts chain work on you: held or still for four hours it is a fault, moving it is automatic', () => {
    const now = Date.parse('2026-11-13T12:00:00Z')
    const row = (progressAt: string, held: string | null, mergeSha: string | null = null): ChainAttentionRow => ({ id: 'acme/site#7', repository: 'acme/site', issue: 7,
      held, sequence: 9, mergeSha, pullNumber: 12, step: 'repair-pr: uncertain', progressAt: Date.parse(progressAt), ageMs: now - Date.parse(progressAt),
      blocker: 'New invocations held by the person; Original pre-merge review evidence pending', evidence: { state: 'fresh', checkedAt: null, gates: [] }, nextAction: 'Resume', retryAt: null, journal: '/api/behavior-chains?id=acme%2Fsite%237&after=4',
      reconciliation: { nextObservationAt: null, waitingForResourceRelease: false } })
    // The chains map holds only the first page; the hold comes from the attention row past it.
    const chain = (progressAt: string, held: string | null, mergeSha: string | null = null,
      chains: ReadonlyMap<string, { sequence: number, held: string | null }> = new Map()) => itemEntries([{ id: 'chain:acme/site#7', group: 'needs', tone: 'amber', icon: 'held', title: 'acme/site#7 · repair-pr: uncertain', body: row(progressAt, held, mergeSha).blocker,
      source: 'Behavior chain', scope: null, when: progressAt, meta: '', details: [], behaviors: [], notice: null, chainJournal: row(progressAt, held, mergeSha).journal, chain: row(progressAt, held, mergeSha) } as NotificationItem], role,
    chains, new Map(), now)[0]
    expect(chain('2026-11-13T11:00:00Z', 'New invocations held by the person')).toMatchObject({ group: 'fault', kind: 'Chain held', title: 'New invocations held by the person', detail: 'repair-pr: uncertain',
      where: 'acme/site #7 → #12', options: [], quiet: [{ key: 'resume', label: 'Resume the chain', icon: 'play' }],
      chain: { id: 'acme/site#7', sequence: 9 } })
    expect(chain('2026-11-13T11:00:00Z', null)).toMatchObject({ group: 'auto', kind: 'Behavior chain', quiet: undefined, chain: undefined })
    expect(chain('2026-11-13T07:59:00Z', null)).toMatchObject({ group: 'fault', kind: 'Chain stuck' })
    // A merged hold stays a fault but offers no Resume: the API rejects it with 409.
    expect(chain('2026-11-13T11:00:00Z', 'New invocations held by the person', 'c'.repeat(40))).toMatchObject({ group: 'fault', kind: 'Chain held', quiet: undefined, chain: undefined })
    // On page one the row still wins over a stale page entry, with its own sequence for Resume.
    expect(chain('2026-11-13T11:00:00Z', 'New invocations held by the person', null,
      new Map([['acme/site#7', { sequence: 5, held: null }]]))).toMatchObject({ group: 'fault', kind: 'Chain held',
      quiet: [{ key: 'resume', label: 'Resume the chain', icon: 'play' }], chain: { id: 'acme/site#7', sequence: 9 } })
    // ...in both directions: an unheld row beats a stale held page entry.
    expect(chain('2026-11-13T11:00:00Z', null, null,
      new Map([['acme/site#7', { sequence: 5, held: 'New invocations held by the person' }]]))).toMatchObject({ group: 'auto', kind: 'Behavior chain', quiet: undefined, chain: undefined })
  })

  it('reads pull requests’ status as a failed read when Poise could not read them, keeping what an unread organization had', () => {
    const before = prStatusesFrom({ health: { status: 'ok' }, rows: [status('in_queue')], datastore: { orgs: [{ org: 'acme', status: 'ready' }] } }, null)
    expect([...before.keys()]).toEqual(['acme/site#14'])
    // Unavailable is not "no pull requests": the last read stays.
    expect(() => prStatusesFrom({ health: { status: 'unavailable' }, rows: [], datastore: { orgs: [] } }, before)).toThrow('could not read its pull requests')
    expect(() => prStatusesFrom({ error: 'invalid_query' }, before)).toThrow('cannot read')
    // An organization whose datastore could not be read keeps its rows; one read afresh does not.
    const partial = prStatusesFrom({ health: { status: 'stale' }, rows: [], datastore: { orgs: [{ org: 'acme', status: 'unavailable' }] } }, before)
    expect(partial.get('acme/site#14')?.blocker.id).toBe('in_queue')
    expect(prStatusesFrom({ health: { status: 'ok' }, rows: [], datastore: { orgs: [{ org: 'acme', status: 'ready' }] } }, before).size).toBe(0)
  })

  it('makes a retry still failing four hours after it began a fault', () => {
    const now = Date.parse('2026-11-13T12:00:00Z')
    const retry = (began: string | null) => itemEntries([{ id: 'diagnostic:["rate_limit"]', group: 'auto', tone: 'slate', icon: 'retry', title: 'The service is limiting requests. Poise will try again.', body: '', source: 'Behaviors', scope: null,
      when: '2026-11-13T11:59:00Z', meta: '', details: [], behaviors: [], notice: null, code: 'rate_limit', began } as NotificationItem], role, new Map(), new Map(), now)[0].group
    expect(retry('2026-11-13T09:00:00Z')).toBe('auto')
    expect(retry('2026-11-13T07:59:00Z')).toBe('fault')
    expect(retry(null)).toBe('auto')
  })

  it('puts a Behaviors diagnostic with whoever clears it', () => {
    expect(diagnosticGroup('authentication', 'x')).toBe('fault')
    expect(diagnosticGroup('github_access', 'x')).toBe('fault')
    for (const code of ['rate_limit', 'provider_capacity', 'network_interruption', 'upstream_unavailable', 'head_changed', 'approval_blocked_unresolved_conversations', 'datastore_stale', 'runtime_status_unknown']) expect(diagnosticGroup(code, 'x')).toBe('auto')
    expect(diagnosticGroup('unknown', STALLED_MESSAGE)).toBe('auto')
    for (const code of ['held_result', 'invalid_agent_result', 'runtime_unhealthy', 'review_contract_violation', 'review_budget_exhausted', 'unknown']) expect(diagnosticGroup(code, 'Command failed (1)')).toBe('fault')
    expect(diagnosticGroup(undefined, 'x')).toBe('fault')
    // A notice joined with a diagnostic takes the diagnostic's group.
    const joined = itemEntries([{ ...pullNotice('pr_ready'), code: 'held_result', body: 'The review outcome needs verification before retry.',
      details: [{ behavior: 'review-new-prs', target: 'acme/site#14', at: null, next: null, detail: 'held' }] } as NotificationItem], role, new Map())[0]
    expect(joined.group).toBe('fault')
  })

  it('puts a decision’s recommendation first, with Other', () => {
    const [entry] = decisionEntries([
      { id: 3, kind: 'decision', text: 'Which filter wins?', detail: null, createdAt: '2026-11-11T08:00:00Z', source: { sessionId: 'w1', title: 'W3', exists: true }, options: [{ id: 'a', label: 'A', detail: null, recommended: false }, { id: 'b', label: 'B', detail: null, recommended: true }] },
      { id: 4, kind: 'decision', text: 'Answered', detail: null, createdAt: '2026-11-11T08:00:00Z', source: { sessionId: 'w1', title: 'W3', exists: true }, answer: { label: 'A', freeText: false, at: '2026-11-11T08:01:00Z', relay: 'delivered' } },
    ], role)
    expect(entry.options.map((o) => o.key)).toEqual(['b', 'a'])
    expect(entry.freeText?.label).toBe('Other')
    expect(entry.open?.href).toBe('?view=chat&chat=w1&back=overview')
  })

  // #1379: no entry is stuck. Every one can be put away, except a Manager’s
  // prompt that offers options, which always takes Other in your own words.
  it('lets every entry be dismissed, saying what Dismiss does, except a Manager’s prompt with options', () => {
    const manager = (chat: string) => (chat === 'm1' ? 'manager' : null)
    const ask = (sessionId: string, freeText: boolean) => requestEntries([request({ sessionId, kind: 'question', content: { questions: [{ id: 'q', question: 'Which?', options: [{ label: 'A' }], multiSelect: false, freeText }] } })], manager)[0]
    expect(ask('m1', true)).toMatchObject({ dismissable: false, freeText: { label: 'Other' } })
    // A Manager’s question that cannot take your own words keeps Dismiss, so it is never stuck.
    expect(ask('m1', false)).toMatchObject({ dismissable: true, dismissWords: 'hides it here; the chat still waits for your answer in Chat' })
    expect(ask('s2', true)).toMatchObject({ dismissable: true })
    const permission = requestEntries([request({ content: { title: 'Run it', options: [{ id: 'a', name: 'Allow' }] } })], manager)[0]
    expect(permission).toMatchObject({ dismissable: true, dismissWords: expect.stringContaining('the chat still waits') })

    const decision = (options: boolean, exists: boolean) => decisionEntries([{ id: 5, kind: 'decision', text: 'Which?', detail: null, createdAt: '2026-11-11T08:00:00Z',
      source: { sessionId: 'w1', title: 'W3', exists }, options: options ? [{ id: 'a', label: 'A', detail: null, recommended: true }] : [] }], role)[0]
    expect(decision(true, true)).toMatchObject({ dismissable: false, freeText: { label: 'Other' } })
    expect(decision(false, true)).toMatchObject({ dismissable: true, dismissWords: 'hides it from the Switchboard; the chat is told nothing' })
    expect(decision(true, false)).toBeUndefined()

    const chain = itemEntries([{ id: 'chain:acme/site#7', group: 'needs', tone: 'amber', icon: 'held', title: 'acme/site#7 · repair-pr: uncertain', body: 'held', source: 'Behavior chain', scope: null,
      when: '2026-11-08T18:35:17.371Z', meta: 'No verified advance for 4d', details: [], behaviors: [], notice: null, chainJournal: '/api/behavior-chains?id=acme%2Fsite%237&after=4' } as NotificationItem], role,
    new Map([['acme/site#7', { sequence: 5, held: 'Original outcome requires reconciliation' }]]))[0]
    expect(chain).toMatchObject({ source: 'chain', dismissable: true, dismissWords: 'hides it until the chain moves; the chain stays held',
      revision: '2026-11-08T18:35:17.371Z|acme/site#7 · repair-pr: uncertain|held', options: [], quiet: [{ key: 'resume', label: 'Resume the chain', icon: 'play' }] })
    const diagnostic = itemEntries([{ id: 'diagnostic:["x"]', group: 'needs', tone: 'amber', icon: 'held', title: 'Reviews time out', body: '', source: 'Behaviors', scope: null,
      when: '2026-11-12T10:00:00Z', meta: '', details: [], behaviors: [], notice: null } as NotificationItem], role, new Map())[0]
    expect(diagnostic).toMatchObject({ dismissable: true, revision: '2026-11-12T10:00:00Z|Reviews time out' })
    const [thread] = threadEntries({ slug: 'doc', site: 'site', repo: 'acme/site', pr: 3, prUrl: 'u', checkedAt: null, active: true, stale: false, problems: [], openThreads: 1 },
      [{ id: 't1', kind: 'thread', repo: 'acme/site', site: 'site', pr: 3, prUrl: 'u', resolved: false, canReply: true, canResolve: true, messages: [{ author: 'ann', body: 'Typo', createdAt: '2026-11-12T09:00:00Z' }] }], (slug) => slug)
    expect(thread).toMatchObject({ group: 'auto', dismissable: true, revision: '1|2026-11-12T09:00:00Z', dismissWords: expect.stringContaining('the thread stays open on GitHub') })

    // A put-away entry stays away until what it reports changes; notices keep their own dismissal.
    const put = new Map([[chain.id, chain.revision], [diagnostic.id, 'an older occurrence']])
    expect(undismissed([chain, diagnostic, permission], put).map((entry) => entry.id)).toEqual([diagnostic.id, permission.id])
  })

  it('keeps what a card shows, never what answering needs, and restores it remembered and unanswerable', () => {
    const [entry] = requestEntries([request({ content: { title: 'Run gh pr create', description: 'x'.repeat(5000), input: { command: 'gh pr create' }, options: [{ id: 'allow', name: 'Allow once' }, { id: 'deny', name: 'Deny' }] } })], role)
    const [kept] = keepEntries([entry])
    expect(kept).toEqual({ id: 'request:r1', source: 'request', group: 'needs-you', kind: 'Permission', title: 'Run gh pr create', where: 'Muse', since: '2026-11-11T08:00:00Z',
      detail: 'Asks before a step', options: ['Allow once', 'Deny'], primary: 0, open: { href: '?view=chat&chat=s1&back=overview', label: 'Open the chat' } })
    // The description, the command and the request's ids stay behind.
    expect(JSON.stringify(kept)).not.toMatch(/xxxx|"command"|sessionId|"request":/)
    const [back] = restoreEntries(JSON.parse(JSON.stringify([kept])))
    expect(back).toMatchObject({ id: 'request:r1', remembered: true, dismissable: false, silenceable: false, title: 'Run gh pr create', group: 'needs-you' })
    expect(back.options.map((o) => [o.label, o.primary])).toEqual([['Allow once', true], ['Deny', false]])
    expect(back.request).toBeUndefined()
    // Anything kept in another shape is dropped, never guessed at; a link goes only within Poise or to https.
    expect(restoreEntries([{ ...kept, group: 'ready' }, { ...kept, id: 3 }, null, 'x'])).toEqual([])
    expect(restoreEntries('not a list')).toEqual([])
    expect(restoreEntries([{ ...kept, open: { href: 'javascript:alert(1)', label: 'x' }, github: 'http://example.com' }])[0]).toMatchObject({ open: undefined, github: undefined })
    // Long words are cut to what a card shows, and at most 200 entries are kept.
    expect(keepEntries([{ ...entry, title: 'y'.repeat(1000) }])[0].title).toHaveLength(240)
    expect(keepEntries(Array.from({ length: 250 }, () => entry))).toHaveLength(200)
  })

  it('lists the newest entry first within each group, and an entry without a time last', () => {
    const at = (id: string, since: string | null, group: 'needs-you' | 'fault' = 'needs-you') =>
      ({ ...requestEntries([request({ id, createdAt: since ?? '', content: { title: id, options: [{ id: 'a', name: 'Allow' }] } })], role)[0], since, group })
    const list = ordered([at('old', '2026-11-04T15:55:00Z'), at('none', null), at('fault', '2026-11-13T09:00:00Z', 'fault'), at('new', '2026-11-12T20:00:00Z'), at('mid', '2026-11-08T18:35:00Z')])
    expect(list.map((entry) => entry.title)).toEqual(['new', 'mid', 'old', 'none', 'fault'])
  })
})

describe('the day’s tiles', () => {
  it('keeps the day’s own leading work type when a search narrows the rows (#1380)', () => {
    const types = [{ type: 'feat', count: 8 }, { type: 'fix', count: 2 }, { type: 'docs', count: 0 }]
    expect(workTypeRows(types, (type) => type.includes('fix'))).toEqual({ lead: { type: 'feat', count: 8 }, rows: [{ type: 'fix', count: 2 }] })
    expect(workTypeRows(types, () => true).rows.map((row) => row.type)).toEqual(['feat', 'fix'])
    expect(workTypeRows([], () => true)).toEqual({ lead: undefined, rows: [] })
  })

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
