import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  meta: {} as Record<string, string>,
  orgs: [
    { login: 'alpha', datastorePath: '/alpha.sqlite', status: 'ready', error: null as string | null },
  ],
}))
vi.mock('../server/db', () => ({ getMeta: (key: string) => mocks.meta[key] ?? null, setMeta: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, MAX_PROCESS_ARG_BYTES: 64 * 1024 }))
vi.mock('../server/organizations', () => ({
  getOrganizations: () => mocks.orgs,
  readyOrganizations: () => mocks.orgs.filter((org) => org.status === 'ready'),
  organizationArgs: (org: { datastorePath: string }, args: string[]) => ['--db', org.datastorePath, ...args],
}))
const { handleGhBody } = await import('../server/gh')

const HEAD = 'a'.repeat(40)

function record(number: number, day = 5) {
  const date = `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`
  return { repo: 'alpha/same', number, status: 'open', author: 'octocat', title: `alpha ${number}`, url: `https://github.com/alpha/same/pull/${number}`, created_at: date, updated_at: date, closed_at: null, comments_count: 0 }
}

// Full --mergeable evidence for an open pull request; each case overrides
// what it needs. Mirrors github-interface's response shape.
function evidence(overrides: Record<string, unknown> = {}) {
  return {
    action: 'mergeable',
    repository: 'alpha/same',
    state: 'open',
    draft: false,
    github_mergeable: true,
    github_mergeable_state: 'clean',
    checks_state: 'SUCCESS',
    unresolved_conversations: 0,
    head_sha: HEAD,
    review_decision: null,
    threads_checked: true,
    queue_enabled: false,
    has_rollup: true,
    check_contexts: [],
    contexts_partial: false,
    ...overrides,
  }
}

function emptyChecks(partial = false) {
  return { failing: [], failingCount: 0, runningCount: 0, partial }
}

beforeEach(() => {
  mocks.meta = { me: 'octocat', agentAccount: 'review-bot' }
  mocks.runFile.mockReset()
})

async function greenPr(answers: Record<string, unknown>, numbers: number[]) {
  mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
    if (command !== 'github-interface') return { stdout: JSON.stringify(numbers.map((number) => record(number))), stderr: '' }
    const answer = answers[args[1]]
    if (answer instanceof Error) throw answer
    return { stdout: JSON.stringify(answer), stderr: '' }
  })
  return handleGhBody({ operation: 'green_pr', org: 'alpha' })
}

function mergeableCalls() {
  return mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--mergeable')
}

function heldOf(body: unknown, number: number) {
  return (body as any).held.find((entry: any) => entry.number === number)
}

