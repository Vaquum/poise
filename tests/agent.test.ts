import { access } from 'node:fs/promises'
import { dirname } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  captureAdmission: vi.fn(), captureOutcome: vi.fn(), observeSnapshot: vi.fn(),
  diagnostic: vi.fn(),
  runFile: vi.fn(),
  workerBuild: vi.fn<(outfile: string) => void>(),
  models: {} as Record<string, { default: string, fallback: string }>,
  agentAccount: 'bit-mis',
  // The scheduler's replay check; these tests admit everything unless told not to.
  admit: vi.fn(async () => ({ author: 'poise-user' })),
}))

vi.mock('esbuild', async importOriginal => {
  const original = await importOriginal<typeof import('esbuild')>()
  return { ...original, build: (options: import('esbuild').BuildOptions) => {
    mocks.workerBuild(options.outfile ?? '')
    return original.build(options)
  } }
})

vi.mock('../server/settings', () => ({
  getModelSettings: () => mocks.models,
  requireAgentAccount: () => {
    if (!mocks.agentAccount) throw new Error('No agent account is set. Set it in Settings → GitHub: it is the GitHub user your reviews and comments are posted as.')
    return mocks.agentAccount
  },
}))

vi.mock('../server/behavior-ledger', () => ({
  captureBehaviorAdmission: mocks.captureAdmission, captureBehaviorOutcome: mocks.captureOutcome,
  observeAgentSnapshot: mocks.observeSnapshot, behaviorLedgerHeartbeat: vi.fn(),
}))

vi.mock('../server/logging', () => ({
  diagnostic: mocks.diagnostic,
}))

vi.mock('../server/process', () => ({
  claudeSubscriptionEnvironment: vi.fn(),
  runFile: mocks.runFile,
  spawnDetached: vi.fn(),
}))
vi.mock('../server/claude-auth', () => ({
  claudeAuth: {
    observeProcessFailure: vi.fn(),
    requireReady: vi.fn(),
  },
}))
vi.mock('../server/review-checkout', () => ({ resolveReviewCheckout: vi.fn(async () => '/repo') }))

vi.mock('../server/gh', () => ({
  getHeadSha: vi.fn(),
  getPrAuthor: vi.fn(),
  localCheckoutPath: vi.fn(),
}))

import { fetchAgentLogs, fetchAgentLogSnapshot, fetchAgentReasoning, fetchSelectedAgentLogSnapshot, fetchAgentLogsSince, fetchAgentLogWatermark, fetchRunningAgentLogs, fetchRunningAgentLogSnapshot, quarantinedLogMayMatch, resetAgentLogCache } from '../server/agent'
import { CATALOG_STDOUT } from './model-catalog-fixture'

function logRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a'.repeat(32),
    pr_id: '12',
    repo: 'owner/repo',
    actor: 'bit-mis',
    model: 'opus-5-xhigh',
    behavior: 'pr_review',
    session_id: null,
    prompt: '',
    started_at: '2026-07-17T09:00:00.000Z',
    started_at_precise: '2026-07-17T09:00:00.000Z',
    completed_at: '2026-07-17T09:01:00.000Z',
    time_elapsed: '1m',
    status: 'completed',
    outcome: null,
    head_sha: null,
    expected_head: null,
    source: null,
    correlation_id: null,
    action: null,
    response: null,
    error: '',
    ...overrides,
  }
}

beforeEach(() => {
  mocks.captureAdmission.mockClear(); mocks.captureOutcome.mockClear(); mocks.observeSnapshot.mockClear()
  mocks.diagnostic.mockClear()
  mocks.workerBuild.mockClear()
  resetAgentLogCache()
})

describe('agent log compatibility', () => {
  beforeEach(() => mocks.runFile.mockReset())

  it('projects an existing validated snapshot without another Caller read', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([logRow()]), stderr: '' })
    const snapshot = await fetchAgentLogSnapshot()
    expect(mocks.observeSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot)
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    expect(mocks.runFile.mock.calls[0][1]).toEqual(['--logs'])
    expect(mocks.captureAdmission).not.toHaveBeenCalled()
    expect(mocks.diagnostic).not.toHaveBeenCalled()
  })

  // Every --logs read still dumps the whole Caller log, and the 32 MiB
  // runFile cap fails all of them at once. A read past 75% of the cap warns
  // into the workspace diagnostics, at most hourly, and still resolves.
  it('warns once as --logs nears the read cap, and still resolves', async () => {
    const huge = logRow({ prompt: 'x'.repeat(25 * 1024 * 1024) })
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([huge]), stderr: '' })
    const first = await fetchAgentLogSnapshot()
    const second = await fetchAgentLogSnapshot()
    expect(first.entries).toHaveLength(1)
    expect(second.entries).toHaveLength(1)
    expect(mocks.diagnostic).toHaveBeenCalledTimes(1)
    const warning = mocks.diagnostic.mock.calls[0][0]
    expect(warning).toMatchObject({ level: 'warning', operation: 'agent.logs.cap' })
    expect(warning.resources).toEqual({ bytes: expect.any(Number), rows: 1, cap: 32 * 1024 * 1024 })
    expect(warning.resources.bytes).toBeGreaterThan(24 * 1024 * 1024)
    expect(warning.message).toContain('33554432')
  })

  // Fields agent-interface added over time — expected_head, source,
  // correlation_id, action — are simply absent from rows written before them.
  // Only an explicit null was accepted, so `undefined` failed validation, and
  // because the batch is validated as a unit one such row rejected all of
  // them: with the oldest row in this log dating to May, /api/agent-logs
  // answered 502 and Swarm rendered nothing at all.
  it('reads a row written before a field existed, and does not fail its batch', async () => {
    const legacy = logRow({ behavior: null, pr_id: null, repo: null, actor: 'bit-mis' })
    for (const field of ['expected_head', 'source', 'correlation_id', 'action', 'outcome', 'head_sha', 'session_id']) {
      delete legacy[field]
    }
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([legacy, logRow({ id: 'b'.repeat(32) })]),
      stderr: '',
    })
    const rows = await fetchAgentLogs()
    expect(rows).toHaveLength(2)
    // Absent reads as absent, not as a violation.
    expect(rows.find((r) => r.id === 'a'.repeat(32))).toMatchObject({
      expected_head: null, source: null, correlation_id: null, action: null,
      outcome: null, head_sha: null, session_id: null,
    })
    // And the well-formed row beside it still arrives.
    expect(rows.some((r) => r.id === 'b'.repeat(32))).toBe(true)
  })

  it('passes the exact durable process cause into Poise with its call identity', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([logRow({ diagnostic: {
      version: 1, source: 'caller', severity: 'error', operation: 'fetch', phase: 'checkout', outcome: 'exit',
      stderr: 'fatal: remote ref missing\nremote: exact cause', stderr_truncated: false,
      call_id: 'a'.repeat(32), correlation_id: 'run', exit_code: 128, filesystem: null,
    } })]), stderr: '' })
    const rows = await fetchAgentLogs()
    expect(rows[0]?.diagnostic).toMatchObject({ operation: 'fetch', stderr: 'fatal: remote ref missing\nremote: exact cause',
      context: { call_id: 'a'.repeat(32), correlation_id: 'run', exit_code: 128 } })
  })

  it('keeps a historical unqualified repository row readable', async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([logRow({ repo: 'legacy-repo' })]),
      stderr: '',
    })
    await expect(fetchAgentLogs()).resolves.toMatchObject([{
      repo: 'legacy-repo',
      source: null,
    }])
  })

  it('rejects an unqualified repository in a Poise launch contract', async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([logRow({
        repo: 'legacy-repo',
        source: 'poise:review-new-prs',
        expected_head: 'b'.repeat(40),
        head_sha: 'b'.repeat(40),
        correlation_id: 'correlation-1',
        action: 'reviewed_clean',
        outcome: 'clean',
      })]),
      stderr: '',
    })
    await expect(fetchAgentLogs()).rejects.toThrow(/incomplete Poise provenance/)
  })

  it('accepts a running Poise call before it has a terminal error', async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([logRow({
        status: 'running',
        completed_at: null,
        error: null,
        source: 'poise:review-new-prs',
        expected_head: 'b'.repeat(40),
        correlation_id: 'correlation-1',
      })]),
      stderr: '',
    })
    await expect(fetchAgentLogs()).resolves.toMatchObject([{
      status: 'running',
      error: '',
      source: 'poise:review-new-prs',
    }])
  })

  it('accepts a typed superseded Poise call', async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([logRow({
        status: 'superseded',
        outcome: 'superseded',
        head_sha: 'c'.repeat(40),
        source: 'poise:review-new-prs',
        expected_head: 'b'.repeat(40),
        correlation_id: 'correlation-1',
      })]),
      stderr: '',
    })
    await expect(fetchAgentLogs()).resolves.toMatchObject([{
      status: 'superseded',
      outcome: 'superseded',
      head_sha: 'c'.repeat(40),
    }])
  })
})

