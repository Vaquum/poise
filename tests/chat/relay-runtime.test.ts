// Runtime relay behavior through real servers sharing one database: a
// relay-held turn survives from one ChatRuntime to the next (handover,
// adopt, replay, settle), and a dead relay falls back to
// interrupt-and-resume with the transcript saying so.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentId, ChatEnvelope, ChatEvent, PromptInput } from '../../server/chat/protocol'
import type { Adapter, AdapterHost, AdapterStartOptions, ReplayInit } from '../../server/chat/adapters/types'
import type { CallerTurns } from '../../server/chat/caller-turns'
import type { RelayConnection } from '../../server/chat/relay'
import { CATALOG } from '../model-catalog-fixture'

let root = ''
let repo = ''
let runtimeModule: typeof import('../../server/chat/runtime')
let storage: typeof import('../../server/chat/storage')
let worker: typeof import('../../server/chat/worker')

function git(args: string[], cwd = repo): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

interface FakeControls {
  hosts: AdapterHost[]
  adapters: FakeAdapter[]
  auto: boolean
  replayTurns: ReplayInit[]
  /** False simulates a crashed server: a dead link settles nothing. */
  exitAware?: boolean
  /** Makes replayTurn throw: a handoff that must fall back. */
  failReplay?: string
  /** Hold replay until another server has adopted the same open turn. */
  replayGate?: Promise<void>
  failReplayAfterGate?: string
  /** Manual turns resolve with terminate: true. */
  terminateTurns?: boolean
  startWorker?: { command: string, args: string[] }
}

class FakeAdapter implements Adapter {
  agent: AgentId = 'grok'
  nativeSessionId: string | undefined
  capabilities = { steer: true, fork: true, thought: true, plan: true, commands: true, modes: false, permissions: true, questions: true, resume: true, images: false }
  alive = false
  inputs: PromptInput[] = []
  private finishTurn: ((stop?: 'end_turn' | 'cancelled') => void) | null = null
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  constructor(readonly host: AdapterHost, readonly controls: FakeControls) {
    // Like a real adapter, a dead link settles a pending prompt.
    const spawn = host.spawn.bind(host)
    host.spawn = (async (command, args, options) => {
      const peer = await spawn(command, args, options)
      if (this.controls.exitAware !== false) peer.once('exit', () => this.finishTurn?.('cancelled'))
      return peer
    })
  }
  async start(options: AdapterStartOptions) {
    this.alive = true
    if (this.controls.startWorker) await this.host.spawn(this.controls.startWorker.command, this.controls.startWorker.args)
    this.nativeSessionId = options.resume || `native-${this.controls.adapters.length}`
    return { nativeSessionId: this.nativeSessionId, capabilities: this.capabilities, modelId: options.modelId, effort: options.effort, efforts: ['high', 'xhigh'] }
  }
  async prompt(turnId: string, input: PromptInput, signal: AbortSignal) {
    this.inputs.push(input)
    this.host.emit({ type: 'text.delta', turnId, messageId: `${turnId}:m1`, delta: `echo: ${input.text}` })
    if (this.controls.auto) return { stopReason: 'end_turn' as const, usage: { totalTokens: 3 } }
    return new Promise<{ stopReason: 'end_turn' | 'cancelled', terminate?: true }>((resolve) => {
      this.finishTurn = (stop = 'end_turn') => {
        this.finishTurn = null
        resolve(this.controls.terminateTurns ? { stopReason: stop, terminate: true as const } : { stopReason: stop })
      }
      signal.addEventListener('abort', () => this.finishTurn?.('cancelled'), { once: true })
    })
  }
  async replayTurn(init: ReplayInit) {
    if (this.controls.failReplay) throw new Error(this.controls.failReplay)
    this.controls.replayTurns.push(init)
    this.alive = true
    this.nativeSessionId = init.session.nativeSessionId
    await this.controls.replayGate
    if (this.controls.failReplayAfterGate) throw new Error(this.controls.failReplayAfterGate)
    return { stopReason: 'end_turn' as const, usage: { totalTokens: 3 } }
  }
  async steer() {}
  finish() { this.finishTurn?.('end_turn') }
  async cancel() { this.finishTurn?.('cancelled') }
  async setModel(modelId: string, effort: string) { return { modelId, effort } }
  async setMode() {}
  async fork() { return `${this.nativeSessionId}-fork` }
  async close() { this.alive = false; for (const l of this.exitListeners) l(0, null) }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) { this.exitListeners.push(listener) }
}

const runtimes: Array<import('../../server/chat/runtime').ChatRuntime> = []

