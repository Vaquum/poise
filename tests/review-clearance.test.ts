import { afterEach, expect, it, vi } from 'vitest'
import { chainBasis, type BehaviorChain, type ChainInvocation } from '../server/behavior-chain-store'
import { chainReviewClearance, decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { publishReviewClearance, reviewClearanceOnly, reviewClearanceResults, type ClearanceOwner, type ClearancePull, type ClearanceSnapshot } from '../server/review-clearance'
import { completedReviewCall } from './review-response-fixture'

const HEAD = 'a'.repeat(40), GROUP = 'e'.repeat(40), NOW = 1_800_000_000_000
afterEach(() => vi.useRealTimers())

function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  const panel = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  const call = completedReviewCall('autonomio/poise', 17, HEAD, 'reviewer')
  const observation: ChainObservation = { checkedAt: NOW, issue: { open: true, eligible: true, revision: 'issue', commentIds: [] },
    issueReviewers: [], prReviewers: [panel], implementer: panel, repairer: panel, approver: panel, existingPulls: [],
    publication: { pull_number: 17, head_sha: HEAD, head_invocation: 'implementation', state: 'open', merged: false, merge_sha: null },
    pull: { number: 17, head: HEAD, headSince: NOW, state: 'open', draft: false, merged: false, mergeSha: null,
      queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: true, ready: true,
      reviewIds: [91], reviewRevision: 'review', reviewContext: 'b'.repeat(64), reviewReceipts: [{ id: 91, head: HEAD,
        state: 'COMMENTED', invocation: call.id, response: call.artifact!.review_response, submittedAt: NOW }],
      greyRuns: [], pending: false, failing: [], conflict: false, behind: false } }
  const invocation: ChainInvocation = { id: 'native-review', callId: call.id, behavior: 'review-pr',
    basis: chainBasis(['pr', HEAD, observation.pull!.reviewContext]), actor: 'reviewer', model: 'fixture', slot: 'primary',
    admittedAt: NOW - 2000, admissionSequence: 1, state: 'settled', outcome: 'clean',
    request: { command: 'agent-interface', cwd: '/fixture', argv: ['--pr-review', '#17', '--expected-head', HEAD] },
    evidence: { status: 'completed', action: 'reviewed_clean', outcome: 'clean', review_id: 91,
      head_sha: HEAD, completedAt: NOW, artifact: call.artifact } }
  const chain: BehaviorChain = { id: 'autonomio/poise#7', repository: 'autonomio/poise', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer', sequence: 4, held: null, waiting: null,
    resumedAfterSequence: 0, mergeSha: null, observation, invocations: [invocation] }
  const pull: ClearancePull = { number: 17, head: HEAD, context: observation.pull!.reviewContext!, headRef: chain.branch,
    headRepo: chain.repository, author: chain.author, draft: false, reviews: observation.pull!.reviewReceipts.map(review => ({ ...review,
      actor: chain.reviewer, response: review.response, submittedAt: new Date(review.submittedAt!).toISOString() })) }
  const snapshot: ClearanceSnapshot = { pulls: [pull], groups: [] }
  const owners = new Map<number, ClearanceOwner>([[17, { kind: 'managed', chain, observation }]])
  const result = () => reviewClearanceResults(snapshot, owners, Date.now())
  function negative() {
    invocation.evidence!.action = 'requested_changes'
    invocation.evidence!.outcome = 'changes_requested'
    observation.pull!.reviewReceipts[0].state = pull.reviews[0].state = 'CHANGES_REQUESTED'
    observation.pull!.changesRequested = true
  }
  return { chain, observation, invocation, pull, snapshot, owners, result, negative }
}

it('fences a pending native review despite green CI and a separate approval, then reuses its retained clean result', () => {
  const { chain, invocation, observation, result } = fixture()
  invocation.state = 'started'
  expect(result()[0].conclusion).toBe('failure')
  invocation.state = 'settled'
  expect(result()[0].conclusion).toBe('success')
  expect(decideBehaviorChain(chain, observation, NOW)).toMatchObject({ kind: 'invoke', behavior: 'merge-pr' })
  // Clearance itself has no CI-readiness prerequisite.
  observation.pull!.ready = false; observation.pull!.pending = true
  expect(chainReviewClearance(chain, observation, NOW)).toBeNull()
})

