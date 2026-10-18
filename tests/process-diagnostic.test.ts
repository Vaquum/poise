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

it('keeps historical absence readable and refuses unsupported or malformed diagnostics', () => {
  expect(parseProcessDiagnostic(undefined)).toBeNull()
  for (const value of ['error', [], { version: 2 }, { version: 1, source: 'caller', severity: 'info' }]) {
    expect(() => parseProcessDiagnostic(value)).toThrow('diagnostic')
  }
})
