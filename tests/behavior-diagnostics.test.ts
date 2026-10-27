import { afterEach, describe, expect, it, vi } from 'vitest'
import { behaviorErrorMessage, behaviorIncidentDiagnostics } from '../server/behavior-diagnostics'
import type { LogEntry } from '../server/agent'
import type { BehaviorDeadLetter, BehaviorLaunchClaim } from '../server/db'

afterEach(() => vi.unstubAllEnvs())

// Caller's GitHub client prints rate-limit headers and the raw response body
// on one stderr line; GitHub pretty-prints the body, so the last line is `}`.
const QUOTA_STDERR = 'error: GitHub 403 rate-limit: {\'x-ratelimit-resource\': \'core\', \'x-ratelimit-limit\': \'5000\', '
  + '\'x-ratelimit-remaining\': \'0\', \'x-ratelimit-used\': \'5000\', \'x-ratelimit-reset\': \'1800000000\'} body={\n'
  + '\t"message": "API rate limit exceeded for user ID 42. Slow down and retry after the reset.",\n'
  + '\t"documentation_url": "https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting",\n'
  + '\t"status": "403"\n}'
const QUOTA_SUMMARY = 'Command failed (1): github-interface: GitHub 403 rate-limit '
  + '{\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', \'x-ratelimit-reset\': \'1800000000\'}: '
  + 'API rate limit exceeded for user ID 42. Slow down and retry after the reset.'