describe('agent log quarantine', () => {
  beforeEach(() => mocks.runFile.mockReset())

  it('returns valid rows newest first while retaining malformed row attribution', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'a'.repeat(32) }),
      logRow({ id: 'B'.repeat(32), actor: 42, correlation_id: 'claim-1', session_id: 'session-1' }),
      logRow({ id: 'c'.repeat(32) }),
    ]), stderr: '' })
    const controller = new AbortController()

    const snapshot = await fetchAgentLogSnapshot({ signal: controller.signal })

    expect(snapshot.entries.map((row) => row.id)).toEqual(['c'.repeat(32), 'a'.repeat(32)])
    expect(snapshot.quarantined).toEqual([{
      index: 1,
      status: 'completed',
      error: 'agent-interface log row 1 has invalid actor',
      id: 'b'.repeat(32),
      correlationId: 'claim-1',
      repo: 'owner/repo',
      prId: '12',
      behavior: 'pr_review',
      sessionId: 'session-1',
    }])
    // The spawn carries the shared read's own abort signal, not the caller's:
    // one waiter leaving must not kill the read for the others.
    const childSignal = mocks.runFile.mock.calls[0][2].signal as AbortSignal
    expect(childSignal).toBeInstanceOf(AbortSignal)
    expect(childSignal).not.toBe(controller.signal)
    expect(childSignal.aborted).toBe(false)
    await expect(fetchAgentLogs()).rejects.toThrow(/log row 1 has invalid actor/)
  })

  it('retains recognized lifecycle hints without inventing terminal state for unreadable rows', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ actor: 42, status: 'RUNNING' }),
      logRow({ actor: 42, status: 'completed' }),
      logRow({ actor: 42, status: 'unexpected' }),
      logRow({ actor: 42, status: 42 }),
    ]), stderr: '' })
    const snapshot = await fetchAgentLogSnapshot()
    expect(snapshot.entries).toEqual([])
    expect(snapshot.quarantined.map((row) => row.status)).toEqual(['running', 'completed', null, null])
  })

  it('validates routing independently and keeps completely unreadable rows conservative', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'bad-id', correlation_id: 'claim-1', repo: 'bad repo', pr_id: 12, behavior: {}, session_id: [] }),
      null,
      ['not a log object'],
    ]), stderr: '' })

    const snapshot = await fetchAgentLogSnapshot()

    expect(snapshot.entries).toEqual([])
    expect(snapshot.quarantined[0]).toMatchObject({
      id: null, correlationId: 'claim-1', repo: null, prId: null, behavior: null, sessionId: null,
    })
    for (const row of snapshot.quarantined.slice(1)) {
      expect(row).toMatchObject({ id: null, correlationId: null, repo: null, prId: null, behavior: null, sessionId: null })
      expect(quarantinedLogMayMatch(row, { id: 'a'.repeat(32), correlationId: 'claim-2', repo: 'owner/repo', prId: '12', behavior: 'pr_review' })).toBe(true)
    }
  })

  it.each([
    ['empty output', ''],
    ['invalid JSON', '[broken'],
    ['non-array JSON', '{}'],
  ])('rejects an unavailable feed with %s', async (message, stdout) => {
    mocks.runFile.mockResolvedValue({ stdout, stderr: '' })
    await expect(fetchAgentLogSnapshot()).rejects.toThrow(message)
    await expect(fetchAgentLogs()).rejects.toThrow(message)
  })

  it('isolates unrelated identities but retains duplicate call or correlation identities', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'a'.repeat(32), correlation_id: 'claim-1', actor: 42, session_id: 'session-1' }),
    ]), stderr: '' })
    const { quarantined: [row] } = await fetchAgentLogSnapshot()

    expect(quarantinedLogMayMatch(row, { repo: 'owner/other' })).toBe(false)
    expect(quarantinedLogMayMatch(row, { prId: '13' })).toBe(false)
    expect(quarantinedLogMayMatch(row, { behavior: 'issue_review' })).toBe(false)
    expect(quarantinedLogMayMatch(row, { sessionId: 'session-2' })).toBe(false)
    expect(quarantinedLogMayMatch(row, { id: 'b'.repeat(32) })).toBe(false)
    expect(quarantinedLogMayMatch(row, { correlationId: 'claim-2' })).toBe(false)
    expect(quarantinedLogMayMatch(row, { repo: 'OWNER/REPO', prId: '12' })).toBe(true)
    expect(quarantinedLogMayMatch(row, { id: 'A'.repeat(32), correlationId: 'claim-2', repo: 'other/repo' })).toBe(true)
    expect(quarantinedLogMayMatch(row, { id: 'b'.repeat(32), correlationId: 'claim-1', repo: 'other/repo' })).toBe(true)
  })

  it('allows unrelated quarantine only for an explicitly scoped read', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'a'.repeat(32), session_id: 'session-1' }),
      logRow({ id: 'b'.repeat(32), actor: 42, session_id: 'session-2' }),
    ]), stderr: '' })

    await expect(fetchAgentLogs({ identity: { sessionId: 'session-1' } }))
      .resolves.toMatchObject([{ id: 'a'.repeat(32) }])
    await expect(fetchAgentLogs({ identity: { sessionId: 'session-2' } })).rejects.toThrow(/invalid actor/)
    await expect(fetchAgentLogs()).rejects.toThrow(/invalid actor/)
  })

  it('allows an exact validated call despite unknown rows but never infers a missing call or complete session', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'a'.repeat(32), session_id: 'session-1' }),
      null,
    ]), stderr: '' })

    await expect(fetchAgentLogs({ identity: { id: 'A'.repeat(32) } }))
      .resolves.toMatchObject([{ id: 'a'.repeat(32) }])
    await expect(fetchAgentLogs({ identity: { id: 'b'.repeat(32) } })).rejects.toThrow(/not an object/)
    await expect(fetchAgentLogs({ identity: { sessionId: 'session-1' } })).rejects.toThrow(/not an object/)
  })

  it.each(['id', 'correlation'])('rejects an exact call result with a conflicting quarantined %s duplicate', async (duplicate) => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'a'.repeat(32), correlation_id: 'claim-1' }),
      logRow({
        id: duplicate === 'id' ? 'a'.repeat(32) : 'b'.repeat(32),
        correlation_id: duplicate === 'correlation' ? 'claim-1' : 'claim-2',
        repo: 'other/repo',
        actor: 42,
      }),
    ]), stderr: '' })

    await expect(fetchAgentLogs({ identity: { id: 'a'.repeat(32), repo: 'owner/repo' } }))
      .rejects.toThrow(/invalid actor/)
  })

  it.each(['id', 'correlation'])('rejects a session-scoped result with a quarantined %s duplicate claiming another session', async (duplicate) => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'a'.repeat(32), correlation_id: 'claim-1', session_id: 'session-1', behavior: 'author_content' }),
      logRow({
        id: duplicate === 'id' ? 'a'.repeat(32) : 'b'.repeat(32),
        correlation_id: duplicate === 'correlation' ? 'claim-1' : 'claim-2',
        session_id: 'session-2', behavior: 'chat', actor: 42,
      }),
    ]), stderr: '' })

    await expect(fetchAgentLogs({ identity: { sessionId: 'session-1', behavior: 'author_content' } }))
      .rejects.toThrow(/invalid actor/)
  })

  it.each(['session-2', null])('does not extend a session scope to a valid duplicate with session %s', async (sessionId) => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'a'.repeat(32), session_id: 'session-1', behavior: 'author_content' }),
      logRow({ id: 'b'.repeat(32), session_id: sessionId, behavior: 'author_content' }),
      logRow({ id: 'b'.repeat(32), session_id: 'session-3', behavior: 'author_content', actor: 42 }),
    ]), stderr: '' })

    const rows = await fetchAgentLogs({ identity: { sessionId: 'session-1', behavior: 'author_content' } })

    expect(rows.map((row) => row.id)).toEqual(['b'.repeat(32), 'a'.repeat(32)])
  })

  it('does not invent an owner for a legacy unqualified repository', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ actor: 42, repo: 'legacy-repo' }),
    ]), stderr: '' })
    const { quarantined: [row] } = await fetchAgentLogSnapshot()

    expect(quarantinedLogMayMatch(row, { repo: 'owner/legacy-repo' })).toBe(true)
    expect(quarantinedLogMayMatch(row, { repo: 'owner/another-repo' })).toBe(false)
  })
})

