import { describe, expect, it } from 'vitest'
import {
  age, attentionOrder, eventWords, journalStep, phaseOf, readChain, readChainsPage, readJournalPage, reasonWords, stepEvent, taskState, timelineLines,
  type AttentionRow, type ChainRow, type JournalEvent,
} from '../src/ui/places/observe/chains'
import { readFrom, readLater, readNewest, readOlder, type ReadPage } from '../src/ui/places/observe/journal'
import { behaviorName, estimateText, groupRuns, matchesSearch, modelName, serverSearch, statusOf, type LogEntry } from '../src/ui/places/observe/runs'
import { historyState, readRecord, rowKey } from '../src/ui/places/observe/history'

// Observe's pure mappings (#556): the chain's tasks, its journal read newest
// first, runs in the seven state words, and the GitHub history's words.

const chain = (over: Partial<ChainRow> = {}): ChainRow => readChain({
  id: 'acme/site#12', repository: 'acme/site', issue: 12, sequence: 40, held: null, waiting: null, mergeSha: null,
  reviewPending: null, reviewStatus: 'not-recorded', supersession: null, reconciliation: null, pullNumber: 14, invocations: [], ...over,
})
const invocation = (behavior: string, state: string, extra: Record<string, unknown> = {}) => ({ id: `${behavior}-${state}-${Math.random()}`, behavior, state, callId: null, model: 'Opus', slot: 'primary', outcome: null, admittedAt: 1, ...extra })

describe('a chain as a task', () => {
  it('names the phase from the step it stands on, and counts review rounds after each repair', () => {
    expect(phaseOf(chain()).word).toBe('Intake')
    expect(phaseOf(chain({ invocations: [invocation('review-issue', 'settled'), invocation('implement-issue', 'started')] })).word).toBe('Implementation')
    const twice = chain({ invocations: [invocation('review-pr', 'settled'), invocation('repair-pr', 'settled'), invocation('review-pr', 'settled'), invocation('repair-pr', 'settled'), invocation('review-pr', 'started')] })
    expect(phaseOf(twice)).toMatchObject({ index: 3, round: 3, word: 'PR review · round 3' })
    expect(phaseOf(chain({ mergeSha: 'abcdef1234567' })).word).toBe('Merged')
    expect(phaseOf(chain({ supersession: { covering: [], failures: [], recovery: null } })).word).toBe('Superseded')
  })

  it('says where it stands in the seven state words, with its reason', () => {
    expect(taskState(chain({ invocations: [invocation('review-pr', 'started')] }))).toEqual({ state: 'running', reason: 'PR review · round 1 · Opus' })
    expect(taskState(chain({ waiting: 'native merge queue owns entry 88' }))).toEqual({ state: 'waiting', reason: 'In the merge queue' })
    expect(taskState(chain({ held: 'queue removal requires a decision: manual (q1)' })).state).toBe('blocked')
    expect(taskState(chain({ held: 'New invocations held by the person' })).reason).toBe('Held by you: no new invocations')
    expect(taskState(chain({ invocations: [invocation('repair-pr', 'uncertain', { outcome: 'a reply may have posted' })] }))).toEqual({ state: 'blocked', reason: 'Not confirmed: a reply may have posted; reconciling' })
    expect(taskState(chain({ invocations: [invocation('review-pr', 'admitted')] })).state).toBe('waiting')
    expect(taskState(chain({ mergeSha: '4d34831aaaa', reviewPending: true }))).toEqual({ state: 'waiting', reason: 'Merged as 4d34831 · review evidence pending' })
    expect(taskState(chain({ mergeSha: '4d34831aaaa', reviewPending: false, reviewStatus: 'complete' }))).toEqual({ state: 'done', reason: 'Merged as 4d34831' })
    expect(taskState(chain({ supersession: { covering: [{ number: 500, mergeSha: '9a1c2e7ffff' }], failures: [{ id: 9201 }], recovery: { id: 9214 } } }))).toEqual({ state: 'done', reason: 'Superseded: #500 covered it, merged as 9a1c2e7' })
    expect(taskState(chain())).toEqual({ state: 'idle', reason: 'Awaiting the next observation' })
  })

  it('words the waits the decision logic writes, and leaves others as written', () => {
    expect(reasonWords('exact-head CI is still running')).toBe('CI is still running on its head')
    expect(reasonWords('repair-pr is in native failure backoff')).toBe('Repair failed; it retries after a backoff')
    expect(reasonWords('something new')).toBe('Something new')
  })

  it('orders Needs attention by the oldest verified progress, and says how long', () => {
    const entry = (id: string, progressAt: number) => ({ id, progressAt }) as AttentionRow
    expect(attentionOrder([entry('b', 30), entry('c', 10), entry('a', 30)]).map((a) => a.id)).toEqual(['c', 'a', 'b'])
    expect(age(36 * 60_000)).toBe('36m')
    expect(age(184 * 60_000)).toBe('3h 4m')
    expect(age(1596 * 60_000)).toBe('1d 2h')
  })

  it('reads a journal link’s chain and step, and refuses what it cannot read', () => {
    expect(journalStep('/api/behavior-chains?id=acme%2Fsite%2312&after=41')).toEqual({ id: 'acme/site#12', after: 41 })
    expect(journalStep('/api/behavior-chains?after=4')).toBeNull()
    expect(() => readChainsPage({ chains: [{ id: 'x' }] })).toThrow(/incomplete/)
    expect(readChainsPage({ chains: [], next: null, attention: [], cutover: { mode: 'v2', legacyPulls: ['a/b#1'], sequence: 1, requestedAt: null } }).cutover?.legacyPulls).toEqual(['a/b#1'])
    expect(readJournalPage({ events: [{ sequence: 3, at: 1, type: 'chain.held', reason: 'r' }], next: null }).events[0]).toMatchObject({ sequence: 3, reason: 'r' })
  })
})

