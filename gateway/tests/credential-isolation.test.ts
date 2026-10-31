// Gateway tests run without the variables the diagnostics redact as
// credentials (credential-isolation.ts, the setup file), so a harness flag
// named like one cannot turn the digits a test reads back into "[redacted]".
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../src/log.js'
import { credentialVariables, removeCredentialVariables } from './credential-isolation.js'

// A parent environment like a Claude Code session's, which exports
// CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH=1, in some sessions
// USE_STAGING_OAUTH=0, and real tokens; with git configuration that carries
// a credential, too.
const PARENT_ENVIRONMENT = {
  CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
  USE_STAGING_OAUTH: '0',
  CLAUDE_CODE_MESSAGING_TOKEN: 'opaque-session-token',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
  GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic b3BhcXVlLWNyZWRlbnRpYWw=',
}
const gateway = fileURLToPath(new URL('..', import.meta.url))

afterEach(() => { vi.unstubAllEnvs() })

describe('every gateway test process', () => {
  it('carries no variable whose value the diagnostics redact as a credential', () => {
    // Names only: a failure must not print the developer's tokens.
    expect(credentialVariables(process.env)).toEqual([])
  })

  it('carries none when started from a parent like a Claude Code session', () => {
    // The test above, in vitest started from such a parent.
    const report = join(tmpdir(), `gw-credential-isolation-${process.pid}.json`)
    try {
      const run = spawnSync(process.execPath, [join(gateway, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/credential-isolation.test.ts',
        '--testNamePattern', 'carries no variable', '--reporter=json', `--outputFile=${report}`], { cwd: gateway, encoding: 'utf8', env: { ...process.env, ...PARENT_ENVIRONMENT } })
      expect(existsSync(report), run.stderr).toBe(true)
      const result = JSON.parse(readFileSync(report, 'utf8')) as { numPassedTests: number, numFailedTests: number, testResults: { assertionResults: { failureMessages: string[] }[] }[] }
      const failures = result.testResults.flatMap((file) => file.assertionResults.flatMap((test) => test.failureMessages)).join('\n')
      expect({ passed: result.numPassedTests, failed: result.numFailedTests }, failures).toEqual({ passed: 1, failed: 0 })
    } finally {
      rmSync(report, { force: true })
    }
  }, 30_000)
})

describe('credential variables', () => {
  it('go with GIT_CONFIG_COUNT, which git refuses once the keys it counts are gone', () => {
    const env: NodeJS.ProcessEnv = { ...PARENT_ENVIRONMENT, PATH: '/bin' }
    removeCredentialVariables(env)
    expect(env).toEqual({ PATH: '/bin' })
  })

  it('would turn a logged exit code into [redacted] if a harness flag stayed', () => {
    const logged = () => {
      const lines: string[] = []
      createLogger((line) => lines.push(line)).error('workspace.upgrade.failed', { error: 'installing the release exited with 1' })
      return (JSON.parse(lines[0]) as { error: string }).error
    }
    vi.stubEnv('CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', '1')
    expect(logged()).toBe('installing the release exited with [redacted]')
    // As credential-isolation.ts removes them before any test runs.
    for (const name of credentialVariables(process.env)) vi.stubEnv(name, undefined)
    expect(logged()).toBe('installing the release exited with 1')
  })
})
