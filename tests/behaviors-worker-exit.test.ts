import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { REVIEW_BUDGET_STOPPED } from '../server/behavior-diagnostics'
import type { DetachedProcessExit, DetachedSpawnOptions } from '../server/process'
import checkoutSuperseded from './fixtures/review-checkout-superseded.json'
import { agentLog, fixture, HEAD_SHA, NEXT_HEAD_SHA, launchApprovalBeforeCrash, launchReviewBeforeCrash, mocks } from './behaviors-runtime-fixture'

async function reviewWorker(behavior: 'review-new-prs' | 'approve-prs' = 'review-new-prs') {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-11-10T16:54:00.000Z'))
  const launched = await (behavior === 'review-new-prs' ? launchReviewBeforeCrash() : launchApprovalBeforeCrash())
  await launched.behaviors.stopBehaviorsRuntime()
  const claim = launched.database.listBehaviorLaunchClaims(behavior)[0]
  const timeout = agentLog({
    status: 'failed', completed_at: new Date().toISOString(), error_code: 'review_budget_exhausted',
    error: 'Review reached its total time limit; needs attention', diagnostic: null,
    behavior: claim.launchBehavior, actor: claim.launchActor, source: claim.launchSource, correlation_id: claim.launchCorrelationId,
    expected_head: claim.launchExpectedHead,
  })
  const exit = (mocks.spawnDetached.mock.calls[0][2] as DetachedSpawnOptions).onExit!
  const logging = await import('../server/logging')
  const collector = { events: [] as Record<string, unknown>[] }
  const cli = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command, args, ...rest) => {
    if (command === 'agent-interface' && args[0] === '--diagnostics') return {
      stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: collector.events,
        cursor: collector.events.length, hasMore: false, backfillPending: false }), stderr: '',
    }
    if (command === 'agent-interface' && args[0] === '--logs' && args[1] === '--select') {
      const selection = JSON.parse(args[2]) as { ids: string[], correlations: string[] }
      return { stdout: JSON.stringify(fixture.agentLogs.filter((row) => selection.ids.includes(String(row.id))
        || selection.correlations.includes(String(row.correlation_id)))), stderr: '' }
    }
    return cli(command, args, ...rest)
  })
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  logging.startLogging()
  const checkpoint = join(fixture.tempRoot, 'logging.db.caller')
  await vi.waitFor(() => expect(JSON.parse(readFileSync(checkpoint, 'utf8')).cursor).toBe(0))
  const events = () => {
    logging.loggingRuntime()!.flush()
    return logging.loggingRuntime()!.query((db) => db.query({ workspace: logging.loggingWorkspace(), operator: false })).events
  }
  return { ...launched, claim, timeout, exit, logging, collector, checkpoint, events }
}