function makeRuntime(instance: string, controls?: FakeControls) {
  const owned: FakeControls = controls ?? { hosts: [], adapters: [], auto: true, replayTurns: [] }
  const finishes: Array<{ callId: string, status: string, error?: string }> = []
  const caller: CallerTurns = {
    async start() { return 'a'.repeat(32) },
    async finish(callId, status, error) { finishes.push({ callId, status, error }); return { id: callId, status } },
  }
  const runtime = new runtimeModule.ChatRuntime({
    instance,
    instanceLabel: 'test',
    adapters: { grok: (host: AdapterHost) => { const a = new FakeAdapter(host, owned); owned.hosts.push(host); owned.adapters.push(a); return a } },
    callerTurns: caller,
    catalog: async () => CATALOG as any,
    resolveCheckout: async () => repo,
    idleTimeoutMinutes: () => 0,
    requireClaudeReady: async () => {},
  })
  const events: ChatEnvelope[] = []
  runtime.on('event', (e: ChatEnvelope) => events.push(e))
  runtimes.push(runtime)
  return { runtime, controls: owned, events, finishes }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-relay-runtime-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  repo = join(root, 'repo')
  await mkdir(repo)
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 't@example.invalid'])
  git(['config', 'user.name', 't'])
  await writeFile(join(repo, 'README.md'), '# repo\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  vi.resetModules()
  runtimeModule = await import('../../server/chat/runtime')
  storage = await import('../../server/chat/storage')
  worker = await import('../../server/chat/worker')
})

afterAll(async () => {
  const { closeDatabase } = await import('../../server/db')
  closeDatabase()
  delete process.env.POISE_DB
  delete process.env.POISE_LOCK_DIR
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop({ handover: false }).catch(() => undefined)
  spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: repo })
  spawnSync('git', ['clean', '-fdq'], { cwd: repo })
  spawnSync('git', ['switch', '-q', 'main'], { cwd: repo })
})

