import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Counts the children started on this thread. The process worker loads its own
// node:child_process, so what it starts never reaches this count.
const mainThread = vi.hoisted(() => ({ spawns: 0 }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      mainThread.spawns += 1
      return actual.spawn(...args)
    },
  }
})

// A child the stopped worker can no longer reap stays a zombie until the server
// exits: stopped either way.
function processStopped(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return state === '' || state.startsWith('Z')
  } catch (error: any) {
    if (error?.status === 1) return true
    throw error
  }
}

async function waitFor<T>(read: () => Promise<T | null> | T | null): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting')
}

const readPid = async (path: string): Promise<number | null> => {
  const pid = Number(await readFile(path, 'utf8').catch(() => ''))
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

// Each test starts from a fresh process module, so from a fresh worker.
beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  mainThread.spawns = 0
})

describe('the process worker', () => {
  it('starts runFile children off the main thread', async () => {
    const { processWorkerReady, runFile } = await import('../server/process')
    expect(await processWorkerReady()).toBe(true)

    expect((await runFile(process.execPath, ['-e', 'process.stdout.write("ok")'])).stdout).toBe('ok')
    expect(mainThread.spawns).toBe(0)
  })

  it('rejects a missing executable with the same error in the worker as on the main thread', async () => {
    const { processWorkerReady, runFile, stopProcessWorker } = await import('../server/process')
    expect(await processWorkerReady()).toBe(true)
    const shape = (error: any) => ({ name: error.name, message: error.message, code: error.code, errno: error.errno,
      syscall: error.syscall, path: error.path, spawnargs: error.spawnargs, stdout: error.stdout, stderr: error.stderr })

    const inWorker = await runFile('/nonexistent/poise-cli', ['--probe']).catch((error: unknown) => error)
    expect(mainThread.spawns).toBe(0)
    await stopProcessWorker()
    const onMainThread = await runFile('/nonexistent/poise-cli', ['--probe']).catch((error: unknown) => error)
    expect(mainThread.spawns).toBe(1)

    expect(inWorker).toBeInstanceOf(Error)
    expect(shape(inWorker)).toEqual(shape(onMainThread))
    expect(shape(inWorker)).toMatchObject({ code: 'ENOENT', syscall: 'spawn /nonexistent/poise-cli', path: '/nonexistent/poise-cli', stdout: '', stderr: '' })
  })

  it('stops the children of a worker that stops, reports them interrupted, and starts later calls on the main thread', async () => {
    const { processWorkerReady, runFile, stopProcessWorker } = await import('../server/process')
    expect(await processWorkerReady()).toBe(true)
    const root = await mkdtemp(join(tmpdir(), 'poise-process-worker-'))
    const pidFile = join(root, 'child.pid')
    const running = runFile(process.execPath, [
      '-e', "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1_000)", pidFile,
    ], { timeoutMs: 30_000 })
    try {
      const pid = await waitFor(() => readPid(pidFile))
      await stopProcessWorker()

      await expect(running).rejects.toMatchObject({ message: expect.stringContaining('the process worker stopped'), killed: true, signal: 'SIGKILL' })
      await waitFor(() => processStopped(pid) ? true : null)
      expect(await processWorkerReady()).toBe(false)
      expect((await runFile(process.execPath, ['-e', 'process.stdout.write("still")'])).stdout).toBe('still')
      expect(mainThread.spawns).toBe(1)
    } finally {
      await running.catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('starts children on the main thread when the worker cannot start', async () => {
    vi.doMock('node:worker_threads', async (original) => ({
      ...(await original<typeof import('node:worker_threads')>()),
      Worker: class { constructor() { throw new Error('no worker threads here') } },
    }))
    try {
      const { processWorkerReady, runFile } = await import('../server/process')
      expect(await processWorkerReady()).toBe(false)

      expect((await runFile(process.execPath, ['-e', 'process.stdout.write("fallback")'])).stdout).toBe('fallback')
      expect(mainThread.spawns).toBe(1)
    } finally {
      vi.doUnmock('node:worker_threads')
    }
  })
})