describe('agent log snapshot sharing', () => {
  // Braces, not an expression body: vitest would run a returned function as
  // a teardown, calling the mock once more after every test.
  beforeEach(() => { mocks.runFile.mockReset() })

  it('shares one read across overlapping readers, and queues a fresh reader onto a follow-up', async () => {
    const releases: Array<(value: { stdout: string, stderr: string }) => void> = []
    mocks.runFile.mockImplementation(() => new Promise((resolve) => { releases.push(resolve) }))
    const first = fetchAgentLogSnapshot()
    const late = Array.from({ length: 10 }, () => fetchAgentLogSnapshot())
    const fresh = fetchAgentLogSnapshot({ fresh: true })
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    releases[0]!({ stdout: JSON.stringify([logRow({ id: 'a'.repeat(32) })]), stderr: '' })
    const firstSnapshot = await first
    expect(firstSnapshot.entries.map((row) => row.id)).toEqual(['a'.repeat(32)])
    const snapshots = await Promise.all(late)
    for (const snapshot of snapshots) expect(snapshot).toBe(firstSnapshot)
    // The fresh reader queued for the next read, which starts when the
    // running one settles — and sees the row written after it arrived.
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
    releases[1]!({ stdout: JSON.stringify([logRow({ id: 'a'.repeat(32) }), logRow({ id: 'b'.repeat(32) })]), stderr: '' })
    const freshSnapshot = await fresh
    expect(freshSnapshot.entries.map((row) => row.id)).toEqual(['b'.repeat(32), 'a'.repeat(32)])
    expect(mocks.observeSnapshot).toHaveBeenCalledTimes(2)
  })

  it('reuses the shared snapshot within its TTL, then reads again', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([logRow()]), stderr: '' })
    const first = await fetchAgentLogSnapshot()
    await expect(fetchAgentLogSnapshot()).resolves.toBe(first)
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    resetAgentLogCache()
    await expect(fetchAgentLogSnapshot()).resolves.not.toBe(first)
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
  })

  it('rereads once the shared snapshot TTL expires', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([logRow()]), stderr: '' })
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(1_000_000)
      const first = await fetchAgentLogSnapshot()
      now.mockReturnValue(1_000_000 + 4_999)
      await expect(fetchAgentLogSnapshot()).resolves.toBe(first)
      expect(mocks.runFile).toHaveBeenCalledTimes(1)
      now.mockReturnValue(1_000_000 + 5_000)
      await expect(fetchAgentLogSnapshot()).resolves.not.toBe(first)
      expect(mocks.runFile).toHaveBeenCalledTimes(2)
    } finally {
      now.mockRestore()
    }
  })

  it('rejects one waiter’s abort without disturbing the other reader', async () => {
    const releases: Array<(value: { stdout: string, stderr: string }) => void> = []
    mocks.runFile.mockImplementation(() => new Promise((resolve) => { releases.push(resolve) }))
    const first = fetchAgentLogSnapshot()
    const leaving = new AbortController()
    const staying = new AbortController()
    const gone = fetchAgentLogSnapshot({ signal: leaving.signal })
    const kept = fetchAgentLogSnapshot({ signal: staying.signal })
    const reason = new Error('waiter is gone')
    leaving.abort(reason)
    const failure = await gone.catch((error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).name).toBe('AbortError')
    expect((failure as Error).message).toBe('The operation was aborted')
    expect((failure as { code?: unknown }).code).toBe('ABORT_ERR')
    expect((failure as Error).cause).toBe(reason)
    releases[0]!({ stdout: JSON.stringify([logRow()]), stderr: '' })
    await expect(first).resolves.toBeDefined()
    // Both remaining readers joined the one running read.
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    const childSignal = mocks.runFile.mock.calls[0][2].signal as AbortSignal
    expect(childSignal.aborted).toBe(false)
    await expect(kept).resolves.toMatchObject({ entries: [{ id: 'a'.repeat(32) }] })
  })

  it('drops a queued read its waiters all abandon before it spawns', async () => {
    const releases: Array<(value: { stdout: string, stderr: string }) => void> = []
    mocks.runFile.mockImplementation(() => new Promise((resolve) => { releases.push(resolve) }))
    const controller = new AbortController()
    const first = fetchAgentLogSnapshot()
    const queued = fetchAgentLogSnapshot({ signal: controller.signal, fresh: true })
    controller.abort()
    await expect(queued).rejects.toThrow('The operation was aborted')
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    releases[0]!({ stdout: JSON.stringify([logRow()]), stderr: '' })
    await expect(first).resolves.toBeDefined()
    // Nothing was left queued: a fresh call spawns its own read.
    const third = fetchAgentLogSnapshot({ fresh: true })
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
    releases[1]!({ stdout: JSON.stringify([logRow()]), stderr: '' })
    await expect(third).resolves.toBeDefined()
  })

  it('aborts the child once every waiter is gone, and a new caller spawns fresh', async () => {
    // Like the real runFile: the child dies when its own signal aborts.
    const releases: Array<(value: { stdout: string, stderr: string }) => void> = []
    mocks.runFile.mockImplementation((_command: string, _args: readonly string[],
      options: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      releases.push(resolve)
      options.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')), { once: true })
    }))
    const gone = new AbortController()
    const first = new AbortController()
    const second = new AbortController()
    const running = fetchAgentLogSnapshot({ signal: gone.signal })
    const one = fetchAgentLogSnapshot({ signal: first.signal })
    const two = fetchAgentLogSnapshot({ signal: second.signal })
    // All three joined the one running read.
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    const childSignal = mocks.runFile.mock.calls[0][2].signal as AbortSignal
    gone.abort()
    await expect(running).rejects.toThrow('The operation was aborted')
    expect(childSignal.aborted).toBe(false)
    first.abort()
    await expect(one).rejects.toThrow('The operation was aborted')
    expect(childSignal.aborted).toBe(false)
    second.abort()
    await expect(two).rejects.toThrow('The operation was aborted')
    expect(childSignal.aborted).toBe(true)
    // The slot cleared synchronously: a caller arriving during kill
    // teardown joins no dying child.
    const fresh = fetchAgentLogSnapshot()
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
    releases[1]!({ stdout: JSON.stringify([logRow()]), stderr: '' })
    await expect(fresh).resolves.toBeDefined()
  })

  it('rejects a pre-aborted caller without spawning', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(fetchAgentLogSnapshot({ signal: controller.signal })).rejects.toThrow()
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('fails a shared read’s waiters, still runs the fresh waiter’s queued read, then shares', async () => {
    mocks.runFile.mockRejectedValueOnce(new Error('Caller is down'))
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([logRow()]), stderr: '' })
    const one = fetchAgentLogSnapshot()
    const two = fetchAgentLogSnapshot({ fresh: true })
    await expect(one).rejects.toThrow('Caller is down')
    // The queued read is its own attempt, not the failure inherited.
    await expect(two).resolves.toBeDefined()
    expect(mocks.observeSnapshot).toHaveBeenCalledTimes(1)
    await expect(fetchAgentLogSnapshot()).resolves.toBeDefined()
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
  })

  it('freezes the shared snapshot so co-waiters cannot corrupt each other', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'a'.repeat(32) }),
      logRow({ id: 'b'.repeat(32), actor: 42 }),
    ]), stderr: '' })
    const snapshot = await fetchAgentLogSnapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.entries)).toBe(true)
    expect(Object.isFrozen(snapshot.quarantined)).toBe(true)
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true)
    expect(Object.isFrozen(snapshot.quarantined[0])).toBe(true)
    expect(() => snapshot.entries.push(snapshot.entries[0]!)).toThrow(TypeError)
  })

  it('ignores an abort that lands after the read has settled', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([logRow()]), stderr: '' })
    const controller = new AbortController()
    const first = await fetchAgentLogSnapshot({ signal: controller.signal })
    controller.abort()
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    await expect(fetchAgentLogSnapshot()).resolves.toBe(first)
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
  })

  it('spawns every shared read under its own diagnostic identity', async () => {
    const { diagnosticIdentity, withNoticeDiagnosticIdentity } = await import('../server/logging-context')
    const seen: Array<{ correlationId: string }> = []
    const releases: Array<(value: { stdout: string, stderr: string }) => void> = []
    mocks.runFile.mockImplementation(() => new Promise((resolve) => {
      seen.push(diagnosticIdentity() as { correlationId: string })
      releases.push(resolve)
    }))
    const firstSpawner = { correlationId: 'first', behavior: 'review-new-prs', repository: 'o/r', target: 'o/r#1', account: 'a' }
    const queuedSpawner = { correlationId: 'queued', behavior: 'approve-prs', repository: 'o/r', target: 'o/r#2', account: 'a' }
    const first = withNoticeDiagnosticIdentity(firstSpawner, () => fetchAgentLogSnapshot())
    const second = withNoticeDiagnosticIdentity(queuedSpawner, () => fetchAgentLogSnapshot({ fresh: true }))
    releases[0]!({ stdout: JSON.stringify([logRow()]), stderr: '' })
    await first
    // The queued read starts inside the first read's settle callback, whose
    // async context is the first read's spawner — not the queued waiter's.
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
    releases[1]!({ stdout: JSON.stringify([logRow()]), stderr: '' })
    await second
    expect(seen).toHaveLength(2)
    for (const identity of seen) {
      expect(identity).toMatchObject({ behavior: 'agent-logs', repository: null, target: null, account: null })
      expect(identity.correlationId).not.toBe('first')
      expect(identity.correlationId).not.toBe('queued')
    }
    expect(seen[0]!.correlationId).not.toBe(seen[1]!.correlationId)
  })

  it('gives each waiter its own error object when a shared read fails', async () => {
    const shared = Object.assign(new Error('Caller is down'), { code: 1, killed: false, signal: null, stdout: '', stderr: 'boom', errno: -2 })
    mocks.runFile.mockRejectedValue(shared)
    const first = fetchAgentLogSnapshot()
    const second = fetchAgentLogSnapshot()
    const third = fetchAgentLogSnapshot()
    const failures = await Promise.all([
      first.catch((error) => error),
      second.catch((error) => error),
      third.catch((error) => error),
    ])
    // All three joined the one running read: distinct objects.
    expect(failures[0]).not.toBe(failures[1])
    expect(failures[1]).not.toBe(failures[2])
    expect(failures[0]).not.toBe(shared)
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).toBe('Caller is down')
      expect(failure.name).toBe('Error')
      expect(failure.code).toBe(1)
      expect(failure.stderr).toBe('boom')
      expect(failure.errno).toBe(-2)
      expect(failure.cause).toBe(shared)
    }
  })

  it('wraps a non-Error rejection in a fresh error per waiter', async () => {
    mocks.runFile.mockRejectedValue('Caller is down')
    const failures = await Promise.all([
      fetchAgentLogSnapshot().catch((error) => error),
      fetchAgentLogSnapshot().catch((error) => error),
    ])
    expect(failures[0]).not.toBe(failures[1])
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).toBe('Caller is down')
      expect(failure.cause).toBe('Caller is down')
    }
  })

  it('attributes each waiter copy under its own identity', async () => {
    const { diagnosticIdentity, withNoticeDiagnosticIdentity } = await import('../server/logging-context')
    mocks.runFile.mockRejectedValue({ message: 'Caller is down' })
    const failures = await Promise.all([
      fetchAgentLogSnapshot().catch((error) => error),
      fetchAgentLogSnapshot().catch((error) => error),
    ])
    const firstIdentity = { correlationId: 'first', behavior: 'review-new-prs', repository: 'o/r', target: 'o/r#1', account: 'a' }
    const secondIdentity = { correlationId: 'second', behavior: 'approve-prs', repository: 'o/r', target: 'o/r#2', account: 'a' }
    await withNoticeDiagnosticIdentity(firstIdentity, async () => { throw failures[0] }).catch(() => undefined)
    await withNoticeDiagnosticIdentity(secondIdentity, async () => { throw failures[1] }).catch(() => undefined)
    // No ambient context: each copy kept the identity it was logged under.
    // A shared object would carry only the last writer's identity.
    expect(diagnosticIdentity(failures[0])).toMatchObject({ correlationId: 'first', behavior: 'review-new-prs' })
    expect(diagnosticIdentity(failures[1])).toMatchObject({ correlationId: 'second', behavior: 'approve-prs' })
  })
})

