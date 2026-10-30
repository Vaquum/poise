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
      '--pull-action-state': { pull_number: 21, state: 'open', head_sha: HEAD, merged: false, queue_entry_id: null, queue_removals: [], my_reviews: [] },
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
    actor: 'reviewer', model: 'fixture', slot: 'primary', admittedAt: Date.now(), admissionSequence: 1,
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
