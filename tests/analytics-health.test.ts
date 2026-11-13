import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { projectAnalyticsHealth, healthIntervals, workError, retryProven } from '../server/analytics-health'
import { BehaviorChainJournal, chainBasis, type BehaviorChain, type ChainEvent, type ChainInvocation } from '../server/behavior-chain-store'
import { nativeActionReceipt } from '../server/behavior-chain-action'
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
  return { db, journal, seed, append, observe, fail, succeed, finish, merge, read, input }
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

it('withholds only a zero-denominator or unknown merge-time rate, in words, while retaining known counts', async () => {
  const f = setup()
  expect((await f.read()).rate).toMatchObject({ completed: 0, perItem: null, withheld: 'no v2 work merged in the last 24 hours' })
  f.merge(f.fail(f.seed(1), 'old error', NOW - 30 * HOUR), NOW - HOUR)
  // A gap in the observational ledger during the item's life hides no work error: they come from the journal (#1381).
  f.input.history.gaps = [{ since: new Date(NOW - 40 * HOUR).toISOString(), until: new Date(NOW - 35 * HOUR).toISOString(), reason: 'unavailable' }]
  expect(healthIntervals(f.input.history, NOW - 24 * HOUR, NOW).every(part => part.state === 'covered')).toBe(true)
  const report = await f.read()
  expect(report.rate).toMatchObject({ completed: 1, errors: 1, perItem: 1, unsettled: 0, withheld: null })
  expect(report.limits.join(' ')).not.toContain('incomplete lifetime evidence')
  expect(report.coverage.find(source => source.name === 'Caller receipts')!.intervals!.some(part => part.state === 'gap')).toBe(true)
  f.append(f.seed(2), { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: 'acme/repo', pull_number: 102, merged: true, merge_sha: MERGE } }, NOW)
  const unknown = await f.read()
  expect(unknown.limits.join(' ')).toContain('original GitHub merge time unavailable')
  expect(unknown.rate).toMatchObject({ completed: 1, errors: 1, perItem: null, withheld: expect.stringContaining('merge time for acme/repo#2 is unknown') })
})

it('verifies a merge from GitHub\'s merge facts in any observation: a lagging publication or an existing pull request (#1381)', async () => {
  const f = setup()
  // The first merged read still has Poise's publication open on its head; the next agrees.
  const agreeing = structuredClone(f.observe(f.seed(8), NOW - 2 * HOUR, NOW - 2 * HOUR).observation) as ChainObservation
  Object.assign(agreeing.publication, { pull_number: 101 }); agreeing.pull!.number = 101
  const behind = structuredClone(agreeing)
  Object.assign(behind.publication, { merged: false, merge_sha: HEAD, state: 'open' })
  let lagging = f.append(f.seed(1), { type: 'chain.observed', observation: behind }, NOW - 2 * HOUR)
  lagging = f.append(lagging, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: 'acme/repo', pull_number: 101, merged: true, merge_sha: MERGE, review_complete: true } }, NOW - 2 * HOUR)
  lagging = f.append(lagging, { type: 'chain.observed', observation: { ...agreeing, checkedAt: NOW - 2 * HOUR + 1 } }, NOW - 2 * HOUR + 1)
  // An existing pull request closed the seed: the chain has no publication of its own.
  let existing = f.seed(2)
  const outside = structuredClone(f.observe(f.seed(9), NOW - HOUR, NOW - HOUR).observation) as ChainObservation
  Object.assign(outside.publication, { pull_number: null, head_sha: null, state: null, merged: false, merge_sha: null })
  existing = f.append(existing, { type: 'chain.observed', observation: outside }, NOW - HOUR)
  existing = f.append(existing, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: 'acme/repo', pull_number: 109, merged: true, merge_sha: MERGE, review_complete: false } }, NOW - HOUR)
  const report = await f.read()
  expect(report.rate).toMatchObject({ completed: 2, errors: 0, perItem: 0, withheld: null })
  expect(report.rate.items.map(item => item.work).sort()).toEqual(['acme/repo#1', 'acme/repo#2'])
  // A merged pull request that is not the chain's own publication proves nothing.
  let other = f.seed(3)
  const foreign = structuredClone(outside)
  Object.assign(foreign.publication, { pull_number: 555 })
  other = f.append(other, { type: 'chain.observed', observation: foreign }, NOW - HOUR)
  f.append(other, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: 'acme/repo', pull_number: 109, merged: true, merge_sha: MERGE, review_complete: false } }, NOW - HOUR)
  expect((await f.read()).rate).toMatchObject({ perItem: null, withheld: expect.stringContaining('acme/repo#3') })
})

it('shows a lower bound while a counted item still has a run being reconciled (#1381)', async () => {
  const f = setup()
  const template = f.fail(f.seed(1), 'template', NOW - 5 * HOUR).invocations[0]
  f.merge(f.seed(2), NOW - HOUR)
  let chain = f.seed(3)
  const id = chainBasis('still-reconciling').slice(0, 32)
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { ...template, id, admittedAt: NOW - 3 * HOUR } }, NOW - 3 * HOUR)
  chain = f.append(chain, { type: 'invocation.started', invocationId: id }, NOW - 3 * HOUR)
  chain = f.append(chain, { type: 'invocation.uncertain', invocationId: id, reason: 'Original outcome requires read-only reconciliation' }, NOW - 2 * HOUR)
  chain = f.observe(chain, NOW - HOUR, NOW - HOUR)
  f.append(chain, { type: 'chain.merged', mergeSha: MERGE, evidence: { repository: chain.repository, pull_number: 103, merged: true, merge_sha: MERGE, review_complete: false } }, NOW - HOUR)
  const report = await f.read()
  expect(report.rate).toMatchObject({ completed: 2, errors: 0, perItem: 0, unsettled: 1, withheld: null })
  expect(report.limits.join(' ')).toContain('acme/repo#3: a run admitted before its merge is still unsettled')
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

it('counts a failed native Call whose accepted response settled as completed via nativeCallStatus', () => {
  const f = setup()
  const chain = f.fail(f.seed(1), 'auth', NOW - HOUR)
  const invocation = chain.invocations[0]
  const settled = { ...invocation, evidence: { ...invocation.evidence, status: 'completed', nativeCallStatus: 'failed' } } as ChainInvocation
  expect(workError(chain, settled)).toMatchObject({ at: NOW - HOUR })
  const clean = { ...invocation, evidence: { ...invocation.evidence, status: 'completed', nativeCallStatus: 'completed' } } as ChainInvocation
  expect(workError(chain, clean)).toBeNull()
})