describe('manual review model selection', () => {
  beforeEach(async () => {
    mocks.models = {}
    mocks.runFile.mockReset().mockResolvedValue({ stdout: CATALOG_STDOUT, stderr: '' })
    const { invalidateCatalog } = await import('../server/models')
    invalidateCatalog()
    const gh = await import('../server/gh')
    vi.mocked(gh.getHeadSha).mockResolvedValue('a'.repeat(40))
    vi.mocked(gh.getPrAuthor).mockResolvedValue('poise-user')
    const { setMeta } = await import('../server/db')
    setMeta('me', 'poise-user'); setMeta('agentAccount', 'bit-mis')
    mocks.agentAccount = 'bit-mis'
    vi.mocked(gh.localCheckoutPath).mockResolvedValue('/repo')
    const { spawnDetached } = await import('../server/process')
    vi.mocked(spawnDetached).mockReset().mockResolvedValue(undefined)
    const { claudeAuth } = await import('../server/claude-auth')
    vi.mocked(claudeAuth.requireReady).mockReset().mockResolvedValue(undefined)
  })

  it('launches the catalog default with its recovery model when nothing is chosen', async () => {
    const { triggerPrReview, replayAgentJob } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    const { claudeAuth } = await import('../server/claude-auth')
    await triggerPrReview('https://github.com/o/r/pull/12')
    await replayAgentJob({ behavior: 'pr_approve', repo: 'o/r', pr_id: 12 }, mocks.admit)
    expect(spawnDetached).toHaveBeenCalledTimes(2)
    for (const [, args] of vi.mocked(spawnDetached).mock.calls) {
      expect(args).toEqual(expect.arrayContaining(['--model', 'opus-5-xhigh', '--recovery-model', 'gpt-6-astra-ultra', '--actor', 'bit-mis', '--expected-head', 'a'.repeat(40)]))
    }
    expect(claudeAuth.requireReady).toHaveBeenCalledTimes(4)
    const admissions = mocks.captureAdmission.mock.calls.map(([admission]) => admission)
    expect(admissions).toMatchObject([
      { behavior: 'review-new-prs', source: 'poise:manual-review', repository: 'o/r', number: 12 },
      { behavior: 'approve-prs', source: 'poise:replay', repository: 'o/r', number: 12 },
    ])
    expect(new Set(admissions.map(({ admissionKey }) => admissionKey)).size).toBe(2)
    for (const admission of admissions) expect(admission.admissionKey).toBe(admission.nativeId)
  })

  it('records a rejected spawn and preserves its exact error', async () => {
    const { triggerPrReview } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    const failure = new Error('spawn rejected')
    vi.mocked(spawnDetached).mockRejectedValueOnce(failure)
    await expect(triggerPrReview('https://github.com/o/r/pull/12')).rejects.toBe(failure)
    expect(mocks.captureAdmission).toHaveBeenCalledOnce()
    expect(mocks.captureOutcome).toHaveBeenCalledExactlyOnceWith({
      nativeId: mocks.captureAdmission.mock.calls[0][0].nativeId,
      state: 'failed', activity: 'settled', stateSource: 'native', outcome: 'spawn_failed',
    })
  })

  it('launches the chosen default and fallback, and skips the Claude gate for Codex', async () => {
    const choice = { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' }
    mocks.models = { pr_review: choice, pr_approve: choice }
    const { triggerPrReview, replayAgentJob } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    const { claudeAuth } = await import('../server/claude-auth')
    await triggerPrReview('https://github.com/o/r/pull/12')
    await replayAgentJob({ behavior: 'pr_approve', repo: 'o/r', pr_id: 12 }, mocks.admit)
    for (const [, args] of vi.mocked(spawnDetached).mock.calls) {
      expect(args).toEqual(expect.arrayContaining(['--model', 'gpt-6-astra-ultra', '--recovery-model', 'opus-5-xhigh']))
    }
    expect(claudeAuth.requireReady).not.toHaveBeenCalled()
  })

  it('falls back to the catalog default when the chosen model was retired', async () => {
    mocks.models = { pr_review: { default: 'opus-4.8-max', fallback: 'gpt-6-astra-ultra' } }
    const { triggerPrReview } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    await triggerPrReview('https://github.com/o/r/pull/12')
    expect(vi.mocked(spawnDetached).mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'opus-5-xhigh']))
  })

  it('does not launch against Caller that cannot honor the selection', async () => {
    mocks.runFile.mockResolvedValue({ stdout: '{}', stderr: '' })
    const { triggerPrReview } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    await expect(triggerPrReview('https://github.com/o/r/pull/12')).rejects.toThrow(/Update Caller/)
    expect(spawnDetached).not.toHaveBeenCalled()
  })

  // A replay launches only what the scheduler would: its check runs first, on
  // the target as the request names it, and a refusal stops everything after.
  it.each([
    ['pr_review', 'o/r', 12, 12],
    ['pr_approve', 'o/r', '12', 12],
    ['issue_review', 'Vaquum/Origo', '452', 452],
  ] as const)('asks the scheduler check before preparing a %s replay, and launches nothing it refuses', async (behavior, repo, prId, number) => {
    const { replayAgentJob } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    const { claudeAuth } = await import('../server/claude-auth')
    const gh = await import('../server/gh')
    const refusal = Object.assign(new Error(`Replay refused: ${repo}#${number} is not open.`), { statusCode: 409 })
    mocks.admit.mockRejectedValueOnce(refusal)
    mocks.runFile.mockClear()
    await expect(replayAgentJob({ behavior, repo, pr_id: prId }, mocks.admit)).rejects.toBe(refusal)
    expect(mocks.admit).toHaveBeenCalledWith(behavior, repo, number)
    // Refused before the model catalog, the sign-in, the checkout or the head
    // are read, so a refused replay costs nothing and starts nothing.
    expect(mocks.runFile).not.toHaveBeenCalled()
    expect(claudeAuth.requireReady).not.toHaveBeenCalled()
    expect(gh.localCheckoutPath).not.toHaveBeenCalled()
    expect(gh.getHeadSha).not.toHaveBeenCalled()
    expect(spawnDetached).not.toHaveBeenCalled()
  })

  it('checks nothing for a malformed or unreplayable request', async () => {
    const { replayAgentJob } = await import('../server/agent')
    await expect(replayAgentJob({ behavior: 'pr_review', repo: 'not-a-repo', pr_id: 1 }, mocks.admit)).rejects.toThrow('repo must be owner/name')
    await expect(replayAgentJob({ behavior: 'pr_review', repo: 'o/r', pr_id: '0' }, mocks.admit)).rejects.toThrow('pr_id must be a positive integer')
    await expect(replayAgentJob({ behavior: 'fix_failing_ci', repo: 'o/r', pr_id: 1 }, mocks.admit)).rejects.toThrow('is not replayable')
    expect(mocks.admit).not.toHaveBeenCalled()
  })

  it('launches nothing without an agent account and says where to set it', async () => {
    mocks.agentAccount = ''
    const { setMeta } = await import('../server/db'); setMeta('agentAccount', '')
    const { triggerPrReview, replayAgentJob } = await import('../server/agent')
    const { spawnDetached } = await import('../server/process')
    await expect(triggerPrReview('https://github.com/o/r/pull/12')).rejects.toThrow('Set it in Settings → GitHub')
    await expect(replayAgentJob({ behavior: 'pr_approve', repo: 'o/r', pr_id: 12 }, mocks.admit)).rejects.toThrow('Set it in Settings → GitHub')
    await expect(replayAgentJob({ behavior: 'issue_review', repo: 'o/r', pr_id: '4' }, mocks.admit)).rejects.toThrow('No agent account is set')
    expect(spawnDetached).not.toHaveBeenCalled()
  })
})