describe('review worker exit diagnostics', () => {
  it.each([HEAD_SHA, NEXT_HEAD_SHA])('suppresses a generic worker error only for its durable supersession (%s)', async (head) => {
    const worker = await reviewWorker()
    try {
      const superseded = { ...worker.timeout, ...checkoutSuperseded, head_sha: head, response: 'retained supersession audit' }
      fixture.agentLogs = [superseded]
      await worker.exit({ code: 1, signal: null })

      expect(worker.events().filter((event) => event.severity === 'error')).toEqual([])
      expect(fixture.agentLogs).toEqual([superseded])
      expect(worker.database.listBehaviorLaunchClaims('review-new-prs')[0]).toMatchObject({
        claimId: worker.claim.claimId, launchError: 'worker exited exit 1; awaiting durable agent result',
      })
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    } finally { await worker.logging.stopLogging() }
  })

  it.each([null, {
    version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase: 'reviewing',
    outcome: 'timeout', timeout_seconds: 1413, provider_started: true,
  }])('keeps one Caller timeout through delayed collection and replay (diagnostic %j)', async (diagnostic) => {
    const worker = await reviewWorker()
    try {
      worker.timeout.diagnostic = diagnostic
      fixture.agentLogs = [worker.timeout]
      await worker.exit({ code: 1, signal: null })

      expect(worker.events().filter((event) => event.severity === 'error')).toEqual([
        expect.objectContaining({ source: 'caller', callId: worker.timeout.id,
          correlationId: worker.claim.launchCorrelationId, message: worker.timeout.error }),
      ])
      expect(worker.database.listBehaviorLaunchClaims('review-new-prs')).toEqual([
        expect.objectContaining({ claimId: worker.claim.claimId,
          launchError: 'worker exited exit 1; awaiting durable agent result',
          leaseUntil: expect.any(Number) }),
      ])
      expect(worker.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()

      worker.collector.events = [worker.timeout]
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      await worker.logging.stopLogging()
      // A lost checkpoint replays the same retained completion after restart.
      writeFileSync(worker.checkpoint, JSON.stringify({ version: 1, streamId: 'a'.repeat(32), cursor: 0 }))
      worker.logging.startLogging()
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      expect(worker.events().filter((event) => event.severity === 'error')).toHaveLength(1)
      expect(worker.logging.loggingRuntime()!.health().rejected).toBe(0)
    } finally { await worker.logging.stopLogging() }
  })

  it('keeps one Caller timeout when its error exceeds periodic truncation', async () => {
    const worker = await reviewWorker()
    try {
      const fullError = `Review reached its total time limit; needs attention ${'x'.repeat(9000)}`
      worker.timeout.error = fullError
      fixture.agentLogs = [worker.timeout]
      await worker.exit({ code: 1, signal: null })

      const errors = worker.events().filter((event) => event.severity === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ source: 'caller', callId: worker.timeout.id,
        correlationId: worker.claim.launchCorrelationId })
      expect(errors[0].message).toBe(fullError.slice(0, 2048))
      const incidentId = (errors[0] as { incidentId: string }).incidentId
      expect(worker.database.listBehaviorLaunchClaims('review-new-prs')).toEqual([
        expect.objectContaining({ claimId: worker.claim.claimId,
          launchError: 'worker exited exit 1; awaiting durable agent result',
          leaseUntil: expect.any(Number) }),
      ])

      // Periodic --diagnostics truncates the same error to 8,192 characters.
      worker.collector.events = [{ ...worker.timeout, error: fullError.slice(0, 8192) }]
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      await worker.logging.stopLogging()
      writeFileSync(worker.checkpoint, JSON.stringify({ version: 1, streamId: 'a'.repeat(32), cursor: 0 }))
      worker.logging.startLogging()
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      const replayed = worker.events().filter((event) => event.severity === 'error')
      expect(replayed).toHaveLength(1)
      expect((replayed[0] as { incidentId: string }).incidentId).toBe(incidentId)
      expect(worker.logging.loggingRuntime()!.health().rejected).toBe(0)
    } finally { await worker.logging.stopLogging() }
  })

  it('keeps one Caller timeout when truncation meets supplementary characters', async () => {
    const worker = await reviewWorker()
    try {
      const prefix = 'Review reached its total time limit; needs attention '
      const fullError = `${prefix}${'😀'.repeat(100)}${'x'.repeat(9000)}`
      const truncated = Array.from(fullError).slice(0, 8192).join('')
      worker.timeout.error = fullError
      fixture.agentLogs = [worker.timeout]
      await worker.exit({ code: 1, signal: null })

      const errors = worker.events().filter((event) => event.severity === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ source: 'caller', callId: worker.timeout.id,
        correlationId: worker.claim.launchCorrelationId })
      const incidentId = (errors[0] as { incidentId: string }).incidentId

      // Periodic SQL substr counts Unicode characters while JS slice counts
      // UTF-16 units; only the code-point truncation replays exactly.
      worker.collector.events = [{ ...worker.timeout, error: truncated }]
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      await worker.logging.stopLogging()
      writeFileSync(worker.checkpoint, JSON.stringify({ version: 1, streamId: 'a'.repeat(32), cursor: 0 }))
      worker.logging.startLogging()
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      const replayed = worker.events().filter((event) => event.severity === 'error')
      expect(replayed).toHaveLength(1)
      expect((replayed[0] as { incidentId: string }).incidentId).toBe(incidentId)
      expect(worker.logging.loggingRuntime()!.health().rejected).toBe(0)
    } finally { await worker.logging.stopLogging() }
  })

  it('keeps one Caller timeout when its diagnostic exceeds the envelope', async () => {
    const worker = await reviewWorker()
    try {
      const fullError = `Review reached its total time limit; needs attention ${'x'.repeat(8000)}`
      worker.timeout.error = fullError
      worker.timeout.diagnostic = {
        version: 1, source: 'caller', severity: 'error', operation: 'o'.repeat(30000),
        phase: 'reviewing', outcome: 'timeout', stderr: 's'.repeat(30000), stderr_truncated: false,
        timeout_seconds: 1413, provider_started: true,
      }
      fixture.agentLogs = [worker.timeout]
      await worker.exit({ code: 1, signal: null })

      const errors = worker.events().filter((event) => event.severity === 'error')
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({ source: 'caller', callId: worker.timeout.id,
        correlationId: worker.claim.launchCorrelationId })
      const incidentId = (errors[0] as { incidentId: string }).incidentId

      // Periodic --diagnostics drops the diagnostic and shortens the error to
      // 2,048 characters once the entry exceeds 64 KiB.
      const envelopeError = Array.from(Array.from(fullError).slice(0, 8192).join('')).slice(0, 2048).join('')
      worker.collector.events = [{ ...worker.timeout, error: envelopeError, diagnostic: null,
        evidence_unavailable: 'Stored process diagnostic exceeds the bounded metadata envelope' }]
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      await worker.logging.stopLogging()
      writeFileSync(worker.checkpoint, JSON.stringify({ version: 1, streamId: 'a'.repeat(32), cursor: 0 }))
      worker.logging.startLogging()
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      const replayed = worker.events().filter((event) => event.severity === 'error')
      expect(replayed).toHaveLength(1)
      expect((replayed[0] as { incidentId: string }).incidentId).toBe(incidentId)
      expect(worker.logging.loggingRuntime()!.health().rejected).toBe(0)
    } finally { await worker.logging.stopLogging() }
  })

  it('keeps one Caller timeout when the envelope turns on the new resource fields', async () => {
    const worker = await reviewWorker()
    try {
      const truncate = (value: string, limit: number): string => {
        if (value.length <= limit) return value
        const chars = Array.from(value)
        return chars.length > limit ? chars.slice(0, limit).join('') : value
      }
      const jsonLength = (value: unknown): number => {
        const js = JSON.stringify(value) ?? 'null'
        let separators = 0, extra = 0, inString = false, escaped = false
        for (const char of js) {
          if (inString) {
            if (escaped) { escaped = false; continue }
            if (char === '\\') { escaped = true; continue }
            if (char === '"') { inString = false; continue }
            const code = char.codePointAt(0)!
            if (code > 127) extra += (code > 0xffff ? 12 : 6) - Buffer.byteLength(char)
            continue
          }
          if (char === '"') { inString = true; continue }
          if (char === ':' || char === ',') separators += 1
        }
        return Buffer.byteLength(js) + separators + extra
      }
      const fullError = `Review reached its total time limit; needs attention ${'x'.repeat(9000)}`
      const truncatedError = truncate(fullError, 8192)
      const fields = ['id', 'model', 'status', 'pr_id', 'repo', 'actor', 'behavior', 'outcome',
        'head_sha', 'expected_head', 'source', 'correlation_id', 'action', 'error_code'] as const
      const candidateSize = (operationLength: number, withNew: boolean): number => {
        const diagnostic = { version: 1, source: 'caller', severity: 'error', operation: 'o'.repeat(operationLength),
          phase: 'reviewing', outcome: 'timeout', timeout_seconds: 1413, provider_started: true }
        const candidate: Record<string, unknown> = { seq: 0 }
        for (const field of fields) {
          const value = (worker.timeout as Record<string, unknown>)[field]
          candidate[field] = typeof value === 'string' ? truncate(value, 512) : value
        }
        candidate.error = truncatedError
        if (withNew) candidate.resource_error = null
        if (withNew) candidate.ownership_error = null
        candidate.started_at_precise = worker.timeout.started_at_precise
        candidate.completed_at = worker.timeout.completed_at
        candidate.diagnostic = diagnostic
        return jsonLength(candidate)
      }
      const baseOld = candidateSize(0, false)
      const padding = 64 * 1024 - baseOld - 10
      expect(padding).toBeGreaterThan(0)
      const diagnostic = { version: 1, source: 'caller', severity: 'error', operation: 'o'.repeat(padding),
        phase: 'reviewing', outcome: 'timeout', timeout_seconds: 1413, provider_started: true }
      expect(jsonLength(diagnostic)).toBeLessThanOrEqual(65536)
      expect(candidateSize(padding, false)).toBeLessThanOrEqual(64 * 1024)
      expect(candidateSize(padding, true)).toBeGreaterThan(64 * 1024)
      worker.timeout.error = fullError
      worker.timeout.diagnostic = diagnostic
      fixture.agentLogs = [worker.timeout]
      await worker.exit({ code: 1, signal: null })

      const errors = worker.events().filter((event) => event.severity === 'error')
      expect(errors).toHaveLength(1)
      const envelopeError = truncate(truncatedError, 2048)
      expect(errors[0]).toMatchObject({ source: 'caller', callId: worker.timeout.id,
        correlationId: worker.claim.launchCorrelationId, message: envelopeError })
      const incidentId = (errors[0] as { incidentId: string }).incidentId

      worker.collector.events = [{ ...worker.timeout, error: envelopeError, diagnostic: null,
        evidence_unavailable: 'Stored process diagnostic exceeds the bounded metadata envelope' }]
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      await worker.logging.stopLogging()
      writeFileSync(worker.checkpoint, JSON.stringify({ version: 1, streamId: 'a'.repeat(32), cursor: 0 }))
      worker.logging.startLogging()
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      const replayed = worker.events().filter((event) => event.severity === 'error')
      expect(replayed).toHaveLength(1)
      expect((replayed[0] as { incidentId: string }).incidentId).toBe(incidentId)
      expect(worker.logging.loggingRuntime()!.health().rejected).toBe(0)
    } finally { await worker.logging.stopLogging() }
  })

  it.each([
    'missing result', 'unreadable logs', 'malformed diagnostic', 'unavailable evidence', 'foreign invocation',
    'different head', 'different reviewer', 'different source', 'older result', 'unfinished result',
    'different failure', 'signal', 'process error', 'different exit', 'rejected capture',
  ].flatMap((scenario) => (scenario === 'rejected capture' ? [false] : [false, true])
    .map((superseded) => ({ scenario, superseded }))))('keeps a visible worker failure for $scenario (superseded=$superseded)', async ({ scenario, superseded }) => {
    const worker = await reviewWorker()
    try {
      if (superseded) Object.assign(worker.timeout, checkoutSuperseded)
      fixture.agentLogs = [worker.timeout]
      const result: DetachedProcessExit = { code: 1, signal: null }
      if (scenario === 'missing result') fixture.agentLogs = []
      if (scenario === 'unreadable logs') {
        const cli = mocks.runFile.getMockImplementation()!
        mocks.runFile.mockImplementation(async (command, args, ...rest) => {
          if (command === 'agent-interface' && args[0] === '--logs') throw new Error('Caller evidence read failed')
          return cli(command, args, ...rest)
        })
      }
      if (scenario === 'malformed diagnostic') worker.timeout.diagnostic = { version: 99 }
      if (scenario === 'unavailable evidence') worker.timeout.evidence_unavailable = 'Stored diagnostic is unreadable'
      if (scenario === 'foreign invocation') worker.timeout.correlation_id = 'another-invocation'
      if (scenario === 'different head') worker.timeout.expected_head = 'b'.repeat(40)
      if (scenario === 'different reviewer') worker.timeout.actor = 'other-reviewer'
      if (scenario === 'different source') worker.timeout.source = 'poise:manual-review'
      if (scenario === 'older result') worker.timeout.started_at_precise = '2026-11-09T16:54:00.000Z'
      if (scenario === 'unfinished result') worker.timeout.completed_at = null
      if (scenario === 'different failure') worker.timeout.error_code = 'review_submission_failed'
      if (scenario === 'signal') { result.code = null; result.signal = 'SIGTERM' }
      if (scenario === 'process error') result.error = new Error('independent process failure')
      if (scenario === 'different exit') result.code = 7
      if (scenario === 'rejected capture') vi.spyOn(worker.logging, 'diagnostic').mockReturnValue(null)

      await worker.exit(result)

      expect(worker.events()).toContainEqual(expect.objectContaining({ severity: 'error', source: 'poise',
        ...(scenario === 'unreadable logs'
          ? { message: 'Caller evidence read failed', context: expect.objectContaining({ componentMessage: expect.stringContaining('worker exited for ' + worker.target) }) }
          : { message: expect.stringContaining('worker exited for ' + worker.target) }) }))
      expect(worker.database.listBehaviorLaunchClaims('review-new-prs')[0].launchError).toContain('awaiting durable agent result')
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    } finally { await worker.logging.stopLogging() }
  })

  it.each([
    ['review-new-prs', null], ['approve-prs', null],
    ['review-new-prs', 'warning'], ['approve-prs', 'warning'],
    ['review-new-prs', 'error'], ['approve-prs', 'error'],
  ] as const)('correlates a retryable preflight GitHub 503 for %s through collection and replay (diagnostic %s)', async (behavior, severity) => {
    const worker = await reviewWorker(behavior)
    try {
      const call = worker.timeout
      Object.assign(call, { error_code: null, error: 'error: GitHub 503: Service Unavailable',
        action: 'not_started', outcome: 'preflight_failed', review_policy: 'bounded-v1',
        diagnostic: severity ? { version: 1, source: 'caller', severity, operation: 'github-interface', phase: 'preflight' } : null,
        // The call's own read carries its progress; the whole history does not.
        progress: { version: 1, phase: 'preflight', phase_started_at: '2026-11-10T17:00:00.000Z', heartbeat_at: '2026-11-10T17:00:01.000Z',
          last_provider_event_at: null, deadline_at: null, warning: null, events: [] } })
      // The launch cached empty history. One earlier timeout leaves retry
      // budget, but is outside the selected invocation's completion read.
      fixture.agentLogs = [agentLog({ ...call, id: 'e'.repeat(32), correlation_id: 'prior-timeout', diagnostic: null,
        error_code: 'review_budget_exhausted', error: 'Review reached its total time limit; needs attention',
        started_at: '2026-11-10T16:50:00.000Z', started_at_precise: '2026-11-10T16:50:00.000Z',
        completed_at: '2026-11-10T16:51:00.000Z' }), call]
      const originalCalls = structuredClone(fixture.agentLogs)
      const meta = () => worker.database.db.prepare('SELECT * FROM meta ORDER BY key').all()
      const originalMeta = meta()
      const claims = () => worker.database.db.prepare('SELECT * FROM behavior_seen ORDER BY key, target').all() as Record<string, unknown>[]
      const originalClaims = claims()
      await worker.exit({ code: 1, signal: null })

      const retained = worker.events()
      expect(retained).toEqual([expect.objectContaining({ severity: severity ?? 'warning', source: 'caller', callId: call.id,
        correlationId: worker.claim.launchCorrelationId, message: call.error, component: worker.claim.launchBehavior,
        context: expect.objectContaining({ action: 'not_started', outcome: 'preflight_failed', errorCode: null }) })])
      expect(fixture.agentLogs).toEqual(originalCalls)
      expect(meta()).toEqual(originalMeta)
      expect(claims()).toEqual(originalClaims.map((row) => row.claim_id === worker.claim.claimId
        ? { ...row, lease_until: Date.now() + 2 * 60 * 60_000,
          ...(row.key === behavior ? { launch_error: 'worker exited exit 1; awaiting durable agent result' } : {}) }
        : row))
      expect(worker.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()

      worker.collector.events = [call]
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      await worker.logging.stopLogging()
      writeFileSync(worker.checkpoint, JSON.stringify({ version: 1, streamId: 'a'.repeat(32), cursor: 0 }))
      worker.logging.startLogging()
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      expect(worker.events()).toEqual(retained)
      expect(worker.logging.loggingRuntime()!.health().rejected).toBe(0)
    } finally { await worker.logging.stopLogging() }
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('correlates a settled Codex credential rejection for %s through collection and replay', async (behavior) => {
    const worker = await reviewWorker(behavior)
    try {
      const call = worker.timeout
      Object.assign(call, { error_code: 'authentication_failed',
        error: 'codex review failed: Your refresh [redacted credential] was already used',
        action: 'not_started', outcome: 'preflight_failed',
        diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review',
          phase: 'provider_execution', outcome: 'exit', submission: 'none' } })
      fixture.agentLogs = [call]
      const originalCalls = structuredClone(fixture.agentLogs)
      const meta = () => worker.database.db.prepare('SELECT * FROM meta ORDER BY key').all()
      const originalMeta = meta()
      const claims = () => worker.database.db.prepare('SELECT * FROM behavior_seen ORDER BY key, target').all() as Record<string, unknown>[]
      const originalClaims = claims()
      await worker.exit({ code: 1, signal: null })

      const retained = worker.events()
      expect(retained).toEqual([expect.objectContaining({ severity: 'error', source: 'caller', callId: call.id,
        correlationId: worker.claim.launchCorrelationId, message: call.error, component: worker.claim.launchBehavior,
        context: expect.objectContaining({ action: 'not_started', outcome: 'preflight_failed', errorCode: 'authentication_failed' }) })])
      expect(fixture.agentLogs).toEqual(originalCalls)
      expect(meta()).toEqual(originalMeta)
      expect(claims()).toEqual(originalClaims.map((row) => row.claim_id === worker.claim.claimId
        ? { ...row, lease_until: Date.now() + 2 * 60 * 60_000,
          ...(row.key === behavior ? { launch_error: 'worker exited exit 1; awaiting durable agent result' } : {}) }
        : row))
      expect(worker.behaviors.getBehaviorsRuntimeHealth().failures).toEqual([])
      expect(mocks.spawnDetached).toHaveBeenCalledOnce()

      const incidentId = (retained[0] as { incidentId: string }).incidentId
      worker.collector.events = [call]
      await vi.advanceTimersByTimeAsync(15_000)
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      await worker.logging.stopLogging()
      writeFileSync(worker.checkpoint, JSON.stringify({ version: 1, streamId: 'a'.repeat(32), cursor: 0 }))
      worker.logging.startLogging()
      await vi.waitFor(() => expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1))
      const replayed = worker.events()
      expect(replayed).toEqual(retained)
      expect((replayed[0] as { incidentId: string }).incidentId).toBe(incidentId)
      expect(worker.logging.loggingRuntime()!.health().rejected).toBe(0)
    } finally { await worker.logging.stopLogging() }
  })

  describe.each(['review-new-prs', 'approve-prs'] as const)('%s authentication_failed', (behavior) => {
    it.each([
      'missing result', 'unreadable logs', 'malformed diagnostic', 'unavailable evidence', 'foreign invocation',
      'different head', 'different reviewer', 'different source', 'older result', 'unfinished result',
      'different behavior', 'different repository', 'different PR', 'ambiguous result',
      'signal', 'process error', 'different exit', 'rejected capture',
      'historical provider exit', 'historical provider error', 'missing action', 'missing outcome',
      'executed head', 'review ID', 'review comments', 'receipts', 'malformed receipt',
      'submission mismatch', 'null diagnostic', 'wrong operation',
    ])('keeps a visible worker failure for %s', async (scenario) => {
      const worker = await reviewWorker(behavior)
      try {
        Object.assign(worker.timeout, { error_code: 'authentication_failed',
          error: 'codex review failed: Your refresh [redacted credential] was already used',
          action: 'not_started', outcome: 'preflight_failed',
          diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review',
            phase: 'provider_execution', outcome: 'exit', submission: 'none' } })
        fixture.agentLogs = [worker.timeout]
        const result: DetachedProcessExit = { code: 1, signal: null }
        if (scenario === 'missing result') fixture.agentLogs = []
        if (scenario === 'unreadable logs') {
          const cli = mocks.runFile.getMockImplementation()!
          mocks.runFile.mockImplementation(async (command, args, ...rest) => {
            if (command === 'agent-interface' && args[0] === '--logs') throw new Error('Caller evidence read failed')
            return cli(command, args, ...rest)
          })
        }
        if (scenario === 'malformed diagnostic') worker.timeout.diagnostic = { version: 99 }
        if (scenario === 'unavailable evidence') worker.timeout.evidence_unavailable = 'Stored diagnostic is unreadable'
        if (scenario === 'foreign invocation') worker.timeout.correlation_id = 'another-invocation'
        if (scenario === 'different head') worker.timeout.expected_head = 'b'.repeat(40)
        if (scenario === 'different reviewer') worker.timeout.actor = 'other-reviewer'
        if (scenario === 'different source') worker.timeout.source = 'poise:manual-review'
        if (scenario === 'older result') worker.timeout.started_at_precise = '2026-11-09T16:54:00.000Z'
        if (scenario === 'unfinished result') worker.timeout.completed_at = null
        if (scenario === 'different behavior') worker.timeout.behavior = behavior === 'review-new-prs' ? 'pr_approve' : 'pr_review'
        if (scenario === 'different repository') worker.timeout.repo = 'Vaquum/other'
        if (scenario === 'different PR') worker.timeout.pr_id = '18'
        if (scenario === 'ambiguous result') fixture.agentLogs.push({ ...worker.timeout, id: 'd'.repeat(32) })
        if (scenario === 'signal') { result.code = null; result.signal = 'SIGTERM' }
        if (scenario === 'process error') result.error = new Error('independent process failure')
        if (scenario === 'different exit') result.code = 7
        if (scenario === 'rejected capture') vi.spyOn(worker.logging, 'diagnostic').mockReturnValue(null)
        if (scenario === 'historical provider exit') worker.timeout.error_code = 'review_provider_exit'
        if (scenario === 'historical provider error') worker.timeout.error_code = 'review_provider_error'
        if (scenario === 'missing action') worker.timeout.action = null
        if (scenario === 'missing outcome') worker.timeout.outcome = null
        if (scenario === 'executed head') worker.timeout.head_sha = worker.claim.launchExpectedHead
        if (scenario === 'review ID') worker.timeout.review_id = 91
        if (scenario === 'review comments') worker.timeout.review_comments = 0
        if (scenario === 'receipts') worker.timeout.receipts = []
        if (scenario === 'malformed receipt') worker.timeout.review_id = 'unreadable'
        if (scenario === 'submission mismatch') worker.timeout.diagnostic = { ...(worker.timeout.diagnostic as Record<string, unknown>), submission: 'partial' }
        if (scenario === 'null diagnostic') worker.timeout.diagnostic = null
        if (scenario === 'wrong operation') worker.timeout.diagnostic = { ...(worker.timeout.diagnostic as Record<string, unknown>), operation: 'github-interface' }
        const originalCalls = structuredClone(fixture.agentLogs)
        const originalMeta = worker.database.db.prepare('SELECT * FROM meta ORDER BY key').all()

        await worker.exit(result)

        expect(worker.events()).toContainEqual(expect.objectContaining({ severity: 'error', source: 'poise',
          ...(scenario === 'unreadable logs'
            ? { message: 'Caller evidence read failed',
              context: expect.objectContaining({ componentMessage: expect.stringContaining('worker exited for ' + worker.target) }) }
            : { message: expect.stringContaining('worker exited for ' + worker.target) }) }))
        expect(worker.database.listBehaviorLaunchClaims(behavior)[0].launchError).toContain('awaiting durable agent result')
        expect(fixture.agentLogs).toEqual(originalCalls)
        expect(worker.database.db.prepare('SELECT * FROM meta ORDER BY key').all()).toEqual(originalMeta)
        expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      } finally { await worker.logging.stopLogging() }
    })
  })

  describe.each([
    ['review-new-prs', 'timeout'], ['review-new-prs', '503'], ['approve-prs', '503'],
  ] as const)('%s %s', (behavior, failure) => {
    it.each([
      'missing result', 'unreadable logs', 'malformed diagnostic', 'unavailable evidence', 'foreign invocation',
      'different head', 'different reviewer', 'different source', 'older result', 'unfinished result',
      'different failure', 'different behavior', 'different repository', 'different PR', 'ambiguous result',
      'signal', 'process error', 'different exit', 'rejected capture',
      ...(failure === '503' ? ['publication 503', 'missing action', 'missing outcome', 'executed head', 'review ID',
        'review comments', 'receipts', 'malformed receipt', 'other 5xx', 'network failure', 'HTTP 503', 'nested 503',
        'paused retry', 'disabled retry', 'quarantined claim', 'exhausted retry', 'retained retry stop', 'packet hold', 'access hold',
        'unreadable retry history', 'missing retry history', 'changed retry evidence', 'ambiguous retry history', 'quarantined retry history'] : []),
    ])('keeps a visible worker failure for %s', async (scenario) => {
      const worker = await reviewWorker(behavior)
      try {
        if (failure === '503') Object.assign(worker.timeout, { error_code: null,
          error: 'error: GitHub 503: Service Unavailable', action: 'not_started', outcome: 'preflight_failed', review_policy: 'bounded-v1' })
        fixture.agentLogs = [worker.timeout]
        const result: DetachedProcessExit = { code: 1, signal: null }
        if (scenario === 'missing result') fixture.agentLogs = []
        if (scenario === 'unreadable logs') {
          const cli = mocks.runFile.getMockImplementation()!
          mocks.runFile.mockImplementation(async (command, args, ...rest) => {
            if (command === 'agent-interface' && args[0] === '--logs') throw new Error('Caller evidence read failed')
            return cli(command, args, ...rest)
          })
        }
        if (scenario === 'malformed diagnostic') worker.timeout.diagnostic = { version: 99 }
        if (scenario === 'unavailable evidence') worker.timeout.evidence_unavailable = 'Stored diagnostic is unreadable'
        if (scenario === 'foreign invocation') worker.timeout.correlation_id = 'another-invocation'
        if (scenario === 'different head') worker.timeout.expected_head = 'b'.repeat(40)
        if (scenario === 'different reviewer') worker.timeout.actor = 'other-reviewer'
        if (scenario === 'different source') worker.timeout.source = 'poise:manual-review'
        if (scenario === 'older result') worker.timeout.started_at_precise = '2026-11-09T16:54:00.000Z'
        if (scenario === 'unfinished result') worker.timeout.completed_at = null
        if (scenario === 'different failure') worker.timeout.error_code = 'review_submission_failed'
        if (scenario === 'different behavior') worker.timeout.behavior = behavior === 'review-new-prs' ? 'pr_approve' : 'pr_review'
        if (scenario === 'different repository') worker.timeout.repo = 'Vaquum/other'
        if (scenario === 'different PR') worker.timeout.pr_id = '18'
        if (scenario === 'ambiguous result') fixture.agentLogs.push({ ...worker.timeout, id: 'd'.repeat(32) })
        if (scenario === 'signal') { result.code = null; result.signal = 'SIGTERM' }
        if (scenario === 'process error') result.error = new Error('independent process failure')
        if (scenario === 'different exit') result.code = 7
        if (scenario === 'rejected capture') vi.spyOn(worker.logging, 'diagnostic').mockReturnValue(null)
        if (scenario === 'publication 503') Object.assign(worker.timeout, { error_code: 'review_submission_failed', action: null, outcome: null })
        if (scenario === 'missing action') worker.timeout.action = null
        if (scenario === 'missing outcome') worker.timeout.outcome = null
        if (scenario === 'executed head') worker.timeout.head_sha = worker.claim.launchExpectedHead
        if (scenario === 'review ID') worker.timeout.review_id = 91
        if (scenario === 'review comments') worker.timeout.review_comments = 0
        if (scenario === 'receipts') worker.timeout.receipts = []
        if (scenario === 'malformed receipt') worker.timeout.review_id = 'unreadable'
        if (scenario === 'other 5xx') worker.timeout.error = 'error: GitHub 502: Bad Gateway'
        if (scenario === 'network failure') worker.timeout.error = 'httpx.ReadTimeout'
        if (scenario === 'HTTP 503') worker.timeout.error = 'HTTP 503: Service Unavailable'
        if (scenario === 'nested 503') worker.timeout.error = 'error: GitHub 403: denied\nGitHub 503: nested body text'
        if (scenario === 'paused retry') worker.database.setMeta(`behavior_${behavior.replace(/-/g, '_')}_paused_until`, '2026-11-11T00:00:00Z')
        if (scenario === 'disabled retry') worker.database.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '0')
        if (scenario === 'quarantined claim') worker.database.quarantineBehaviorLaunchOwned(behavior, worker.target, worker.claim.claimId,
          'invalid_result', 'retained hold', false)
        if (scenario === 'packet hold') worker.database.setMeta(`packet_block:${behavior}:${worker.claim.launchRepo}#${worker.claim.launchPr}`, worker.claim.launchExpectedHead)
        if (scenario === 'access hold') worker.database.setMeta(`behavior_repo_hold:${worker.claim.launchActor}:${worker.claim.launchRepo.toLowerCase()}`,
          JSON.stringify({ repo: worker.claim.launchRepo, actor: worker.claim.launchActor, error: 'GitHub 404',
            heldAtMs: Date.now(), nextRecheckAtMs: Date.now() + 60_000 }))
        if (['exhausted retry', 'retained retry stop', 'ambiguous retry history', 'quarantined retry history'].includes(scenario)) {
          const prior = agentLog({ ...worker.timeout, id: 'e'.repeat(32), correlation_id: 'prior-timeout',
            error_code: 'review_budget_exhausted', error: 'Review reached its total time limit; needs attention' })
          fixture.agentLogs.push(prior, { ...prior, id: 'd'.repeat(32), correlation_id: scenario === 'ambiguous retry history' ? 'prior-timeout' : 'second-timeout' })
          if (scenario === 'quarantined retry history') prior.diagnostic = { version: 99 }
          if (scenario === 'retained retry stop') {
            fixture.agentLogs = [worker.timeout]
            worker.database.db.prepare(`INSERT INTO behavior_seen(key, target, seen_at, claim_id, launch_behavior, launch_repo, launch_pr,
              launch_requested_at, launch_call_id, launch_error, launch_expected_head, launch_actor, launch_source, launch_correlation_id)
              VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(behavior, worker.target + ':prior', new Date().toISOString(),
              worker.claim.launchBehavior, worker.claim.launchRepo, worker.claim.launchPr, worker.claim.launchRequestedAt,
              prior.id, REVIEW_BUDGET_STOPPED, worker.claim.launchExpectedHead,
              worker.claim.launchActor, worker.claim.launchSource, prior.correlation_id)
          }
        }
        if (['unreadable retry history', 'missing retry history', 'changed retry evidence'].includes(scenario)) {
          const cli = mocks.runFile.getMockImplementation()!
          mocks.runFile.mockImplementation(async (command, args, ...rest) => {
            if (command === 'agent-interface' && (args[0] === '--logs' && args[1] === '--without-progress')) {
              if (scenario === 'unreadable retry history') throw new Error('Caller retry history read failed')
              return { stdout: JSON.stringify(scenario === 'missing retry history' ? [] : [{ ...worker.timeout, review_id: 91 }]), stderr: '' }
            }
            return cli(command, args, ...rest)
          })
        }
        const originalCalls = structuredClone(fixture.agentLogs)
        const originalMeta = worker.database.db.prepare('SELECT * FROM meta ORDER BY key').all()

        await worker.exit(result)

        expect(worker.events()).toContainEqual(expect.objectContaining({ severity: 'error', source: 'poise',
          ...(['unreadable logs', 'unreadable retry history'].includes(scenario)
            ? { message: scenario === 'unreadable logs' ? 'Caller evidence read failed' : 'Caller retry history read failed',
              context: expect.objectContaining({ componentMessage: expect.stringContaining('worker exited for ' + worker.target) }) }
            : { message: expect.stringContaining('worker exited for ' + worker.target) }) }))
        expect(worker.database.listBehaviorLaunchClaims(behavior)[0].launchError).toContain(scenario === 'quarantined claim' ? 'retained hold' : 'awaiting durable agent result')
        expect(fixture.agentLogs).toEqual(originalCalls)
        expect(worker.database.db.prepare('SELECT * FROM meta ORDER BY key').all()).toEqual(originalMeta)
        expect(mocks.spawnDetached).toHaveBeenCalledOnce()
      } finally { await worker.logging.stopLogging() }
    })
  })
})