it('proves publish-issue retries through --invocation-id and rerun-grey-ci through greyRecovery', () => {
  const f = setup()
  const chain = f.observe(f.seed(1), NOW - HOUR)
  const original = 'a'.repeat(32)
  const publishRetry = { id: 'retry-publish', behavior: 'publish-issue', callId: null,
    request: { command: 'github-interface', argv: ['--issue-work', '1', '--invocation-id', original, '--expected-head', HEAD], cwd: '/fixture' },
    evidence: { action: 'published', outcome: 'published', head_sha: HEAD } } as unknown as ChainInvocation
  const publication = { ...(chain.observation as ChainObservation).publication, head_sha: HEAD, head_invocation: original }
  const pull = { ...((chain.observation as ChainObservation).pull!), head: HEAD }
  const observation = { ...(chain.observation as ChainObservation), checkedAt: NOW, publication, pull } as ChainObservation
  expect(retryProven(chain, publishRetry, observation, NOW)).toBe(true)
  expect(retryProven(chain, { ...publishRetry, callId: 'b'.repeat(32) } as ChainInvocation,
    { ...observation, publication: { ...publication, head_invocation: 'b'.repeat(32) } } as ChainObservation, NOW)).toBe(false)
  const greyRetry = { id: 'retry-grey', behavior: 'rerun-grey-ci', callId: null,
    request: { command: 'github-interface', argv: [], cwd: '/fixture' },
    evidence: { status: 'completed' } } as unknown as ChainInvocation
  expect(retryProven(chain, greyRetry, { ...observation, greyRecovery: { invocationId: 'retry-grey', receipt: { outcome: 'rerun_observed' } } }, NOW)).toBe(true)
  expect(retryProven(chain, greyRetry, { ...observation, greyRecovery: { invocationId: 'other', receipt: { outcome: 'rerun_observed' } } }, NOW)).toBe(false)
})

it('uses the latest operator resume and accepts cross-chain reconnect evidence', async () => {
  const f = setup()
  let first = f.observe(f.seed(1), NOW - 32 * HOUR)
  first = f.fail(first, 'failure', NOW - 30 * HOUR)
  const sameCall = first.invocations.at(-1)!.callId!
  first = f.append(first, { type: 'chain.resumed', recovery: { origin: 'operator', intervention: {
    callId: sameCall, at: NOW - 28 * HOUR, verifiedAt: NOW - 28 * HOUR + 1000 } } }, NOW - 28 * HOUR + 2000)
  first = f.append(first, { type: 'chain.resumed', recovery: { origin: 'operator', intervention: {
    callId: sameCall, at: NOW - 3 * HOUR, verifiedAt: NOW - 3 * HOUR + 1000 } } }, NOW - 3 * HOUR + 2000)
  first = f.succeed(first, 'retry', NOW - 2 * HOUR)
  first = f.observe(first, NOW - 2 * HOUR + 1000, null, [17])
  f.merge(first, NOW - HOUR)
  let second = f.observe(f.seed(2), NOW - 5 * HOUR)
  second = f.fail(second, 'failure', NOW - 4 * HOUR)
  second = f.append(second, { type: 'chain.resumed', recovery: { origin: 'operator', intervention: {
    callId: 'c'.repeat(32), at: NOW - 3 * HOUR, verifiedAt: NOW - 3 * HOUR + 1000 } } }, NOW - 3 * HOUR + 2000)
  second = f.succeed(second, 'retry', NOW - 2 * HOUR)
  second = f.observe(second, NOW - 2 * HOUR + 1000, null, [17])
  f.merge(second, NOW - HOUR)
  const report = await f.read()
  expect(report.recovery.intervention.map(item => item.work).sort()).toEqual(['acme/repo#1', 'acme/repo#2'])
  expect(report.recovery.intervention.find(item => item.work === 'acme/repo#1')).toMatchObject({ interventionAt: NOW - 3 * HOUR })
})

it('proves publish-issue retries with the native issue_work action and nested receipts', () => {
  const f = setup()
  const chain = f.observe(f.seed(1), NOW - HOUR)
  const original = 'a'.repeat(32)
  const publication = { ...(chain.observation as ChainObservation).publication, head_sha: HEAD, head_invocation: original }
  const pull = { ...((chain.observation as ChainObservation).pull!), head: HEAD }
  const observation = { ...(chain.observation as ChainObservation), checkedAt: NOW, publication, pull } as ChainObservation
  const argv = ['--issue-work', '1', '--invocation-id', original, '--expected-head', HEAD]
  const native = { id: 'retry-publish', behavior: 'publish-issue', callId: null,
    request: { command: 'github-interface', argv, cwd: '/fixture' },
    evidence: { action: 'issue_work', outcome: 'published', head_sha: HEAD } } as unknown as ChainInvocation
  expect(retryProven(chain, native, observation, NOW)).toBe(true)
  const nested = { id: 'retry-publish', behavior: 'publish-issue', callId: null,
    request: { command: 'github-interface', argv, cwd: '/fixture' },
    evidence: { status: 'completed', outcome: 'published', head_sha: HEAD,
      nativeActionResult: { action: 'issue_work', outcome: 'published', head_sha: HEAD } } } as unknown as ChainInvocation
  expect(retryProven(chain, nested, observation, NOW)).toBe(true)
  const wrong = { ...native, evidence: { action: 'issue_work', outcome: 'published', head_sha: HEAD } } as unknown as ChainInvocation
  expect(retryProven(chain, wrong, { ...observation, publication: { ...publication, head_invocation: 'b'.repeat(32) } } as ChainObservation, NOW)).toBe(false)
})

it('proves rerun-grey-ci retries from settled evidence after the observation drops greyRecovery', () => {
  const f = setup()
  const chain = f.observe(f.seed(1), NOW - HOUR)
  const argv = ['--rerun-grey-ci-if-ready', '1', '--run-id', '123', '--run-attempt', '2', '--expected-head', HEAD]
  const retry = { id: 'retry-grey', behavior: 'rerun-grey-ci', callId: null,
    request: { command: 'github-interface', argv, cwd: '/fixture' },
    evidence: { status: 'completed', outcome: 'rerun_observed', head_sha: HEAD, run_id: 123, run_attempt: 2 } } as unknown as ChainInvocation
  const pull = { ...((chain.observation as ChainObservation).pull!), head: HEAD }
  const observation = { ...(chain.observation as ChainObservation), checkedAt: NOW, pull } as unknown as ChainObservation
  delete (observation as Record<string, unknown>).greyRecovery
  expect(retryProven(chain, retry, observation, NOW)).toBe(true)
  expect(retryProven(chain, { ...retry, evidence: { ...retry.evidence, head_sha: 'c'.repeat(40) } } as unknown as ChainInvocation, observation, NOW)).toBe(false)
})

