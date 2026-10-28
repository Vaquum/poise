import { afterEach, expect, it, vi } from 'vitest'
import { parseProcessDiagnostic } from '../server/process-diagnostic'

afterEach(() => vi.unstubAllEnvs())

it('retains multiline causal evidence and explicit missing context, excluding arbitrary content', () => {
  const event = parseProcessDiagnostic({ version: 1, source: 'caller', severity: 'error', operation: 'fetch', phase: 'checkout',
    outcome: 'exit', stderr: 'fatal: missing ref\nremote: explanation', stderr_truncated: false,
    call_id: 'a'.repeat(32), correlation_id: 'run', exit_code: 128, prompt: 'private prompt', filesystem: null })
  expect(event).toMatchObject({ stderr: 'fatal: missing ref\nremote: explanation', context: {
    call_id: 'a'.repeat(32), correlation_id: 'run', exit_code: 128, signal: null, release: null }, filesystem: null })
  expect(JSON.stringify(event)).not.toContain('private prompt')
})

it('redacts every allowed string field before the evidence reaches Poise responses', () => {
  vi.stubEnv('TEST_SECRET', 'nonstandard-secret-value')
  const event = parseProcessDiagnostic({ version: 1, source: 'caller', severity: 'error', operation: 'fetch', phase: 'checkout',
    outcome: 'exit', stderr: 'fatal: nonstandard-secret-value\nAuthorization: Basic ZW5jb2RlZA==\nCookie: private-cookie\nhttps://name:password@example.com/?token=private-query',
    stderr_truncated: false, cwd: 'ghp_privatekey', filesystem: { measurement_error: 'Bearer private-bearer' } })
  for (const secret of ['nonstandard-secret-value', 'ZW5jb2RlZA==', 'private-cookie', 'password', 'private-query', 'ghp_privatekey', 'private-bearer']) {
    expect(JSON.stringify(event)).not.toContain(secret)
  }
})

it('redacts configured secrets of every length, as Logging does', () => {
  vi.stubEnv('TEST_PASSWORD', 'pw7!')
  vi.stubEnv('TEST_TOKEN', 's2')
  const event = parseProcessDiagnostic({ version: 1, source: 'caller', severity: 'error', operation: 'fetch', phase: 'checkout',
    outcome: 'exit', stderr: 'fatal: pw7! rejected for s2', stderr_truncated: false, cwd: '/srv/s2', filesystem: { measurement_error: 'denied: pw7!' } })
  expect(event).toMatchObject({ stderr: 'fatal: [redacted] rejected for [redacted]', context: { cwd: '/srv/[redacted]' },
    filesystem: { measurement_error: 'denied: [redacted]' } })
})

it('leaves its markers whole when a secret is a single character', () => {
  vi.stubEnv('TEST_KEY', 'e')
  const event = parseProcessDiagnostic({ version: 1, source: 'caller', severity: 'error', operation: 'fetch', phase: 'checkout',
    outcome: 'exit', stderr: 'fatal: e\nAuthorization: Basic Zm9v', stderr_truncated: false, filesystem: null })
  expect(event?.stderr).toBe('fatal: [redacted]\n[redacted header]')
})

it('keeps historical absence readable and refuses unsupported or malformed diagnostics', () => {
  expect(parseProcessDiagnostic(undefined)).toBeNull()
  for (const value of ['error', [], { version: 2 }, { version: 1, source: 'caller', severity: 'info' }]) {
    expect(() => parseProcessDiagnostic(value)).toThrow('diagnostic')
  }
})

it('keeps missing historical v1 evidence unknown, including uncertain submission', () => {
  const event = parseProcessDiagnostic({ version: 1, source: 'caller', severity: 'error',
    operation: 'provider.review', phase: 'submitting', submission: 'uncertain' })
  expect(event).toMatchObject({ outcome: null, stderr: null, stderr_truncated: null,
    context: { submission: 'uncertain' } })
  expect(parseProcessDiagnostic({ version: 1, source: 'caller', severity: 'error', operation: 'provider.review',
    phase: 'provider_execution', stderr: 'codex exited 1', exit_code: 1, submission: 'none' }))
    .toMatchObject({ outcome: null, stderr: 'codex exited 1', stderr_truncated: null,
      context: { exit_code: 1, submission: 'none' } })
})

it.each([{ outcome: 7 }, { stderr: [] }, { stderr_truncated: 'false' }])('rejects malformed present diagnostic evidence %j', (extra) => {
  expect(() => parseProcessDiagnostic({ version: 1, source: 'caller', severity: 'error',
    operation: 'provider.review', phase: 'submitting', ...extra })).toThrow('diagnostic')
})
