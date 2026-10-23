import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
  return {
    instance, busyNow: 0, workingNow: 0, heldNow: new Set<string>(),
    busy() { return this.busyNow }, working() { return this.workingNow },
    relayHeldSessions() { return this.heldNow },
    startDrain: vi.fn(), endDrain: vi.fn(), stopTurnsForDrain: vi.fn(async () => 0),
  }
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
  fireDelay(delayMs: number): void {
    const entry = [...this.timers.entries()].find(([_, timer]) => timer.delayMs === delayMs)
    if (!entry) throw new Error(`no timer with delay ${delayMs}`)
    this.timers.delete(entry[0])
    entry[1].callback()
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
    expect(service.health()).toEqual({ ok: true, mode: 'service', version: null, activeChatTurns: 1, runningCallerCalls: 0, backgroundWork: 0, idle: false, draining: false, release: null, switching: null, desiredRelease: null, installedRelease: null, pendingSince: null })

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

  it('is never idle while Caller\'s records cannot be read, since an earlier server\'s calls may still run', async () => {
    const { service } = serviceOf()
    const records = join(root, 'caller-records')
    await mkdir(records, { recursive: true })
    await writeFile(join(records, 'calls.sqlite3'), 'not a database')
    vi.stubEnv('AGENT_INTERFACE_DATA_DIR', records)
    try {
      expect(service.health()).toMatchObject({ runningCallerCalls: 0, idle: false })
    } finally {
      vi.stubEnv('AGENT_INTERFACE_DATA_DIR', '')
    }
    expect(service.health()).toMatchObject({ idle: true })
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
    const launches = ['/api/pr-review', '/api/agent-replay', '/api/chat-content', '/api/debate', '/api/models/refresh']
    const admitted = launches.map((path) => service.admitLaunch('POST', path))
    expect(admitted.every((launch) => typeof launch === 'function')).toBe(true)
    // A launch that passed the gate before the drain still counts after it.
    const health = service.drain()
    expect(health).toMatchObject({ backgroundWork: launches.length, idle: false, draining: true })
    for (const path of launches) expect(service.admitLaunch('POST', path), path).toBe('draining')
    for (const [method, path] of [['GET', '/api/chat'], ['POST', '/api/chat'], ['POST', '/api/settings'], ['POST', '/api/agent-stop'], ['POST', '/api/chat-attachment'], ['PUT', '/api/editor/doc/x']]) {
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
    expect([...timer.timers.values()].map((entry) => entry.delayMs)).toEqual([(1800 + 300) * 1000, control.DRAIN_TURN_DEADLINE_MS])
    // The gateway renews the drain by calling it again while it waits.
    service.drain()
    expect(timer.timers.size).toBe(2)
    timer.fireDelay((1800 + 300) * 1000)
    expect(service.draining).toBe(false)
    expect(runtime.endDrain).toHaveBeenCalledTimes(1)
    expect(background.releaseBackgroundPaused()).toBe(false)
    expect(log).toHaveBeenCalledWith('[service] the drain lapsed: no drain call renewed it within 2100 s, so new work is admitted again')
  })

  it('stops Chat turns that hold the drain past the turn deadline, once per drain', () => {
    const { runtime, timer, log, service } = serviceOf()
    service.drain()
    // The gateway's renewals renew the lapse, never the turn deadline.
    service.drain()
    service.drain()
    expect([...timer.timers.values()].filter((entry) => entry.delayMs === control.DRAIN_TURN_DEADLINE_MS)).toHaveLength(1)
    timer.fireDelay(control.DRAIN_TURN_DEADLINE_MS)
    expect(runtime.stopTurnsForDrain).toHaveBeenCalledTimes(1)
    expect(runtime.stopTurnsForDrain).toHaveBeenCalledWith(control.DRAIN_TURN_STOPPED)
    expect(log).toHaveBeenCalledWith('[service] the drain reached the Chat-turn deadline; turns still running are stopped for the update')
    // The drain stays on: idle follows once the stopped turns settle.
    expect(service.draining).toBe(true)
  })

  it('drops the turn deadline when the drain is lifted, lapses, or the runtime stops', () => {
    const { runtime, timer, service } = serviceOf()
    service.drain()
    service.resume()
    expect(timer.timers.size).toBe(0)
    service.drain()
    service.reset()
    expect(timer.timers.size).toBe(0)
    service.drain()
    timer.fireDelay((1800 + 300) * 1000)
    expect(timer.timers.size).toBe(0)
    expect(runtime.stopTurnsForDrain).not.toHaveBeenCalled()
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

describe('switching to another release', () => {
  // Releases as the gateway installs them: a directory with its base and an installed marker.
  async function releases(installed: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(root, 'releases-'))
    for (const [name, base] of Object.entries(installed)) {
      await mkdir(join(dir, name))
      await writeFile(join(dir, name, 'base'), `${base}\n`)
      await writeFile(join(dir, name, 'installed'), '')
    }
    return dir
  }

  function switching(dir: string, options: { restart?: () => boolean, canRestart?: () => boolean, name?: string } = {}) {
    const runtime = fakeRuntime()
    const timer = new FakeTimer()
    const restart = vi.fn(options.restart ?? (() => true))
    const service = new control.ServiceControl(runtime as unknown as ChatRuntime, {
      drainTimeoutSeconds: 1800, timer, log: vi.fn(), releasesDir: dir,
      release: { name: options.name ?? 'r1', base: 'b1' }, restart, canRestart: options.canRestart ?? (() => true),
    })
    return { runtime, timer, restart, service }
  }

  it('restarts onto an installed release of its base once no Chat turn or work of its own runs', async () => {
    const dir = await releases({ r2: 'b1' })
    const { runtime, timer, restart, service } = switching(dir)
    try {
      expect(service.switchRelease('r2')).toEqual({ release: 'r2', switching: true })
      expect((await readFile(join(dir, 'next'), 'utf8')).trim()).toBe('r2')
      // Nothing is refused while it waits, behavior ticks included.
      expect(background.releaseBackgroundPaused()).toBe(false)
      const launch = service.admitLaunch('POST', '/api/debate')
      expect(launch).toEqual(expect.any(Function))
      ;(launch as () => void)()
      runtime.workingNow = 1
      timer.fire()
      expect(restart).not.toHaveBeenCalled()
      // Agent processes idle between turns do not hold it back; work in a turn does.
      runtime.workingNow = 0
      runtime.busyNow = 3
      const sessionId = session(runtime.instance, true)
      timer.fire()
      expect(restart).not.toHaveBeenCalled()
      storage.setOpenTurn(sessionId, null, null)
      timer.fire()
      expect(restart).toHaveBeenCalledTimes(1)
      expect(runtime.startDrain).toHaveBeenCalledWith('service')
      expect(background.releaseBackgroundPaused()).toBe(true)
      expect(service.health().draining).toBe(true)
      expect(timer.timers.size).toBe(0)
    } finally {
      service.reset()
      background.resumeReleaseBackground()
    }
  })

  it('lands while relay-held turns are running, and waits for the rest', async () => {
    const dir = await releases({ r2: 'b1' })
    const { runtime, timer, restart, service } = switching(dir)
    try {
      expect(service.switchRelease('r2')).toEqual({ release: 'r2', switching: true })
      const held = session(runtime.instance, true)
      const unheld = session(runtime.instance, true)
      expect(service.health().activeChatTurns).toBe(2)
      runtime.heldNow = new Set([held])
      timer.fire()
      expect(restart).not.toHaveBeenCalled()
      runtime.heldNow = new Set([held, unheld])
      timer.fire()
      expect(restart).toHaveBeenCalledTimes(1)
      // The switch landed with turns recorded open: health still counts them.
      expect(service.health().activeChatTurns).toBe(2)
    } finally {
      service.reset()
      background.resumeReleaseBackground()
    }
  })

  it('does nothing for the release it already runs', async () => {
    const dir = await releases({ r1: 'b1' })
    const { service } = switching(dir)
    expect(service.switchRelease('r1')).toEqual({ release: 'r1', switching: false })
    expect(existsSync(join(dir, 'next'))).toBe(false)
  })

  it('calls a pending switch off when asked for the release it runs, its image\'s own uninstalled one included', async () => {
    // r1, the release it runs, is the image's own: nothing in the home volume names it installed.
    const dir = await releases({ r2: 'b1' })
    const { timer, restart, service } = switching(dir)
    try {
      service.switchRelease('r2')
      expect(service.health().switching).toBe('r2')
      expect(service.switchRelease('r1')).toEqual({ release: 'r1', switching: false })
      expect(existsSync(join(dir, 'next'))).toBe(false)
      expect(service.health().switching).toBeNull()
      expect(timer.timers.size).toBe(0)
      expect(restart).not.toHaveBeenCalled()
    } finally {
      service.reset()
      background.resumeReleaseBackground()
    }
  })

  it('refuses a release not installed, one built for another base or that failed to start, and a server without the supervisor', async () => {
    const dir = await releases({ r2: 'b1', r3: 'b2', r4: 'b1' })
    await writeFile(join(dir, 'r4', 'failed'), 'exited with 1 within a minute of starting\n')
    expect(() => switching(dir).service.switchRelease('r4')).toThrow(expect.objectContaining({ statusCode: 409, message: expect.stringContaining('failed to start') }))
    expect(() => switching(dir).service.switchRelease('r9')).toThrow(expect.objectContaining({ statusCode: 409 }))
    expect(() => switching(dir).service.switchRelease('r3')).toThrow(expect.objectContaining({ statusCode: 409 }))
    expect(() => switching(dir).service.switchRelease('../r2')).toThrow(expect.objectContaining({ statusCode: 400 }))
    expect(() => switching(dir, { canRestart: () => false }).service.switchRelease('r2')).toThrow(expect.objectContaining({ statusCode: 409 }))
    expect(existsSync(join(dir, 'next'))).toBe(false)
  })

  it('stays on its release and admits work again when the restart is refused', async () => {
    const dir = await releases({ r2: 'b1' })
    const { timer, restart, service } = switching(dir, { restart: () => false })
    try {
      service.switchRelease('r2')
      timer.fire()
      expect(restart).toHaveBeenCalledTimes(1)
      expect(service.health().draining).toBe(false)
      expect(background.releaseBackgroundPaused()).toBe(false)
      // The switch stays queued: the next exit of any kind still switches.
      expect((await readFile(join(dir, 'next'), 'utf8')).trim()).toBe('r2')
      expect(service.health().switching).toBe('r2')
    } finally {
      background.resumeReleaseBackground()
    }
  })

  it('reports a queued switch from the persisted record, even to a server that never asked for it', async () => {
    const dir = await releases({ r2: 'b1' })
    await writeFile(join(dir, 'next'), 'r2\n')
    const { timer, service } = switching(dir)
    try {
      expect(service.health().switching).toBe('r2')
      // Reporting never re-arms the poll: only asking for a switch does.
      expect(timer.timers.size).toBe(0)
      await rm(join(dir, 'next'))
      expect(service.health().switching).toBeNull()
      await writeFile(join(dir, 'next'), '../r2\n')
      expect(service.health().switching).toBeNull()
    } finally {
      service.reset()
      background.resumeReleaseBackground()
    }
  })

  it('stops reporting a switch once its persisted record is gone', async () => {
    const dir = await releases({ r2: 'b1' })
    const { service } = switching(dir)
    try {
      service.switchRelease('r2')
      expect(service.health().switching).toBe('r2')
      await rm(join(dir, 'next'))
      expect(service.health().switching).toBeNull()
    } finally {
      service.reset()
      background.resumeReleaseBackground()
    }
  })

  it('reports the desired, installed and active release with how long a switch has been pending', async () => {
    const dir = await releases({ r2: 'b1' })
    const { service } = switching(dir)
    try {
      // No switch pending: the desired release is the active one, and nothing has been pending.
      expect(service.health()).toMatchObject({ release: 'r1', switching: null, desiredRelease: 'r1', installedRelease: 'r1', pendingSince: null })
      // A switch stuck behind running turns: desired and installed are the target, active is still the old release.
      await writeFile(join(dir, 'next'), 'r2\n')
      const since = new Date('2026-10-22T18:00:00.000Z')
      await utimes(join(dir, 'next'), since, since)
      expect(service.health()).toMatchObject({ release: 'r1', switching: 'r2', desiredRelease: 'r2', installedRelease: 'r2', pendingSince: '2026-10-22T18:00:00.000Z' })
    } finally {
      service.reset()
      background.resumeReleaseBackground()
    }
  })

  it('reports the desired release as not installed when it cannot be switched to', async () => {
    const dir = await releases({ r2: 'b1', r3: 'b2', r4: 'b1' })
    await writeFile(join(dir, 'r4', 'failed'), 'exited with 1 within a minute of starting\n')
    const { service } = switching(dir)
    try {
      // Missing, built for another base, or failed to start: desired names it, installed does not.
      for (const queued of ['r9', 'r3', 'r4']) {
        await writeFile(join(dir, 'next'), `${queued}\n`)
        expect(service.health(), queued).toMatchObject({ release: 'r1', switching: queued, desiredRelease: queued, installedRelease: null, pendingSince: expect.any(String) })
      }
    } finally {
      service.reset()
      background.resumeReleaseBackground()
    }
  })

  it('keeps the pending age when the queued switch is asked for again', async () => {
    const dir = await releases({ r2: 'b1' })
    const first = switching(dir)
    try {
      first.service.switchRelease('r2')
      const since = new Date('2026-10-22T18:00:00.000Z')
      await utimes(join(dir, 'next'), since, since)
      expect(first.service.health().pendingSince).toBe('2026-10-22T18:00:00.000Z')
      // The gateway asks on every pass until the switch lands; re-asking must not move the age.
      first.service.switchRelease('r2')
      expect(first.service.health().pendingSince).toBe('2026-10-22T18:00:00.000Z')
      expect((await readFile(join(dir, 'next'), 'utf8')).trim()).toBe('r2')
      expect(first.timer.timers.size).toBe(1)
      // A restarted server re-arms its poll when asked again, without moving the age either.
      const second = switching(dir)
      try {
        second.service.switchRelease('r2')
        expect(second.timer.timers.size).toBe(1)
        expect(second.service.health().pendingSince).toBe('2026-10-22T18:00:00.000Z')
      } finally {
        second.service.reset()
        background.resumeReleaseBackground()
      }
    } finally {
      first.service.reset()
      background.resumeReleaseBackground()
    }
  })

  it('takes a switch only from the gateway\'s admin scope or loopback, as JSON over POST', async () => {
    const dir = await releases({ r2: 'b1' })
    const { service } = switching(dir)
    try {
      expect(() => call('POST', '/api/service/switch', { kind: 'gateway', scope: 'browser' }, service)).toThrow(expect.objectContaining({ statusCode: 403 }))
      expect(call('GET', '/api/service/switch', { kind: 'local' }, service)).toMatchObject({ status: 405, allow: 'POST' })
      const res = response()
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ release: 'r2' }))]), { method: 'POST', headers: { 'content-type': 'application/json' } }) as unknown as IncomingMessage
      await control.handleServiceApi(req, res as unknown as ServerResponse, '/api/service/switch', { kind: 'gateway', scope: 'admin' }, service)
      expect(res.statusCode).toBe(202)
      expect(JSON.parse(res.body)).toEqual({ release: 'r2', switching: true })
    } finally {
      service.reset()
      background.resumeReleaseBackground()
    }
  })
})

