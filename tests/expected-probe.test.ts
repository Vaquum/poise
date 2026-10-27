// Expected probes miss without logging errors; real failures still do.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { branchExists, defaultBranch } from '../server/chat/git'
import { loggingRuntime, startLogging, stopLogging } from '../server/logging'
import { isExpectedFailure, runFile } from '../server/process'
import { resolveReviewCheckout } from '../server/review-checkout'

let directory = ''
afterEach(async () => {
  await stopLogging()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

function start(): string {
  directory = mkdtempSync(join(tmpdir(), 'poise-expected-probe-'))
  vi.stubEnv('POISE_DB', join(directory, 'cache.db'))
  vi.stubEnv('POISE_WORKSPACE_HANDLE', 'alice')
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  startLogging()
  return directory
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function initRepo(root: string): string {
  const checkout = mkdtempSync(join(root, 'repo-'))
  git(checkout, 'init', '--quiet', '--initial-branch=main')
  git(checkout, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '--allow-empty', '-m', 'init')
  return checkout
}

function events() {
  loggingRuntime()!.flush()
  return loggingRuntime()!.query((db) => db.query({ workspace: 'alice', operator: false })).events
}

describe('expected probe misses', () => {
  it('logs no error for a missing origin/HEAD and falls back to the local default', async () => {
    const root = start()
    const checkout = initRepo(root)
    await expect(defaultBranch(checkout)).resolves.toBe('main')
    const seen = events().filter((event) => event.operation === 'git')
    expect(seen).toHaveLength(0)
    expect(JSON.stringify(events())).not.toContain('symbolic ref')
  })

  it('marks the miss expected on the rejection itself', async () => {
    const root = start()
    const checkout = initRepo(root)
    const failure = await runFile('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: checkout, expected: { codes: [128], stderr: /is not a symbolic ref/ } }).then(
        () => null,
        (error: unknown) => error,
      )
    expect(failure).toMatchObject({ code: 128 })
    expect(isExpectedFailure(failure)).toBe(true)
    expect(events().filter((event) => event.operation === 'git')).toHaveLength(0)
  })

  it('logs no error for a missing branch probe', async () => {
    const root = start()
    const checkout = initRepo(root)
    await expect(branchExists(checkout, 'no-such-branch')).resolves.toBe(false)
    expect(events().filter((event) => event.operation === 'git')).toHaveLength(0)
  })

  it('still logs the same exit code with unexpected stderr', async () => {
    const root = start()
    const plain = mkdtempSync(join(root, 'plain-'))
    const failure = await runFile('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { cwd: plain, expected: { codes: [128], stderr: /is not a symbolic ref/ } }).then(
        () => null,
        (error: unknown) => error,
      )
    expect(failure).toMatchObject({ code: 128 })
    expect(isExpectedFailure(failure)).toBe(false)
    const seen = events().filter((event) => event.operation === 'git')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ exitCode: 128 })
    expect(seen[0].stderr).toContain('not a git repository')
  })

  it('logs a real provisioning failure but not the checkout probe miss before it', async () => {
    if (process.platform === 'win32') return
    const root = start()
    const bin = mkdtempSync(join(root, 'caller-bin-'))
    writeFileSync(join(bin, 'github-interface'), [
      '#!/bin/sh',
      'if [ "$1" = "--local-checkout-path" ]; then',
      '  echo "error: checkout not found under /fake/dev: $2/$3" >&2',
      '  exit 1',
      'fi',
      'echo "error: reviewer cannot read repository" >&2',
      'exit 1',
      '',
    ].join('\n'))
    chmodSync(join(bin, 'github-interface'), 0o700)
    vi.stubEnv('CALLER_BIN_ROOT', bin)
    await expect(resolveReviewCheckout('octocat', 'hello', 1, 'reviewer', 'a'.repeat(40)))
      .rejects.toThrow('Command failed')
    const seen = events().filter((event) => event.operation === 'github-interface')
    expect(seen).toHaveLength(1)
    expect(seen[0].stderr).toContain('reviewer cannot read repository')
    expect(JSON.stringify(events())).not.toContain('checkout not found')
  })
})
