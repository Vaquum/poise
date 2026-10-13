import { describe, expect, it } from 'vitest'
import { behaviorDiagnosticGroups } from '../src/behavior-diagnostics'
import type { BehaviorDiagnostics, BehaviorKey } from '../src/behaviors'

function snapshot(): BehaviorDiagnostics {
  return { status: 'ok', agentLogsError: null,
    datastore: { status: 'healthy', checkedAt: '', ageSeconds: 1, lastSuccessAt: '', error: null },
    identity: { status: 'valid', actor: 'bit-mis', error: null }, failures: [], deadLetters: [] }
}

describe('behavior diagnostic groups', () => {
  it('collapses REST and GraphQL access failures across review slots and behaviors by repository', () => {
    const diagnostics = snapshot()
    for (const repo of ['Vaquum/Composer', 'mikkokotila/eightchord-com']) {
      for (const behavior of ['review-new-prs', 'approve-prs', 'resolve-unblocking'] as BehaviorKey[]) {
        for (const slot of behavior === 'review-new-prs' ? ['', ':secondary', ':tertiary'] : ['']) {
          diagnostics.failures.push({ behavior, target: `${repo}#21${slot}:check`, kind: 'operation',
            consecutiveFailures: 19, lastFailureAt: '', nextRetryAt: '',
            error: behavior === 'resolve-unblocking' ? `Could not resolve to a Repository with the name '${repo}'.` : 'GitHub 404: Not Found' })
        }
      }
    }
    const groups = behaviorDiagnosticGroups(diagnostics)
    expect(groups).toHaveLength(2)
    expect(groups.map((group) => [group.severity, group.scope, group.details.length])).toEqual([
      ['error', 'Vaquum/Composer', 5], ['error', 'mikkokotila/eightchord-com', 5],
    ])
  })
  it('keeps unknown failures and held transient text visible as errors', () => {
    const diagnostics = snapshot()
    diagnostics.deadLetters.push({ id: 'x', behavior: 'approve-prs', target: 'org/repo#1',
      error: 'Selected model is at capacity.', createdAt: '' })
    expect(behaviorDiagnosticGroups(diagnostics)[0]?.severity).toBe('error')
  })
  it('keeps an API outage separate from last-known repository errors', () => {
    const diagnostics = snapshot()
    diagnostics.apiError = { severity: 'warning', code: 'upstream_unavailable', message: 'HTTP 502' }
    diagnostics.identity.error = 'Reviewer is not configured'
    const groups = behaviorDiagnosticGroups(diagnostics)
    expect(groups.map((group) => [group.scope, group.severity])).toEqual([['Identity', 'error'], ['Behaviors', 'warning']])
  })
  it('retains unexplained degraded runtime evidence alongside an API warning', () => {
    const diagnostics = snapshot()
    diagnostics.status = 'degraded'
    diagnostics.apiError = { severity: 'warning', code: 'upstream_unavailable', message: 'HTTP 502' }
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => [group.severity, group.code])).toEqual([
      ['error', 'runtime_unhealthy'], ['warning', 'upstream_unavailable'],
    ])
  })
  it('retains the organization and behavior origin for an untargeted GitHub access failure', () => {
    const diagnostics = snapshot()
    diagnostics.failures.push({ org: 'acme', behavior: 'approve-prs', kind: 'operation',
      consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error: 'GitHub 404: Not Found' })
    expect(behaviorDiagnosticGroups(diagnostics)[0]?.scope).toBe('acme approve-prs')
  })
  it('deduplicates only the exact no-action attempt, never an unrelated held result with the same cause', () => {
    const diagnostics = snapshot()
    const error = 'Selected model is at capacity.'
    diagnostics.failures.push({ behavior: 'approve-prs', target: 'org/repo#1@head=a', kind: 'worker',
      consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error, callId: 'safe-attempt',
      diagnostic: { severity: 'warning', code: 'provider_capacity' } })
    diagnostics.deadLetters.push({ id: 'x', behavior: 'approve-prs', target: 'org/repo#1',
      error, createdAt: '', callId: 'safe-attempt' })
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => group.severity)).toEqual(['warning'])
    diagnostics.deadLetters[0]!.callId = 'uncertain-attempt'
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => group.severity)).toEqual(['warning', 'error'])
    diagnostics.deadLetters[0]!.callId = 'safe-attempt'
    diagnostics.deadLetters[0]!.behavior = 'review-new-prs'
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => group.severity)).toEqual(['warning', 'error'])
  })
  it('keeps a legacy worker error held when its Caller no-action proof is unavailable', () => {
    const diagnostics = snapshot()
    diagnostics.failures.push({ behavior: 'approve-prs', target: 'org/repo#1', kind: 'worker',
      consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error: 'Selected model is at capacity.' })
    diagnostics.deadLetters.push({ id: 'x', behavior: 'approve-prs', target: 'org/repo#1',
      error: 'Selected model is at capacity.', createdAt: '' })
    const groups = behaviorDiagnosticGroups(diagnostics)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.severity).toBe('error')
    expect(groups[0]?.details).toHaveLength(2)
  })
  it.each(['provider_capacity', 'rate_limit', 'upstream_unavailable'])('deduplicates a verified warning classified by structured code %s', (code) => {
    const diagnostics = snapshot()
    diagnostics.failures.push({ behavior: 'approve-prs', target: 'org/repo#1', kind: 'worker',
      consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error: 'Provider rejected the request',
      callId: 'verified-attempt', diagnostic: { severity: 'warning', code } })
    diagnostics.deadLetters.push({ id: 'x', behavior: 'approve-prs', target: 'org/repo#1',
      error: 'Provider rejected the request', createdAt: '', callId: 'verified-attempt' })
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => group.severity)).toEqual(['warning'])
  })
  it('keeps recovered warning identity for audit suppression without rendering either as an active problem', () => {
    const diagnostics = snapshot()
    diagnostics.failures.push({ behavior: 'approve-prs', target: 'org/repo#1', kind: 'worker',
      consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error: 'Selected model is at capacity.',
      callId: 'recovered-attempt', recovered: true, diagnostic: { severity: 'warning', code: 'provider_capacity' } })
    diagnostics.deadLetters.push({ id: 'x', behavior: 'approve-prs', target: 'org/repo#1',
      error: 'Selected model is at capacity.', createdAt: '', callId: 'recovered-attempt' })
    expect(behaviorDiagnosticGroups(diagnostics)).toEqual([])
    diagnostics.deadLetters[0]!.callId = 'unrelated-held-attempt'
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => group.severity)).toEqual(['error'])
  })
})
