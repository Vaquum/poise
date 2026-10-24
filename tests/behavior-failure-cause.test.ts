import { describe, expect, it } from 'vitest'
import { classifyBehaviorDiagnostic, failureCause, isRepoAccessDenied, rateLimitRetryAtMs } from '../src/behavior-failure-cause'

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

  it('keeps the quota facts a rate-limit error carries', () => {
    const error = 'error: GitHub 403 rate-limit: {\'x-ratelimit-resource\': \'core\', \'x-ratelimit-limit\': \'5000\', '
      + '\'x-ratelimit-remaining\': \'0\', \'x-ratelimit-used\': \'5000\', \'x-ratelimit-reset\': \'1800000000\'} body={\n'
      + '\t"message": "API rate limit exceeded for user ID 42.",\n\t"status": "403"\n}'
    expect(failureCause(error)).toBe('GitHub 403 rate-limit '
      + '{\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', \'x-ratelimit-reset\': \'1800000000\'}: '
      + 'API rate limit exceeded for user ID 42.')
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
    expect(classifyBehaviorDiagnostic(CAPACITY_STREAM)).toEqual({ severity: 'info', code: 'provider_capacity' })
  })
  it.each([
    ['error: pull-request head or base changed while building review packet', 'head_changed'],
    ['pull-request head or base changed before checkout', 'head_changed'],
    ['pull-request head or base changed during checkout', 'head_changed'],
    [`pull-request head changed during readiness check: expected ${'a'.repeat(40)}, got ${'b'.repeat(40)}`, 'head_changed'],
    ['GitHub 429: rate limited', 'rate_limit'], ['HTTP 502', 'upstream_unavailable'],
    ['GitHub 503: Service Unavailable', 'upstream_unavailable'], ['Traceback\nhttpx.ReadTimeout', 'network_interruption'],
  ])('recognizes the transient cause %s', (error, code) => {
    expect(classifyBehaviorDiagnostic(error)).toEqual({ severity: 'info', code })
  })
  it.each(['GitHub 404: Not Found', 'HTTP 401', 'invalid verdict', 'warning: an unknown problem',
    'Code Mode is unavailable because code-mode host is disabled.'])('keeps actionable or unknown evidence as needing attention: %s', (error) => {
    expect(classifyBehaviorDiagnostic(error).severity).toBe('warning')
  })
  it.each([
    'GitHub 403 rate-limit: {\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\'} body={"message": "API rate limit exceeded"}',
    'Command failed (1): github-interface: GitHub 403 rate-limit {\'x-ratelimit-remaining\': \'0\', \'x-ratelimit-reset\': \'1800000000\'}: API rate limit exceeded for user ID 42.',
    'GitHub 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
    'HTTP 403 API rate limit exceeded',
  ])('recognizes an evidenced quota exhaustion as a rate limit: %s', (error) => {
    expect(classifyBehaviorDiagnostic(error)).toEqual({ severity: 'info', code: 'rate_limit' })
  })
  it.each([
    'GitHub 403: Forbidden',
    'GitHub 403 rate-limit: {\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'12\'} body={"message": "Resource not accessible by integration"}',
    'GitHub 403 rate-limit: {\'x-ratelimit-remaining\': \'12\'} body={"message": "Must have admin rights to Repository."}',
  ])('keeps an access refusal without exhaustion evidence as repository access: %s', (error) => {
    expect(classifyBehaviorDiagnostic(error)).toEqual({ severity: 'warning', code: 'github_access' })
  })
  it('never downgrades a held outcome or a structured account block based on transient text', () => {
    expect(classifyBehaviorDiagnostic(CAPACITY_STREAM, { held: true }).severity).toBe('warning')
    expect(classifyBehaviorDiagnostic(CAPACITY_STREAM, { errorCode: 'review_provider_blocked' }).severity).toBe('warning')
    expect(classifyBehaviorDiagnostic(CAPACITY_STREAM, { errorCode: 'invalid_agent_result' }).severity).toBe('error')
  })
  it.each(['invalid_agent_result'])('reserves red for the confirmed integration fault %s', (errorCode) => {
    expect(classifyBehaviorDiagnostic('worker failed', { errorCode, held: true })).toEqual({ severity: 'error', code: errorCode })
  })
  it.each(['review_contract_violation', 'review_recovery_failed', 'review_provider_blocked', 'review_packet_too_large', 'review_budget_exhausted', 'model_output_limit'])('keeps the external worker condition %s yellow', (errorCode) => {
    expect(classifyBehaviorDiagnostic('worker failed', { errorCode, held: true })).toEqual({ severity: 'warning', code: errorCode })
  })
  it('does not lose an unknown terminal cause behind an earlier capacity message', () => {
    const error = CAPACITY_STREAM + '\n{"type":"turn.failed","error":{"message":"invalid result contract"}}'
    expect(classifyBehaviorDiagnostic(error).severity).toBe('warning')
    expect(failureCause(error)).toBe('invalid result contract')
  })
  it('keeps an unknown structured failure or quoted capacity text as needing attention', () => {
    expect(classifyBehaviorDiagnostic('Selected model is at capacity.', { errorCode: 'new_unknown_failure' }).severity).toBe('warning')
    expect(classifyBehaviorDiagnostic('Invalid result: "Selected model is at capacity."').severity).toBe('warning')
    expect(classifyBehaviorDiagnostic(`pull-request head changed: expected ${'a'.repeat(40)}, got missing`).severity).toBe('warning')
    expect(classifyBehaviorDiagnostic('Selected model is at capacity.', { errorCode: 'authentication_failed' }))
      .toEqual({ severity: 'warning', code: 'authentication' })
  })
})