describe('behavior CLI diagnostics', () => {
  it('extracts and redacts the terminal event before truncating a long provider stream', () => {
    vi.stubEnv('GH_TOKEN', 'terminal-secret-value')
    const stream = '{"type":"item.completed","item":{"type":"error","message":"Code Mode disabled"}}\n'
      + 'startup '.repeat(100) + '\n{"type":"turn.failed","error":{"message":"Selected model is at capacity. terminal-secret-value"}}'
    expect(behaviorErrorMessage(stream)).toBe('Selected model is at capacity. [redacted]')
  })
  it('selects the quota cause from a multiline rate-limit failure, not its closing brace', () => {
    const result = behaviorErrorMessage(Object.assign(new Error('Command failed (1): github-interface'), { stderr: QUOTA_STDERR }))
    expect(result).toBe(QUOTA_SUMMARY)
    expect(result.length).toBeLessThanOrEqual(300)
  })
  it('selects the same quota cause from the compact single-line envelope', () => {
    const stderr = 'error: GitHub 403 rate-limit: {\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', '
      + '\'x-ratelimit-reset\': \'1800000000\'} body={"message": "API rate limit exceeded for user ID 42.", "status": "403"}'
    expect(behaviorErrorMessage(Object.assign(new Error('Command failed (1): github-interface'), { stderr })))
      .toBe('Command failed (1): github-interface: GitHub 403 rate-limit '
        + '{\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', \'x-ratelimit-reset\': \'1800000000\'}: '
        + 'API rate limit exceeded for user ID 42.')
  })
  it('prefers the terminal provider failure over a JSON body', () => {
    const result = behaviorErrorMessage(Object.assign(new Error('Command failed (1): agent-interface'), {
      stderr: `${QUOTA_STDERR}\n{"type":"turn.failed","error":{"message":"Selected model is at capacity."}}`,
    }))
    expect(result).toBe('Selected model is at capacity.')
  })
  it.each([
    'error: checkout not found under /Users/example/dev: autonomio/autonomio',
    'error: GitHub 404: Not Found',
    'httpx.ConnectError: DNS lookup failed',
  ])('keeps the terminal cause: %s', (stderr) => {
    expect(behaviorErrorMessage(Object.assign(new Error('Command failed (1): github-interface'), {
      stderr: `Traceback (most recent call last):\n${stderr}\n`,
    }))).toBe(`Command failed (1): github-interface: ${stderr}`)
  })
  it('redacts credentials before truncation or persistence', () => {
    vi.stubEnv('GH_TOKEN', 'tango-77-foxtrot-9182')
    const result = behaviorErrorMessage(Object.assign(new Error('Command failed (1): github-interface'), {
      stderr: 'error: tango-77-foxtrot-9182 ghp_abcdef github_pat_abcdef Bearer B7Q9x2Rm4Kv8Wd3 https://user:password@example.org/path',
    }))
    expect(result).toBe('Command failed (1): github-interface: error: [redacted] [redacted] [redacted] [redacted credential] https://[redacted]@example.org/path')
  })
  it('withholds credential fields the summary redactor used to leak', () => {
    const result = behaviorErrorMessage(Object.assign(new Error('Command failed (1): github-interface'), {
      stderr: 'error: Authorization: Basic Zm9vYmFyZm9vYmFy password=hunter2call response={"access_token":"opaque-token-fixture-value"} '
        + 'https://api.example.test/?access_token=opaque-query-fixture',
    }))
    for (const exposed of ['Zm9vYmFyZm9vYmFy', 'hunter2call', 'opaque-token-fixture-value', 'opaque-query-fixture']) {
      expect(result).not.toContain(exposed)
    }
    expect(result).toContain('[redacted')
  })
  it('selects the full quota message GitHub pretty-prints without swallowing it', () => {
    const stderr = 'error: GitHub 403 rate-limit: {\'x-ratelimit-resource\': \'core\', \'x-ratelimit-limit\': \'5000\', '
      + '\'x-ratelimit-remaining\': \'0\', \'x-ratelimit-used\': \'5000\', \'x-ratelimit-reset\': \'1800000000\'} body={\n'
      + '\t"message": "API rate limit exceeded for user ID 42. If you reach out to GitHub Support for help, please include the request ID '
      + 'AA11:22BB:33CC:44DD:55EE:66FF and timestamp 2026-10-22 16:41:30 UTC. For more on scraping GitHub and how it may affect your rights, '
      + 'please review our Terms of Service (https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)",\n'
      + '\t"status": "403"\n}'
    const result = behaviorErrorMessage(Object.assign(new Error('Command failed (1): github-interface'), { stderr }))
    expect(result.length).toBe(300)
    expect(result).toContain('GitHub 403 rate-limit')
    expect(result).toContain('\'x-ratelimit-remaining\': \'0\'')
    expect(result).toContain('1800000000')
    expect(result).toContain('API rate limit exceeded for user ID 42.')
    expect(result).not.toContain('documentation_url')
    expect(result.endsWith(': }')).toBe(false)
  })
  it('redacts the selected cause before bounding it, without leaving secret fragments', () => {
    const secret = 'opaque-boundary-secret-value'
    vi.stubEnv('GH_TOKEN', secret)
    const stderr = 'error: GitHub 403 rate-limit: {\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', '
      + `'x-ratelimit-reset': '1800000000'} body={\n\t"message": "${'m'.repeat(140)}${secret}${'m'.repeat(120)}",\n}`
    const error = Object.assign(new Error('Command failed (1): github-interface'), { stderr, stdout: 'stdout-secret-value' })
    const unbounded = behaviorErrorMessage(error, Infinity)
    // The secret crosses the 300-character naive cut, so truncating first
    // would persist a fragment.
    expect(unbounded.indexOf('[redacted]')).toBeLessThan(300)
    expect(unbounded.indexOf('[redacted]') + secret.length).toBeGreaterThan(300)
    for (const exposed of [secret, secret.slice(0, 12), secret.slice(-12), 'stdout-secret-value']) {
      expect(unbounded).not.toContain(exposed)
    }
    const result = behaviorErrorMessage(error)
    expect(result.length).toBeLessThanOrEqual(300)
    for (const exposed of [secret, secret.slice(0, 12), secret.slice(-12), 'stdout-secret-value']) {
      expect(result).not.toContain(exposed)
    }
  })
  it.each(['', '   \n  ', '{\n}', '{\n"status": "403"\n}', '{"message": oops', 'https://docs.github.com/rest#rate-limiting'])(
    'leaves an unknown cause honest when stderr names none: %j', (stderr) => {
      expect(behaviorErrorMessage(Object.assign(new Error('Command failed (1): github-interface'), { stderr })))
        .toBe('Command failed (1): github-interface')
    })
  it('bounds output, strips control characters, and never exposes stdout', () => {
    const result = behaviorErrorMessage(Object.assign(new Error('failed'), {
      stderr: `\u001b[31m${'x'.repeat(1000)}`, stdout: 'secret credential',
    }))
    expect(result.length).toBe(300)
    expect(result).not.toContain('\u001b')
    expect(result).not.toContain('secret credential')
  })
})