describe('progress data does not determine review status', () => {
  const now = '2026-09-13T11:00:00.000Z'
  const progress = {
    version: 1, phase: 'waiting_provider', phase_started_at: now,
    heartbeat_at: now, last_provider_event_at: null, deadline_at: null,
    warning: null, events: [{ at: now, message: 'Waiting for provider' }],
  }

  it('preserves current progress and keeps rows from older Caller versions readable', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ progress }), logRow({ id: 'b'.repeat(32) }),
    ]), stderr: '' })
    const rows = await fetchAgentLogs()
    expect(rows[0].progress).toBeNull()
    expect(rows[1].progress).toEqual(progress)
  })

  it.each([
    { ...progress, version: 2 },
    { ...progress, heartbeat_at: 'invalid' },
    { ...progress, events: Array(21).fill({ at: now, message: 'event' }) },
    { ...progress, events: [{ at: now, message: 'x'.repeat(161) }] },
    { ...progress, phase: '__proto__' },
  ])('invalid observation data cannot hide the run or override its outcome', async (progress) => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([logRow({ progress, status: 'completed', outcome: 'approved' })]), stderr: '' })
    await expect(fetchAgentLogs()).resolves.toMatchObject([{ status: 'completed', outcome: 'approved', progress: null }])
  })
})


