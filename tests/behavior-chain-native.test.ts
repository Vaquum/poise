import { expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { LogEntry } from '../server/agent-log-parse'
import { chainBasis, type BehaviorChain, type ChainInvocation } from '../server/behavior-chain-store'
import type { Organization } from '../server/organizations'
import type { NativeChainHooks } from '../server/behavior-chain-native'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, spawnDetached: vi.fn() }))
vi.mock('../server/models', () => ({ agentInterfaceCwd: () => '/interface' }))
vi.mock('../server/settings', () => ({ getSettings: () => ({ me: 'author', agentAccount: 'reviewer' }),
  getBehaviorChainSettings: () => ({ enabled: true, seedMode: 'all', label: 'poise' }) }))
vi.mock('../server/organizations', () => ({ organizationForRepository: () => ({ login: 'example' }), organizationArgs: vi.fn() }))
const { nativeChainOperations } = await import('../server/behavior-chain-native')
const { decideBehaviorChain } = await import('../server/behavior-chain-decision')

const HEAD = 'a'.repeat(40)
const chain: BehaviorChain = { id: 'example/repo#7', repository: 'example/repo', issue: 7, branch: 'poise/issue-7',
  author: 'author', reviewer: 'reviewer', sequence: 1, held: null, waiting: null, resumedAfterSequence: 0,
  mergeSha: null, observation: null, invocations: [] }
const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }

it.each([false, true])('verifies Caller Python request encoding and original response bytes (bounded=%s)', async bounded => {
  const invocation = mergeInvocation()
  invocation.request = { command: 'github-interface', cwd: '/fixture', nativeResources: 2, argv: invocation.request.argv,
    ...(bounded ? { resourceLimits: { version: 1 as const, memoryBytes: 2147483648, diskBytes: 536870912 } } : {}) }
  const requestSha = execFileSync('python3', ['-c', `
import hashlib, json, sys
request = json.load(sys.stdin)
print(hashlib.sha256(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
`], { input: JSON.stringify(invocation.request), encoding: 'utf8', timeout: 10_000 }).trim()
  const retained = '{"duration":1.0,"outcome":"enqueued"}'
  const call: LogEntry = { id: 'b'.repeat(32), pr_id: '21', repo: chain.repository, actor: invocation.actor,
    model: 'native-action', behavior: 'native_action', session_id: null, prompt: '', started_at: new Date().toISOString(),
    time_elapsed: '1s', status: 'completed', outcome: 'native_action', action: 'native_action', head_sha: HEAD,
    expected_head: HEAD, source: 'poise:behavior-chain', correlation_id: invocation.id, response: 'bbbbbbbb', error: '',
    artifact: { phase: 'received_native_action',
    request_sha: requestSha, response_sha: createHash('sha256').update(retained).digest('hex') } }
  mocks.runFile.mockResolvedValueOnce({ stdout: `${retained}\n` })
  await expect(actionOperations().readActionResult(invocation, call))
    .resolves.toEqual({ duration: 1, outcome: 'enqueued' })
  mocks.runFile.mockResolvedValueOnce({ stdout: `${JSON.stringify(JSON.parse(retained))}\n` })
  await expect(actionOperations().readActionResult(invocation, call))
    .rejects.toThrow('retained digest')
})

function actionOperations(overrides: Partial<NativeChainHooks> = {}) {
  return nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {}, ...overrides,
  })
}

function mergeInvocation(): ChainInvocation {
  return { id: 'original-merge', behavior: 'merge-pr', basis: 'merge', actor: 'reviewer', model: null, slot: null,
    reservation: null, admittedAt: Date.now() - 1000, admissionSequence: 2, state: 'started', callId: null, outcome: null, evidence: null,
    request: { command: 'github-interface', cwd: '/fixture', argv: ['--merge-if-ready', '21', '--expected-head', HEAD, '--token-user', 'reviewer'] } }
}

