import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAILED_START_MS, supervisor, UPDATE_EXIT_CODE } from '../deploy/runtime/supervisor.mjs'

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

function supervise(diagnostic) {
  return supervisor({
    home,
    diagnostic,
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

describe('the workspace supervisor', () => {
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
