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
      ['warning', 'Vaquum/Composer', 5], ['warning', 'mikkokotila/eightchord-com', 5],
    ])
  })
  it('keeps unknown failures and held transient text visible as needing attention', () => {
    const diagnostics = snapshot()
    diagnostics.deadLetters.push({ id: 'x', behavior: 'approve-prs', target: 'org/repo#1',
      error: 'Selected model is at capacity.', createdAt: '' })
    expect(behaviorDiagnosticGroups(diagnostics)[0]?.severity).toBe('warning')
  })
  it('keeps an API outage separate from last-known repository errors', () => {
    const diagnostics = snapshot()
    diagnostics.apiError = { severity: 'warning', code: 'upstream_unavailable', message: 'HTTP 502' }
    diagnostics.identity.error = 'Reviewer is not configured'
    const groups = behaviorDiagnosticGroups(diagnostics)
    expect(groups.map((group) => [group.scope, group.severity])).toEqual([['Identity', 'warning'], ['Behaviors', 'info']])
  })
  it('retains unexplained degraded runtime evidence alongside an API warning', () => {
    const diagnostics = snapshot()
    diagnostics.status = 'degraded'
    diagnostics.runtimeError = 'Behavior runtime is degraded.'
    diagnostics.apiError = { severity: 'warning', code: 'upstream_unavailable', message: 'HTTP 502' }
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => [group.severity, group.code])).toEqual([
      ['error', 'runtime_unhealthy'], ['info', 'upstream_unavailable'],
    ])
  })
  it('retains the organization and behavior origin for an untargeted GitHub access failure', () => {
    const diagnostics = snapshot()
    diagnostics.failures.push({ org: 'acme', behavior: 'approve-prs', kind: 'operation',
      consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error: 'GitHub 404: Not Found' })
    expect(behaviorDiagnosticGroups(diagnostics)[0]?.scope).toBe('acme approve-prs')
  })
  it('never treats a generic degraded snapshot as proof that Poise needs repair', () => {
    const diagnostics = snapshot()
    diagnostics.status = 'degraded'
    expect(behaviorDiagnosticGroups(diagnostics)).toEqual([expect.objectContaining({ severity: 'warning', code: 'runtime_status_unknown' })])
  })
  it('shows a retained no-action head-change incident in grey after its active failure is gone', () => {
    const diagnostics = snapshot()
    diagnostics.deadLetters.push({ id: 'x', behavior: 'review-new-prs', target: 'org/repo#18',
      error: `pull-request head changed: expected ${'a'.repeat(40)}, got ${'b'.repeat(40)}`, createdAt: '', attemptCount: 3,
      diagnostic: { severity: 'info', code: 'head_changed' } })
    expect(behaviorDiagnosticGroups(diagnostics)).toEqual([expect.objectContaining({ severity: 'info', code: 'head_changed' })])
  })
  it('deduplicates only the exact no-action attempt, never an unrelated held result with the same cause', () => {
    const diagnostics = snapshot()
    const error = 'Selected model is at capacity.'
    diagnostics.failures.push({ behavior: 'approve-prs', target: 'org/repo#1@head=a', kind: 'worker',
      consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error, callId: 'safe-attempt',
      diagnostic: { severity: 'warning', code: 'provider_capacity' } })
    diagnostics.deadLetters.push({ id: 'x', behavior: 'approve-prs', target: 'org/repo#1',
      error, createdAt: '', callId: 'safe-attempt' })
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => group.severity)).toEqual(['info'])
    diagnostics.deadLetters[0]!.callId = 'uncertain-attempt'
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => group.severity)).toEqual(['info', 'warning'])
    diagnostics.deadLetters[0]!.callId = 'safe-attempt'
    diagnostics.deadLetters[0]!.behavior = 'review-new-prs'
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => group.severity)).toEqual(['info', 'warning'])
  })
  it('keeps a legacy worker error held when its Caller no-action proof is unavailable', () => {
    const diagnostics = snapshot()
    diagnostics.failures.push({ behavior: 'approve-prs', target: 'org/repo#1', kind: 'worker',
      consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error: 'Selected model is at capacity.' })
    diagnostics.deadLetters.push({ id: 'x', behavior: 'approve-prs', target: 'org/repo#1',
      error: 'Selected model is at capacity.', createdAt: '' })
    const groups = behaviorDiagnosticGroups(diagnostics)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.severity).toBe('warning')
    expect(groups[0]?.details).toHaveLength(2)
  })
  it.each(['provider_capacity', 'rate_limit', 'upstream_unavailable'])('deduplicates a verified warning classified by structured code %s', (code) => {
    const diagnostics = snapshot()
    diagnostics.failures.push({ behavior: 'approve-prs', target: 'org/repo#1', kind: 'worker',
      consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error: 'Provider rejected the request',
      callId: 'verified-attempt', diagnostic: { severity: 'warning', code } })
    diagnostics.deadLetters.push({ id: 'x', behavior: 'approve-prs', target: 'org/repo#1',
      error: 'Provider rejected the request', createdAt: '', callId: 'verified-attempt' })
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => group.severity)).toEqual(['info'])
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
    expect(behaviorDiagnosticGroups(diagnostics).map((group) => group.severity)).toEqual(['warning'])
  })
  it.each([false, true])('prefers current held evidence over a persisted automatic failure with recovered=%s', (recovered) => {
    const diagnostics = snapshot()
    const error = 'Selected model is at capacity.'
    diagnostics.failures.push({ behavior: 'approve-prs', target: 'org/repo#1', kind: 'worker',
      consecutiveFailures: 1, lastFailureAt: '', nextRetryAt: '', error, callId: 'attempt', recovered,
      diagnostic: { severity: 'info', code: 'provider_capacity' } })
    diagnostics.deadLetters.push({ id: 'audit', behavior: 'approve-prs', target: 'org/repo#1', error,
      createdAt: '', callId: 'attempt', diagnostic: { severity: 'warning', code: 'held_result' } })
    expect(behaviorDiagnosticGroups(diagnostics)).toEqual([expect.objectContaining({ severity: 'warning', code: 'held_result' })])
  })

  it('records what each detail is about, so the notification rail can join and count it', () => {
    const diagnostics = snapshot()
    diagnostics.agentLogsError = 'agent-interface --logs exited with status 1'
    diagnostics.failures.push({ behavior: 'review-new-prs', target: 'acme/api#9:secondary:check', kind: 'operation',
      consecutiveFailures: 2, lastFailureAt: '2026-10-17T10:05:00.000Z', nextRetryAt: '', error: 'GitHub 404: Not Found' })
    diagnostics.deadLetters.push({ id: 'letter', behavior: 'approve-prs', target: 'acme/web#3', error: 'No verdict.',
      createdAt: '2026-10-17T10:07:00.000Z', attemptCount: 2, diagnostic: { severity: 'error', code: 'invalid_agent_result' } })
    const entries = behaviorDiagnosticGroups(diagnostics).map((group) => group.entries.map(({ behavior, target, at, next }) => ({ behavior, target, at, next })))
    expect(entries).toEqual([
      [{ behavior: null, target: null, at: null, next: null }],
      [{ behavior: 'review-new-prs', target: 'acme/api#9:secondary:check', at: '2026-10-17T10:05:00.000Z', next: null }],
      [{ behavior: 'approve-prs', target: 'acme/web#3', at: '2026-10-17T10:07:00.000Z', next: null }],
    ])
    for (const group of behaviorDiagnosticGroups(diagnostics)) expect(group.entries.map((entry) => entry.detail)).toEqual(group.details)
  })

  it('carries a failing behavior’s next check as its own field, not inside the detail text', () => {
    const diagnostics = snapshot()
    diagnostics.failures.push({ behavior: 'review-new-prs', target: 'acme/api#9', kind: 'operation',
      consecutiveFailures: 2, lastFailureAt: '2026-10-17T10:05:00.000Z', nextRetryAt: '2026-10-17T10:10:00.000Z', error: 'GitHub 404: Not Found' })
    const [entry] = behaviorDiagnosticGroups(diagnostics)[0]!.entries
    expect(entry!.next).toBe('2026-10-17T10:10:00.000Z')
    expect(entry!.detail).not.toContain('next check')
    expect(entry!.detail).not.toContain('2026-10-17T10:10:00.000Z')
  })

  it('keeps failures apart when only their next check differs', () => {
    const diagnostics = snapshot()
    for (const nextRetryAt of ['2026-10-17T10:10:00.000Z', '2026-10-17T10:20:00.000Z']) {
      diagnostics.failures.push({ behavior: 'review-new-prs', target: 'acme/api#9', kind: 'operation',
        consecutiveFailures: 2, lastFailureAt: '2026-10-17T10:05:00.000Z', nextRetryAt, error: 'GitHub 404: Not Found' })
    }
    expect(behaviorDiagnosticGroups(diagnostics)[0]!.entries).toHaveLength(2)
  })
})
