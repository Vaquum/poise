import { beforeEach, expect, it, vi } from 'vitest'
import type { McpGrantScope } from '../gateway/src/mcp-contract'
import { fetchSelectedAgentLogSnapshot } from '../server/agent'
import { readBehaviorLedger } from '../server/behavior-ledger'
import { readLivePull } from '../server/mcp-live-pull'
import { readMcpPull } from '../server/mcp-pull'

vi.mock('../server/gh', () => ({ requireConfiguredRepository: vi.fn() }))
vi.mock('../server/organizations', () => ({ organizationForRepository: vi.fn(() => ({ status: 'ready' })) }))
vi.mock('../server/agent', () => ({ fetchSelectedAgentLogSnapshot: vi.fn() }))
vi.mock('../server/behavior-ledger', () => ({ readBehaviorLedger: vi.fn() }))
vi.mock('../server/mcp-live-pull', () => ({ readLivePull: vi.fn() }))

const grant: McpGrantScope = { resource: 'https://poise.test/mcp', handle: 'alice', ownerId: 1,
  grantId: '00000000-0000-0000-0000-000000000000', repository: 'Acme/Repo', pullDiagnostics: true }
const id = 'a'.repeat(32), head = 'b'.repeat(40)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(readBehaviorLedger).mockResolvedValue({ status: 200, body: { health: { status: 'ok', pending: 0 }, nextCursor: null,
    records: [{ behavior: 'approve-prs', refs: [{ kind: 'caller', availability: 'available', identity: id }] }] } } as unknown as Awaited<ReturnType<typeof readBehaviorLedger>>)
  vi.mocked(readLivePull).mockResolvedValue({ source: 'Live GitHub through Caller', observedAt: new Date().toISOString(),
    coverage: 'complete', record: null, reason: 'Fixture' } as Awaited<ReturnType<typeof readLivePull>>)
})

it('projects only the exact approval run and bounded failure evidence', async () => {
  const row = { id, repo: 'Acme/Repo', pr_id: '20', behavior: 'pr_approve', status: 'failed', action: null, outcome: null,
    expected_head: head, head_sha: null, started_at: '2026-11-25T15:53:00Z', review_id: null,
    error: 'error: GitHub 500: private response body', artifact: { phase: 'submitting_review', github_failure: {
      call_id: id, method: 'POST', operation: 'pull request reviews', status: 500, submission: 'uncertain', secret: 'hidden' } } }
  vi.mocked(fetchSelectedAgentLogSnapshot).mockResolvedValue({ entries: [row], quarantined: [] } as unknown as Awaited<ReturnType<typeof fetchSelectedAgentLogSnapshot>>)
  const result = await readMcpPull({ repository: 'Acme/Repo', pull: 20 }, grant)
  expect(result).toMatchObject({ coverage: 'complete', runs: [{ id, expectedHead: head, failure: {
    method: 'POST', operation: 'pull request reviews', status: 500, submission: 'uncertain' } }] })
  expect(JSON.stringify(result)).not.toContain('private response body')
  expect(JSON.stringify(result)).not.toContain('hidden')
  expect(readBehaviorLedger).toHaveBeenCalledWith({ operation: 'list', repository: 'Acme/Repo', number: 20, limit: 10 })
  expect(fetchSelectedAgentLogSnapshot).toHaveBeenCalledWith({ latest: [], ids: [id] }, { fresh: true })
})

it('reports missing and contradictory records without inferring a safe retry', async () => {
  vi.mocked(fetchSelectedAgentLogSnapshot).mockResolvedValue({ entries: [{ id, repo: 'Acme/Other', pr_id: '20', behavior: 'pr_approve' }],
    quarantined: [] } as unknown as Awaited<ReturnType<typeof fetchSelectedAgentLogSnapshot>>)
  const result = await readMcpPull({ repository: 'Acme/Repo', pull: 20 }, grant)
  expect(result).toMatchObject({ coverage: 'partial', runs: [] })
  await expect(readMcpPull({ repository: 'Acme/Other', pull: 20 }, grant)).rejects.toThrow('outside this grant')
  await expect(readMcpPull({ repository: 'Acme/Repo', pull: 20 }, { ...grant, pullDiagnostics: undefined })).rejects.toThrow('consent is required')
})

it('keeps an older 500 uncertain and distinguishes a retained approval', async () => {
  const row = { id, repo: 'Acme/Repo', pr_id: '20', behavior: 'pr_approve', status: 'failed', action: null, outcome: null,
    expected_head: head, head_sha: null, started_at: '2026-11-25T15:53:00Z', review_id: null,
    error: 'error: GitHub 500: private response body', artifact: { phase: 'reviewing' } }
  vi.mocked(fetchSelectedAgentLogSnapshot).mockResolvedValue({ entries: [row], quarantined: [] } as unknown as Awaited<ReturnType<typeof fetchSelectedAgentLogSnapshot>>)
  const legacy = await readMcpPull({ repository: 'Acme/Repo', pull: 20 }, grant)
  expect(legacy.runs[0].failure).toEqual({ method: null, operation: null, status: 500, submission: 'unknown' })
  expect(JSON.stringify(legacy)).not.toContain('private response body')
  vi.mocked(fetchSelectedAgentLogSnapshot).mockResolvedValue({ entries: [{ ...row, status: 'completed', action: 'approved',
    outcome: 'approved', head_sha: head, review_id: 91, error: null }], quarantined: [] } as unknown as Awaited<ReturnType<typeof fetchSelectedAgentLogSnapshot>>)
  const approved = await readMcpPull({ repository: 'Acme/Repo', pull: 20 }, grant)
  expect(approved.runs[0]).toMatchObject({ action: 'approved', outcome: 'approved', reviewId: 91, head, failure: null })
})
