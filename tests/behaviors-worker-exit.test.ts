import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DetachedProcessExit, DetachedSpawnOptions } from '../server/process'
import checkoutSuperseded from './fixtures/review-checkout-superseded.json'
import { agentLog, fixture, HEAD_SHA, NEXT_HEAD_SHA, launchReviewBeforeCrash, mocks } from './behaviors-runtime-fixture'

async function reviewWorker() {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-11-10T16:54:00.000Z'))
  const launched = await launchReviewBeforeCrash()
  await launched.behaviors.stopBehaviorsRuntime()
  const claim = launched.database.listBehaviorLaunchClaims('review-new-prs')[0]
  const timeout = agentLog({
    status: 'failed', completed_at: new Date().toISOString(), error_code: 'review_budget_exhausted',
    error: 'Review reached its total time limit; needs attention', diagnostic: null,
    actor: claim.launchActor, source: claim.launchSource, correlation_id: claim.launchCorrelationId,
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
      expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1)
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
      expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1)
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
      expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1)
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
      expect(JSON.parse(readFileSync(worker.checkpoint, 'utf8')).cursor).toBe(1)
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
})