describe('the timeline', () => {
  const event = (sequence: number, type = 'chain.observed', at = sequence * 1000): JournalEvent =>
    ({ sequence, at, type, invocationId: null, reason: null, outcome: null, callId: null, diagnostic: null })

  it('folds observations in a row into one line, keeping a named step on its own', () => {
    const events = [event(1, 'chain.admitted'), event(2), event(3), event(4), event(5, 'chain.held'), event(6)]
    expect(timelineLines(events, null).map((l) => [l.event.sequence, l.folded])).toEqual([[6, 1], [5, 1], [4, 3], [1, 1]])
    expect(timelineLines(events, 3).map((l) => [l.event.sequence, l.folded])).toEqual([[6, 1], [5, 1], [4, 1], [3, 1], [2, 1], [1, 1]])
    expect(stepEvent(events, 2)).toBe(3)
    expect(stepEvent(events, null)).toBeNull()
  })

  it('names runs by their step, and links the run they started', () => {
    const run = { id: 'i1', behavior: 'review-pr', state: 'settled', callId: 'c'.repeat(32), model: 'Opus', slot: 'primary', outcome: 'approved', admittedAt: 1 }
    const words = eventWords({ ...event(9, 'invocation.settled'), invocationId: 'i1', outcome: 'approved', callId: 'c'.repeat(32) }, new Map([['i1', run]]))
    expect(words).toEqual({ kind: 'run', text: 'PR review settled: approved · primary · Opus', call: 'c'.repeat(32) })
    expect(eventWords({ ...event(9, 'invocation.uncertain'), reason: 'provider stopped mid-post' }, new Map()).kind).toBe('uncertain')
  })

  // A journal whose sequence numbers are shared with another chain, as the server's are.
  function journal(mine: number[]): ReadPage {
    return async (after) => {
      const events = mine.filter((s) => s > after).slice(0, 20).map((s) => event(s))
      return { events, next: events.length === 20 ? events[events.length - 1].sequence : null }
    }
  }
  const sequences = (from: number, count: number, step = 7) => Array.from({ length: count }, (_, i) => from + i * step)

  it('reads the newest page of a long journal, then the events before it without a gap', async () => {
    const mine = sequences(5, 300)
    const read = journal(mine)
    const newest = await readNewest(read, mine[mine.length - 1])
    expect(newest.events.length).toBeGreaterThanOrEqual(20)
    expect(newest.events[newest.events.length - 1].sequence).toBe(mine[mine.length - 1])
    expect(newest.complete).toBe(true)
    const older = await readOlder(read, newest)
    const got = older.events.map((e) => e.sequence)
    expect(got).toEqual(mine.slice(mine.length - got.length))
    expect(got.length).toBeGreaterThan(newest.events.length)
  })

  it('reads a short journal whole, and from a step a link names', async () => {
    const mine = [3, 9, 15]
    const whole = await readNewest(journal(mine), 15)
    expect(whole).toMatchObject({ start: true, complete: true })
    expect(whole.events.map((e) => e.sequence)).toEqual(mine)
    const long = sequences(5, 90)
    const from = await readFrom(journal(long), long[10] - 1, 2)
    expect(from.events[0].sequence).toBe(long[10])
    expect(from.complete).toBe(false)
    const later = await readLater(journal(long), from)
    expect(later.events.map((e) => e.sequence)).toEqual(long.slice(10))
    expect(later.complete).toBe(true)
  })
})