it('checks every configured slot and rejects missing, stale, unavailable or dismissed native receipts', () => {
  const { observation, invocation, pull, result } = fixture()
  observation.prReviewers.push({ slot: 'secondary', model: 'other', recovery: 'other' })
  expect(result()[0].summary).toContain('secondary')
  observation.prReviewers.pop()
  for (const change of [() => { pull.context = 'c'.repeat(64) }, () => { pull.head = 'c'.repeat(40) },
    () => { pull.reviews = [] }, () => { pull.reviews[0].state = 'DISMISSED' },
    () => { invocation.evidence!.artifact = {} }]) {
    const original = structuredClone({ pull, evidence: invocation.evidence })
    change(); expect(result()[0].conclusion).toBe('failure')
    Object.assign(pull, original.pull); invocation.evidence = original.evidence
  }
})

it('revokes the original head and active mixed merge group on a same-head native change request despite a separate approval', () => {
  const { snapshot, owners, result, negative, pull } = fixture()
  const independent = { ...structuredClone(pull), number: 18, head: 'f'.repeat(40), author: 'independent', reviews: [] }
  snapshot.pulls.push(independent); owners.set(18, { kind: 'independent' })
  snapshot.groups.push({ head: GROUP, base: 'd'.repeat(40), pulls: [17, 18] })
  expect(result().every(item => item.conclusion === 'success')).toBe(true)
  negative()
  pull.reviews.push({ id: 92, head: HEAD, state: 'APPROVED', actor: 'separate-reviewer', invocation: null,
    response: null, submittedAt: new Date(NOW).toISOString() })
  expect(result().find(item => item.head === HEAD)?.conclusion).toBe('failure')
  expect(result().find(item => item.head === GROUP)?.conclusion).toBe('failure')
  expect(result().find(item => item.head === independent.head)?.conclusion).toBe('success')
})

it('aggregates different PR contexts on a shared SHA, including a later independent classification', () => {
  const { snapshot, owners, result, pull } = fixture()
  snapshot.pulls.push({ ...structuredClone(pull), number: 18, context: 'c'.repeat(64), author: 'independent' })
  owners.set(18, { kind: 'unknown' })
  expect(result()).toHaveLength(1)
  expect(result()[0].conclusion).toBe('failure')
  owners.set(18, { kind: 'independent' })
  pull.context = 'd'.repeat(64)
  expect(result()[0].conclusion).toBe('failure')
  expect(result()[0].summary).toContain('#17')
  owners.set(17, { kind: 'independent' })
  expect(result()[0].conclusion).toBe('success')
})