describe('repository access denial', () => {
  it.each([
    'GitHub 404: Not Found',
    'Command failed (1): github-interface: error: GitHub 404: Not Found',
    "Could not resolve to a Repository with the name 'Vaquum/field-data-api'.",
    "GitHub merge candidate query failed: [{'message': \"Could not resolve to a Repository with the name 'acme/web'.\", 'path': ['pr0']}]",
    "[{'type': 'NOT_FOUND', 'path': ['repository'], 'message': 'Could not resolve to a Repository.'}]",
    '[{"type": "NOT_FOUND", "path": ["repository", "pullRequest"], "message": "Not found"}]',
  ])('recognizes the agent account cannot read the repository: %s', (error) => {
    expect(isRepoAccessDenied(error)).toBe(true)
  })
  it.each([
    'GitHub 403: Forbidden',
    'GitHub 403 rate-limit: {\'x-ratelimit-remaining\': \'12\'} body={"message": "Must have admin rights to Repository."}',
    'GitHub 401: Bad credentials',
    "[{'type': 'NOT_FOUND', 'path': ['resolveReviewThread'], 'message': 'Could not resolve to a thread.'}]",
    'GitHub 4040: unexpected status',
    'Selected model is at capacity.',
    'Command timed out after 30s',
    'pull-request head changed during readiness check',
  ])('leaves a non-repository failure to its own retry: %s', (error) => {
    expect(isRepoAccessDenied(error)).toBe(false)
  })
})

describe('rate-limit retry time', () => {
  const now = Date.parse('2026-10-22T14:38:00Z')
  it('reads the reset epoch Caller surfaces on a 403', () => {
    const reset = Math.floor(now / 1000) + 300
    const error = `GitHub 403 rate-limit: {'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '${reset}'} body={"message":"API rate limit exceeded"}`
    expect(rateLimitRetryAtMs(error, now)).toBe(reset * 1000)
  })
  it('reads a JSON-quoted reset and prefers the later of reset and retry-after', () => {
    const reset = Math.floor(now / 1000) + 300
    expect(rateLimitRetryAtMs(`GitHub 429 rate-limit: {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "${reset}"}`, now)).toBe(reset * 1000)
    expect(rateLimitRetryAtMs(`GitHub 429 rate-limit: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '${reset}', 'retry-after': '600'}`, now)).toBe(now + 600_000)
    expect(rateLimitRetryAtMs(`GitHub 429 rate-limit: {'retry-after': '30'}`, now)).toBe(now + 30_000)
  })
  it('honors a short retry-after over a distant reset while quota remains', () => {
    const reset = Math.floor(now / 1000) + 3000
    expect(rateLimitRetryAtMs(`GitHub 429 rate-limit: {'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '${reset}', 'retry-after': '30'}`, now)).toBe(now + 30_000)
  })
  it('ignores anything without a sane stated time', () => {
    expect(rateLimitRetryAtMs('GitHub read unavailable', now)).toBeNull()
    expect(rateLimitRetryAtMs(`GitHub 403 rate-limit: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': 'yesterday'}`, now)).toBeNull()
    expect(rateLimitRetryAtMs(`GitHub 403 rate-limit: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1'}`, now)).toBeNull()
    expect(rateLimitRetryAtMs(`GitHub 403 rate-limit: {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '${Math.floor(now / 1000) + 100_000}'}`, now)).toBeNull()
    expect(rateLimitRetryAtMs(`GitHub 429 rate-limit: {'retry-after': '999999'}`, now)).toBeNull()
  })
  it('ignores the reset while quota remains or its state is unknown', () => {
    const reset = Math.floor(now / 1000) + 300
    expect(rateLimitRetryAtMs(`GitHub 403 rate-limit: {'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '${reset}'} body={"message":"Resource not accessible by integration"}`, now)).toBeNull()
    expect(rateLimitRetryAtMs(`GitHub 403 rate-limit: {'x-ratelimit-reset': '${reset}'}`, now)).toBeNull()
  })
})
