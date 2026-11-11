import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { projectAnalyticsHealth, healthIntervals, workError } from '../server/analytics-health'
import { BehaviorChainJournal, chainBasis, type BehaviorChain, type ChainEvent } from '../server/behavior-chain-store'
import type { ChainObservation } from '../server/behavior-chain-decision'
import type { Dependencies, LedgerHistory } from '../server/health'

const NOW = Date.parse('2026-11-11T06:00:00Z'), HOUR = 3_600_000
const HEAD = 'a'.repeat(40), MERGE = 'b'.repeat(40)
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function setup() {
  const db = new Database(':memory:'); databases.push(db)
  const journal = new BehaviorChainJournal(db)
  let serial = 0
  const append = (chain: BehaviorChain, event: ChainEvent, at: number) => journal.append(chain.id, `event-${++serial}`, chain.sequence, event, at)
  const seed = (issue: number, at = NOW - 48 * HOUR, repository = 'acme/repo') => journal.append(`${repository}#${issue}`, `seed-${issue}`, 0,
    { type: 'chain.admitted', repository, issue, branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' }, at)
  const observe = (chain: BehaviorChain, at: number, mergedAt: number | null = null, comments: number[] = []): BehaviorChain => {
    const reviewer = { model: 'fixture', slot: 'primary', recovery: 'fixture' }
    const observation: ChainObservation = { checkedAt: at, existingPulls: [], issue: { open: true, eligible: true, revision: 'issue', commentIds: comments },
      issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer,
      prerequisites: { wait: null, base: HEAD, evidence: [] },
      publication: { pull_number: mergedAt === null ? null : chain.issue + 100, head_sha: mergedAt === null ? null : HEAD,
        head_invocation: null, state: mergedAt === null ? null : 'closed', merged: mergedAt !== null, merge_sha: mergedAt === null ? null : MERGE },
      pull: mergedAt === null ? null : { number: chain.issue + 100, head: HEAD, headSince: at, state: 'closed', draft: false, merged: true,
        mergeSha: MERGE, mergedAt, queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: true, ready: true,
        reviewIds: [], reviewReceipts: [], reviewRevision: 'review', greyRuns: [], pending: false, failing: [], conflict: false, behind: false, checksState: 'SUCCESS' } }
    return append(chain, { type: 'chain.observed', observation }, at)
  }
  const finish = (chain: BehaviorChain, name: string, at: number, evidence: Record<string, unknown>) => {
    const id = chainBasis(`${chain.id}:${name}`).slice(0, 32)
    chain = append(chain, { type: 'invocation.admitted', invocation: { id, behavior: 'review-issue', actor: 'reviewer', slot: 'primary',
      basis: 'issue', model: 'fixture', admittedAt: at - 1000, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, at - 1000)
    chain = append(chain, { type: 'invocation.started', invocationId: id }, at - 500)
    return append(chain, { type: 'invocation.settled', invocationId: id, callId: id, outcome: String(evidence.outcome),
      evidence: { completedAt: at, ...evidence } }, at)
  }
  const fail = (chain: BehaviorChain, name: string, at: number, code = 'authentication_failed', message = 'Refresh credential rejected') => finish(chain, name, at,
    { status: 'failed', action: 'not_started', outcome: 'preflight_failed', error_code: code, error: message })
  const succeed = (chain: BehaviorChain, name: string, at: number) => finish(chain, name, at, { status: 'completed', action: 'commented', outcome: 'commented',
    issue_revision: 'issue', error: '', receipts: [{ issue: chain.id, author: 'reviewer', comment_id: 17 }] })
  const merge = (chain: BehaviorChain, mergedAt: number, observedAt = mergedAt) => {
    chain = observe(chain, observedAt, mergedAt)
    return append(chain, { type: 'chain.merged', mergeSha: MERGE,
      evidence: { repository: chain.repository, pull_number: chain.issue + 100, merged: true, merge_sha: MERGE, review_complete: true } }, observedAt)
  }
  const history: LedgerHistory = { coverageStart: new Date(NOW - 96 * HOUR).toISOString(), retainedFrom: new Date(NOW - 96 * HOUR).toISOString(),
    observedAt: new Date(NOW).toISOString(), callerObservedAt: new Date(NOW).toISOString(), dropped: 0, gaps: [], detailFloor: null, generation: 'fixture' }
  const dependencies: Dependencies = { ledger: { status: 'ok', reason: null, since: null, queueAgeMs: null, pending: 0, stallBudgetMs: null },
    datastore: [{ org: 'acme', status: 'ok', reason: null, since: null, checkedAt: new Date(NOW).toISOString(), lastSuccessAt: new Date(NOW).toISOString(), ageSeconds: 0, error: null }],
    githubQuota: [], collectors: { status: 'ok', reason: null, since: null, queued: 0, queuedBytes: 0, dropped: 0, lastSuccessfulWriteAt: null, error: null } }
  const input: Parameters<typeof projectAnalyticsHealth>[1] = { now: NOW, scope: '', history, dependencies, organizations: [{ login: 'acme', managed: true, status: 'ready', stage: 'ready', error: null, activatedAt: null, retryAt: null }] }
  const read = () => projectAnalyticsHealth(journal, input)
  return { journal, seed, append, observe, fail, succeed, finish, merge, read, input }
}

it('counts one incident per seed over completed lifetimes, including pre-window errors, with error-free items in the denominator', async () => {
  const f = setup()
  let errored = f.fail(f.seed(1), 'first observation', NOW - 30 * HOUR)
  errored = f.fail(errored, 'same incident observed again', NOW - 29 * HOUR)
  f.merge(errored, NOW - HOUR)
  f.merge(f.seed(2), NOW - HOUR)
  f.merge(f.fail(f.seed(3), 'unrelated', NOW - 27 * HOUR, 'transport_failed', 'HTTP 503'), NOW - 25 * HOUR, NOW)
  const initial = await f.read()
  expect(initial.rate).toMatchObject({ completed: 2, errors: 1, perItem: .5 })
  expect(initial.rate.items.map(item => item.work)).toEqual(['acme/repo#1', 'acme/repo#2'])
  const completed = f.journal.read('acme/repo#1')!
  f.append(completed, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: 'acme/repo', pull_number: 101,
    merged: true, merge_sha: MERGE, review_complete: true } }, NOW)
  expect((await f.read()).rate).toEqual(initial.rate)
})

it('withholds zero-denominator, unknown merge-time and incomplete lifetime rates while retaining known counts', async () => {
  const f = setup()
  expect((await f.read()).rate).toMatchObject({ completed: 0, perItem: null })
  f.merge(f.fail(f.seed(1), 'old error', NOW - 30 * HOUR), NOW - HOUR)
  f.input.history.gaps = [{ since: new Date(NOW - 40 * HOUR).toISOString(), until: new Date(NOW - 35 * HOUR).toISOString(), reason: 'unavailable' }]
  expect(healthIntervals(f.input.history, NOW - 24 * HOUR, NOW).every(part => part.state === 'covered')).toBe(true)
  const report = await f.read()
  expect(report.rate).toMatchObject({ completed: 1, errors: 1, perItem: null })
  expect(report.limits.join(' ')).toContain('incomplete lifetime evidence')
  expect(report.coverage.find(source => source.name === 'Caller receipts')!.intervals!.some(part => part.state === 'gap')).toBe(true)
  f.append(f.seed(2), { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: 'acme/repo', pull_number: 102, merged: true, merge_sha: MERGE } }, NOW)
  expect((await f.read()).limits.join(' ')).toContain('original GitHub merge time unavailable')
})

it('uses execution evidence rather than Logging severity, excluding successful preparation and ordinary feedback or no-effect outcomes', () => {
  const f = setup()
  const chain = f.seed(1)
  const auth = f.fail(chain, 'auth', NOW - HOUR)
  expect(workError(auth, auth.invocations[0])).toMatchObject({ at: NOW - HOUR })
  const invocation = auth.invocations[0]
  const classify = (evidence: Record<string, unknown>) => workError(auth, { ...invocation, evidence: { ...invocation.evidence, ...evidence } })
  expect(classify({ error_code: null, error: 'HTTP 503' })).not.toBeNull()
  expect(classify({ status: 'completed', diagnostic: { version: 1, severity: 'warning', message: 'preparation warning' } })).toBeNull()
  expect(classify({ status: 'completed', action: 'requested_changes', outcome: 'changes_requested' })).toBeNull()
  expect(classify({ error_code: 'atomic_work_blocked', error: 'required CI is failing' })).toBeNull()
  expect(classify({ error_code: 'stopped' })).toBeNull()
  expect(classify({ outcome: 'superseded' })).toBeNull()
  expect(classify({ outcome: 'target_closed' })).toBeNull()
})

it('counts a hold before publication and verified overdue CI while excluding a healthy draft or queue wait older than 24 hours', async () => {
  const f = setup()
  const held = f.seed(1)
  f.append(held, { type: 'chain.held', reason: 'Person held before PR creation' }, NOW - HOUR)
  for (const issue of [2, 3, 4]) {
    let chain = f.observe(f.seed(issue), NOW - 30 * HOUR, NOW - 30 * HOUR)
    const observation = structuredClone(chain.observation) as ChainObservation
    observation.checkedAt = NOW
    observation.publication.merged = false; observation.publication.merge_sha = null; observation.publication.state = 'open'
    Object.assign(observation.pull!, { merged: false, mergeSha: null, mergedAt: null, state: 'open', draft: issue === 2,
      queueEntry: issue === 3 ? 'queue-entry' : null, pending: true, headSince: NOW - 30 * HOUR })
    chain = f.append(chain, { type: 'chain.observed', observation }, NOW)
    expect(chain.mergeSha).toBeNull()
  }
  const report = await f.read()
  expect(report.blocked.count).toBe(2)
  expect(report.blocked.items.map(item => item.work)).toEqual(['acme/repo#1', 'acme/repo#4'])
  expect(report.blocked.oldestProgressAt).toBe(NOW - 48 * HOUR)
  expect(report.blocked.largestStage).toBe('Issue admission: 2')
  const polled = f.journal.read('acme/repo#4')!
  f.append(polled, { type: 'chain.observed', observation: { ...polled.observation, checkedAt: NOW } }, NOW)
  const again = await f.read()
  expect(again.blocked).toEqual(report.blocked)
})

it('requires verified retry progress, retains resolving outside help after merge, and leaves old ambiguous resumes unknown', async () => {
  const f = setup()
  for (const [issue, origin] of [[1, 'automatic'], [2, 'operator'], [3, 'unknown'], [4, 'resume-only']] as const) {
    let chain = f.observe(f.seed(issue), NOW - 5 * HOUR)
    chain = f.fail(chain, 'failure', NOW - 4 * HOUR)
    const call = chain.invocations.at(-1)!.callId!
    if (origin !== 'automatic') chain = f.append(chain, { type: 'chain.resumed', ...(origin === 'operator' ? { recovery: { origin, intervention: {
      callId: call, at: NOW - 3 * HOUR, verifiedAt: NOW - 3 * HOUR + 1000 } } } : origin === 'resume-only' ? { recovery: { origin: 'operator' as const } } : {}) }, NOW - 3 * HOUR + 2000)
    if (origin !== 'resume-only') {
      chain = f.succeed(chain, 'retry', NOW - 2 * HOUR)
      chain = f.observe(chain, NOW - 2 * HOUR + 1000, null, [17])
    }
    f.merge(chain, NOW - HOUR)
  }
  const report = await f.read()
  expect(report.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#1'])
  expect(report.recovery.intervention).toMatchObject([{ work: 'acme/repo#2', origin: 'operator', interventionAt: NOW - 3 * HOUR,
    progressAt: NOW - 2 * HOUR + 1000 }])
  expect(report.recovery.unknown).toBe(2)
  const polled = f.journal.read('acme/repo#2')!
  f.append(polled, { type: 'chain.observed', observation: { ...polled.observation, checkedAt: NOW } }, NOW)
  expect((await f.read()).recovery).toEqual(report.recovery)
})

it('takes the latest error from active work and preserves historical gaps after current source recovery', async () => {
  const f = setup()
  f.merge(f.fail(f.seed(1), 'finished', NOW - 3 * HOUR), NOW - 2 * HOUR)
  f.fail(f.seed(2), 'active', NOW - HOUR, 'transport_failed', 'ECONNRESET')
  f.input.history.gaps = [{ since: new Date(NOW - HOUR / 2).toISOString(), until: new Date(NOW - HOUR / 4).toISOString(), reason: 'unavailable' }]
  const report = await f.read()
  expect(report.lastError).toMatchObject({ error: { work: 'acme/repo#2', at: NOW - HOUR }, lastObserved: true })
  expect(report.coverage.find(source => source.name === 'Caller receipts')).toMatchObject({ status: 'ok', intervals: expect.arrayContaining([expect.objectContaining({ state: 'gap' })]) })
  expect((await f.read()).lastError).toEqual(report.lastError)
})

it('retains an original failed Call while its invocation is uncertain and after publication reconciliation succeeds', async () => {
  const f = setup()
  const template = f.fail(f.seed(1), 'template', NOW - 3 * HOUR).invocations[0]
  let chain = f.seed(2)
  const id = chainBasis('uncertain-original').slice(0, 32)
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { ...template, id, admittedAt: NOW - 2 * HOUR } }, NOW - 2 * HOUR)
  chain = f.append(chain, { type: 'invocation.started', invocationId: id }, NOW - 2 * HOUR)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { ...template.evidence,
    callId: id, completedAt: NOW - HOUR } }, NOW - HOUR)
  chain = f.append(chain, { type: 'invocation.uncertain', invocationId: id, reason: 'Original publication needs reconciliation' }, NOW - HOUR)
  expect((await f.read()).lastError.error).toMatchObject({ work: chain.id, callId: id, at: NOW - HOUR })
  chain = f.append(chain, { type: 'invocation.settled', invocationId: id, callId: id, outcome: 'commented', evidence: {
    status: 'completed', action: 'commented', outcome: 'commented', completedAt: NOW - HOUR / 2 } }, NOW - HOUR / 2)
  f.merge(chain, NOW - HOUR / 4)
  const report = await f.read()
  expect(report.rate).toMatchObject({ completed: 1, errors: 1, perItem: 1 })
  expect(report.lastError.error).toMatchObject({ work: chain.id, callId: id, at: NOW - HOUR })
})

it('reports covered error-free intervals, unknown coverage, excluded legacy work and unread accounts without covered zeroes', async () => {
  const f = setup()
  expect((await f.read()).lastError).toMatchObject({ error: null, lastObserved: false, coveredSince: NOW - 24 * HOUR, coveredUntil: NOW })
  f.input.history.coverageStart = null
  expect((await f.read()).lastError).toMatchObject({ error: null, coveredSince: null, coveredUntil: null })
  f.input.organizations[0].status = 'error'
  f.merge(f.seed(1), NOW - HOUR)
  const report = await f.read()
  expect(report.rate).toMatchObject({ completed: 1, perItem: null })
  expect(report.coverage.find(source => source.name === 'GitHub')!.status).toBe('error')
  expect(report.limits.join(' ')).toContain('uncorrelated legacy work excluded')
})