describe('stopping a run', () => {
  beforeEach(() => mocks.runFile.mockReset())
  it('asks Caller to stop the call and passes its answer through', async () => {
    const { stopAgentJob } = await import('../server/agent')
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ id: 'a'.repeat(32), stopped: true, status: 'failed', error_code: 'stopped' }), stderr: '' })
    await expect(stopAgentJob('A'.repeat(32))).resolves.toEqual({ id: 'a'.repeat(32), stopped: true, status: 'failed', error_code: 'stopped' })
    expect(mocks.runFile).toHaveBeenCalledWith('agent-interface', ['--stop', 'a'.repeat(32)], expect.objectContaining({ timeoutMs: 30_000 }))
  })
  it('refuses a malformed id before running anything, and an old Caller after', async () => {
    const { stopAgentJob } = await import('../server/agent')
    await expect(stopAgentJob('../etc')).rejects.toThrow('invalid agent call id')
    expect(mocks.runFile).not.toHaveBeenCalled()
    mocks.runFile.mockResolvedValue({ stdout: 'usage: agent-interface BEHAVIOR', stderr: '' })
    await expect(stopAgentJob('b'.repeat(32))).rejects.toThrow('Update Caller')
  })
})

describe('provider reasoning reads', () => {
  beforeEach(() => mocks.runFile.mockReset())
  it('reads only a full call id and bounds the CLI output', async () => {
    mocks.runFile.mockResolvedValue({ stdout: 'exposed reasoning' })
    await expect(fetchAgentReasoning('A'.repeat(32))).resolves.toMatchObject({ body: 'exposed reasoning' })
    expect(mocks.runFile).toHaveBeenCalledWith('agent-interface', ['--read-reasoning', 'a'.repeat(32)], expect.objectContaining({ maxOutputBytes: 512 * 1024 }))
    mocks.runFile.mockClear()
    for (const id of ['../secret', 'a'.repeat(8)]) await expect(fetchAgentReasoning(id)).rejects.toThrow('invalid agent call id')
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
})


describe('review policy compatibility', () => {
  it('rejects a Caller release without the bounded review policy or the catalog', async () => {
    const { reviewChoice } = await import('../server/review-model')
    const { invalidateCatalog } = await import('../server/models')
    invalidateCatalog()
    mocks.runFile.mockResolvedValue({ stdout: CATALOG_STDOUT.replace('"policy":"bounded-v1"', '"policy":"unbounded"'), stderr: '' })
    await expect(reviewChoice('pr_review')).rejects.toThrow('Update Caller')
    invalidateCatalog()
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ opus: 'opus-5-high', astra: 'gpt-6-astra-xhigh', policy: 'bounded-v1' }), stderr: '' })
    await expect(reviewChoice('pr_review')).rejects.toThrow('Update Caller')
  })
})

