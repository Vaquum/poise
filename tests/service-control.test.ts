import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatRuntime } from '../server/chat/runtime'
import type { SessionRecord } from '../server/chat/protocol'
import type { RequestAuthority } from '../server/http'

let root = ''
let control: typeof import('../server/service/control')
let storage: typeof import('../server/chat/storage')
let background: typeof import('../server/release-background')
let callerCalls: typeof import('../server/service/caller-calls')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-service-control-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.resetModules()
  storage = await import('../server/chat/storage')
  control = await import('../server/service/control')
  background = await import('../server/release-background')
  callerCalls = await import('../server/service/caller-calls')
})

afterAll(async () => {
  background.resumeReleaseBackground()
  ;(await import('../server/db')).closeDatabase()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

function session(instance: string, openTurn: boolean): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  storage.insertSession({
    id, agent: 'grok', repo: '', checkout: '/workspace', branch: { name: 'chat/x', origin: 'new', provisional: true },
    status: openTurn ? 'running' : 'idle', title: '', instance, createdAt: now, updatedAt: now,
  } as unknown as SessionRecord)
  if (openTurn) storage.setOpenTurn(id, randomUUID(), null)
  return id
}

function fakeRuntime(instance = `poise-production:${randomUUID()}`) {
  return { instance, busyNow: 0, busy() { return this.busyNow }, startDrain: vi.fn(), endDrain: vi.fn() }
}

class FakeTimer {
  timers = new Map<number, { delayMs: number, callback: () => void }>()
  private ids = 0
  setTimeout(callback: () => void, delayMs: number): number {
    this.timers.set(++this.ids, { delayMs, callback })
    return this.ids
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number) }
  fire(): void {
    const [id, timer] = [...this.timers.entries()][0]
    this.timers.delete(id)
    timer.callback()
  }
}

function serviceOf(runtime = fakeRuntime(), timer = new FakeTimer(), log = vi.fn()) {
  return { runtime, timer, log, service: new control.ServiceControl(runtime as unknown as ChatRuntime, { drainTimeoutSeconds: 1800, timer, log }) }
}

function response() {
  const res = { statusCode: 0, body: '', headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { res.headers[name] = value },
    end(body: string) { res.body = body } }
  return res
}

function call(method: string, path: string, authority: RequestAuthority, service: InstanceType<typeof control.ServiceControl>) {
  const res = response()
  const req = Object.assign(Readable.from([]), { method, headers: {} }) as unknown as IncomingMessage
  control.handleServiceApi(req, res as unknown as ServerResponse, path, authority, service)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, allow: res.headers.Allow }
}

describe('service health', () => {
  it('counts this workspace\'s open Chat turns and Caller calls', async () => {
    const runtime = fakeRuntime()
    session(runtime.instance, true)
    session(runtime.instance, false)
    session('poise-dev:another-database', true)
    const { service } = serviceOf(runtime)
    expect(service.health()).toEqual({ ok: true, mode: 'service', version: null, activeChatTurns: 1, runningCallerCalls: 0, backgroundWork: 0, idle: false, draining: false })

    let finish!: () => void
    const debate = callerCalls.countDebate(() => new Promise<void>((resolve) => { finish = resolve }))
    expect(service.health().runningCallerCalls).toBe(1)
    finish()
    await debate
    expect(service.health().runningCallerCalls).toBe(0)
    await expect(callerCalls.countDebate(async () => { throw new Error('debate failed') })).rejects.toThrow('debate failed')
    expect(service.health().runningCallerCalls).toBe(0)
  })

  it('counts every other piece of work a restart would cut, and is idle only when all are done', () => {
    const { runtime, service } = serviceOf()
    expect(service.health()).toMatchObject({ backgroundWork: 0, idle: true })
    runtime.busyNow = 2
    expect(service.health()).toMatchObject({ backgroundWork: 2, idle: false })
    runtime.busyNow = 0
    const tick = background.trackReleaseBackground()
    expect(service.health()).toMatchObject({ backgroundWork: 1, idle: false })
    tick()
    const launch = service.admitLaunch('POST', '/api/pr-review')
    if (typeof launch !== 'function') throw new Error('the launch was not admitted')
    expect(service.health()).toMatchObject({ backgroundWork: 1, idle: false })
    launch()
    launch()
    expect(service.health()).toMatchObject({ backgroundWork: 0, idle: true })
  })
})

