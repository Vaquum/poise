import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAILED_START_MS, openNamespaceWitness, supervisor, UPDATE_EXIT_CODE } from '../deploy/runtime/supervisor.mjs'
import { gatewayKeys, serviceEnvironment } from './service-fixture'

// The workspace supervisor (deploy/runtime/supervisor.mjs): which release it
// runs, how it switches without stopping the container, and what it does
// when a release fails to start.

class FakeChild extends EventEmitter {
  signals = []
  kill(signal) { this.signals.push(signal) }
  exit(code, signal = null) { this.emit('exit', code, signal) }
}

const IMAGE = { name: 'r1', poise: '/opt/poise', venv: '/opt/caller/venv' }
let home = ''
let clock = 0
let started = []

async function install(name, base) {
  const dir = join(home, '.poise', 'releases', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'base'), `${base}\n`)
  await writeFile(join(dir, 'installed'), '')
}

async function pointer(name, value) {
  await writeFile(join(home, '.poise', 'releases', name), `${value}\n`)
}

function supervise(diagnostic, nativeControlFactory = null) {
  return supervisor({
    home,
    diagnostic,
    nativeControlFactory,
    image: IMAGE,
    base: 'B',
    env: { HOME: home, PATH: `${home}/.local/bin:/opt/caller/venv/bin:/usr/bin:/bin` },
    start: (release, env) => {
      const child = new FakeChild()
      started.push({ release, env, child })
      return child
    },
    now: () => clock,
    log: vi.fn(),
  })
}

async function nth(index) {
  await vi.waitFor(() => expect(started.length).toBeGreaterThan(index))
  return started[index]
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'poise-supervisor-'))
  await mkdir(join(home, '.poise', 'releases'), { recursive: true })
  clock = 1_000_000
  started = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(home, { recursive: true, force: true })
})

describe('native namespace evidence', () => {
  const epoch = { boot: 'unavailable-test-kernel', init_start: '0', namespace_dev: '0', namespace_ino: '1' }
  const owner = { pid: 3, start: '0' }
  const holder = { pid: 4, start: '0' }
  it.each([
    { pid: 0, start: '1', namespace: 'pid:[2]' },
    { pid: '2', start: '1', namespace: 'pid:[2]' },
    { pid: 2, start: 1, namespace: 'pid:[2]' },
    { pid: 2, start: 'unknown', namespace: 'pid:[2]' },
    { pid: 2, start: '1', namespace: '../another-scope' },
    { pid: 2, start: '1', namespace: 'pid:[2]', owner: { pid: 2, start: '1' } },
    { pid: 2, start: '1', namespace: 'pid:[2]', holder: { pid: 4, start: 0 } },
  ])('refuses invalid ownership instead of manufacturing empty evidence: %j', (identity) => {
    expect(() => openNamespaceWitness({ owner, holder, ...identity, epoch })).toThrow('Invalid native namespace identity')
  })

  it('refuses unavailable or mismatched kernel evidence instead of returning an empty namespace', () => {
    expect(() => openNamespaceWitness({ pid: process.pid, start: '0', namespace: 'pid:[1]', epoch, owner, holder })).toThrow()
  })
})