describe('runs in the seven state words', () => {
  const run = (over: Partial<LogEntry> = {}): LogEntry => ({
    id: 'a'.repeat(32), pr_id: '12', repo: 'acme/site', actor: null, model: 'Claude · Opus', behavior: 'pr_review', session_id: null, prompt: '',
    started_at: '2026-11-11T10:00:00', started_at_precise: '2026-11-11T08:00:00Z', completed_at: '2026-11-11T08:03:00Z', time_elapsed: '3m',
    status: 'completed', outcome: null, response: null, error: '', ...over,
  })

  it('maps each status onto a state, with the outcome beside it', () => {
    expect(statusOf(run({ outcome: 'approved' }))).toMatchObject({ state: 'done', word: 'Approved' })
    expect(statusOf(run({ outcome: 'changes_requested', review_comments: 2 }))).toMatchObject({ state: 'done', word: 'Changes requested', note: '2 comments' })
    expect(statusOf(run({ outcome: 'clean' }))).toMatchObject({ state: 'done', word: 'No comments' })
    expect(statusOf(run({ outcome: 'superseded', head_sha: 'a', expected_head: 'b' }))).toMatchObject({ state: 'idle', word: 'Superseded', note: 'New commits arrived while it ran' })
    expect(statusOf(run({ status: 'failed', error_code: 'stopped' }))).toMatchObject({ state: 'idle', word: 'Stopped by you' })
    expect(statusOf(run({ status: 'timeout' }))).toMatchObject({ state: 'failed', word: 'Timed out' })
    expect(statusOf(run({ outcome: 'preflight_failed', error: 'clone failed\nmore' }))).toMatchObject({ state: 'failed', word: 'Preflight failed', note: 'clone failed' })
    expect(statusOf(run({ status: 'failed', error: 'GitHub returned 502\nPOST …' }))).toMatchObject({ state: 'failed', note: 'GitHub returned 502' })
    const now = Date.parse('2026-11-11T08:05:00Z')
    const running = run({ status: 'running', completed_at: null, progress: { version: 1, phase: 'reasoning', phase_started_at: '2026-11-11T08:04:00Z', heartbeat_at: '2026-11-11T08:04:59Z', last_provider_event_at: '2026-11-11T08:02:00Z', deadline_at: null, warning: null, events: [] } })
    expect(statusOf(running, now)).toMatchObject({ state: 'running', warn: true, note: 'No provider update for 3m; last: reasoning reported' })
  })

  it('shows a proven stale issue review as superseded without rewriting its receipt', () => {
    const stale = run({ behavior: 'issue_review', status: 'failed', error_code: 'issue_revision_changed', action: 'not_started',
      outcome: 'preflight_failed', error: 'seed issue changed during review; no comments posted', receipts: null })
    const before = structuredClone(stale)
    expect(statusOf(stale)).toEqual({ state: 'idle', word: 'Superseded', note: 'Issue changed', warn: false })
    expect(matchesSearch(stale, 'issue changed')).toBe(true)
    expect(stale).toEqual(before)
    const publication = { ...stale, id: 'b'.repeat(32), artifact: { phase: 'posting_issue_reviews', plan_sha: 'b'.repeat(64) } }
    expect(groupRuns([stale, publication])).toHaveLength(2)
    for (const change of [{ behavior: 'pr_review' }, { status: 'error' }, { error_code: null }, { error_code: 'posting_failed' },
      { action: null }, { outcome: null }, { receipts: [] }, { artifact: { phase: 'posting_issue_reviews', plan_sha: 'b'.repeat(64) } },
      { artifact: { phase: 'reviewing', resource_error: 'cleanup_failed' } }, { resource_error: 'cleanup_failed' },
      { ownership_error: 'ownership_failed' },
      { resource_ownership: { version: 1, roots: [], errors: [{ cause: 'cleanup failed', path: null, at: 1 }] } }]) {
      expect(statusOf({ ...stale, ...change }).state, JSON.stringify(change)).toBe('failed')
    }
  })

  it('names a chain’s own GitHub action for what it did, with no model, and behaviors by their own names', () => {
    const native = run({ model: 'native-action', behavior: 'native_action', prompt: '--merge-if-ready' })
    expect(behaviorName(native)).toBe('Merge if ready')
    expect(modelName(native)).toBe('')
    expect(behaviorName(run())).toBe('Review New Pull Requests')
    expect(modelName(run({ recovery_model: 'Codex' }))).toBe('Claude · Opus → Codex')
  })

  it('filters by what the columns show, and asks the server for the raw behavior a name means', () => {
    expect(matchesSearch(run({ outcome: 'approved' }), 'approved')).toBe(true)
    expect(matchesSearch(run(), 'acme/site#12')).toBe(true)
    expect(matchesSearch(run(), 'Review New Pull')).toBe(true)
    expect(serverSearch('Review New Pull')).toBe('pr_review')
    expect(serverSearch('acme')).toBe('acme')
  })

  it('groups identical finished runs, never one with a response or still going', () => {
    const a = run({ id: '1'.repeat(32) }), b = run({ id: '2'.repeat(32) }), c = run({ id: '3'.repeat(32), response: 'x' })
    expect(groupRuns([a, b, c]).map((g) => g.entries.length)).toEqual([2, 1])
  })

  it('estimates a running run from similar ones, and says when it runs longer than usual', () => {
    const started = Date.parse('2026-11-11T08:00:00Z')
    const running = run({ status: 'running', completed_at: null })
    const basis = { medianMs: 9 * 60_000, p90Ms: 14 * 60_000 }
    expect(estimateText(running, { remainingMs: 0, basis, samples: 9 }, started + 3 * 60_000)).toEqual({ text: '≈ 6 min left', warn: false })
    expect(estimateText(running, { remainingMs: 0, basis, samples: 9 }, started + 15 * 60_000)).toEqual({ text: 'Longer than usual · similar runs took 9 min', warn: true })
    expect(estimateText(running, null)).toBeNull()
  })
})

