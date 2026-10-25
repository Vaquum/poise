import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execute = promisify(execFile)
const script = resolve('scripts/npm-audit.mjs')

const fakeNpm = `#!/bin/sh
# Answers npm audit from $NPM_FAKE_DIR, one fixture per pass.
case "$*" in *--json*) pass=json;; *) pass=human;; esac
printf 'call %s %s\\n' "$pass" "$*" >>"$NPM_FAKE_DIR/calls.log"
cat "$NPM_FAKE_DIR/$pass.out"
exit "$(cat "$NPM_FAKE_DIR/$pass.code")"
`

interface Fixture {
  out: string
  code: number
}

async function stage(fixtures: Record<string, Fixture>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'npm-audit-'))
  const bin = join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'npm'), fakeNpm, { mode: 0o755 })
  for (const [name, fixture] of Object.entries(fixtures)) {
    await writeFile(join(dir, `${name}.out`), fixture.out)
    await writeFile(join(dir, `${name}.code`), String(fixture.code))
  }
  return dir
}

interface AuditResult {
  code: number
  stdout: string
  stderr: string
}

async function runAudit(env: NodeJS.ProcessEnv): Promise<AuditResult> {
  try {
    const result = await execute(process.execPath, [script], { env, timeout: 15_000 })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number | string, stdout?: string, stderr?: string }
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

async function callsMade(dir: string): Promise<string[]> {
  try {
    return (await readFile(join(dir, 'calls.log'), 'utf-8')).trim().split('\n')
  } catch {
    return []
  }
}

const advisories = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: { vulnerabilities: { info: 0, low: 2, moderate: 0, high: 6, critical: 0, total: 8 } },
})

const outage = JSON.stringify({
  error: { code: 'E502', summary: 'Bad Gateway', detail: 'request to https://registry.npmjs.org/-/npm/v1/security/audits/quick failed' },
})

describe('scripts/npm-audit.mjs', () => {
  it('passes a clean audit without a second call', async () => {
    const dir = await stage({ human: { out: 'found 0 vulnerabilities\n', code: 0 } })
    try {
      const env = { ...process.env, NPM_FAKE_DIR: dir, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}` }
      const result = await runAudit(env)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(await callsMade(dir)).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports genuine advisories as a code failure', async () => {
    const dir = await stage({
      human: { out: '8 vulnerabilities (2 low, 6 high)\n', code: 1 },
      json: { out: `${advisories}\n`, code: 1 },
    })
    try {
      const env = { ...process.env, NPM_FAKE_DIR: dir, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}` }
      const result = await runAudit(env)
      expect(result.code).toBe(1)
      expect(result.stdout).toContain('8 vulnerabilities')
      expect(result.stderr).toContain('title=npm audit found advisories')
      expect(result.stderr).toContain('6 high')
      expect(result.stderr).not.toContain('service unavailable')
      expect(await callsMade(dir)).toHaveLength(2)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a registry outage as retryable, not as vulnerable code', async () => {
    const dir = await stage({
      human: { out: 'npm error code E502\nnpm error 502 Bad Gateway\n', code: 1 },
      json: { out: `${outage}\n`, code: 1 },
    })
    try {
      const env = { ...process.env, NPM_FAKE_DIR: dir, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}` }
      const result = await runAudit(env)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('title=npm audit service unavailable')
      expect(result.stderr).toContain('E502')
      expect(result.stderr).toContain('Re-run the failed jobs to retry')
      expect(result.stderr).not.toContain('found advisories')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocks on an unparseable report instead of guessing', async () => {
    const dir = await stage({
      human: { out: 'npm error code ENOENT\n', code: 1 },
      json: { out: 'not json\n', code: 1 },
    })
    try {
      const env = { ...process.env, NPM_FAKE_DIR: dir, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}` }
      const result = await runAudit(env)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('title=npm audit inconclusive')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('blocks when npm itself does not run', async () => {
    const dir = await stage({})
    try {
      const empty = join(dir, 'empty')
      await mkdir(empty)
      const env = { ...process.env, PATH: empty }
      const result = await runAudit(env)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('title=npm audit inconclusive')
      expect(result.stderr).toContain('npm did not run')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