describe('why a pull request is held', () => {
  it('names a draft from its flag even when its merge state is not draft', async () => {
    const result = await greenPr({ '#30': evidence({ draft: true, status: null }) }, [30])
    expect(heldOf(result.body, 30)).toEqual({
      repo: 'alpha/same', number: 30, head: HEAD,
      held: { reasons: ['draft'], checks: emptyChecks(), threadsChecked: true },
    })
    expect((result.body as any).records).toEqual([])
  })

  it('names a conflict from either mergeability or a dirty state', async () => {
    const result = await greenPr({ '#31': evidence({ github_mergeable: false, github_mergeable_state: 'dirty', status: null }) }, [31])
    expect(heldOf(result.body, 31).held.reasons).toEqual(['conflict'])
  })

  it('names a branch behind its base', async () => {
    const result = await greenPr({ '#32': evidence({ github_mergeable_state: 'behind', status: null }) }, [32])
    expect(heldOf(result.body, 32).held.reasons).toEqual(['behind'])
  })

  it('reports a failing required check under blocked with its names, not as blocked', async () => {
    const result = await greenPr({ '#33': evidence({
      github_mergeable_state: 'blocked', checks_state: 'FAILURE', status: null,
      check_contexts: [
        { name: 'browser shard 3', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    }) }, [33])
    expect(heldOf(result.body, 33).held).toEqual({
      reasons: ['checks_failing'],
      checks: { failing: ['browser shard 3'], failingCount: 1, runningCount: 0, partial: false },
      threadsChecked: true,
    })
  })

  it('names running checks from the aggregate with their count', async () => {
    const result = await greenPr({ '#34': evidence({
      github_mergeable_state: 'unstable', checks_state: 'PENDING', status: 'yellow',
      check_contexts: [{ name: 'browser shard 3', status: 'IN_PROGRESS', conclusion: null }],
    }) }, [34])
    expect(heldOf(result.body, 34).held).toEqual({
      reasons: ['checks_running'],
      checks: { failing: [], failingCount: 0, runningCount: 1, partial: false },
      threadsChecked: true,
    })
    expect((result.body as any).records).toEqual([{ repo: 'alpha/same', number: 34, status: 'yellow' }])
  })

  it('names an open conversation', async () => {
    const result = await greenPr({ '#35': evidence({ unresolved_conversations: 2, status: 'yellow' }) }, [35])
    expect(heldOf(result.body, 35).held.reasons).toEqual(['conversation_open'])
  })

  it('claims no open conversation from truncated threads alone', async () => {
    const result = await greenPr({ '#36': evidence({ threads_checked: false, status: 'yellow' }) }, [36])
    expect(heldOf(result.body, 36).held).toEqual({ reasons: [], checks: emptyChecks(), threadsChecked: false })
  })

  it('claims an open conversation when a truncated read still saw one', async () => {
    const result = await greenPr({ '#37': evidence({ threads_checked: false, unresolved_conversations: 1, status: 'yellow' }) }, [37])
    const held = heldOf(result.body, 37).held
    expect(held.reasons).toEqual(['conversation_open'])
    expect(held.threadsChecked).toBe(false)
  })

  it('names a queue repository without approval as review required', async () => {
    const full = await greenPr({ '#38': evidence({ queue_enabled: true, review_decision: 'REVIEW_REQUIRED', status: 'yellow' }) }, [38])
    expect(heldOf(full.body, 38).held.reasons).toEqual(['review_required'])
    const none = await greenPr({ '#39': evidence({ queue_enabled: true, review_decision: null, status: 'yellow' }) }, [39])
    expect(heldOf(none.body, 39).held.reasons).toEqual(['review_required'])
  })

  it('names requested changes even where the colour stays green', async () => {
    const result = await greenPr({ '#40': evidence({ review_decision: 'CHANGES_REQUESTED', status: 'green' }) }, [40])
    expect(heldOf(result.body, 40).held.reasons).toEqual(['changes_requested'])
    expect((result.body as any).records).toEqual([{ repo: 'alpha/same', number: 40, status: 'green' }])
  })

  it('caps failing names at five past one read and marks them partial', async () => {
    const contexts = Array.from({ length: 6 }, (_, index) => ({ name: `shard ${index + 1}`, status: 'COMPLETED', conclusion: 'FAILURE' }))
    const result = await greenPr({ '#41': evidence({ checks_state: 'FAILURE', status: 'yellow', check_contexts: contexts, contexts_partial: true }) }, [41])
    expect(heldOf(result.body, 41).held).toEqual({
      reasons: ['checks_failing'],
      checks: { failing: ['shard 1', 'shard 2', 'shard 3', 'shard 4', 'shard 5'], failingCount: 6, runningCount: 0, partial: true },
      threadsChecked: true,
    })
  })

  it('reads legacy commit statuses alongside check runs', async () => {
    const result = await greenPr({ '#42': evidence({
      checks_state: 'FAILURE', status: 'yellow',
      check_contexts: [
        { name: 'deploy', status: null, conclusion: 'FAILURE' },
        { name: 'docs', status: null, conclusion: 'PENDING' },
        { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    }) }, [42])
    expect(heldOf(result.body, 42).held.checks).toEqual({ failing: ['deploy'], failingCount: 1, runningCount: 1, partial: false })
  })

  it('reports a failed read as unknown with nothing known', async () => {
    const result = await greenPr({ '#43': new Error('GitHub unavailable') }, [43])
    expect(heldOf(result.body, 43)).toEqual({
      repo: 'alpha/same', number: 43, head: null,
      held: { reasons: ['unknown'], checks: emptyChecks(), threadsChecked: false },
    })
    expect((result.body as any).records).toEqual([])
  })

  it('leaves check names out under quota pressure while the aggregate still decides', async () => {
    mocks.meta['github-quota:risk:review-bot:graphql'] = JSON.stringify({
      resetAt: new Date(Date.now() + 3_600_000).toISOString(), since: Date.now() - 60_000, lastAt: Date.now(), warned: true,
    })
    const result = await greenPr({ '#44': evidence({ checks_state: 'FAILURE', status: 'yellow', check_contexts: null }) }, [44])
    expect(mergeableCalls().map(([, args]) => args)).toEqual([['--mergeable', '#44', '--token-user', 'review-bot', '--no-check-contexts']])
    expect(heldOf(result.body, 44).held).toEqual({
      reasons: ['checks_failing'],
      checks: { failing: [], failingCount: 0, runningCount: 0, partial: true },
      threadsChecked: true,
    })
  })

  it('reads check names in full while the quota observation shows no pressure', async () => {
    const result = await greenPr({ '#47': evidence({ status: 'green' }) }, [47])
    expect(mergeableCalls().map(([, args]) => args)).toEqual([['--mergeable', '#47', '--token-user', 'review-bot']])
    expect(heldOf(result.body, 47)).toEqual({
      repo: 'alpha/same', number: 47, head: HEAD,
      held: { reasons: [], checks: emptyChecks(), threadsChecked: true },
    })
    expect((result.body as any).records).toEqual([{ repo: 'alpha/same', number: 47, status: 'green' }])
  })

  it('marks a missing rollup unknown without hiding its other reasons', async () => {
    const bare = await greenPr({ '#45': evidence({ has_rollup: false, checks_state: null, status: null }) }, [45])
    expect(heldOf(bare.body, 45).held.reasons).toEqual(['unknown'])
    const blocked = await greenPr({ '#46': evidence({ github_mergeable_state: 'blocked', has_rollup: false, checks_state: null, status: null }) }, [46])
    expect(heldOf(blocked.body, 46).held.reasons).toEqual(['blocked', 'unknown'])
  })

  it('keeps blocked for a block with no other explanation', async () => {
    const result = await greenPr({ '#48': evidence({ github_mergeable_state: 'blocked', status: null }) }, [48])
    expect(heldOf(result.body, 48).held.reasons).toEqual(['blocked'])
  })

  it('lists every reason that applies in one order', async () => {
    const result = await greenPr({ '#49': evidence({
      github_mergeable: false, github_mergeable_state: 'dirty', checks_state: 'FAILURE',
      review_decision: 'CHANGES_REQUESTED', unresolved_conversations: 2, status: null,
      check_contexts: [{ name: 'browser shard 3', status: 'COMPLETED', conclusion: 'FAILURE' }],
    }) }, [49])
    expect(heldOf(result.body, 49).held.reasons).toEqual(['conflict', 'checks_failing', 'changes_requested', 'conversation_open'])
  })

  it('makes no more GitHub reads than one per open pull request', async () => {
    const numbers = [51, 52, 53]
    mocks.runFile.mockImplementation(async (command: string, _args: string[]) => {
      if (command !== 'github-interface') return { stdout: JSON.stringify(numbers.map((number) => record(number))), stderr: '' }
      return { stdout: JSON.stringify(evidence({ status: 'green' })), stderr: '' }
    })
    const result = await handleGhBody({ operation: 'green_pr', org: 'alpha' })
    expect(mergeableCalls()).toHaveLength(3)
    expect((result.body as any).held).toHaveLength(3)
    expect((result.body as any).records).toHaveLength(3)
  })

  it('drops a malformed head instead of reporting it', async () => {
    const result = await greenPr({ '#54': evidence({ head_sha: 'not-a-sha', status: 'green' }) }, [54])
    expect(heldOf(result.body, 54).head).toBeNull()
  })
})