// An issue review has no pull-request head: its Poise rows carry none, finish
// as `commented`, and say which comments they posted. Before Poise knew the
// shape, one such row rejected the whole log — Swarm blank, reconciliation
// stalled for every behavior.
describe('issue review rows', () => {
  beforeEach(() => mocks.runFile.mockReset())

  function issueRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return logRow({
      behavior: 'issue_review',
      repo: 'Vaquum/Origo',
      pr_id: '452',
      source: 'poise:review-new-issues',
      correlation_id: 'claim-1',
      expected_head: null,
      head_sha: null,
      ...overrides,
    })
  }

  it('reads running, commented and failed issue reviews with their receipts', async () => {
    const receipt = { issue: 'Vaquum/Origo#452', comment_id: 9, url: 'https://github.com/Vaquum/Origo/issues/452#issuecomment-9', author: 'bit-mis' }
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([
        issueRow({ id: 'a'.repeat(32), status: 'running', completed_at: null }),
        issueRow({ id: 'b'.repeat(32), status: 'completed', action: 'commented', outcome: 'commented', receipts: [receipt] }),
        issueRow({ id: 'c'.repeat(32), status: 'failed', error: 'GitHub 502', error_code: 'posting_failed', receipts: [receipt, { broken: true }] }),
        issueRow({ id: 'd'.repeat(32), status: 'failed', error: 'provider failed' }),
        issueRow({ id: 'e'.repeat(32), status: 'failed', error: 'crashed while posting', receipts: 'garbled' }),
      ]),
      stderr: '',
    })
    const rows = await fetchAgentLogs()
    const byId = (letter: string) => rows.find((row) => row.id === letter.repeat(32))!
    expect(byId('a').status).toBe('running')
    expect(byId('b')).toMatchObject({ action: 'commented', outcome: 'commented', receipts: [receipt] })
    // A receipt it cannot read is dropped, but posting still counts as begun.
    expect(byId('c').receipts).toEqual([receipt])
    expect(byId('d').receipts).toBeNull()
    expect(byId('e').receipts).toEqual([])
  })

  it('keeps the commented outcome to issue reviews and requires a terminal outcome', async () => {
    mocks.runFile.mockResolvedValue({
      stdout: JSON.stringify([logRow({ action: 'commented', outcome: 'commented' })]),
      stderr: '',
    })
    await expect(fetchAgentLogs()).rejects.toThrow(/violates the schema/)
    resetAgentLogCache()
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([issueRow({ status: 'completed' })]), stderr: '' })
    await expect(fetchAgentLogs()).rejects.toThrow(/incomplete terminal outcome/)
  })

  it('replays an issue review with the Issue review default and no head or checkout', async () => {
    mocks.models = { issue_review: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' } }
    mocks.runFile.mockResolvedValue({ stdout: CATALOG_STDOUT, stderr: '' })
    const { invalidateCatalog } = await import('../server/models')
    invalidateCatalog()
    const gh = await import('../server/gh')
    mocks.agentAccount = 'bit-mis'
    const { spawnDetached } = await import('../server/process')
    vi.mocked(spawnDetached).mockReset().mockResolvedValue(undefined)
    const { replayAgentJob } = await import('../server/agent')
    const result = await replayAgentJob({ behavior: 'issue_review', repo: 'Vaquum/Origo', pr_id: '452' }, mocks.admit)
    expect(result.source).toBe('poise:replay')
    const [command, args] = vi.mocked(spawnDetached).mock.calls[0]
    expect(command).toBe('agent-interface')
    expect(args).toEqual(['--issue-review', 'Vaquum/Origo#452', '--model', 'gpt-6-astra-ultra', '--recovery-model', 'opus-5-xhigh',
      '--actor', 'bit-mis', '--source', 'poise:replay', '--correlation-id', result.correlationId])
    expect(gh.getHeadSha).not.toHaveBeenCalled()
    expect(gh.localCheckoutPath).not.toHaveBeenCalled()
  })
})

describe('running agent-log lane', () => {
  beforeEach(() => { mocks.runFile.mockReset() })

  it('reads the running set from its own indexed argv', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'a'.repeat(32), status: 'running', completed_at: null }),
      logRow({ id: 'b'.repeat(32), status: 'running', completed_at: null }),
    ]), stderr: '' })
    const snapshot = await fetchRunningAgentLogSnapshot()
    expect(mocks.runFile.mock.calls[0][1]).toEqual(['--logs', '--status', 'running'])
    expect(snapshot.entries.map((row) => row.id)).toEqual(['b'.repeat(32), 'a'.repeat(32)])
    expect(Object.isFrozen(snapshot)).toBe(true)
    // The ledger keeps its full-read cadence; the running lane only answers.
    expect(mocks.observeSnapshot).not.toHaveBeenCalled()
  })

  it('keeps the running filter when Caller cannot pre-filter', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([
      logRow({ id: 'a'.repeat(32), status: 'completed' }),
      logRow({ id: 'b'.repeat(32), status: 'running', completed_at: null }),
    ]), stderr: '' })
    const rows = await fetchRunningAgentLogs()
    expect(rows.map((row) => row.id)).toEqual(['b'.repeat(32)])
  })

  it('shares the running snapshot separately from the history snapshot', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: readonly string[]) => ({
      stdout: JSON.stringify([logRow({ status: args.includes('--status') ? 'running' : 'completed' })]),
      stderr: '',
    }))
    const history = await fetchAgentLogSnapshot()
    const running = await fetchRunningAgentLogSnapshot()
    await expect(fetchAgentLogSnapshot()).resolves.toBe(history)
    await expect(fetchRunningAgentLogSnapshot()).resolves.toBe(running)
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
    resetAgentLogCache()
    await fetchAgentLogSnapshot()
    await fetchRunningAgentLogSnapshot()
    expect(mocks.runFile).toHaveBeenCalledTimes(4)
  })

  it('answers a running read while a history read is still running', async () => {
    let releaseHistory!: (value: { stdout: string, stderr: string }) => void
    mocks.runFile.mockImplementation(async (_command: string, args: readonly string[]) => {
      if (args.includes('--status')) return { stdout: JSON.stringify([logRow({ status: 'running', completed_at: null })]), stderr: '' }
      return new Promise((resolve) => { releaseHistory = resolve })
    })
    const history = fetchAgentLogSnapshot()
    const running = await fetchRunningAgentLogs()
    expect(running.map((row) => row.status)).toEqual(['running'])
    releaseHistory({ stdout: JSON.stringify([logRow()]), stderr: '' })
    await expect(history).resolves.toBeDefined()
  })

  it('names an older Caller instead of its usage text', async () => {
    mocks.runFile.mockRejectedValue(Object.assign(new Error('Command failed (2): agent-interface'),
      { code: 2, stdout: '', stderr: 'error: first argument must be a behavior switch\n\nusage: agent-interface BEHAVIOR ...\n' }))
    await expect(fetchRunningAgentLogSnapshot()).rejects.toThrow('Update Caller: running-only log reads are unavailable')
    const locked = Object.assign(new Error('Command failed (1): agent-interface'),
      { code: 1, stdout: '', stderr: 'traceback: database is locked' })
    mocks.runFile.mockRejectedValue(locked)
    const failure = await fetchRunningAgentLogSnapshot().catch((error) => error)
    expect(failure.message).toBe('Command failed (1): agent-interface')
    expect(failure.message).not.toContain('Update Caller')
  })
})