it('proves rerun-grey-ci retries from a normal rerun_requested receipt with verified CI progress', () => {
  const f = setup()
  const chain = f.observe(f.seed(1), NOW - HOUR)
  const argv = ['--rerun-grey-ci-if-ready', '1', '--run-id', '123', '--run-attempt', '2', '--expected-head', HEAD]
  const retry = { id: 'retry-grey', behavior: 'rerun-grey-ci', callId: null,
    request: { command: 'github-interface', argv, cwd: '/fixture' },
    evidence: { status: 'completed', outcome: 'rerun_requested', head_sha: HEAD, run_id: 123, run_attempt: 2 } } as unknown as ChainInvocation
  const pull = { ...((chain.observation as ChainObservation).pull!), head: HEAD }
  const observation = { ...(chain.observation as ChainObservation), checkedAt: NOW, pull } as unknown as ChainObservation
  delete (observation as Record<string, unknown>).greyRecovery
  expect(retryProven(chain, retry, observation, NOW)).toBe(true)
  expect(retryProven(chain, { ...retry, evidence: { ...retry.evidence, outcome: 'not_ready' } } as unknown as ChainInvocation, observation, NOW)).toBe(false)
})

it('proves resolve-threads retries through settlement when the receipt carries no outcome', () => {
  const f = setup()
  let chain = f.seed(1)
  const admittedAt = NOW - 2 * HOUR
  const invocation = { id: 'resolve-1', behavior: 'resolve-threads', actor: 'reviewer', slot: null, basis: 'resolve',
    model: null, admittedAt, request: { command: 'github-interface', cwd: '/fixture',
      argv: ['--resolve-nonblocking-conversations-if-ready', '1', '--username', 'reviewer', '--expected-head', HEAD, '--token-user', 'reviewer'] },
    evidence: null } as unknown as ChainInvocation
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id: invocation.id, behavior: invocation.behavior,
    actor: invocation.actor, slot: null, basis: 'resolve', model: null, admittedAt, request: invocation.request } }, admittedAt)
  const result = { action: 'resolved_nonblocking_conversations_if_ready', repository: 'acme/repo', pull_number: 1, head_sha: HEAD,
    ready_except_conversations: true, resolved_count: 1, unresolved_count: 0, conversations: [{ id: '1', isResolved: true }] }
  const proof = nativeActionReceipt(chain, { ...invocation, request: invocation.request } as ChainInvocation, result, NOW - HOUR)
  const retry = { ...invocation, evidence: { status: 'completed', nativeActionReceipt: proof } } as unknown as ChainInvocation
  const observation = { checkedAt: NOW } as ChainObservation
  expect(proof.result.outcome).toBeUndefined()
  expect(retryProven(chain, retry, observation, NOW)).toBe(true)
})

it('excludes confirmed closed seeds without a PR from blocked work', async () => {
  const f = setup()
  let chain = f.seed(1)
  const reviewer = { model: 'fixture', slot: 'primary', recovery: 'fixture' }
  const closed: ChainObservation = { checkedAt: NOW, existingPulls: [], issue: { open: false, eligible: true, revision: 'issue', commentIds: [] },
    issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer,
    prerequisites: { wait: null, base: HEAD, evidence: [] },
    publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null }, pull: null }
  chain = f.append(chain, { type: 'chain.observed', observation: closed }, NOW - HOUR)
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id: chainBasis(`${chain.id}:closed`).slice(0, 32),
    behavior: 'review-issue', actor: 'reviewer', slot: 'primary', basis: 'issue', model: 'fixture',
    admittedAt: NOW - 48 * HOUR, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, NOW - 48 * HOUR)
  chain = f.append(chain, { type: 'invocation.started', invocationId: chain.invocations[0].id }, NOW - 48 * HOUR + 1)
  chain = f.append(chain, { type: 'invocation.settled', invocationId: chain.invocations[0].id, callId: chain.invocations[0].id,
    outcome: 'commented', evidence: { status: 'completed', action: 'commented', outcome: 'commented', completedAt: NOW - 47 * HOUR } }, NOW - 47 * HOUR)
  const report = await f.read()
  expect(report.blocked.count).toBe(0)
  expect(report.blocked.items).toEqual([])
})