describe('private diagnostic maintenance delivery', () => {
  it('refuses browser/link assertions before reading any diagnostic evidence', () => {
    const { service } = serviceOf()
    for (const scope of ['browser', 'link'] as const) {
      expect(() => call('GET', '/api/service/diagnostics', { kind: 'gateway', scope }, service)).toThrow(expect.objectContaining({ statusCode: 403 }))
    }
    expect(call('POST', '/api/service/diagnostics', { kind: 'gateway', scope: 'admin' }, service)).toMatchObject({ status: 405, allow: 'GET' })
  })
})


it('distinguishes an invalid diagnostic cursor from an unavailable source', async () => {
  const logging = await import('../server/logging')
  const { DiagnosticCursorError } = await import('../gateway/src/diagnostics/store')
  const spy = vi.spyOn(logging, 'diagnosticPage').mockImplementation(() => { throw new DiagnosticCursorError('old source key') })
  const { service } = serviceOf()
  const req = Object.assign(Readable.from([]), { method: 'GET', url: '/api/service/diagnostics?cursor=old', headers: {} }) as unknown as IncomingMessage
  const res = response()
  try {
    control.handleServiceApi(req, res as unknown as ServerResponse, '/api/service/diagnostics', { kind: 'gateway', scope: 'admin' }, service)
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'diagnostic_cursor_invalid' })
    spy.mockImplementation(() => { throw new Error('source sink unavailable') })
    expect(() => control.handleServiceApi(req, res as unknown as ServerResponse, '/api/service/diagnostics', { kind: 'gateway', scope: 'admin' }, service)).toThrow('source sink unavailable')
  } finally { spy.mockRestore() }
})
