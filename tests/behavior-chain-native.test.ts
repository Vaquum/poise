import { expect, it, vi } from 'vitest'
import type { BehaviorChain } from '../server/behavior-chain-store'
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
      '--read-issue': { issue: { title: 'Seed', body: '', state: 'open', labels: [] } },
      '--issue-comments': { comments: [] },
      '--issue-work': { existing_pulls: [], pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null },
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

it('seeds roster draws and resolutions by the chain seed issue', async () => {
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--read-issue': { issue: { title: 'Seed', body: '', state: 'open', labels: [] } },
      '--issue-comments': { comments: [] },
      '--issue-work': { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: 'open', merged: false, merge_sha: null },
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