it.each(['fenced', 'existing'] as const)('validates the original closed-target fence response without provider preparation: %s', async outcome => {
  const prepare = vi.fn(async () => ({}))
  const borrow = vi.fn(() => () => {})
  const invocation: ChainInvocation = { ...mergeInvocation(), behavior: 'repair-pr', model: 'fixture', actor: 'author',
    request: { command: 'agent-interface', cwd: '/fixture', argv: ['--atomic-work', 'example/repo#7', '--pull-number', '21', '--expected-head', HEAD] } }
  mocks.runFile.mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'c'.repeat(32), outcome, model: 'fixture', actor: 'author',
    repo: chain.repository, pr_id: '21', behavior: 'repair_pr', source: 'poise:behavior-chain', correlation_id: invocation.id, expected_head: HEAD }) })
  expect(await actionOperations({ prepare, borrow }).fenceClosedTarget(chain, invocation)).toBe(outcome === 'fenced')
  expect(mocks.runFile.mock.calls.at(-1)?.slice(0, 2)).toEqual(['agent-interface', ['--fence-closed-behavior', '--model', 'fixture',
    '--actor', 'author', '--repo', chain.repository, '--number', '21', '--behavior', 'repair_pr', '--correlation-id', invocation.id, '--expected-head', HEAD]])
  expect(prepare).not.toHaveBeenCalled()
  expect(borrow).not.toHaveBeenCalled()
})

it('refuses a late native launch before reserving capacity or preparing a provider', async () => {
  const prepare = vi.fn(async () => ({}))
  const borrow = vi.fn(() => () => {})
  expect(await actionOperations({ prepare, borrow }).launch(mergeInvocation(), () => {}, () => false)).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  expect(borrow).not.toHaveBeenCalled()
})

it('releases borrowed capacity when closure arrives during provider preparation', async () => {
  const release = vi.fn()
  const borrow = vi.fn(() => release)
  const prepare = vi.fn(async () => ({}))
  const allowed = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
  expect(await actionOperations({ prepare, borrow }).launch(mergeInvocation(), () => {}, allowed)).toBe(false)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(borrow).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
})

it('retains a returned native mutation response when its process subsequently fails', async () => {
  const response = { action: 'merge_if_ready', repository: chain.repository, pull_number: 21,
    head_sha: HEAD, outcome: 'enqueued', queue_entry_id: 'accepted-queue-entry' }
  mocks.runFile.mockRejectedValueOnce(Object.assign(new Error('process exited after response'), {
    code: 1, signal: null, stdout: JSON.stringify({ id: 'c'.repeat(32), result: response }),
  }))
  await expect(actionOperations().perform(mergeInvocation(), chain)).resolves.toEqual({ ...response,
    nativeCallId: 'c'.repeat(32), nativeOuterProcessFailure: { code: 1, signal: null } })
})

it.each(['', 'partial JSON {', '[]'])('preserves the original process failure when stdout is not a valid response: %s', async (stdout) => {
  const failure = Object.assign(new Error('native timeout after a possible write'), { code: 'ETIMEDOUT', signal: 'SIGTERM', stdout })
  mocks.runFile.mockRejectedValueOnce(failure)
  await expect(actionOperations().perform(mergeInvocation(), chain)).rejects.toBe(failure)
})