describe('selected agent-log reads', () => {
  beforeEach(() => { mocks.runFile.mockReset() })
  const selection = { latest: [
    { behavior: 'pr_review', source: 'poise:review-new-prs', owner: 'owner' },
    { behavior: 'issue_review', source: 'poise:review-new-issues', owner: 'owner' },
  ], ids: ['a'.repeat(32)] }

  it('shares and caches one bounded selection with a missing kind and an old incident', async () => {
    let answer!: (value: { stdout: string, stderr: string }) => void
    mocks.runFile.mockImplementation(() => new Promise(resolve => { answer = resolve }))
    const first = fetchSelectedAgentLogSnapshot(selection)
    const concurrent = fetchSelectedAgentLogSnapshot(selection)
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    expect(mocks.runFile.mock.calls[0][1]).toEqual(['--logs', '--select', JSON.stringify(selection)])
    answer({ stdout: JSON.stringify([logRow()]), stderr: '' })
    const snapshot = await first
    expect(await concurrent).toBe(snapshot)
    expect(await fetchSelectedAgentLogSnapshot(selection)).toBe(snapshot)
    expect(snapshot.entries.map(row => row.id)).toEqual(['a'.repeat(32)])
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('keeps large selections on the same off-thread decoder as history', async () => {
    const rows = Array.from({ length: 1000 }, (_, index) => logRow({
      id: index.toString(16).padStart(32, '0'), prompt: 'x'.repeat(4000),
    }))
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify(rows), stderr: '' })
    const selected = await fetchSelectedAgentLogSnapshot({ latest: [], ids: rows.map(row => String(row.id)) })
    expect(selected.entries).toHaveLength(1000)
    expect(selected.entries[0]!.id).toBe((999).toString(16).padStart(32, '0'))
    expect(Object.isFrozen(selected.entries[0])).toBe(true)
  }, 30_000)

  it('includes terminal candidates after the exact pre-launch insertion boundary', async () => {
    mocks.runFile.mockResolvedValueOnce({ stdout: JSON.stringify({ cursor: '42' }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([logRow({ behavior: 'author_content', session_id: 'session', status: 'completed' })]), stderr: '' })
    const before = await fetchAgentLogWatermark()
    const snapshot = await fetchAgentLogsSince(before, { session: 'session', behavior: 'author_content', prompt: '--topic' }, { fresh: true })
    expect(snapshot.entries[0]!.status).toBe('completed')
    expect(mocks.runFile.mock.calls.map(([, args]) => args)).toEqual([
      ['--logs', '--watermark'],
      ['--logs', '--after', '42', '--session', 'session', '--behavior', 'author_content', '--prompt', '--topic'],
    ])
  })

  it.each(['[]', '{"cursor":-1}', '{"cursor":"bad"}'])('rejects a malformed insertion boundary %s', async stdout => {
    mocks.runFile.mockResolvedValue({ stdout, stderr: '' })
    await expect(fetchAgentLogWatermark()).rejects.toThrow('invalid insertion boundary')
  })

  it('names unsupported Caller selection instead of reporting absent history', async () => {
    mocks.runFile.mockRejectedValue(Object.assign(new Error('Command failed (2): agent-interface'),
      { code: 2, stdout: '', stderr: 'usage: agent-interface BEHAVIOR ...\n' }))
    await expect(fetchSelectedAgentLogSnapshot(selection)).rejects.toThrow('Update Caller: selected log reads are unavailable')
    await expect(fetchAgentLogWatermark()).rejects.toThrow('Update Caller: selected log reads are unavailable')
  })
})

describe('off-thread agent-log parse', () => {
  beforeEach(() => { mocks.runFile.mockReset() })

  it('decodes a small read inline without worker latency', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([logRow()]), stderr: '' })
    const started = performance.now()
    const snapshot = await fetchAgentLogSnapshot()
    expect(performance.now() - started).toBeLessThan(100)
    expect(snapshot.entries).toHaveLength(1)
  })

  it('shares one temporary build and removes it after concurrent parse workers finish', async () => {
    const stdout = JSON.stringify([logRow({ prompt: 'x'.repeat(2 * 1024 * 1024) })])
    mocks.runFile.mockResolvedValue({ stdout, stderr: '' })
    const [first, second] = await Promise.all([
      fetchSelectedAgentLogSnapshot({ latest: [], ids: ['a'.repeat(32)] }),
      fetchSelectedAgentLogSnapshot({ latest: [], ids: ['b'.repeat(32)] }),
    ])
    expect(first.entries).toEqual(second.entries)
    expect(mocks.workerBuild).toHaveBeenCalledTimes(1)
    const output = mocks.workerBuild.mock.calls[0]![0]
    expect(output).not.toContain('node_modules')
    await expect(access(dirname(output))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('removes its temporary asset after a worker reports invalid JSON', async () => {
    mocks.runFile.mockResolvedValue({ stdout: '[' + ' '.repeat(2 * 1024 * 1024), stderr: '' })
    await expect(fetchAgentLogSnapshot()).rejects.toThrow('returned invalid JSON')
    expect(mocks.workerBuild).toHaveBeenCalledTimes(1)
    const output = mocks.workerBuild.mock.calls[0]![0]
    await expect(access(dirname(output))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('parses the worker request and failure shapes', async () => {
    const { executeAgentLogParse } = await import('../server/agent-log-worker')
    const ok = executeAgentLogParse({ stdout: JSON.stringify([logRow({ id: 'a'.repeat(32) })]), source: 'agent-interface --logs' })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.snapshot.entries.map((row) => row.id)).toEqual(['a'.repeat(32)])
    const failed = executeAgentLogParse({ stdout: '[broken', source: 'agent-interface --logs' })
    expect(failed).toEqual({ ok: false, error: {
      name: 'Error', message: 'agent-interface --logs returned invalid JSON', causeMessage: expect.any(String),
    } })
  })

  // A 25 MB read decodes off the event loop: the loop keeps turning while
  // the worker parses, which an inline decode could never let happen.
  it('decodes a large read off the event loop with identical results', async () => {
    const rows = Array.from({ length: 6000 }, (_, index) => logRow({
      id: index.toString(16).padStart(32, '0'), prompt: 'x'.repeat(4000),
    }))
    const stdout = JSON.stringify(rows)
    expect(stdout.length).toBeGreaterThan(20 * 1024 * 1024)
    mocks.runFile.mockResolvedValue({ stdout, stderr: '' })
    let turns = 0
    const timer = setInterval(() => { turns += 1 }, 5)
    try {
      const snapshot = await fetchAgentLogSnapshot()
      expect(turns).toBeGreaterThanOrEqual(3)
      expect(snapshot.entries).toHaveLength(6000)
      expect(snapshot.entries[0]!.id).toBe((5999).toString(16).padStart(32, '0'))
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.entries[0])).toBe(true)
      expect(mocks.observeSnapshot).toHaveBeenCalledExactlyOnceWith(snapshot)
    } finally {
      clearInterval(timer)
    }
    const { parseAgentLogStdout } = await import('../server/agent-log-parse')
    expect(parseAgentLogStdout(stdout, 'agent-interface --logs')).toEqual({
      entries: (await fetchAgentLogSnapshot()).entries,
      quarantined: [],
    })
  }, 30_000)
})