it('excludes a held binding retired by a different merged closing PR', async () => {
  const f = setup()
  const reviewer = { model: 'fixture', slot: 'primary', recovery: 'fixture' }
  const closing = 'https://github.com/acme/repo/pull/1260'
  const TEST_MERGE = '307c8a031acceae31843add8e66d97ce93ef5e13'
  const makeClosed = (existingPulls: string[], externalMerge?: ChainObservation['externalMerge']): ChainObservation => ({
    checkedAt: NOW, existingPulls, issue: { open: false, eligible: true, revision: 'issue', commentIds: [] },
    issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer,
    prerequisites: { wait: null, base: HEAD, evidence: [] },
    publication: { pull_number: 1259, head_sha: HEAD, head_invocation: null, state: 'closed', merged: false, merge_sha: TEST_MERGE },
    pull: { number: 1259, head: HEAD, headSince: NOW - HOUR, state: 'closed', draft: false, merged: false, mergeSha: null,
      mergedAt: null, queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'review', greyRuns: [], pending: false, failing: [], conflict: false, behind: false, checksState: null },
    ...(externalMerge === undefined ? {} : { externalMerge }),
  })
  const settle = (issue: number, observation: ChainObservation) => {
    let chain = f.seed(issue)
    chain = f.append(chain, { type: 'invocation.admitted', invocation: { id: chainBasis(`${chain.id}:closed`).slice(0, 32),
      behavior: 'review-issue', actor: 'reviewer', slot: 'primary', basis: 'issue', model: 'fixture',
      admittedAt: NOW - 48 * HOUR, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, NOW - 48 * HOUR)
    chain = f.append(chain, { type: 'invocation.started', invocationId: chain.invocations[0].id }, NOW - 48 * HOUR + 1)
    chain = f.append(chain, { type: 'invocation.settled', invocationId: chain.invocations[0].id, callId: chain.invocations[0].id,
      outcome: 'commented', evidence: { status: 'completed', action: 'commented', outcome: 'commented', completedAt: NOW - 47 * HOUR } }, NOW - 47 * HOUR)
    chain = f.append(chain, { type: 'chain.observed', observation }, NOW - HOUR)
    return f.append(chain, { type: 'chain.held', reason: `seed issue already belongs to existing work: ${closing}` }, NOW - HOUR + 1)
  }
  const retired = settle(1, makeClosed([closing], { pull_number: 1260, merge_sha: MERGE }))
  const missing = settle(2, makeClosed([closing]))
  const extra = settle(3, makeClosed([closing, 'https://github.com/acme/repo/pull/1261'], { pull_number: 1260, merge_sha: MERGE }))
  const incomplete = settle(4, makeClosed([closing], { pull_number: 1260 } as unknown as ChainObservation['externalMerge']))
  expect(f.journal.page('', 100, false).map(chain => chain.id)).toEqual([missing.id, extra.id, incomplete.id].sort())
  const report = await f.read()
  expect(report.blocked.count).toBe(3)
  expect(report.blocked.items.map(item => item.work).sort()).toEqual([missing.id, extra.id, incomplete.id].sort())
  expect(report.blocked.items.map(item => item.work)).not.toContain(retired.id)
})

it('counts a pre-merge failure reconciled after merging via its admitted attempt', async () => {
  const f = setup()
  let chain = f.seed(1)
  const id = chainBasis(`${chain.id}:delayed`).slice(0, 32)
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id, behavior: 'review-issue', actor: 'reviewer', slot: 'primary',
    basis: 'issue', model: 'fixture', admittedAt: NOW - 5 * HOUR, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, NOW - 5 * HOUR)
  chain = f.observe(chain, NOW - 2 * HOUR, NOW - HOUR)
  chain = f.append(chain, { type: 'chain.merged', mergeSha: MERGE,
    evidence: { repository: chain.repository, pull_number: chain.issue + 100, merged: true, merge_sha: MERGE, review_complete: false } }, NOW - HOUR)
  chain = f.append(chain, { type: 'invocation.settled', invocationId: id, callId: id, outcome: 'preflight_failed',
    evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed', error_code: 'authentication_failed', error: 'delayed', completedAt: NOW } }, NOW)
  const report = await f.read()
  expect(report.rate).toMatchObject({ completed: 1, errors: 1 })
})

it('counts a deferred native failure with failed nativeCallStatus toward its verified retry recovery', async () => {
  const f = setup()
  let chain = f.observe(f.seed(11), NOW - 5 * HOUR)
  const failedId = chainBasis(`${chain.id}:deferred-fail`).slice(0, 32)
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id: failedId, behavior: 'review-issue', actor: 'reviewer', slot: 'primary',
    basis: 'issue', model: 'fixture', admittedAt: NOW - 4 * HOUR, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, NOW - 4 * HOUR)
  chain = f.append(chain, { type: 'invocation.started', invocationId: failedId }, NOW - 4 * HOUR + 500)
  chain = f.append(chain, { type: 'invocation.settled', invocationId: failedId, callId: failedId, outcome: 'preflight_failed',
    evidence: { status: 'deferred', nativeCallStatus: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error_code: 'authentication_failed', error: 'Refresh credential rejected', completedAt: NOW - 4 * HOUR } }, NOW - 4 * HOUR)
  chain = f.succeed(chain, 'retry', NOW - 2 * HOUR)
  chain = f.observe(chain, NOW - 2 * HOUR + 1000, null, [17])
  f.merge(chain, NOW - HOUR)
  const report = await f.read()
  expect(report.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#11'])
  expect(report.recovery.unknown).toBe(0)
})

it('counts a grey-CI recovery whose verified CI success precedes its settlement', async () => {
  const f = setup()
  const reviewer = { model: 'fixture', slot: 'primary', recovery: 'fixture' }
  const openPull = (at: number, pending: boolean, checksState: string | null): ChainObservation => ({
    checkedAt: at, existingPulls: [], issue: { open: true, eligible: true, revision: 'issue', commentIds: [] },
    issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer,
    prerequisites: { wait: null, base: HEAD, evidence: [] },
    publication: { pull_number: 111, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null },
    pull: { number: 111, head: HEAD, headSince: NOW - 5 * HOUR, state: 'open', draft: false, merged: false, mergeSha: null,
      mergedAt: null, queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'review', greyRuns: [], pending, failing: [], conflict: false, behind: false, checksState } })
  let chain = f.seed(12)
  chain = f.append(chain, { type: 'chain.observed', observation: openPull(NOW - 5 * HOUR, true, 'PENDING') }, NOW - 5 * HOUR)
  const basis = chainBasis(['grey', HEAD, 123, 2])
  const failedId = chainBasis(`${chain.id}:grey-fail`).slice(0, 32)
  const failedAt = NOW - 4 * HOUR
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id: failedId, behavior: 'rerun-grey-ci', actor: 'reviewer', slot: null,
    basis, model: null, admittedAt: failedAt, request: { command: 'github-interface',
      argv: ['--rerun-grey-ci-if-ready', '12', '--run-id', '123', '--run-attempt', '2', '--expected-head', HEAD], cwd: '/fixture' } } }, failedAt)
  chain = f.append(chain, { type: 'invocation.settled', invocationId: failedId, callId: failedId, outcome: 'read_failed',
    evidence: { status: 'failed', action: 'not_started', outcome: 'read_failed', error: 'grey workflow read failed',
      head_sha: HEAD, run_id: 123, run_attempt: 2, completedAt: failedAt } }, failedAt)
  const retryId = chainBasis(`${chain.id}:grey-retry`).slice(0, 32)
  const retryAdmittedAt = NOW - 3 * HOUR
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id: retryId, behavior: 'rerun-grey-ci', actor: 'reviewer', slot: null,
    basis, model: null, admittedAt: retryAdmittedAt, request: { command: 'github-interface',
      argv: ['--rerun-grey-ci-if-ready', '12', '--run-id', '123', '--run-attempt', '2', '--expected-head', HEAD], cwd: '/fixture' } } }, retryAdmittedAt)
  const observedAt = NOW - 2 * HOUR
  const proving = openPull(observedAt, false, 'SUCCESS') as ChainObservation & { greyRecovery: { invocationId: string, receipt: Record<string, unknown> } }
  proving.greyRecovery = { invocationId: retryId, receipt: { outcome: 'rerun_observed', action: 'rerun_grey_ci_if_ready',
    repository: 'acme/repo', pull_number: 12, head_sha: HEAD, run_id: 123, run_attempt: 2, observed_run_attempt: 3 } }
  chain = f.append(chain, { type: 'chain.observed', observation: proving }, observedAt)
  const settledAt = NOW - 2 * HOUR + 500
  chain = f.append(chain, { type: 'invocation.settled', invocationId: retryId, callId: null, outcome: 'rerun_observed',
    evidence: { status: 'completed', outcome: 'rerun_observed', head_sha: HEAD, run_id: 123, run_attempt: 2 } }, settledAt)
  const report = await f.read()
  expect(report.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#12'])
  expect(report.recovery.unknown).toBe(0)
})