it('lets the existing review and same-head repair/verification path produce clearance without CI-repair feedback', () => {
  const { chain, observation, invocation, negative, pull, result } = fixture()
  chain.invocations = []
  observation.pull!.ready = false
  expect(decideBehaviorChain(chain, observation, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
  chain.invocations = [invocation]; negative()
  expect(decideBehaviorChain(chain, observation, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
  const repair: ChainInvocation = { ...invocation, id: 'repair', behavior: 'repair-pr', admittedAt: NOW + 1,
    request: { ...invocation.request, context: { head: HEAD, reviewRevision: 'review' } },
    evidence: { status: 'completed', action: 'published', completedAt: NOW + 2 } }
  chain.invocations.push(repair)
  expect(decideBehaviorChain(chain, observation, NOW)).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
  const approval = structuredClone(invocation)
  approval.id = 'verification'; approval.callId = 'f'.repeat(32); approval.behavior = 'approve-pr'
  approval.admittedAt = NOW + 3; approval.evidence!.completedAt = NOW + 6
  approval.evidence!.action = 'approved'; approval.evidence!.review_id = 93
  const response = { ...((approval.evidence!.artifact as Record<string, unknown>).review_response as Record<string, unknown>), invocation_id: approval.callId, completed_at: NOW + 4 }
  approval.evidence!.artifact = { review_response: response }
  chain.invocations.push(approval)
  observation.pull!.reviewReceipts.push({ id: 93, head: HEAD, state: 'APPROVED', invocation: approval.callId, response, submittedAt: NOW + 5 })
  pull.reviews.push({ id: 93, head: HEAD, state: 'APPROVED', actor: chain.reviewer, invocation: approval.callId,
    response, submittedAt: new Date(NOW + 5).toISOString() })
  vi.setSystemTime(NOW + 10)
  expect(result()[0].conclusion).toBe('success')
  // Another native slot is still an independent obligation.
  observation.prReviewers.push({ slot: 'secondary', model: 'other', recovery: 'other' })
  expect(result()[0].conclusion).toBe('failure')
})

it('returns a queue revocation to review, retaining ordinary queue CI failures as repairs', () => {
  const { chain, observation, invocation } = fixture()
  const nodes = [{ __typename: 'CheckRun', name: 'Poise review clearance', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'Verify (Node 22)', status: 'COMPLETED', conclusion: 'SUCCESS' }]
  const removal = { reason: 'failed_checks', beforeCommit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes } } } }
  expect(reviewClearanceOnly(removal)).toBe(true)
  const queued: ChainInvocation = { ...invocation, behavior: 'merge-pr', admittedAt: NOW - 500,
    evidence: { status: 'completed', outcome: 'enqueued', head_sha: HEAD } }
  chain.invocations = [queued]
  observation.pull!.queueRemoval = { id: 'removal', reason: 'failed_checks', at: NOW, actor: null, reviewClearanceOnly: true }
  expect(decideBehaviorChain(chain, observation, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
  nodes[1].conclusion = 'FAILURE'
  expect(reviewClearanceOnly(removal)).toBe(false)
  observation.pull!.queueRemoval.reviewClearanceOnly = false
  expect(decideBehaviorChain(chain, observation, NOW)).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
  nodes[1].conclusion = 'SUCCESS'; removal.beforeCommit.statusCheckRollup.contexts.pageInfo.hasNextPage = true
  expect(reviewClearanceOnly(removal)).toBe(false)
})

it.each(['context', 'head', 'review'] as const)('keeps a late evaluation blocking when %s changes while it runs', async change => {
  const { snapshot, owners, pull, negative } = fixture()
  snapshot.groups.push({ head: GROUP, base: 'd'.repeat(40), pulls: [17] })
  let reads = 0
  const complete = vi.fn<Parameters<typeof publishReviewClearance>[0]['complete']>().mockResolvedValue()
  await publishReviewClearance({
    retained: () => [{ id: 1, head: HEAD }, { id: 2, head: GROUP }], retain: () => {}, complete,
    begin: async heads => heads.map((head, index) => ({ id: index + 3, head })),
    snapshot: async () => {
      if (++reads === 2) {
        if (change === 'review') negative()
        else pull[change] = (change === 'head' ? 'c'.repeat(40) : 'c'.repeat(64))
      }
      return structuredClone(snapshot)
    },
    owners: async () => structuredClone(owners),
  })
  expect(complete).toHaveBeenCalledOnce()
  expect(complete.mock.calls[0][0].every(item => item.conclusion === 'failure')).toBe(true)
  expect(complete.mock.calls[0][0].map(item => item.head)).toEqual([HEAD, GROUP])
})

it('revokes previous success before an unavailable ownership read, retaining the check identities for restart', async () => {
  fixture()
  const complete = vi.fn<Parameters<typeof publishReviewClearance>[0]['complete']>().mockResolvedValue()
  const retain = vi.fn()
  await expect(publishReviewClearance({ retained: () => [{ id: 1, head: HEAD }], retain, complete,
    snapshot: async () => { throw new Error('ownership source unavailable') }, owners: async () => new Map(),
    begin: async () => [],
  })).rejects.toThrow('ownership source unavailable')
  expect(complete).toHaveBeenCalledWith([{ id: 1, head: HEAD, conclusion: 'failure', summary: expect.any(String) }])
  expect(retain).not.toHaveBeenCalled()
})

it('keeps a healthy queued integration green while fresh original evidence remains identical', async () => {
  const { snapshot, owners } = fixture()
  snapshot.groups.push({ head: GROUP, base: 'd'.repeat(40), pulls: [17] })
  const begin = vi.fn(async (heads: string[]) => heads.map((head, index) => ({ id: index + 1, head })))
  const complete = vi.fn<Parameters<typeof publishReviewClearance>[0]['complete']>().mockResolvedValue()
  let basis = '', checks: Array<{ id: number, head: string }> = []
  const operations = { snapshot: async () => structuredClone(snapshot), owners: async () => structuredClone(owners), begin, complete,
    retained: () => checks, retain: (value: typeof checks) => { checks = value }, basis: () => basis,
    retainBasis: (value: string) => { basis = value } }
  await publishReviewClearance(operations)
  await publishReviewClearance(operations)
  expect(begin).toHaveBeenCalledOnce()
  expect(complete).toHaveBeenCalledOnce()
  expect(complete.mock.calls[0][0].every(result => result.conclusion === 'success')).toBe(true)
  expect(complete.mock.calls[0][0].map(result => result.head)).toEqual([HEAD, GROUP])
})