describe('the GitHub history', () => {
  it('speaks the state words for CI and GitHub’s own for issues and pull requests', () => {
    expect(historyState({ kind: 'action', state: 'failure', mergedAt: null })).toMatchObject({ state: 'failed', word: 'Failed' })
    expect(historyState({ kind: 'action', state: 'action_required', mergedAt: null })).toMatchObject({ state: 'blocked' })
    expect(historyState({ kind: 'action', state: 'cancelled', mergedAt: null })).toMatchObject({ state: 'idle', word: 'Idle · Cancelled' })
    expect(historyState({ kind: 'pr', state: 'closed', mergedAt: '2026-11-11T00:00:00Z' })).toMatchObject({ state: 'done', word: 'Merged', settled: true })
    expect(historyState({ kind: 'issue', state: 'open', mergedAt: null })).toMatchObject({ state: null, word: 'Open', settled: false })
  })

  it('reads a record as a row with one identity', () => {
    const row = readRecord({ kind: 'pr', repo: 'acme/site', number: 7, title: 'T', url: 'https://github.com/acme/site/pull/7', state: 'merged', merged_at: '2026-11-11T00:00:00Z', updated_at: '2026-11-11T00:00:00Z' })
    expect(row).toMatchObject({ state: 'closed', mergedAt: '2026-11-11T00:00:00Z' })
    expect(rowKey(row!)).toBe('acme/site#7')
    expect(rowKey({ kind: 'action', repo: 'acme/site', number: 7 })).toBe('acme/site:action:7')
    expect(readRecord({ kind: 'nope' })).toBeNull()
  })
})