it('counts automatic recovery through a ciRecovery resume without a recovery field', async () => {
  const f = setup()
  let chain = f.observe(f.seed(1), NOW - 5 * HOUR)
  chain = f.fail(chain, 'failure', NOW - 4 * HOUR)
  chain = f.append(chain, { type: 'chain.resumed', ciRecovery: { invocationId: 'i'.repeat(8), callId: 'c'.repeat(32), head: HEAD } }, NOW - 3 * HOUR)
  chain = f.succeed(chain, 'retry', NOW - 2 * HOUR)
  chain = f.observe(chain, NOW - 2 * HOUR + 1000, null, [17])
  f.merge(chain, NOW - HOUR)
  const report = await f.read()
  expect(report.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#1'])
  expect(report.recovery.unknown).toBe(0)
})

it('counts failed native_publication Calls stored under publicationReceipt', async () => {
  const f = setup()
  const nativeCall = 'd'.repeat(32)
  const failedReceipt = { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
    error_code: 'authentication_failed', error: 'Refresh credential rejected',
    completedAt: NOW - 3 * HOUR, callId: nativeCall }
  const template = f.fail(f.seed(9), 'template', NOW - 4 * HOUR)
  const invocation = template.invocations[0]
  expect(workError(template, { ...invocation, evidence: { publicationReceipt: failedReceipt } } as unknown as ChainInvocation))
    .toMatchObject({ callId: nativeCall, at: NOW - 3 * HOUR })
  expect(workError(template, { ...invocation, evidence: { status: 'completed', publicationReceipt: { ...failedReceipt, status: 'completed' } } } as unknown as ChainInvocation))
    .toBeNull()
  let chain = f.seed(1)
  const id = chainBasis(`${chain.id}:publication-fail`).slice(0, 32)
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id, behavior: 'review-issue', actor: 'reviewer', slot: 'primary',
    basis: 'issue', model: 'fixture', admittedAt: NOW - 4 * HOUR, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, NOW - 4 * HOUR)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { publicationReceipt: failedReceipt } }, NOW - 3 * HOUR)
  chain = f.observe(chain, NOW - HOUR, NOW - HOUR)
  chain = f.append(chain, { type: 'chain.merged', mergeSha: MERGE,
    evidence: { repository: chain.repository, pull_number: chain.issue + 100, merged: true, merge_sha: MERGE, review_complete: false } }, NOW - HOUR)
  const report = await f.read()
  expect(report.rate).toMatchObject({ completed: 1, errors: 1, perItem: 1 })
  expect(report.lastError.error).toMatchObject({ work: chain.id, callId: nativeCall, at: NOW - 3 * HOUR })
})

it('ignores an operator resume after a same-invocation publicationResume launch', async () => {
  const f = setup()
  let chain = f.observe(f.seed(1), NOW - 5 * HOUR)
  const id = chainBasis(`${chain.id}:same-publication`).slice(0, 32)
  const admittedAt = NOW - 4 * HOUR
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id, behavior: 'review-issue', actor: 'reviewer', slot: 'primary',
    basis: 'issue', model: 'fixture', admittedAt, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, admittedAt)
  chain = f.append(chain, { type: 'invocation.started', invocationId: id }, admittedAt + 500)
  const failedCall = 'f'.repeat(32)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { status: 'failed', action: 'not_started',
    outcome: 'preflight_failed', error_code: 'authentication_failed', error: 'Refresh credential rejected',
    completedAt: NOW - 4 * HOUR, callId: failedCall } }, NOW - 4 * HOUR)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { publicationResume: {
    callId: failedCall, head: HEAD, plan: 'plan', correlation: 'corr-launch' }, publicationReceipt: null } }, NOW - 3 * HOUR)
  chain = f.append(chain, { type: 'chain.resumed', recovery: { origin: 'operator', intervention: {
    callId: failedCall, at: NOW - 2 * HOUR - 30 * 60_000, verifiedAt: NOW - 2 * HOUR - 30 * 60_000 + 1000 } } }, NOW - 2 * HOUR - 30 * 60_000 + 2000)
  chain = f.append(chain, { type: 'invocation.settled', invocationId: id, callId: failedCall, outcome: 'commented', evidence: {
    status: 'completed', action: 'commented', outcome: 'commented', completedAt: NOW - 2 * HOUR,
    issue_revision: 'issue', error: '', receipts: [{ issue: chain.id, author: 'reviewer', comment_id: 17 }] } }, NOW - 2 * HOUR)
  chain = f.observe(chain, NOW - 2 * HOUR + 1000, null, [17])
  f.merge(chain, NOW - HOUR)
  const report = await f.read()
  expect(report.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#1'])
  expect(report.recovery.intervention).toEqual([])
  expect(report.recovery.unknown).toBe(0)
})

