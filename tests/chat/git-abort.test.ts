// Abort propagation for guarded checkout commands (server/chat/git.ts): an
// aborted signal terminates the worker group and settles only once it is
// verified dead, clearing the lease registration — or keeps it with a
// stuck error when termination cannot be verified.

import { execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CheckoutLease } from '../../server/chat/checkout-lock'
import { GuardedWorkerStuckError, checkpoint, runGuarded } from '../../server/chat/git'
import { isAbortError } from '../../server/process'
import type { SpawnWorkerOptions, WorkerHandle } from '../../server/chat/worker'

vi.mock('../../server/chat/worker', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../server/chat/worker')>()
  return {
    ...original,
    spawnWorker: (command: string, args: readonly string[], options: SpawnWorkerOptions): WorkerHandle => {
      if (command !== '__stuck__') return original.spawnWorker(command, args, options)
      return {
        child: { stdout: null, stderr: null } as unknown as ChildProcess,
        pid: 424242,
        pgid: 424242,
        ident: 'stuck-test-worker',
        command,
        go() {},
        async terminate(): Promise<void> { throw new Error('worker group 424242 (__stuck__) is still alive after SIGKILL') },
        exited: new Promise<never>(() => {}),
        alive: true,
      }
    },
  }
})

const abortStubs = vi.hoisted(() => ({
  abortAtPostCommitRevParse: null as { controller: AbortController, revParses: number } | null,
}))

vi.mock('../../server/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/process')>()
  return {
    ...actual,
    runFile: (command: string, args: readonly string[], options?: import('../../server/process').RunFileOptions) => {
      const gate = abortStubs.abortAtPostCommitRevParse
      if (gate && command === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        gate.revParses += 1
        // checkpoint() reads the head once to inspect, then once to resolve
        // the commit it just made: abort at the second read.
        if (gate.revParses === 2) gate.controller.abort()
      }
      return actual.runFile(command, args, options)
    },
  }
})

vi.setConfig({ testTimeout: 25_000, hookTimeout: 25_000 })

let root = ''
let checkout = ''
const leases: CheckoutLease[] = []

function git(args: string[]): void {
  execFileSync('git', args, { cwd: checkout, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-git-abort-'))
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  checkout = join(root, 'repo')
  await mkdir(checkout)
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 't@example.invalid'])
  git(['config', 'user.name', 't'])
  await writeFile(join(checkout, 'README.md'), '# repo\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
})

afterAll(async () => {
  delete process.env.POISE_LOCK_DIR
  await rm(root, { recursive: true, force: true })
})

afterEach(() => {
  while (leases.length) leases.pop()?.release()
})

function lease(): CheckoutLease {
  const l = new CheckoutLease(checkout, { ownerKind: 'poise:chat', ownerId: 'test', ownerLabel: 'test', instance: 'test' })
  if (!l.tryAcquire().acquired) throw new Error('could not acquire test lease')
  leases.push(l)
  return l
}

async function registeredPgid(l: CheckoutLease): Promise<number> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const pgid = l.read()?.worker_pgid
    if (pgid) return pgid
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('worker never registered')
}

describe('guarded command abort', () => {
  it('terminates the worker group and clears its lease registration', async () => {
    const l = lease()
    const controller = new AbortController()
    const pending = runGuarded(l, 'sleep', ['30'], { cwd: checkout, signal: controller.signal })
    const pgid = await registeredPgid(l)
    controller.abort()
    const failure = await pending.then(() => null, (error: unknown) => error)
    expect(isAbortError(failure)).toBe(true)
    expect(l.read()?.worker_pid).toBeNull()
    expect(() => process.kill(-pgid, 0)).toThrow()
  })

  it('rejects without spawning when already aborted', async () => {
    const l = lease()
    const controller = new AbortController()
    controller.abort()
    await expect(runGuarded(l, 'sleep', ['30'], { cwd: checkout, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(l.read()?.worker_pid).toBeNull()
  })

  it('keeps the lease registration when termination cannot be verified', async () => {
    const l = lease()
    const controller = new AbortController()
    const pending = runGuarded(l, '__stuck__', [], { cwd: checkout, signal: controller.signal })
    expect(await registeredPgid(l)).toBe(424242)
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(GuardedWorkerStuckError)
    expect(l.read()?.worker_pid).toBe(424242)
  })

  it('retains a landed checkpoint when the abort arrives at its post-commit read', async () => {
    const l = lease()
    await writeFile(join(checkout, 'dirty.txt'), 'uncommitted\n')
    const controller = new AbortController()
    abortStubs.abortAtPostCommitRevParse = { controller, revParses: 0 }
    try {
      const result = await checkpoint(l, checkout, 'main', { signal: controller.signal })
      expect(result).toMatchObject({ committed: true })
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
      expect(controller.signal.aborted).toBe(true)
    } finally {
      abortStubs.abortAtPostCommitRevParse = null
    }
    // The checkpoint commit stays reachable; the fixture returns to pristine.
    git(['reset', '--quiet', 'HEAD~1'])
    await rm(join(checkout, 'dirty.txt'))
  })
})
