import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ChatRuntime } from '../server/chat/runtime'
import type { SessionRecord } from '../server/chat/protocol'

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

function fakeRuntime(instance: string) {
  return { instance, startDrain: vi.fn(), endDrain: vi.fn() }
}

function response() {
  const res = { statusCode: 0, body: '', headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { res.headers[name] = value },
    end(body: string) { res.body = body } }
  return res
}

function call(method: string, path: string, authority: import('../server/http').RequestAuthority, service: InstanceType<typeof control.ServiceControl>) {
  const res = response()
  const req = Object.assign(Readable.from([]), { method, headers: {} }) as unknown as IncomingMessage
  control.handleServiceApi(req, res as unknown as ServerResponse, path, authority, service)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, allow: res.headers.Allow }
}

describe('service health and drain', () => {
  it('counts this workspace\'s open Chat turns and Caller calls', async () => {
    const instance = `poise-production:${randomUUID()}`
    session(instance, true)
    session(instance, false)
    session('poise-dev:another-database', true)
    const service = new control.ServiceControl(fakeRuntime(instance) as unknown as ChatRuntime)
    expect(service.health()).toEqual({ ok: true, mode: 'service', version: null, activeChatTurns: 1, runningCallerCalls: 0, draining: false })

    let finish!: () => void
    const debate = callerCalls.countDebate(() => new Promise<void>((resolve) => { finish = resolve }))
    expect(service.health().runningCallerCalls).toBe(1)
    finish()
    await debate
    expect(service.health().runningCallerCalls).toBe(0)
    const failing = callerCalls.countDebate(async () => { throw new Error('debate failed') })
    await expect(failing).rejects.toThrow('debate failed')
    expect(service.health().runningCallerCalls).toBe(0)
  })

  it('drains with the release drain and lifts it again', () => {
    const runtime = fakeRuntime(`poise-production:${randomUUID()}`)
    const service = new control.ServiceControl(runtime as unknown as ChatRuntime)
    expect(service.refusesLaunch('POST', '/api/pr-review')).toBe(false)
    expect(service.drain()).toMatchObject({ draining: true })
    expect(runtime.startDrain).toHaveBeenCalledWith('service')
    expect(background.releaseBackgroundPaused()).toBe(true)
    for (const path of ['/api/pr-review', '/api/agent-replay', '/api/chat-content', '/api/debate', '/api/chat']) {
      expect(service.refusesLaunch('POST', path), path).toBe(true)
    }
    for (const [method, path] of [['GET', '/api/chat'], ['POST', '/api/settings'], ['POST', '/api/agent-stop'], ['POST', '/api/chat-attachment'], ['PUT', '/api/editor/doc/x']]) {
      expect(service.refusesLaunch(method, path), `${method} ${path}`).toBe(false)
    }
    expect(service.resume()).toMatchObject({ draining: false })
    expect(runtime.endDrain).toHaveBeenCalledTimes(1)
    expect(background.releaseBackgroundPaused()).toBe(false)
    expect(service.refusesLaunch('POST', '/api/pr-review')).toBe(false)
  })

  it('never leaves the background paused after the runtime stops', () => {
    const runtime = fakeRuntime(`poise-production:${randomUUID()}`)
    const service = new control.ServiceControl(runtime as unknown as ChatRuntime)
    service.reset()
    expect(runtime.endDrain).not.toHaveBeenCalled()
    service.drain()
    service.reset()
    expect(runtime.endDrain).toHaveBeenCalledTimes(1)
    expect(background.releaseBackgroundPaused()).toBe(false)
    expect(service.draining).toBe(false)
  })
})

describe('service endpoints', () => {
  const service = () => new control.ServiceControl(fakeRuntime(`poise-production:${randomUUID()}`) as unknown as ChatRuntime)

  it('answer loopback and the gateway\'s admin scope', () => {
    const local = service()
    expect(call('GET', '/api/service/health', { kind: 'local' }, local)).toMatchObject({ status: 200, body: { ok: true, mode: 'service', draining: false } })
    expect(call('POST', '/api/service/drain', { kind: 'gateway', scope: 'admin' }, local)).toMatchObject({ status: 200, body: { draining: true } })
    expect(call('GET', '/api/service/health', { kind: 'gateway', scope: 'admin' }, local)).toMatchObject({ status: 200, body: { draining: true } })
    expect(call('POST', '/api/service/resume', { kind: 'local' }, local)).toMatchObject({ status: 200, body: { draining: false } })
  })

  it('refuse a browser or Poise Link assertion', () => {
    for (const scope of ['browser', 'link'] as const) {
      expect(() => call('GET', '/api/service/health', { kind: 'gateway', scope }, service())).toThrow(expect.objectContaining({ statusCode: 403 }))
      expect(() => call('POST', '/api/service/drain', { kind: 'gateway', scope }, service())).toThrow(expect.objectContaining({ statusCode: 403 }))
    }
  })

  it('name the method a route takes and refuse unknown routes', () => {
    expect(call('POST', '/api/service/health', { kind: 'local' }, service())).toMatchObject({ status: 405, allow: 'GET' })
    expect(call('GET', '/api/service/drain', { kind: 'local' }, service())).toMatchObject({ status: 405, allow: 'POST' })
    expect(call('GET', '/api/service/resume', { kind: 'local' }, service())).toMatchObject({ status: 405, allow: 'POST' })
    expect(call('GET', '/api/service/unknown', { kind: 'local' }, service())).toMatchObject({ status: 404 })
  })
})