it('proves publish-issue retries reconciled after a lost response with null action', () => {
  const f = setup()
  const chain = f.observe(f.seed(1), NOW - HOUR)
  const original = 'a'.repeat(32)
  const publication = { ...(chain.observation as ChainObservation).publication, head_sha: HEAD, head_invocation: original }
  const pull = { ...((chain.observation as ChainObservation).pull!), head: HEAD }
  const observation = { ...(chain.observation as ChainObservation), checkedAt: NOW, publication, pull } as ChainObservation
  const argv = ['--issue-work', '1', '--invocation-id', original, '--expected-head', HEAD]
  // recover() settles a lost-response retry with outcome published while the
  // reconciled placeholder keeps action null; verified heads still prove it.
  const reconciled = { id: 'retry-publish', behavior: 'publish-issue', callId: null,
    request: { command: 'github-interface', argv, cwd: '/fixture' },
    evidence: { status: 'completed', action: null, outcome: 'published', head_sha: HEAD } } as unknown as ChainInvocation
  expect(retryProven(chain, reconciled, observation, NOW)).toBe(true)
  const wrongAction = { ...reconciled, evidence: { ...reconciled.evidence, action: 'not_started' } } as unknown as ChainInvocation
  expect(retryProven(chain, wrongAction, observation, NOW)).toBe(false)
})

it('uses the latest publicationResume launch when an earlier launch was cleared', async () => {
  const f = setup()
  let chain = f.observe(f.seed(1), NOW - 5 * HOUR)
  const id = chainBasis(`${chain.id}:cleared-launch`).slice(0, 32)
  const admittedAt = NOW - 4 * HOUR
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id, behavior: 'review-issue', actor: 'reviewer', slot: 'primary',
    basis: 'issue', model: 'fixture', admittedAt, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, admittedAt)
  chain = f.append(chain, { type: 'invocation.started', invocationId: id }, admittedAt + 500)
  const failedCall = 'f'.repeat(32)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { status: 'failed', action: 'not_started',
    outcome: 'preflight_failed', error_code: 'authentication_failed', error: 'Refresh credential rejected',
    completedAt: NOW - 4 * HOUR, callId: failedCall } }, NOW - 4 * HOUR)
  // Abandoned launch cleared after a CallerReceiptStoreError.
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { publicationResume: {
    callId: failedCall, head: HEAD, plan: 'plan', correlation: 'corr-abandoned' }, publicationReceipt: null } }, NOW - 3 * HOUR)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: {
    publicationResume: null, publicationResumeError: 'CallerReceiptStoreError: readable' } }, NOW - 3 * HOUR + 500)
  // Operator help arrives before the retry that actually succeeds.
  chain = f.append(chain, { type: 'chain.resumed', recovery: { origin: 'operator', intervention: {
    callId: failedCall, at: NOW - 2 * HOUR - 30 * 60_000, verifiedAt: NOW - 2 * HOUR - 30 * 60_000 + 1000 } } }, NOW - 2 * HOUR - 30 * 60_000 + 2000)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { publicationResume: {
    callId: failedCall, head: HEAD, plan: 'plan', correlation: 'corr-success' }, publicationReceipt: null } }, NOW - 2 * HOUR - HOUR / 2)
  chain = f.append(chain, { type: 'invocation.settled', invocationId: id, callId: failedCall, outcome: 'commented', evidence: {
    status: 'completed', action: 'commented', outcome: 'commented', completedAt: NOW - 2 * HOUR,
    issue_revision: 'issue', error: '', receipts: [{ issue: chain.id, author: 'reviewer', comment_id: 17 }] } }, NOW - 2 * HOUR)
  chain = f.observe(chain, NOW - 2 * HOUR + 1000, null, [17])
  f.merge(chain, NOW - HOUR)
  const report = await f.read()
  expect(report.recovery.intervention.map(item => item.work)).toEqual(['acme/repo#1'])
  expect(report.recovery.automatic).toEqual([])
  expect(report.recovery.unknown).toBe(0)
})

it('requires same-invocation progress after the success settlement, not a pre-launch head', async () => {
  const f = setup()
  const HEAD2 = 'c'.repeat(40)
  const failedCall = 'e'.repeat(32)
  const reviewer = { model: 'fixture', slot: 'primary', recovery: 'fixture' }
  const makeObservation = (at: number, head: string, merged: boolean): ChainObservation => ({
    checkedAt: at, existingPulls: [], issue: { open: true, eligible: true, revision: 'issue', commentIds: [] },
    issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer,
    prerequisites: { wait: null, base: HEAD, evidence: [] },
    publication: { pull_number: 101, head_sha: head, head_invocation: failedCall,
      state: merged ? 'closed' : 'open', merged, merge_sha: merged ? MERGE : null },
    pull: { number: 101, head, headSince: at, state: merged ? 'closed' : 'open', draft: false, merged,
      mergeSha: merged ? MERGE : null, mergedAt: merged ? NOW - HOUR : null, queueEntry: null, queueRemoval: null,
      changesRequested: false, unresolved: 0, approved: false, ready: true,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'review', greyRuns: [], pending: false, failing: [], conflict: false, behind: false, checksState: 'SUCCESS' } })
  let chain = f.seed(1, NOW - 48 * HOUR)
  chain = f.append(chain, { type: 'chain.observed', observation: makeObservation(NOW - 35 * HOUR, HEAD, false) }, NOW - 35 * HOUR)
  const id = chainBasis(`${chain.id}:repair-continuation`).slice(0, 32)
  const admittedAt = NOW - 30 * HOUR
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id, behavior: 'repair-pr', actor: 'reviewer', slot: 'primary',
    basis: 'issue', model: 'fixture', admittedAt, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, admittedAt)
  chain = f.append(chain, { type: 'invocation.started', invocationId: id }, admittedAt + 500)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { status: 'failed', action: 'not_started',
    outcome: 'preflight_failed', error_code: 'authentication_failed', error: 'Refresh credential rejected',
    completedAt: NOW - 30 * HOUR, callId: failedCall } }, NOW - 30 * HOUR)
  // New head observed before the retry launches: stale completedAt would
  // otherwise accept it as recovery progress outside the 24-hour window.
  chain = f.append(chain, { type: 'chain.observed', observation: makeObservation(NOW - 29 * HOUR, HEAD2, false) }, NOW - 29 * HOUR)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { publicationResume: {
    callId: failedCall, head: HEAD2, plan: 'plan', correlation: 'corr-launch' }, publicationReceipt: null } }, NOW - 28 * HOUR)
  // recover() preserves the failed Call completedAt on the same invocation.
  chain = f.append(chain, { type: 'invocation.settled', invocationId: id, callId: failedCall, outcome: 'published', evidence: {
    status: 'completed', action: 'published', outcome: 'published', head_sha: HEAD2, completedAt: NOW - 30 * HOUR } }, NOW - 2 * HOUR)
  chain = f.append(chain, { type: 'chain.observed', observation: makeObservation(NOW - 2 * HOUR + 1000, HEAD2, false) }, NOW - 2 * HOUR + 1000)
  chain = f.append(chain, { type: 'chain.observed', observation: makeObservation(NOW - HOUR, HEAD2, true) }, NOW - HOUR)
  chain = f.append(chain, { type: 'chain.merged', mergeSha: MERGE,
    evidence: { repository: chain.repository, pull_number: 101, merged: true, merge_sha: MERGE, review_complete: true } }, NOW - HOUR)
  const report = await f.read()
  expect(report.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#1'])
  expect(report.recovery.unknown).toBe(0)
})

