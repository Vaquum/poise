import { describe, expect, it } from 'vitest'
import { classifyBehaviorDiagnostic, failureCause } from '../src/behavior-failure-cause'

// What Behaviors' diagnostics show for a failure (src/behavior-failure-cause.ts).

const GROK = 'Internal error: {\n  "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted",\n  "http_status": 402\n}'

describe('the cause a behavior failure shows', () => {
  it('reads a provider\'s JSON error by its message, not by the line with its brace', () => {
    expect(failureCause(`Error: ${GROK}`)).toBe('Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted')
    expect(failureCause(GROK)).toBe('Internal error: API error (status 402 Payment Required): Grok Build usage balance exhausted')
  })

  it('keeps what GitHub\'s error says before its JSON', () => {
    const error = 'error: GitHub 500: {"message":"Server Error: Sorry, this diff is temporarily unavailable due to heavy server load.","errors":[{"resource":"Comparison","field":"diff","code":"not_available"}],"status":"500"}'
    expect(failureCause(error)).toBe('GitHub 500: Server Error: Sorry, this diff is temporarily unavailable due to heavy server load.')
  })

  it('keeps the last line naming an error otherwise, bounded', () => {
    expect(failureCause('Traceback (most recent call last):\n  File "x.py"\nValueError: bad verdict\n')).toBe('ValueError: bad verdict')
    expect(failureCause('just this')).toBe('just this')
    expect(failureCause(`Error: ${'x'.repeat(400)}`)).toHaveLength(300)
  })
})

const CAPACITY_STREAM = 'codex review produced no submitted verdict: {"type":"thread.started","thread_id":"id"}\n'
  + '{"type":"item.completed","item":{"type":"error","message":"Code Mode is unavailable because code-mode host is disabled."}}\n'
  + '{"type":"error","message":"Reconnecting... unexpected status 503 Service Unavailable"}\n'
  + '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}'

describe('deterministic behavior severity', () => {
  it('uses the terminal turn failure instead of startup notices or intermediate reconnects', () => {
    expect(failureCause(CAPACITY_STREAM)).toBe('Selected model is at capacity. Please try a different model.')
    expect(classifyBehaviorDiagnostic(CAPACITY_STREAM)).toEqual({ severity: 'warning', code: 'provider_capacity' })
  })
  it.each([
    ['error: pull-request head or base changed while building review packet', 'head_changed'],
    ['pull-request head or base changed before checkout', 'head_changed'],
    ['pull-request head or base changed during checkout', 'head_changed'],
    [`pull-request head changed during readiness check: expected ${'a'.repeat(40)}, got ${'b'.repeat(40)}`, 'head_changed'],
    ['GitHub 429: rate limited', 'rate_limit'], ['HTTP 502', 'upstream_unavailable'],
    ['GitHub 503: Service Unavailable', 'upstream_unavailable'], ['Traceback\nhttpx.ReadTimeout', 'network_interruption'],
  ])('recognizes the transient cause %s', (error, code) => {
    expect(classifyBehaviorDiagnostic(error)).toEqual({ severity: 'warning', code })
  })
  it.each(['GitHub 404: Not Found', 'HTTP 401', 'invalid verdict', 'warning: an unknown problem',
    'Code Mode is unavailable because code-mode host is disabled.'])('keeps actionable or unknown evidence as an error: %s', (error) => {
    expect(classifyBehaviorDiagnostic(error).severity).toBe('error')
  })
  it('never downgrades a held outcome or a structured account block based on transient text', () => {
    expect(classifyBehaviorDiagnostic(CAPACITY_STREAM, { held: true }).severity).toBe('error')
    expect(classifyBehaviorDiagnostic(CAPACITY_STREAM, { errorCode: 'review_provider_blocked' }).severity).toBe('error')
    expect(classifyBehaviorDiagnostic(CAPACITY_STREAM, { errorCode: 'invalid_agent_result' }).severity).toBe('error')
  })
  it('does not lose an unknown terminal cause behind an earlier capacity message', () => {
    const error = CAPACITY_STREAM + '\n{"type":"turn.failed","error":{"message":"invalid result contract"}}'
    expect(classifyBehaviorDiagnostic(error).severity).toBe('error')
    expect(failureCause(error)).toBe('invalid result contract')
  })
  it('keeps an unknown structured failure or quoted capacity text as an error', () => {
    expect(classifyBehaviorDiagnostic('Selected model is at capacity.', { errorCode: 'new_unknown_failure' }).severity).toBe('error')
    expect(classifyBehaviorDiagnostic('Invalid result: "Selected model is at capacity."').severity).toBe('error')
    expect(classifyBehaviorDiagnostic(`pull-request head changed: expected ${'a'.repeat(40)}, got missing`).severity).toBe('error')
    expect(classifyBehaviorDiagnostic('Selected model is at capacity.', { errorCode: 'authentication_failed' }))
      .toEqual({ severity: 'error', code: 'authentication' })
  })
})
