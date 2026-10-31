import { expect, it, vi } from 'vitest'
import { chainBasis, type BehaviorChain } from '../server/behavior-chain-store'
import type { Organization } from '../server/organizations'

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
  const reviewed = { ...chain, invocations: [invocation] }
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