it('counts automatic recovery when recover() settles the original invocation after a reconciled failure', async () => {
  const f = setup()
  let chain = f.observe(f.seed(1), NOW - 5 * HOUR)
  const id = chainBasis(`${chain.id}:same-retry`).slice(0, 32)
  const admittedAt = NOW - 4 * HOUR
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id, behavior: 'review-issue', actor: 'reviewer', slot: 'primary',
    basis: 'issue', model: 'fixture', admittedAt, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, admittedAt)
  chain = f.append(chain, { type: 'invocation.started', invocationId: id }, admittedAt + 500)
  const failedCall = 'e'.repeat(32)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { status: 'failed', action: 'not_started',
    outcome: 'preflight_failed', error_code: 'authentication_failed', error: 'Refresh credential rejected',
    completedAt: NOW - 4 * HOUR, callId: failedCall } }, NOW - 4 * HOUR)
  chain = f.append(chain, { type: 'invocation.settled', invocationId: id, callId: failedCall, outcome: 'commented', evidence: {
    status: 'completed', action: 'commented', outcome: 'commented', completedAt: NOW - 2 * HOUR,
    issue_revision: 'issue', error: '', receipts: [{ issue: chain.id, author: 'reviewer', comment_id: 17 }] } }, NOW - 2 * HOUR)
  chain = f.observe(chain, NOW - 2 * HOUR + 1000, null, [17])
  f.merge(chain, NOW - HOUR)
  const report = await f.read()
  expect(report.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#1'])
  expect(report.recovery.unknown).toBe(0)
})

it('counts a lost-response publish-issue retry whose verified head is journaled before its success settlement', async () => {
  const f = setup()
  const HEAD2 = 'c'.repeat(40)
  const failedCall = 'e'.repeat(32)
  const original = 'a'.repeat(32)
  const reviewer = { model: 'fixture', slot: 'primary', recovery: 'fixture' }
  const makeObservation = (at: number, head: string): ChainObservation => ({
    checkedAt: at, existingPulls: [], issue: { open: true, eligible: true, revision: 'issue', commentIds: [] },
    issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer,
    prerequisites: { wait: null, base: HEAD, evidence: [] },
    publication: { pull_number: 101, head_sha: head, head_invocation: original,
      state: 'open', merged: false, merge_sha: null },
    pull: { number: 101, head, headSince: at, state: 'open', draft: false, merged: false,
      mergeSha: null, mergedAt: null, queueEntry: null, queueRemoval: null,
      changesRequested: false, unresolved: 0, approved: false, ready: true,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'review', greyRuns: [], pending: false, failing: [], conflict: false, behind: false, checksState: 'SUCCESS' } })
  let chain = f.seed(1, NOW - 48 * HOUR)
  chain = f.append(chain, { type: 'chain.observed', observation: makeObservation(NOW - 6 * HOUR, HEAD) }, NOW - 6 * HOUR)
  const id = chainBasis(`${chain.id}:lost-publish`).slice(0, 32)
  const admittedAt = NOW - 5 * HOUR
  const argv = ['--issue-work', '1', '--invocation-id', original, '--expected-head', HEAD2]
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id, behavior: 'publish-issue', actor: 'author', slot: null,
    basis: 'publish', model: null, admittedAt, request: { command: 'github-interface', argv, cwd: '/fixture' } } }, admittedAt)
  chain = f.append(chain, { type: 'invocation.started', invocationId: id }, admittedAt + 500)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { status: 'failed', action: 'not_started',
    outcome: 'preflight_failed', error_code: 'authentication_failed', error: 'Refresh credential rejected',
    completedAt: NOW - 5 * HOUR, callId: failedCall } }, NOW - 5 * HOUR)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { publicationResume: {
    callId: failedCall, head: HEAD2, plan: 'plan', correlation: 'corr-launch' }, publicationReceipt: null } }, NOW - 4 * HOUR)
  // The runtime journals the verified published head before recover() appends
  // the success settlement on the same invocation.
  chain = f.append(chain, { type: 'chain.observed', observation: makeObservation(NOW - 3 * HOUR, HEAD2) }, NOW - 3 * HOUR)
  // recover() preserves the failed Call completedAt on the same invocation.
  chain = f.append(chain, { type: 'invocation.settled', invocationId: id, callId: failedCall, outcome: 'published', evidence: {
    status: 'completed', action: null, outcome: 'published', head_sha: HEAD2, completedAt: NOW - 5 * HOUR } }, NOW - 2 * HOUR)
  chain = f.append(chain, { type: 'chain.merged', mergeSha: MERGE,
    evidence: { repository: chain.repository, pull_number: 101, merged: true, merge_sha: MERGE, review_complete: true } }, NOW - HOUR)
  const report = await f.read()
  expect(report.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#1'])
  expect(report.recovery.unknown).toBe(0)
})