describe('the workspace supervisor', () => {
  it('keeps one native controller through a Poise release switch and closes it only at supervisor exit', async () => {
    const close = vi.fn(async () => {})
    const address = { version: 1, instance: 'a'.repeat(32), path: '/tmp/component/control.sock' }
    const factory = vi.fn(async () => ({ address, close }))
    const instance = supervise(null, factory)
    const running = instance.run()
    const first = await nth(0)
    expect(JSON.parse(first.env.POISE_NATIVE_CONTROL)).toEqual(address)
    first.child.exit(UPDATE_EXIT_CODE)
    const second = await nth(1)
    expect(second.env.POISE_NATIVE_CONTROL).toBe(first.env.POISE_NATIVE_CONTROL)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    instance.stop('SIGTERM')
    second.child.exit(0)
    expect(await running).toBe(0)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('runs the image\'s release, then switches to the one a switch named when Poise exits to switch', async () => {
    const instance = supervise()
    const running = instance.run()
    const first = await nth(0)
    expect(first.release).toBe(IMAGE)
    expect(first.env).toMatchObject({ POISE_RELEASE: 'r1', POISE_BASE: 'B', CALLER_BIN_ROOT: '/opt/caller/venv/bin' })

    await install('r2', 'B')
    await pointer('next', 'r2')
    first.child.exit(UPDATE_EXIT_CODE)
    const second = await nth(1)
    const r2 = join(home, '.poise', 'releases', 'r2')
    expect(second.release).toEqual({ name: 'r2', poise: join(r2, 'poise'), venv: join(r2, 'venv') })
    expect(second.env.PATH).toBe(`${home}/.local/bin:${r2}/venv/bin:/usr/bin:/bin`)
    expect(second.env).toMatchObject({
      POISE_RELEASE: 'r2', CALLER_BIN_ROOT: join(r2, 'venv', 'bin'), AGENT_INTERFACE_ROOT: join(r2, 'poise', 'caller', 'agent_interface'),
    })
    expect((await readFile(join(home, '.poise', 'releases', 'current'), 'utf8')).trim()).toBe('r2')
    expect(existsSync(join(home, '.poise', 'releases', 'next'))).toBe(false)

    // The container stops: the signal reaches Poise, and nothing starts again.
    instance.stop('SIGTERM')
    expect(second.child.signals).toEqual(['SIGTERM'])
    second.child.exit(0)
    expect(await running).toBe(0)
    expect(started).toHaveLength(2)
  })

  it('starts the current release after a restart of the container', async () => {
    await install('r2', 'B')
    await pointer('current', 'r2')
    const instance = supervise()
    const running = instance.run()
    expect((await nth(0)).release.name).toBe('r2')
    instance.stop('SIGTERM')
    started[0].child.exit(0)
    await running
  })

  it('dates the release it switches away from to that moment, so pruning keeps it for the agents it launched', async () => {
    await install('r2', 'B')
    await install('r3', 'B')
    await pointer('current', 'r2')
    // Installed long ago, and current until now.
    await utimes(join(home, '.poise', 'releases', 'r2'), 1_000, 1_000)
    const instance = supervise()
    const running = instance.run()
    const first = await nth(0)
    expect(first.release.name).toBe('r2')
    await pointer('next', 'r3')
    clock = 1_800_000_000_000
    first.child.exit(UPDATE_EXIT_CODE)
    expect((await nth(1)).release.name).toBe('r3')
    expect((await stat(join(home, '.poise', 'releases', 'r2'))).mtimeMs).toBe(clock)
    instance.stop('SIGTERM')
    started[1].child.exit(0)
    await running
  })

  it('does not switch to a release of another base, or one never installed', async () => {
    await install('r3', 'other')
    const instance = supervise()
    const running = instance.run()
    await pointer('next', 'r3')
    ;(await nth(0)).child.exit(UPDATE_EXIT_CODE)
    expect((await nth(1)).release).toBe(IMAGE)
    await pointer('next', 'r9')
    started[1].child.exit(UPDATE_EXIT_CODE)
    expect((await nth(2)).release).toBe(IMAGE)
    instance.stop('SIGTERM')
    started[2].child.exit(0)
    await running
  })

  it('goes back to the image\'s release when a new one fails right after starting, and never runs it again', async () => {
    await install('r2', 'B')
    await pointer('current', 'r2')
    const instance = supervise()
    const running = instance.run()
    clock += FAILED_START_MS - 1
    ;(await nth(0)).child.exit(1)
    expect((await nth(1)).release).toBe(IMAGE)
    expect(existsSync(join(home, '.poise', 'releases', 'r2', 'failed'))).toBe(true)
    expect(existsSync(join(home, '.poise', 'releases', 'current'))).toBe(false)
    await pointer('next', 'r2')
    clock += FAILED_START_MS
    started[1].child.exit(UPDATE_EXIT_CODE)
    expect((await nth(2)).release).toBe(IMAGE)
    instance.stop('SIGTERM')
    started[2].child.exit(0)
    await running
  })

  it('exits with Poise\'s code when the image\'s release stops on its own', async () => {
    const instance = supervise()
    const running = instance.run()
    clock += 5 * FAILED_START_MS
    ;(await nth(0)).child.exit(3)
    expect(await running).toBe(3)
  })
})

it('records native supervisor failure facts and omits planned switches and shutdown', async () => {
  const records = []; const instance = supervise((input) => records.push(input)); const running = instance.run()
  const first = await nth(0)
  first.child.exit(UPDATE_EXIT_CODE)
  const second = await nth(1)
  expect(records).toHaveLength(0)
  clock += 2500
  second.child.exit(9)
  expect(await running).toBe(9)
  expect(records).toEqual([expect.objectContaining({ level: 'error', operation: 'workspace.exit', release: 'r1', exitCode: 9,
    context: expect.objectContaining({ elapsedMs: 2500, executable: process.execPath, cwd: '/opt/poise' }) })])
  const stopping = supervise((input) => records.push(input)); const stopped = stopping.run()
  const third = await nth(2); stopping.stop('SIGTERM'); third.child.exit(0)
  await stopped; expect(records).toHaveLength(1)
})

it('retains actual spawn errors without letting a diagnostic reporter change supervision', async () => {
  const fallback = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const records = []; const instance = supervise((input) => { records.push(input); throw new Error('fixture reporter offline') })
  const running = instance.run(); const child = (await nth(0)).child
  child.emit('error', Object.assign(new Error('precise launch cause'), { code: 'EACCES', errno: -13 }))
  expect(await running).toBe(1)
  expect(records[0]).toMatchObject({ level: 'error', operation: 'workspace.spawn', errno: -13, message: 'precise launch cause', context: { processErrorCode: 'EACCES' } })
  expect(fallback).toHaveBeenCalledWith('poise-runtime: diagnostic reporting unavailable: Error')
  expect(fallback.mock.calls.flat().join(' ')).not.toContain('fixture reporter offline')
  fallback.mockRestore()
})

it('records a release fallback without changing the selected release or failed marker', async () => {
  await install('r2', 'B'); await pointer('current', 'r2')
  const records = []; const instance = supervise((input) => records.push(input)); const running = instance.run()
  const child = (await nth(0)).child; clock += 2000; child.exit(1)
  expect((await nth(1)).release).toBe(IMAGE)
  expect(records.find((input) => input.operation === 'workspace.release_fallback')).toMatchObject({ level: 'warning', release: 'r2', exitCode: 1,
    context: { elapsedMs: 2000, startupWindowMs: FAILED_START_MS, fallbackRelease: 'r1' } })
  instance.stop('SIGTERM'); started[1].child.exit(0); await running
})

it('serves the installed build before the 600-second verifier deadline during an active monitor sweep', async () => {
  const root = await mkdtemp(join(tmpdir(), 'poise-release-handover-'))
  const home = join(root, 'home')
  const releases = join(home, '.poise', 'releases')
  const previous = '0'.repeat(40), target = '1'.repeat(40)
  const children = []
  let logs = ''
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('fixture needs a TCP port')
  const port = address.port
  await new Promise(resolve => reservation.close(() => resolve()))
  for (const release of [previous, target]) {
    const poise = join(releases, release, 'poise')
    await mkdir(poise, { recursive: true })
    await symlink(resolve('node_modules'), join(poise, 'node_modules'), 'dir')
    await writeFile(join(releases, release, 'base'), 'handover-base')
    await writeFile(join(releases, release, 'installed'), '')
    await build({ entryPoints: ['tests/fixtures/service-release-handover.ts'], bundle: true,
      platform: 'node', format: 'esm', packages: 'external', outfile: join(poise, 'server.mjs'),
      define: { __POISE_BUILD_SHA__: JSON.stringify(release) }, logLevel: 'silent' })
  }
  const instance = supervisor({ home, base: 'handover-base', nativeControlFactory: null,
    image: { name: previous, poise: join(releases, previous, 'poise'), venv: join(root, 'venv') },
    env: { ...process.env, ...serviceEnvironment(gatewayKeys()), HOME: home, POISE_PORT: String(port),
      POISE_DB: join(home, 'cache.db'), POISE_LOCK_DIR: join(home, 'locks'),
      AGENT_INTERFACE_DATA_DIR: join(home, 'caller') },
    start: (release, env) => {
      const child = spawn(process.execPath, [join(release.poise, 'server.mjs')], { cwd: release.poise, env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout?.on('data', chunk => { logs += chunk })
      child.stderr?.on('data', chunk => { logs += chunk })
      children.push(child)
      return child
    }, log: () => {},
  })
  const running = instance.run()
  const origin = `http://127.0.0.1:${port}`
  const get = async (path) => (await fetch(`${origin}${path}`)).json()
  const waitFor = async (check) => {
    const deadline = Date.now() + 20_000
    for (;;) {
      let ready = false
      try { ready = await check() } catch (error) {
        if (!(error instanceof TypeError)) throw error // A restarting HTTP listener is temporarily unreachable.
      }
      if (ready) return
      if (Date.now() > deadline) throw new Error(`release handover did not settle: ${logs}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  try {
    await waitFor(async () => (await get('/evidence')).reading === true)
    const bindings = (await get('/evidence')).bindings
    const requestedAt = Date.now()
    const switched = await fetch(`${origin}/api/service/switch`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ release: target }) })
    expect(switched.status).toBe(202)
    // New control ticks remain due while the first admitted unit is held.
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(await get('/api/service/health')).toMatchObject({ release: previous, version: previous,
      switching: target, activeChatTurns: 0, switchWaitingOn: '1 background operation' })
    expect(children).toHaveLength(1)
    await get('/finish-read')
    await waitFor(async () => {
      const health = await get('/api/service/health')
      return health.release === target && health.version === target && health.switching === null
    })
    expect(Date.now() - requestedAt).toBeLessThan(600_000)
    expect(children).toHaveLength(2)
    await waitFor(async () => (await get('/evidence')).observations.every((row) => row !== null))
    const evidence = await get('/evidence')
    expect(evidence.bindings).toEqual(bindings)
    expect(evidence.observations[0].fingerprint).toBeTruthy()
    // The original observation survived, so adoption never re-reads that unit.
    expect((await readFile(join(home, 'reads'), 'utf8')).trim().split('\n')).toEqual(['1', '2', '3'])
  } finally {
    instance.stop('SIGTERM')
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(async child => {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }))
    await running
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