describe('service drain', () => {
  it('drains with the release drain and lifts it again', () => {
    const { runtime, service } = serviceOf()
    expect(service.drain()).toMatchObject({ draining: true })
    expect(runtime.startDrain).toHaveBeenCalledWith('service')
    expect(background.releaseBackgroundPaused()).toBe(true)
    expect(service.resume()).toMatchObject({ draining: false })
    expect(runtime.endDrain).toHaveBeenCalledTimes(1)
    expect(background.releaseBackgroundPaused()).toBe(false)
  })

  it('refuses browser launches while draining and counts an admitted one until it is released', () => {
    const { service } = serviceOf()
    const launches = ['/api/pr-review', '/api/agent-replay', '/api/chat-content', '/api/debate', '/api/chat', '/api/models/refresh']
    const admitted = launches.map((path) => service.admitLaunch('POST', path))
    expect(admitted.every((launch) => typeof launch === 'function')).toBe(true)
    // A launch that passed the gate before the drain still counts after it.
    const health = service.drain()
    expect(health).toMatchObject({ backgroundWork: launches.length, idle: false, draining: true })
    for (const path of launches) expect(service.admitLaunch('POST', path), path).toBe('draining')
    for (const [method, path] of [['GET', '/api/chat'], ['POST', '/api/settings'], ['POST', '/api/agent-stop'], ['POST', '/api/chat-attachment'], ['PUT', '/api/editor/doc/x']]) {
      expect(service.admitLaunch(method, path), `${method} ${path}`).toBeNull()
    }
    for (const release of admitted) (release as () => void)()
    expect(service.health()).toMatchObject({ backgroundWork: 0, idle: true, draining: true })
    service.resume()
    expect(typeof service.admitLaunch('POST', '/api/pr-review')).toBe('function')
  })

  it('lapses POISE_DRAIN_TIMEOUT plus five minutes after the last drain call', () => {
    const { runtime, timer, log, service } = serviceOf()
    service.drain()
    expect([...timer.timers.values()].map((entry) => entry.delayMs)).toEqual([(1800 + 300) * 1000])
    // The gateway renews the drain by calling it again while it waits.
    service.drain()
    expect(timer.timers.size).toBe(1)
    timer.fire()
    expect(service.draining).toBe(false)
    expect(runtime.endDrain).toHaveBeenCalledTimes(1)
    expect(background.releaseBackgroundPaused()).toBe(false)
    expect(log).toHaveBeenCalledWith('[service] the drain lapsed: no drain call renewed it within 2100 s, so new work is admitted again')
  })

  it('stops the lapse when the drain is lifted or the runtime stops', () => {
    const { timer, service } = serviceOf()
    service.drain()
    service.resume()
    expect(timer.timers.size).toBe(0)
    service.drain()
    service.reset()
    expect(timer.timers.size).toBe(0)
    expect(service.draining).toBe(false)
    expect(background.releaseBackgroundPaused()).toBe(false)
  })
})

describe('service endpoints', () => {
  it('answer loopback and the gateway\'s admin scope', () => {
    const { service } = serviceOf()
    expect(call('GET', '/api/service/health', { kind: 'local' }, service)).toMatchObject({ status: 200, body: { ok: true, mode: 'service', draining: false } })
    expect(call('POST', '/api/service/drain', { kind: 'gateway', scope: 'admin' }, service)).toMatchObject({ status: 200, body: { draining: true } })
    expect(call('GET', '/api/service/health', { kind: 'gateway', scope: 'admin' }, service)).toMatchObject({ status: 200, body: { draining: true } })
    expect(call('POST', '/api/service/resume', { kind: 'local' }, service)).toMatchObject({ status: 200, body: { draining: false } })
  })

  it('let the owner\'s browser lift a drain, and nothing more', () => {
    const { service } = serviceOf()
    service.drain()
    expect(call('POST', '/api/service/resume', { kind: 'gateway', scope: 'browser' }, service)).toMatchObject({ status: 200, body: { draining: false } })
    for (const [method, path] of [['GET', '/api/service/health'], ['POST', '/api/service/drain'], ['GET', '/api/service/unknown']]) {
      expect(() => call(method, path, { kind: 'gateway', scope: 'browser' }, service), path).toThrow(expect.objectContaining({ statusCode: 403 }))
    }
    for (const path of ['/api/service/health', '/api/service/drain', '/api/service/resume']) {
      expect(() => call('POST', path, { kind: 'gateway', scope: 'link' }, service), path).toThrow(expect.objectContaining({ statusCode: 403 }))
    }
  })

  it('name the method a route takes and refuse unknown routes', () => {
    const { service } = serviceOf()
    expect(call('POST', '/api/service/health', { kind: 'local' }, service)).toMatchObject({ status: 405, allow: 'GET' })
    expect(call('GET', '/api/service/drain', { kind: 'local' }, service)).toMatchObject({ status: 405, allow: 'POST' })
    expect(call('GET', '/api/service/resume', { kind: 'local' }, service)).toMatchObject({ status: 405, allow: 'POST' })
    expect(call('GET', '/api/service/unknown', { kind: 'local' }, service)).toMatchObject({ status: 404 })
  })
})