it('counts a publish-issue retry settled from the observation without a publicationResume launch', async () => {
  const f = setup()
  const HEAD2 = 'c'.repeat(40)
  const failedCall = 'e'.repeat(32)
  const original = 'a'.repeat(32)
  const reviewer = { model: 'fixture', slot: 'primary', recovery: 'fixture' }
  const makeObservation = (at: number, head: string): ChainObservation => ({
    checkedAt: at, existingPulls: [], issue: { open: true, eligible: true, revision: 'issue', commentIds: [] },
    issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer,
    prerequisites: { wait: null, base: HEAD, evidence: [] },
    publication: { pull_number: 101, head_sha: head, head_invocation: original,
      state: 'open', merged: false, merge_sha: null },
    pull: { number: 101, head, headSince: at, state: 'open', draft: false, merged: false,
      mergeSha: null, mergedAt: null, queueEntry: null, queueRemoval: null,
      changesRequested: false, unresolved: 0, approved: false, ready: true,
      reviewIds: [], reviewReceipts: [], reviewRevision: 'review', greyRuns: [], pending: false, failing: [], conflict: false, behind: false, checksState: 'SUCCESS' } })
  let chain = f.seed(1, NOW - 48 * HOUR)
  chain = f.append(chain, { type: 'chain.observed', observation: makeObservation(NOW - 6 * HOUR, HEAD) }, NOW - 6 * HOUR)
  const id = chainBasis(`${chain.id}:lost-publish-no-launch`).slice(0, 32)
  const admittedAt = NOW - 5 * HOUR
  const argv = ['--issue-work', '1', '--invocation-id', original, '--expected-head', HEAD2]
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id, behavior: 'publish-issue', actor: 'author', slot: null,
    basis: 'publish', model: null, admittedAt, request: { command: 'github-interface', argv, cwd: '/fixture' } } }, admittedAt)
  chain = f.append(chain, { type: 'invocation.started', invocationId: id }, admittedAt + 500)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { status: 'failed', action: 'not_started',
    outcome: 'preflight_failed', error_code: 'authentication_failed', error: 'Refresh credential rejected',
    completedAt: NOW - 5 * HOUR, callId: failedCall } }, NOW - 5 * HOUR)
  // No publicationResume launch: the runtime settles publish-issue success
  // directly from the verified observation (see behavior-chain-runtime).
  // The verified head is journaled before recover() appends the settlement.
  chain = f.append(chain, { type: 'chain.observed', observation: makeObservation(NOW - 3 * HOUR, HEAD2) }, NOW - 3 * HOUR)
  // recover() preserves the failed Call completedAt on the same invocation.
  chain = f.append(chain, { type: 'invocation.settled', invocationId: id, callId: failedCall, outcome: 'published', evidence: {
    status: 'completed', action: null, outcome: 'published', head_sha: HEAD2, completedAt: NOW - 5 * HOUR } }, NOW - 2 * HOUR)
  chain = f.append(chain, { type: 'chain.merged', mergeSha: MERGE,
    evidence: { repository: chain.repository, pull_number: 101, merged: true, merge_sha: MERGE, review_complete: true } }, NOW - HOUR)
  const report = await f.read()
  expect(report.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#1'])
  expect(report.recovery.unknown).toBe(0)
})

it('anchors each recovery to its own failure when one invocation fails twice', async () => {
  const f = setup()
  let chain = f.observe(f.seed(1), NOW - 31 * HOUR)
  const id = chainBasis(`${chain.id}:repair-twice`).slice(0, 32)
  const admittedAt = NOW - 30 * HOUR
  chain = f.append(chain, { type: 'invocation.admitted', invocation: { id, behavior: 'review-issue', actor: 'reviewer', slot: 'primary',
    basis: 'issue', model: 'fixture', admittedAt, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } } }, admittedAt)
  chain = f.append(chain, { type: 'invocation.started', invocationId: id }, admittedAt + 500)
  const firstCall = 'f'.repeat(32)
  chain = f.append(chain, { type: 'invocation.reconciled', invocationId: id, evidence: { status: 'failed', action: 'not_started',
    outcome: 'preflight_failed', error_code: 'authentication_failed', error: 'Refresh credential rejected',
    completedAt: NOW - 30 * HOUR, callId: firstCall } }, NOW - 30 * HOUR)
  // An out-of-window operator Resume lands before the later publication Call
  // fails on the same invocation.
  chain = f.append(chain, { type: 'chain.resumed', recovery: { origin: 'operator', intervention: {
    callId: firstCall, at: NOW - 28 * HOUR, verifiedAt: NOW - 28 * HOUR + 1000 } } }, NOW - 28 * HOUR + 2000)
  const secondCall = 'e'.repeat(32)
  chain = f.append(chain, { type: 'invocation.settled', invocationId: id, callId: secondCall, outcome: 'preflight_failed',
    evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error_code: 'authentication_failed', error: 'Refresh credential rejected', completedAt: NOW - 5 * HOUR } }, NOW - 5 * HOUR)
  chain = f.succeed(chain, 'retry', NOW - 2 * HOUR)
  chain = f.observe(chain, NOW - 2 * HOUR + 1000, null, [17])
  f.merge(chain, NOW - HOUR)
  const report = await f.read()
  // The later publication failure anchors after the old operator Resume, so
  // its in-window verified retry counts as automatic instead of being
  // suppressed by the out-of-window intervention.
  expect(report.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#1'])
  expect(report.recovery.intervention).toEqual([])
  expect(report.recovery.unknown).toBe(0)
})

it('replays only the chains whose journal changed, and reads as a fresh journal does wherever the clock moves', async () => {
  const f = setup()
  let recovered = f.observe(f.seed(1), NOW - 7 * HOUR)
  recovered = f.fail(recovered, 'failure', NOW - 6 * HOUR)
  recovered = f.succeed(recovered, 'retry', NOW - 5 * HOUR)
  f.merge(f.observe(recovered, NOW - 5 * HOUR + 1000, null, [17]), NOW - 4 * HOUR)
  f.merge(f.seed(2), NOW - 2 * HOUR)
  f.fail(f.seed(3), 'active', NOW - HOUR)
  const first = await f.read()
  expect(first.rate).toMatchObject({ completed: 2, errors: 1 })
  expect(first.recovery.automatic.map(item => item.work)).toEqual(['acme/repo#1'])
  expect(first.lastError.error).toMatchObject({ work: 'acme/repo#3', at: NOW - HOUR })
  const replayed = vi.spyOn(f.journal, 'history')
  expect(await f.read()).toEqual(first)
  expect(replayed).not.toHaveBeenCalled()
  f.observe(f.journal.read('acme/repo#3')!, NOW)
  await f.read()
  expect(new Set(replayed.mock.calls.map(([id]) => id))).toEqual(new Set(['acme/repo#3']))
  // The window moves by the clock alone: a merge and a recovery leave it,
  // and a clock before an error replays only the chain that error is in.
  for (const [now, replays] of [[NOW + 5 * HOUR, []], [NOW + 30 * HOUR, []], [NOW - 2 * HOUR, ['acme/repo#3']]] as const) {
    replayed.mockClear()
    const read = await projectAnalyticsHealth(f.journal, { ...f.input, now })
    expect(new Set(replayed.mock.calls.map(([id]) => id))).toEqual(new Set(replays))
    expect(read).toEqual(await projectAnalyticsHealth(new BehaviorChainJournal(f.db), { ...f.input, now }))
  }
})