describe('retained incident actionability', () => {
  const error = `error: pull-request head changed: expected ${'a'.repeat(40)}, got ${'b'.repeat(40)}`
  const incident: BehaviorDeadLetter = { id: 'audit', behavior: 'review-new-prs', target: 'acme/repo#18',
    repo: 'acme/repo', pr: 18, actor: 'review-bot', source: 'poise:review-new-prs',
    callId: 'd'.repeat(32), correlationId: 'launch', error, createdAt: '2026-10-13T14:09:00Z',
    resolution: null, resolutionEvidence: null, resolvedAt: null, attemptCount: 3 }
  const call: LogEntry = { id: incident.callId!, repo: incident.repo, pr_id: '18', actor: incident.actor,
    source: incident.source, correlation_id: incident.correlationId, behavior: 'pr_review', model: 'test',
    prompt: '', session_id: null, started_at: '2026-10-13T14:08:00Z', time_elapsed: '4s', status: 'failed',
    action: 'not_started', outcome: 'preflight_failed', head_sha: null, expected_head: 'a'.repeat(40),
    response: null, error, review_id: null, receipts: null }
  const launch: BehaviorLaunchClaim = { key: incident.behavior, target: incident.target, seenAt: incident.createdAt,
    claimId: 'launch', leaseUntil: null, launchBehavior: 'pr_review', launchRepo: incident.repo!, launchPr: 18,
    launchRequestedAt: call.started_at, launchExpectedHead: call.expected_head!, launchActor: incident.actor!,
    launchSource: incident.source!, launchCorrelationId: incident.correlationId!, launchCallId: incident.callId,
    launchError: null, launchQuarantine: null, launchQuarantineMayRun: false, launchCovers: [] }
  it('shows a proven no-action head change as automatic without an active failure summary', () => {
    const result = behaviorIncidentDiagnostics([incident], { entries: [call], quarantined: [] })
    expect(result[0]).toMatchObject({ attemptCount: 3, diagnostic: { severity: 'info', code: 'head_changed' } })
    expect(incident).not.toHaveProperty('diagnostic')
  })
  it.each(['failed', 'error', 'cancelled', 'canceled', 'timed_out', 'timeout'])('accepts a retryable no-action terminal status %s', (status) => {
    expect(behaviorIncidentDiagnostics([incident], { entries: [{ ...call, status }], quarantined: [] })[0]?.diagnostic)
      .toEqual({ severity: 'info', code: 'head_changed' })
  })
  it.each([
    { id: 'e'.repeat(32) }, { correlation_id: 'other' }, { actor: 'other-bot' }, { repo: 'other/repo' },
    { pr_id: '19' }, { behavior: 'pr_approve' }, { source: 'manual' }, { head_sha: 'a'.repeat(40) },
    { review_id: 123 }, { receipts: [] }, { action: null }, { outcome: null }, { expected_head: null },
    { review_comments: 1 }, { status: 'completed' }, { status: 'invalid' },
  ])('keeps mismatched or side-effect evidence visible for verification: %j', (change) => {
    const result = behaviorIncidentDiagnostics([incident], { entries: [{ ...call, ...change }], quarantined: [] })
    expect(result[0]?.diagnostic).toEqual({ severity: 'warning', code: 'held_result' })
  })
  it('does not downgrade missing or duplicate evidence', () => {
    for (const snapshot of [null, { entries: [], quarantined: [] }, { entries: [call, call], quarantined: [] }]) {
      expect(behaviorIncidentDiagnostics([incident], snapshot)[0]?.diagnostic.severity).toBe('warning')
    }
  })
  it('keeps a quarantined duplicate with the exact correlation visible', () => {
    const snapshot = { entries: [call], quarantined: [{ index: 1, id: 'e'.repeat(32), correlationId: incident.correlationId,
      repo: null, prId: null, behavior: null, sessionId: null, error: 'conflicting worker result' }] }
    expect(behaviorIncidentDiagnostics([incident], snapshot)[0]?.diagnostic).toEqual({ severity: 'warning', code: 'held_result' })
  })
  it('rejects a different validated call sharing the exact correlation', () => {
    const snapshot = { entries: [call, { ...call, id: 'e'.repeat(32), status: 'running' }], quarantined: [] }
    expect(behaviorIncidentDiagnostics([incident], snapshot)[0]?.diagnostic).toEqual({ severity: 'warning', code: 'held_result' })
  })
  it('keeps a persisted launch-head mismatch visible as a Poise contract fault', () => {
    const result = behaviorIncidentDiagnostics([incident], { entries: [call], quarantined: [] }, [
      { ...launch, launchExpectedHead: 'f'.repeat(40), launchError: 'launch expected head did not match' },
    ])
    expect(result[0]).toMatchObject({ error: 'launch expected head did not match', diagnostic: { severity: 'error', code: 'invalid_agent_result' } })
  })
  it.each(['invalid_result', 'unreadable'] as const)('never labels a persisted %s quarantine as automatic', (launchQuarantine) => {
    const result = behaviorIncidentDiagnostics([incident], { entries: [call], quarantined: [] }, [{ ...launch, launchQuarantine }])
    expect(result[0]?.diagnostic.severity).toBe(launchQuarantine === 'invalid_result' ? 'error' : 'warning')
  })
  it.each([null, ''] as const)('never borrows an unrelated quarantine through missing identity %j', (correlationId) => {
    const result = behaviorIncidentDiagnostics([{ ...incident, callId: null, correlationId }], { entries: [], quarantined: [] }, [
      { ...launch, launchCallId: null, launchCorrelationId: 'unrelated-launch', launchQuarantine: 'invalid_result', launchError: 'Unrelated fault' },
    ])
    expect(result[0]).toMatchObject({ error: incident.error, diagnostic: { severity: 'warning', code: 'held_result' } })
  })
})