async function waitFor(check: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const ofType = (events: ChatEnvelope[], id: string, type: ChatEvent['type']) => events.filter((e) => e.sessionId === id && e.event.type === type).map((e) => e.event as any)
const lastStatus = (events: ChatEnvelope[], id: string) => ofType(events, id, 'status.changed').at(-1)?.status

describe('relay handover between servers', () => {
  async function heldTurn(instance: string, command = 'sleep 60') {
    const first = makeRuntime(instance)
    first.controls.auto = false
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    first.runtime.prompt(session.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', command]) as RelayConnection
    await waitFor(() => worker.pgidAlive(peer.gatePgid))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const { turnId } = first.runtime.prompt(session.id, { text: 'Survive the restart', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    await new Promise((resolve) => setTimeout(resolve, 200))
    await first.runtime.stop()
    return { first, session, peer, turnId }
  }

  it.each(['local', 'adopted'] as const)('retains the %s worker and lease when the relay dies before its gate group', async (mode) => {
    const instance = `poise-relay-dies-before-worker-${mode}:db`
    const first = makeRuntime(instance)
    first.controls.auto = false
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    first.runtime.prompt(session.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const marker = join(root, `relay-before-worker-${mode}`)
    const peer = await first.controls.hosts[0].spawn(process.execPath,
      ['-e', "require('node:fs').writeFileSync(process.argv[1], 'started'); setInterval(() => {}, 1000)", marker]) as RelayConnection
    await waitFor(() => existsSync(marker))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const { turnId } = first.runtime.prompt(session.id, { text: 'Keep the checkout owned', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    let releaseReplay = () => {}
    let owner = first
    let activePeer = peer
    const lock = await import('../../server/chat/checkout-lock')
    const lease = new lock.CheckoutLease(repo, { ownerKind: 'poise:chat', ownerId: session.id, ownerLabel: '', instance })
    try {
      if (mode === 'adopted') {
        // prompt() follows TURN_START; the relay decodes commands in FIFO
        // order, so the outbound reply proves that boundary was processed.
        await waitFor(() => first.controls.adapters[0].inputs.length === 2)
        await peer.getOutbound()
        await first.runtime.stop()
        owner = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [],
          replayGate: new Promise<void>((resolve) => { releaseReplay = resolve }) })
        await owner.runtime.recover()
        await waitFor(() => owner.controls.replayTurns.length === 1)
        await owner.controls.replayTurns[0].live
        activePeer = owner.controls.replayTurns[0].peer as RelayConnection
      }
      const token = lease.read()?.token
      expect(token).toBeTruthy()
      // The relay is a separate process. Hold the gate alive across relay
      // death, so neither its exit nor the adapter's ending proves safety.
      process.kill(peer.gatePid, 'SIGSTOP')
      process.kill(peer.relayPid, 'SIGKILL')
      await waitFor(() => !activePeer.healthy && !worker.pidAlive(peer.relayPid))
      releaseReplay()
      await waitFor(() => owner.runtime.get(session.id)?.status === 'error')
      expect(ofType(owner.events, session.id, 'turn.finished')).toContainEqual(expect.objectContaining({ turnId }))
      expect(worker.pgidAlive(peer.gatePgid)).toBe(true)
      expect(storage.getWorker(session.id)?.gatePgid).toBe(peer.gatePgid)
      expect(storage.getRelay(session.id)?.relayPid).toBe(peer.relayPid)
      expect(lease.read()?.token).toBe(token)
      expect(owner.runtime.get(session.id)?.orphanNotice).toContain('still alive after shutdown')
      await expect(owner.runtime.close(session.id)).rejects.toThrow('still alive after shutdown')
      expect(lease.read()?.token).toBe(token)
      const contender = new lock.CheckoutLease(repo, { ownerKind: 'poise:chat', ownerId: 'different-session', ownerLabel: '', instance })
      expect(contender.tryAcquire().acquired).toBe(false)
      process.kill(peer.gatePid, 'SIGCONT')
      await waitFor(() => !worker.pgidAlive(peer.gatePgid), 15_000)
      // Relay exit arrived while the gate was stopped. Its later actual exit
      // must retire the same worker's rows without requiring another close.
      await waitFor(() => storage.getWorker(session.id) === null && storage.getRelay(session.id) === null)
      await owner.runtime.close(session.id)
      expect(storage.getWorker(session.id)).toBeNull()
      expect(storage.getRelay(session.id)).toBeNull()
      expect(lease.read()).toBeNull()
      expect(contender.tryAcquire().acquired).toBe(true)
      contender.release()
    } finally {
      releaseReplay()
      if (worker.pidAlive(peer.gatePid)) process.kill(peer.gatePid, 'SIGCONT')
      worker.signalGroup(peer.gatePgid, 'SIGKILL')
      await waitFor(() => !worker.pgidAlive(peer.gatePgid), 10_000)
      await owner.runtime.stop({ handover: false })
    }
  }, 60_000)

  it('retains a started worker when GO confirmation and its shutdown both fail', async () => {
    const instance = 'poise-relay-go-failed-shutdown:db'
    const marker = join(root, 'go-started-native-agent')
    const owner = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [], startWorker: {
      command: process.execPath, args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'started'); setInterval(() => {}, 1000)", marker],
    } })
    const relay = await import('../../server/chat/relay')
    const lock = await import('../../server/chat/checkout-lock')
    const spawn = relay.spawnRelay
    let peer!: RelayConnection
    let refuseShutdown = true
    const spawning = vi.spyOn(relay, 'spawnRelay').mockImplementation(async (options) => {
      peer = await spawn(options)
      const go = peer.go.bind(peer)
      const shutdown = peer.shutdown.bind(peer)
      peer.go = async () => {
        await go()
        await waitFor(() => existsSync(marker))
        throw new Error('fixture GO confirmation failed after native startup')
      }
      peer.shutdown = async () => {
        if (refuseShutdown) throw new Error('fixture shutdown could not verify termination')
        await shutdown()
      }
      return peer
    })
    try {
      const session = await owner.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
      await waitFor(() => !!owner.runtime.get(session.id)?.orphanNotice)
      const lease = new lock.CheckoutLease(repo, { ownerKind: 'poise:chat', ownerId: session.id, ownerLabel: '', instance })
      const token = lease.read()?.token
      expect(token).toBeTruthy()
      expect(existsSync(marker)).toBe(true)
      expect(worker.pgidAlive(peer.gatePgid)).toBe(true)
      expect(storage.getWorker(session.id)?.gatePgid).toBe(peer.gatePgid)
      expect(storage.getRelay(session.id)?.relayPid).toBe(peer.relayPid)
      await waitFor(() => owner.events.some((event) => event.sessionId === session.id && event.event.type === 'error'
        && event.event.message.includes('GO confirmation failed after native startup; agent shutdown failed: fixture shutdown')))
      await expect(owner.runtime.close(session.id)).rejects.toThrow('fixture shutdown could not verify termination')
      expect(lease.read()?.token).toBe(token)
      refuseShutdown = false
      await owner.runtime.close(session.id)
      expect(worker.pgidAlive(peer.gatePgid)).toBe(false)
      expect(storage.getWorker(session.id)).toBeNull()
      expect(storage.getRelay(session.id)).toBeNull()
      expect(lease.read()).toBeNull()
    } finally {
      refuseShutdown = false
      spawning.mockRestore()
      await owner.runtime.stop({ handover: false })
    }
  }, 30_000)

  it.each(['resolve', 'reject'] as const)('leaves a twice handed-over turn alone when old replay later %ss', async (outcome) => {
    const instance = `poise-relay-second-restart-${outcome}:db`
    const { session, peer, turnId } = await heldTurn(instance)
    const lock = await import('../../server/chat/checkout-lock')
    let releaseOld = () => {}
    let releaseCurrent = () => {}
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [],
      replayGate: new Promise<void>((resolve) => { releaseOld = resolve }),
      ...(outcome === 'reject' ? { failReplayAfterGate: 'old replay detached' } : {}) })
    const third = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [],
      replayGate: new Promise<void>((resolve) => { releaseCurrent = resolve }) })
    const signals = vi.spyOn(worker, 'signalGroup')
    try {
      await second.runtime.recover()
      await waitFor(() => second.controls.replayTurns.length === 1)
      await second.runtime.stop()
      await third.runtime.recover()
      await waitFor(() => third.controls.replayTurns.length === 1)
      const lease = new lock.CheckoutLease(repo, { ownerKind: 'poise:chat', ownerId: session.id, ownerLabel: '', instance })
      const ownerToken = lease.read()?.token
      expect(ownerToken).toBeTruthy()
      releaseOld()
      // Drain replay's completion microtasks before inspecting its effects.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(signals).not.toHaveBeenCalled()
      expect(ofType(second.events, session.id, 'turn.finished')).toEqual([])
      expect(second.finishes).toEqual([])
      expect(storage.getOpenTurn(session.id)?.turnId).toBe(turnId)
      expect(storage.getWorker(session.id)?.gatePgid).toBe(peer.gatePgid)
      expect(storage.getRelay(session.id)).not.toBeNull()
      expect(worker.pgidAlive(peer.gatePgid)).toBe(true)
      expect(lease.read()?.token).toBe(ownerToken)
      await expect(readFile(join(peer.dir, 'turn.spool'), 'utf8')).resolves.toBe('')
      releaseCurrent()
      await waitFor(() => ofType(third.events, session.id, 'turn.finished').length === 1)
      expect(ofType(third.events, session.id, 'turn.finished')[0]).toMatchObject({ turnId, stopReason: 'end_turn' })
      expect(third.finishes).toHaveLength(1)
    } finally {
      signals.mockRestore()
      releaseOld()
      releaseCurrent()
    }
  }, 60_000)

  it('does not terminate a worker adopted between recovery inspection and lease adoption', async () => {
    const instance = 'poise-relay-adoption-race:db'
    const { session, peer, turnId } = await heldTurn(instance)
    const lock = await import('../../server/chat/checkout-lock')
    // A distinct live PID represents the winning server; the original
    // server is dead from this holder's point of view, as after a restart.
    const winner = new lock.CheckoutLease(repo, { ownerKind: 'poise:chat', ownerId: session.id, ownerLabel: '', instance },
      { hostPid: peer.relayPid, pidAlive: (pid) => pid !== process.pid && worker.pidAlive(pid) })
    const adopt = lock.CheckoutLease.prototype.adoptLiveWorker
    const adoption = vi.spyOn(lock.CheckoutLease.prototype, 'adoptLiveWorker').mockImplementationOnce(function (this: InstanceType<typeof lock.CheckoutLease>, expected) {
      expect(adopt.call(winner, expected)).toBe(true)
      return adopt.call(this, expected)
    })
    const signals = vi.spyOn(worker, 'signalGroup')
    const second = makeRuntime(instance)
    try {
      await second.runtime.recover()
      await waitFor(() => adoption.mock.calls.length === 1)
      await new Promise<void>((resolve) => setImmediate(resolve))
      await second.runtime.stop({ handover: false })
      expect(signals).not.toHaveBeenCalled()
      expect(second.controls.replayTurns).toEqual([])
      expect(second.finishes).toEqual([])
      expect(ofType(second.events, session.id, 'turn.finished')).toEqual([])
      expect(storage.getOpenTurn(session.id)?.turnId).toBe(turnId)
      expect(storage.getSession(session.id)?.status).toBe('running')
      expect(storage.getWorker(session.id)?.gatePgid).toBe(peer.gatePgid)
      expect(storage.getRelay(session.id)).not.toBeNull()
      expect(worker.pgidAlive(peer.gatePgid)).toBe(true)
      expect(winner.read()).toMatchObject({ token: winner.currentToken, host_pid: peer.relayPid, worker_pgid: peer.gatePgid })
    } finally {
      adoption.mockRestore()
      signals.mockRestore()
      worker.signalGroup(peer.gatePgid, 'SIGKILL')
      await waitFor(() => !worker.pgidAlive(peer.gatePgid), 10_000)
      winner.release()
      storage.forgetWorker(session.id)
      storage.forgetRelay(session.id)
      await rm(peer.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it.each(['probe', 'claim'] as const)('preserves a live owner that wins during recovery %s', async (race) => {
    const instance = `poise-relay-probe-owner-race-${race}:db`
    const { session, peer, turnId } = await heldTurn(instance)
    const lock = await import('../../server/chat/checkout-lock')
    const relay = await import('../../server/chat/relay')
    const recorded = storage.getWorker(session.id)!
    const queue = await import('../../server/chat/message-queue')
    const beforeQueue = queue.readQueue(queue.queueOwner(session.id))
    const beforeSession = storage.getSession(session.id)
    const beforeTurn = storage.getOpenTurn(session.id)
    const winner = new lock.CheckoutLease(repo, { ownerKind: 'poise:chat', ownerId: session.id, ownerLabel: '', instance },
      { hostPid: peer.relayPid, pidAlive: (pid) => pid !== process.pid && worker.pidAlive(pid) })
    const winningPeers: RelayConnection[] = []
    let refusal = ''
    const attach = relay.attachRelay
    const adopt = lock.CheckoutLease.prototype.adoptLiveWorker
    const adoption = race === 'claim' ? vi.spyOn(lock.CheckoutLease.prototype, 'adoptLiveWorker').mockImplementationOnce(function (this: InstanceType<typeof lock.CheckoutLease>, expected) {
      // Even the last ownership read has passed. The CAS must lose to a
      // winner that adopts immediately before recovery claims the row.
      expect(adopt.call(winner, expected)).toBe(true)
      return adopt.call(this, expected)
    }) : null
    const probe = vi.spyOn(relay, 'attachRelay').mockImplementationOnce(async (options) => {
      if (race === 'claim') throw new Error('fixture probe unavailable')
      // The initial holder check already passed. The live winner takes both
      // the lease and relay before recovery's probe reaches the socket.
      expect(winner.adoptLiveWorker({ workerPid: recorded.gatePid, workerPgid: recorded.gatePgid,
        workerIdent: recorded.ident, ownerId: session.id })).toBe(true)
      winningPeers.push((await attach(options)).connection)
      try { return await attach(options) }
      catch (error) { refusal = error instanceof Error ? error.message : String(error); throw error }
    })
    const signals = vi.spyOn(worker, 'signalGroup')
    const second = makeRuntime(instance)
    try {
      await second.runtime.recover()
      if (race === 'claim') {
        expect(adoption).toHaveBeenCalledTimes(1)
        const saved = storage.getRelay(session.id)!
        winningPeers.push((await attach({ sessionId: session.id, dir: saved.dir, socketPath: saved.socket,
          relayPid: saved.relayPid, relayIdent: saved.relayIdent })).connection)
      } else expect(refusal).toContain('another Poise is already attached')
      await expect(second.runtime.close(session.id)).rejects.toMatchObject({ code: 'checkout_busy' })
      await expect(second.runtime.delete(session.id)).rejects.toMatchObject({ code: 'checkout_busy' })
      expect(storage.getSession(session.id)).toEqual(beforeSession)
      expect(storage.getOpenTurn(session.id)).toEqual(beforeTurn)
      expect(queue.readQueue(queue.queueOwner(session.id))).toEqual(beforeQueue)
      await second.runtime.stop({ handover: false })
      expect(storage.getSession(session.id)).toEqual(beforeSession)
      expect(storage.getOpenTurn(session.id)).toEqual(beforeTurn)
      expect(queue.readQueue(queue.queueOwner(session.id))).toEqual(beforeQueue)
      expect(probe).toHaveBeenCalledTimes(1)
      expect(signals).not.toHaveBeenCalled()
      expect(second.controls.replayTurns).toEqual([])
      expect(second.finishes).toEqual([])
      expect(ofType(second.events, session.id, 'turn.finished')).toEqual([])
      expect(storage.getOpenTurn(session.id)?.turnId).toBe(turnId)
      expect(storage.getSession(session.id)?.status).toBe('running')
      expect(storage.getWorker(session.id)?.gatePgid).toBe(peer.gatePgid)
      expect(storage.getRelay(session.id)).not.toBeNull()
      expect(worker.pgidAlive(peer.gatePgid)).toBe(true)
      expect(winner.read()).toMatchObject({ token: winner.currentToken, host_pid: peer.relayPid, worker_pgid: peer.gatePgid })
    } finally {
      probe.mockRestore()
      adoption?.mockRestore()
      signals.mockRestore()
      for (const connection of winningPeers) connection.detach()
      worker.signalGroup(peer.gatePgid, 'SIGKILL')
      await waitFor(() => !worker.pgidAlive(peer.gatePgid), 10_000)
      winner.release()
      storage.forgetWorker(session.id)
      storage.forgetRelay(session.id)
      await rm(peer.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('retains a fallback claim through failed server shutdown and releases it only after verified close', async () => {
    const instance = 'poise-relay-fallback-claim-lifetime:db'
    const { session, peer, turnId } = await heldTurn(instance)
    const lock = await import('../../server/chat/checkout-lock')
    const relay = await import('../../server/chat/relay')
    const probe = vi.spyOn(relay, 'attachRelay').mockRejectedValueOnce(new Error('fixture probe unavailable'))
    const signals = vi.spyOn(worker, 'signalGroup').mockImplementation(() => {})
    const second = makeRuntime(instance)
    const lease = new lock.CheckoutLease(repo, { ownerKind: 'poise:chat', ownerId: session.id, ownerLabel: '', instance })
    try {
      await second.runtime.recover()
      const token = lease.read()?.token
      expect(token).toBeTruthy()
      expect(lease.read()).toMatchObject({ host_pid: process.pid, worker_pgid: peer.gatePgid })
      expect(storage.getWorker(session.id)?.leaseToken).toBe(token)
      expect(ofType(second.events, session.id, 'turn.finished')[0]).toMatchObject({ turnId, stopReason: 'interrupted' })
      await second.runtime.stop({ handover: false })
      expect(lease.read()?.token).toBe(token)
      expect(storage.getWorker(session.id)).not.toBeNull()
      expect(storage.getRelay(session.id)).not.toBeNull()
      expect(worker.pgidAlive(peer.gatePgid)).toBe(true)
      signals.mockRestore()
      await second.runtime.close(session.id)
      expect(worker.pgidAlive(peer.gatePgid)).toBe(false)
      expect(storage.getWorker(session.id)).toBeNull()
      expect(storage.getRelay(session.id)).toBeNull()
      expect(lease.read()).toBeNull()
    } finally {
      probe.mockRestore()
      signals.mockRestore()
      worker.signalGroup(peer.gatePgid, 'SIGKILL')
      await waitFor(() => !worker.pgidAlive(peer.gatePgid), 10_000)
      const row = lease.read()
      if (row) lock.CheckoutLease.releaseByToken(repo, row.token)
      storage.forgetWorker(session.id)
      storage.forgetRelay(session.id)
      await rm(peer.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('cleans up a live idle worker after its completed turn released the checkout lease', async () => {
    const instance = 'poise-relay-idle-worker-no-lease:db'
    const lock = await import('../../server/chat/checkout-lock')
    const first = makeRuntime(instance)
    first.controls.auto = false
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    first.runtime.prompt(session.id, { text: 'Complete before the crash', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    await waitFor(() => worker.pgidAlive(peer.gatePgid))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const lease = new lock.CheckoutLease(repo, { ownerKind: 'poise:chat', ownerId: session.id, ownerLabel: '', instance })
    expect(storage.getOpenTurn(session.id)).toBeNull()
    expect(lease.read()).toBeNull()
    expect(storage.getWorker(session.id)?.gatePgid).toBe(peer.gatePgid)
    // A crash drops the old link without running idle-session shutdown.
    peer.detach()
    runtimes.splice(runtimes.indexOf(first.runtime), 1)
    const second = makeRuntime(instance)
    try {
      await second.runtime.recover()
      expect(worker.pgidAlive(peer.gatePgid)).toBe(false)
      expect(storage.getWorker(session.id)).toBeNull()
      expect(storage.getRelay(session.id)).toBeNull()
      expect(lease.read()).toBeNull()
      expect(second.controls.replayTurns).toEqual([])
      expect(second.finishes).toEqual([])
      expect(ofType(second.events, session.id, 'turn.finished')).toEqual([])
      await expect(second.runtime.close(session.id)).resolves.toMatchObject({ status: 'closed' })
      await expect(second.runtime.delete(session.id)).resolves.toMatchObject({ workspaceRemoved: false })
      expect(storage.getSession(session.id)).toBeNull()
    } finally {
      worker.signalGroup(peer.gatePgid, 'SIGKILL')
      await waitFor(() => !worker.pgidAlive(peer.gatePgid), 10_000)
    }
  }, 60_000)

  it('drops the completed adopted turn spool and outbound log while its agent stays idle', async () => {
    const instance = 'poise-relay-replay-finish-spool:db'
    const { session, peer, turnId } = await heldTurn(instance, 'cat')
    let releaseReplay = () => {}
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [],
      replayGate: new Promise<void>((resolve) => { releaseReplay = resolve }) })
    try {
      await second.runtime.recover()
      await waitFor(() => second.controls.replayTurns.length === 1)
      const adopted = second.controls.replayTurns[0].peer as RelayConnection
      const marker = 'adopted-turn-output\n'
      await new Promise<void>((resolve, reject) => adopted.stdin.write(marker, (error) => error ? reject(error) : resolve()))
      const spool = join(peer.dir, 'turn.spool')
      await vi.waitFor(async () => expect(await readFile(spool, 'utf8')).toContain(marker))
      expect((await adopted.getOutbound()).bytes.toString()).toContain(marker)
      releaseReplay()
      await waitFor(() => lastStatus(second.events, session.id) === 'idle')
      expect(ofType(second.events, session.id, 'turn.finished')).toEqual([expect.objectContaining({ turnId, stopReason: 'end_turn' })])
      await vi.waitFor(async () => {
        await expect(readFile(spool, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      })
      expect(await adopted.getOutbound()).toEqual({ truncated: false, bytes: Buffer.alloc(0) })
      expect(worker.pgidAlive(peer.gatePgid)).toBe(true)
      expect(storage.getWorker(session.id)?.gatePgid).toBe(peer.gatePgid)
      expect(storage.getRelay(session.id)).not.toBeNull()
    } finally {
      releaseReplay()
      await second.runtime.stop({ handover: false })
    }
  }, 60_000)

  it('keeps a relay-held turn running through a restart', async () => {
    const instance = 'poise-relay-handover:db'
    const first = makeRuntime(instance)
    first.controls.auto = false
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    // A first turn starts the agent, as the adapter's start would; the
    // handover turn below then finds the relay already holding it.
    first.runtime.prompt(session.id, { text: 'Start the agent', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const pgid = peer.gatePgid
    await waitFor(() => worker.pgidAlive(pgid))
    first.controls.adapters[0].finish()
    // The full settle, not just the terminal event: the next prompt must
    // observe the idle edge, never the previous turn's running status.
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const { turnId } = first.runtime.prompt(session.id, { text: 'Hold the checkout', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    // Let the turn-start frame flush to the relay before stopping: a real
    // restart lands seconds later, but this test stops within microseconds.
    await new Promise((r) => setTimeout(r, 200))
    // A turn a healthy relay holds is invisible to the release switch while
    // its open row still counts it running.
    expect(first.runtime.working()).toBe(0)
    expect(first.runtime.relayHeldSessions()).toEqual(new Set([session.id]))
    expect(storage.listOpenTurns(instance)).toHaveLength(1)

    await first.runtime.stop()
    expect(storage.getOpenTurn(session.id)?.turnId).toBe(turnId)
    expect(worker.pgidAlive(pgid)).toBe(true)
    expect(storage.getRelay(session.id)).not.toBeNull()

    const second = makeRuntime(instance)
    await second.runtime.recover()
    await waitFor(() => second.controls.replayTurns.length === 1)
    expect(second.controls.replayTurns[0].turnId).toBe(turnId)
    await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 1)
    expect(ofType(second.events, session.id, 'turn.finished')[0]).toMatchObject({ turnId, stopReason: 'end_turn' })
    expect(second.finishes).toHaveLength(1)
    expect(second.finishes[0]).toMatchObject({ status: 'completed' })
    // The adopted agent was not stopped: its rows and process survive.
    await waitFor(() => second.runtime.get(session.id)?.status === 'idle')
    expect(worker.pgidAlive(pgid)).toBe(true)
    expect(storage.getRelay(session.id)).not.toBeNull()

    // The next turn reuses the adopted agent.
    second.controls.auto = true
    second.runtime.prompt(session.id, { text: 'Again', attachments: [], mentions: [] })
    await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 2)
    expect(second.controls.adapters).toHaveLength(1)

    await second.runtime.stop({ handover: false })
    await waitFor(() => !worker.pgidAlive(pgid), 10_000)
    expect(storage.getRelay(session.id)).toBeNull()
    await first.runtime.stop({ handover: false })
  }, 60_000)

  it('falls back to interrupt-and-resume when the relay is gone', async () => {
    const instance = 'poise-relay-fallback:db'
    const first = makeRuntime(instance)
    first.controls.auto = false
    first.controls.exitAware = false
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const { turnId } = first.runtime.prompt(session.id, { text: 'Hold the checkout', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const pgid = peer.gatePgid
    await waitFor(() => worker.pgidAlive(pgid))
    const workerRow = storage.getWorker(session.id)!
    const relayRow = storage.getRelay(session.id)!

    // The relay dies without a handover; its gate tears the agent down.
    // The rows are re-recorded afterwards: a crashed server never runs
    // the exit handler that would have forgotten them.
    process.kill(peer.relayPid, 'SIGKILL')
    await waitFor(() => !worker.pgidAlive(pgid) && !worker.pidAlive(peer.relayPid), 10_000)
    await waitFor(() => storage.getRelay(session.id) === null)
    storage.recordWorker(workerRow)
    storage.recordRelay(relayRow)
    // The old server is gone with the crash: it is never stopped here (its
    // dangling turn settles in afterEach, after the assertions below).

    const second = makeRuntime(instance)
    await second.runtime.recover()
    expect(second.controls.replayTurns).toHaveLength(0)
    const finished = ofType(second.events, session.id, 'turn.finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({ turnId, stopReason: 'interrupted' })
    expect(finished[0].error).toContain('the agent was gone after the restart')
    expect(second.runtime.get(session.id)?.status).toBe('interrupted')
    expect(second.runtime.get(session.id)?.interruptedTurnId).toBe(turnId)
    expect(storage.listWorkers().filter((row) => row.sessionId === session.id)).toEqual([])
    expect(storage.getRelay(session.id)).toBeNull()
  }, 60_000)

  it('counts a turn still waiting for the checkout as work, not as relay-held', async () => {
    const instance = 'poise-relay-prespool:db'
    // Two servers, one checkout: the waiter's relay is primed first, then
    // its next turn waits on the lease the holder's turn keeps.
    const holder = makeRuntime(instance)
    holder.controls.auto = false
    const waiter = makeRuntime(instance)
    waiter.controls.auto = false
    const waiting = await waiter.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(waiter.events, waiting.id) === 'idle')
    waiter.runtime.prompt(waiting.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => waiter.runtime.get(waiting.id)?.status === 'running')
    const peer = await waiter.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const pgid = peer.gatePgid
    await waitFor(() => worker.pgidAlive(pgid))
    waiter.controls.adapters[0].finish()
    await waitFor(() => lastStatus(waiter.events, waiting.id) === 'idle')

    const holding = await holder.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(holder.events, holding.id) === 'idle')
    holder.runtime.prompt(holding.id, { text: 'Hold the checkout', attachments: [], mentions: [] })
    await waitFor(() => holder.runtime.get(holding.id)?.status === 'running')

    // The waiter's turn exists but is still before turnStart: no spool,
    // so a restart could not adopt it — the switch must wait for it.
    const { turnId } = waiter.runtime.prompt(waiting.id, { text: 'Wait for the lease', attachments: [], mentions: [] })
    await waitFor(() => waiter.events.some((e) => e.sessionId === waiting.id && e.event.type === 'turn.started' && (e.event as { turnId: string }).turnId === turnId))
    expect(waiter.runtime.get(waiting.id)?.status).toBe('queued')
    // Counted — the turn plus its chain entry — not skipped as held.
    expect(waiter.runtime.working()).toBe(2)
    expect(waiter.runtime.relayHeldSessions()).toEqual(new Set())

    holder.controls.adapters[0].finish()
    await waitFor(() => lastStatus(holder.events, holding.id) === 'idle')
    await waitFor(() => waiter.runtime.get(waiting.id)?.status === 'running')
    waiter.controls.adapters[0].finish()
    await waitFor(() => lastStatus(waiter.events, waiting.id) === 'idle')
    expect(worker.pgidAlive(pgid)).toBe(true)
  }, 60_000)

  it('counts a turn settling past turnFinish as work, not as relay-held', async () => {
    const instance = 'poise-relay-settle:db'
    const first = makeRuntime(instance)
    first.controls.auto = false
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    // The agent ignores SIGTERM, so the settle's verified stop takes the
    // relay's whole TERM grace: the settle window stays open for seconds.
    first.runtime.prompt(session.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'trap "" TERM; exec sleep 60']) as RelayConnection
    const pgid = peer.gatePgid
    await waitFor(() => worker.pgidAlive(pgid))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    first.controls.terminateTurns = true
    first.runtime.prompt(session.id, { text: 'Settle slowly', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    // The second prompt reached the adapter, so turnStart ran: spool live.
    await waitFor(() => first.controls.adapters[0].inputs.length === 2)
    // Spool live: invisible to the switch while the agent runs.
    expect(first.runtime.working()).toBe(0)
    expect(first.runtime.relayHeldSessions()).toEqual(new Set([session.id]))
    first.controls.adapters[0].finish()
    // Past turnFinish, still settling the verified stop: only the prime
    // turn finished, and the switch waits for this one.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(ofType(first.events, session.id, 'turn.finished')).toHaveLength(1)
    expect(first.runtime.working()).toBe(2)
    expect(first.runtime.relayHeldSessions()).toEqual(new Set())
    await waitFor(() => ofType(first.events, session.id, 'turn.finished').length === 2, 30_000)
    expect(ofType(first.events, session.id, 'turn.finished')[1]).toMatchObject({ stopReason: 'end_turn' })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle', 30_000)
    expect(worker.pgidAlive(pgid)).toBe(false)
    expect(storage.getRelay(session.id)).toBeNull()
  }, 60_000)

  it('keeps the checkout locked when a failed handoff cannot stop the agent', async () => {
    const instance = 'poise-relay-handoff-keeps-lease:db'
    const lock = await import('../../server/chat/checkout-lock')
    const first = makeRuntime(instance)
    first.controls.auto = false
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    first.runtime.prompt(session.id, { text: 'Start the agent', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const pgid = peer.gatePgid
    const relayPid = peer.relayPid
    const relayDir = peer.dir
    await waitFor(() => worker.pgidAlive(pgid))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const { turnId } = first.runtime.prompt(session.id, { text: 'Hold the checkout', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    await new Promise((r) => setTimeout(r, 200))
    await first.runtime.stop()
    expect(storage.getOpenTurn(session.id)?.turnId).toBe(turnId)

    // The replay fails, and the agent cannot be signalled: termination
    // fails, so the fallback must keep the lease, the rows and the relay.
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [], failReplay: 'replay exploded' })
    const signals = vi.spyOn(worker, 'signalGroup').mockImplementation(() => {})
    try {
      await second.runtime.recover()
      await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 1, 30_000)
      const finished = ofType(second.events, session.id, 'turn.finished')[0]
      expect(finished).toMatchObject({ turnId, stopReason: 'interrupted' })
      expect(finished.error).toContain('relay handoff failed')
      expect(worker.pgidAlive(pgid)).toBe(true)
      expect(storage.getWorker(session.id)).not.toBeNull()
      expect(storage.getRelay(session.id)).not.toBeNull()
      expect(second.runtime.get(session.id)?.interruptedTurnId).toBe(turnId)
      expect(second.runtime.get(session.id)?.orphanNotice).toContain('survived termination')
      expect(second.events.some((e) => e.sessionId === session.id && e.event.type === 'error'
        && (e.event as { message: string }).message === 'the checkout stays locked: the agent process could not be stopped')).toBe(true)
      const row = new lock.CheckoutLease(repo, { ownerKind: 'poise:chat', ownerId: session.id, ownerLabel: '', instance }, {}).read()
      expect(row?.worker_pgid).toBe(pgid)
    } finally {
      signals.mockRestore()
      // Best-effort cleanup of what the fallback deliberately kept.
      worker.signalGroup(pgid, 'SIGKILL')
      await waitFor(() => !worker.pgidAlive(pgid), 10_000).catch(() => undefined)
      try { process.kill(relayPid, 'SIGKILL') } catch { /* gone */ }
      const row = new lock.CheckoutLease(repo, { ownerKind: 'poise:chat', ownerId: session.id, ownerLabel: '', instance }, {}).read()
      if (row?.token) { try { lock.CheckoutLease.releaseByToken(repo, row.token) } catch { /* gone */ } }
      storage.forgetWorker(session.id)
      storage.forgetRelay(session.id)
      await rm(relayDir, { recursive: true, force: true })
      await second.runtime.stop({ handover: false }).catch(() => undefined)
      await first.runtime.stop({ handover: false }).catch(() => undefined)
    }
  }, 60_000)
})