it('preserves actual review identities, responses and times after an external merge', async () => {
  const completedAt = Date.now() - 5000
  const response = { repository: 'example/repo', pull_number: 21, head_sha: HEAD, context_sha: 'b'.repeat(64),
    reviewer: 'reviewer', invocation_id: 'c'.repeat(32), model: 'fixture', completed_at: completedAt,
    assessment: { verdict: 'The changed validation has no remaining blocking defects.',
      reviewed_context: 'Inspected the immutable diff and affected callers.', limitations: 'No live provider calls.' } }
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    if (argv[0] === '--chain-seed') return { stdout: JSON.stringify({ repository: 'example/repo', issue_number: 7,
      actor: 'author', branch: chain.branch, issue: { title: 'Seed', body: '', state: 'closed', labels: [] }, comments: [],
      publication: { existing_pulls: [], pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'closed', merged: true, merge_sha: 'd'.repeat(40) } }) }
    if (argv[0] === '--pull-action-state') return { stdout: JSON.stringify({ pull_number: 21, state: 'closed', head_sha: HEAD,
      review_context: response.context_sha, merged: true, merge_sha: 'd'.repeat(40), merged_at: new Date(completedAt + 2000).toISOString(),
      my_reviews: [{ id: 91, state: 'COMMENTED', commit_id: HEAD, invocation_id: response.invocation_id,
        review_response: response, submitted_at: new Date(completedAt + 1000).toISOString() }] }) }
    throw new Error(`unexpected native operation ${argv[0]}`)
  })
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const observation = await operations.observe(chain)
  expect(observation.pull).toMatchObject({ merged: true, reviewIds: [91], mergedAt: completedAt + 2000,
    reviewReceipts: [{ id: 91, invocation: response.invocation_id, response, submittedAt: completedAt + 1000 }] })
  const invocation = { id: 'review', behavior: 'review-pr' as const, basis: chainBasis(['pr', HEAD, response.context_sha]),
    actor: 'reviewer', model: 'fixture', slot: 'primary', reservation: null, admittedAt: completedAt - 1000, admissionSequence: 1,
    request: { command: 'agent-interface' as const, argv: [], cwd: '/fixture' }, state: 'settled' as const,
    callId: response.invocation_id, outcome: 'clean', evidence: { status: 'completed', action: 'reviewed_clean',
      review_id: 91, head_sha: HEAD, completedAt: completedAt + 1000, artifact: { review_response: response } } }
  const preMerge = { ...observation, checkedAt: completedAt + 1000,
    pull: { ...observation.pull!, merged: false, state: 'open', mergeSha: null, mergedAt: null } }
  const reviewed = { ...chain, observation: preMerge, invocations: [invocation] }
  expect(decideBehaviorChain(reviewed, observation, Date.now())).toMatchObject({ kind: 'complete' })
  observation.pull!.mergedAt = completedAt - 1
  expect(decideBehaviorChain(reviewed, observation, Date.now())).toMatchObject({ kind: 'hold' })
})

it.each([
  { blockers: [], mergeable: true, expected: 'approve-pr' },
  { blockers: ['merge_state_not_clean'], mergeable: true, expected: 'repair-pr' },
  { blockers: ['not_mergeable'], mergeable: false, expected: 'repair-pr' },
])('uses native readiness policy for behind branches and still repairs actual conflicts: $expected', async ({ blockers, mergeable, expected }) => {
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: 'example/repo', issue_number: 7, actor: 'author', branch: 'poise/issue-7',
        issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
        publication: { existing_pulls: [], pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null } },
      '--pull-action-state': { pull_number: 21, state: 'open', head_sha: HEAD, review_context: 'b'.repeat(64), merged: false, queue_entry_id: null, queue_removals: [], my_reviews: [] },
      '--pr-readiness': { head_sha: HEAD, draft: false, reviewer_approved_current_head: false,
        unresolved_live_conversation_count: 0, green: false, blockers: [...blockers, 'reviewer_not_approved_current_head'] },
      '--list-failing-ci': { head_sha: HEAD, pull_number: 21, failing: [], mergeable, mergeable_state: mergeable ? 'behind' : 'dirty' },
    }
    if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
    return { stdout: JSON.stringify(evidence[argv[0]]) }
  })
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const observation = await operations.observe(chain)
  expect(decideBehaviorChain(chain, observation, Date.now())).toMatchObject({ kind: 'invoke', behavior: expected })
})

