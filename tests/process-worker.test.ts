import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

  it('rejects a child spawn cannot start, in the worker as on the main thread', async () => {
    const { processWorkerReady, runFile, stopProcessWorker } = await import('../server/process')
    expect(await processWorkerReady()).toBe(true)
    const invalid = { cwd: 123 as unknown as string }

    const inWorker = await runFile(process.execPath, ['-e', ''], invalid).catch((error: unknown) => error)
    expect(mainThread.spawns).toBe(0)
    await stopProcessWorker()
    const onMainThread = await runFile(process.execPath, ['-e', ''], invalid).catch((error: unknown) => error)
    expect(mainThread.spawns).toBe(1)

    for (const error of [inWorker, onMainThread]) {
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ code: 'ERR_INVALID_ARG_TYPE', stdout: '', stderr: '' })
    }
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

  it('stops the child of an abort at once, even when this thread exits before the worker reads the abort', async () => {
    // A teardown can abort and exit in one turn of the main thread, as an
    // in-thread abort always could: the abort itself must stop the child.
    const root = await mkdtemp(join(tmpdir(), 'poise-process-worker-'))
    const pidFile = join(root, 'child.pid')
    try {
      const { build } = await import('esbuild')
      const bundle = async (entry: string, outfile: string) => {
        await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
      }
      await bundle(fileURLToPath(new URL('../server/process-worker.ts', import.meta.url)), join(root, 'process-worker.js'))
      await writeFile(join(root, 'scenario.ts'), [
        "import { existsSync, readFileSync } from 'node:fs'",
        `import { processWorkerReady, runFile } from ${JSON.stringify(fileURLToPath(new URL('../server/process.ts', import.meta.url)))}`,
        'const pidFile = process.argv[2]',
        'if (!await processWorkerReady()) process.exit(2)',
        'const controller = new AbortController()',
        "runFile(process.execPath, ['-e', \"require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1_000)\", pidFile],",
        '  { signal: controller.signal, timeoutMs: 60_000 }).catch(() => undefined)',
        // No turn of this thread until the child runs, so no message from the worker can arrive first.
        'const deadline = Date.now() + 10_000',
        "while (!(existsSync(pidFile) && readFileSync(pidFile, 'utf8'))) if (Date.now() > deadline) process.exit(3)",
        'controller.abort()',
        "process.kill(process.pid, 'SIGKILL')",
      ].join('\n'))
      await bundle(join(root, 'scenario.ts'), join(root, 'scenario.mjs'))

      const scenario = spawnSync(process.execPath, [join(root, 'scenario.mjs'), pidFile], { encoding: 'utf8', timeout: 30_000 })
      expect({ status: scenario.status, signal: scenario.signal, stderr: scenario.stderr }).toMatchObject({ signal: 'SIGKILL' })
      const pid = await waitFor(() => readPid(pidFile))
      await waitFor(() => processStopped(pid) ? true : null)
    } finally {
      const pid = await readPid(pidFile)
      if (pid) try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
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

// The slot an abort and the worker share, one side at a time: the worker's
// spawn() cannot be paused mid-call, so each interleaving is set up directly.
describe('the call slot', () => {
  const sleeper = { args: ['-e', 'setInterval(() => {}, 1_000)'], env: process.env, maxBuffer: 1024, timeoutMs: 30_000, killSignal: 'SIGKILL' as const }

  it('keeps a call the worker has not started from ever starting', async () => {
    const { abortWorkerCall, createCallSlot, startWorkerCall } = await import('../server/process-child')
    const slot = createCallSlot()
    abortWorkerCall(slot, 'SIGKILL', 30_000)
    expect(startWorkerCall({ file: process.execPath, ...sleeper }, slot)).toBeNull()
    expect(mainThread.spawns).toBe(0)
  })

  it('waits for a spawn() under way only as long as its bound, then leaves the stop to the worker', async () => {
    const { CALL_ABORT, CALL_STARTING, CALL_STATE, abortWorkerCall, createCallSlot } = await import('../server/process-child')
    const slot = createCallSlot()
    Atomics.store(slot, CALL_STATE, CALL_STARTING)
    const started = performance.now()
    abortWorkerCall(slot, 'SIGKILL', 100)
    const waited = performance.now() - started
    expect(waited).toBeGreaterThanOrEqual(90)
    expect(waited).toBeLessThan(2_000)
    expect(Atomics.load(slot, CALL_ABORT)).toBe(1)
  })

  it('stops the child the moment spawn() returns when an abort came while it ran', async () => {
    const { CALL_ABORT, CALL_PID, CALL_STARTED, CALL_STATE, createCallSlot, startWorkerCall } = await import('../server/process-child')
    const slot = createCallSlot()
    // The abort's flag landed before the worker's claim, or its wait expired:
    // either way the worker finds it as soon as spawn() returns.
    Atomics.store(slot, CALL_ABORT, 1)
    const child = startWorkerCall({ file: process.execPath, ...sleeper }, slot)
    expect(child?.pid).toBeGreaterThan(0)
    expect(Atomics.load(slot, CALL_STATE)).toBe(CALL_STARTED)
    expect(Atomics.load(slot, CALL_PID)).toBe(child!.pid)
    expect((await child!.outcome).termination).toEqual({ kind: 'abort' })
    await waitFor(() => processStopped(child!.pid!) ? true : null)
  })
})