it('reconciles planned review comments with and without the revision marker', async () => {
  const callId = 'c'.repeat(32)
  // A review interrupted after posting: one comment carries the revision
  // marker, one was posted by an older Caller without it. Both are this
  // run's receipts, so the chain completes instead of blocking.
  const plan = { kind: 'issue_review', posts: [
    { issue: 'example/repo#7', body: 'Marked.' },
    { issue: 'example/repo#7', body: 'Legacy.' },
  ], model: 'fixture', issue_revision: 'd'.repeat(64) }
  const digest = chainBasis(plan)
  const marked = `Marked.\n\n---\n<sub>Issue review · \`fixture\` · rev \`dddddddd\`</sub>\n<!-- agent-interface issue-review call=${callId} -->`
  const legacy = `Legacy.\n\n---\n<sub>Issue review · \`fixture\`</sub>\n<!-- agent-interface issue-review call=${callId} -->`
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: 'example/repo', issue_number: 7, actor: 'author', branch: 'poise/issue-7',
        issue: { title: 'Seed', body: '', state: 'open', labels: [] },
        comments: [
          { id: 7, author: 'reviewer', body: marked, url: 'https://example.test/marked' },
          { id: 8, author: 'reviewer', body: legacy, url: null },
        ],
        publication: { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } },
      '--read-action-plan': { id: callId, sha: digest, plan },
    }
    if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
    return { stdout: JSON.stringify(evidence[argv[0]]) }
  })
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const uncertain: BehaviorChain = { ...chain, invocations: [{ id: 'inv-1', behavior: 'review-issue', basis: 'basis',
    actor: 'reviewer', model: 'fixture', slot: 'primary', reservation: null, admittedAt: Date.now(), admissionSequence: 1,
    request: { command: 'agent-interface', argv: [], cwd: '/interface' }, state: 'uncertain', callId,
    outcome: null, evidence: { callId, artifact: { plan_sha: digest } } }] }
  const observation = await operations.observe(uncertain)
  expect(observation.reviewPublication).toEqual({ callId, complete: true, issueRevision: 'd'.repeat(64), receipts: [
    { issue: 'example/repo#7', comment_id: 7, author: 'reviewer', url: 'https://example.test/marked' },
    { issue: 'example/repo#7', comment_id: 8, author: 'reviewer', url: null },
  ] })
})

it('seeds roster draws and resolutions by the chain seed issue', async () => {
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: 'example/repo', issue_number: 7, actor: 'author', branch: 'poise/issue-7',
        issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
        publication: { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: 'open', merged: false, merge_sha: null } },
    }
    if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
    return { stdout: JSON.stringify(evidence[argv[0]]) }
  })
  const roster = vi.fn(async () => ({ issueReviewers: [reviewer], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }))
  const resolve = vi.fn(async () => reviewer)
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster, resolve, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const observation = await operations.observe(chain)
  expect(roster).toHaveBeenCalledWith('example/repo#7')
  const decision = { kind: 'invoke', behavior: 'review-issue', basis: '', actor: 'reviewer', reviewer, reason: '' } as const
  await operations.request(chain, observation, decision, 'test-id')
  expect(resolve).toHaveBeenCalledWith(decision, 'example/repo#7')
})

it('reads the seed issue, comments and publication inspection in one native process', async () => {
  mocks.runFile.mockClear()
  mocks.runFile.mockImplementation(async () => ({ stdout: JSON.stringify({ repository: 'example/repo', issue_number: 7,
    actor: 'author', branch: 'poise/issue-7', issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
    publication: { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } }) }))
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const observation = await operations.observe(chain)
  expect(observation.issue.commentIds).toEqual([])
  const native = mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface')
  expect(native).toHaveLength(1)
  expect(native[0][1]).toEqual(['--chain-seed', '#7', '--branch', 'poise/issue-7', '--token-user', 'author'])
})

it.each([
  { issue_number: 8 },
  { branch: 'poise/issue-8' },
  { actor: 'reviewer' },
])('rejects seed evidence for another chain or actor: %o', async (override) => {
  mocks.runFile.mockImplementation(async () => ({ stdout: JSON.stringify({ repository: 'example/repo', issue_number: 7,
    actor: 'author', branch: 'poise/issue-7', ...override,
    issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
    publication: { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } }) }))
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  await expect(operations.observe(chain)).rejects.toThrow('belongs to another chain or actor')
})
