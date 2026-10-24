// A release switch with running chat turns: the new server adopts every
// relay-held turn even though the relay and gate still run from the
// previous release's scripts directory, reattaches the event stream,
// retires the old relay when the turn settles, and dispatches what queued
// behind it. A handoff that fails ends the turn and its processes within
// its bound instead of leaving them running unseen.

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentId, ChatEnvelope, ChatEvent, PromptInput, PromptReceipt } from '../../server/chat/protocol'
import type { Adapter, AdapterHost, AdapterStartOptions, ReplayInit } from '../../server/chat/adapters/types'
import type { CallerTurns } from '../../server/chat/caller-turns'
import type { RelayConnection } from '../../server/chat/relay'
import { CATALOG } from '../model-catalog-fixture'

let root = ''
let repo = ''
let runtimeModule: typeof import('../../server/chat/runtime')
let storage: typeof import('../../server/chat/storage')
let worker: typeof import('../../server/chat/worker')
let relayModule: typeof import('../../server/chat/relay')

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
  /** Hold replay until the test releases it. */
  replayGate?: Promise<void>
  /** Makes cancel() a no-op: the turn never acknowledges the stop. */
  ignoreCancel?: boolean
  /** Spawns this command when an adapter starts, like a real adapter. */
  startWorker?: string[]
}

class FakeAdapter implements Adapter {
  agent: AgentId = 'grok'
  nativeSessionId: string | undefined
  capabilities = { steer: true, fork: true, thought: true, plan: true, commands: true, modes: false, permissions: true, questions: true, resume: true, images: false }
  alive = false
  inputs: PromptInput[] = []
  steers: string[] = []
  private finishTurn: ((stop?: 'end_turn' | 'cancelled') => void) | null = null
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  constructor(readonly host: AdapterHost, readonly controls: FakeControls) {
    const spawn = host.spawn.bind(host)
    host.spawn = (async (command, args, options) => {
      const peer = await spawn(command, args, options)
      if (this.controls.exitAware !== false) peer.once('exit', () => this.finishTurn?.('cancelled'))
      return peer
    })
  }
  async start(options: AdapterStartOptions) {
    const command = this.controls.startWorker
    this.alive = true
    this.nativeSessionId = options.resume || `native-${this.controls.adapters.length}`
    if (command) await this.host.spawn(command[0], command.slice(1))
    return { nativeSessionId: this.nativeSessionId, capabilities: this.capabilities, modelId: options.modelId, effort: options.effort, efforts: ['high', 'xhigh'] }
  }
  async prompt(turnId: string, input: PromptInput, signal: AbortSignal) {
    this.inputs.push(input)
    this.host.emit({ type: 'text.delta', turnId, messageId: `${turnId}:m1`, delta: `echo: ${input.text}` })
    if (this.controls.auto) return { stopReason: 'end_turn' as const, usage: { totalTokens: 3 } }
    return new Promise<{ stopReason: 'end_turn' | 'cancelled', terminate?: true }>((resolve) => {
      this.finishTurn = (stop = 'end_turn') => {
        this.finishTurn = null
        resolve({ stopReason: stop })
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
    return { stopReason: 'end_turn' as const, usage: { totalTokens: 3 } }
  }
  async steer(text: string) { this.steers.push(text) }
  finish() { this.finishTurn?.('end_turn') }
  async cancel() { if (!this.controls.ignoreCancel) this.finishTurn?.('cancelled') }
  async setModel(modelId: string, effort: string) { return { modelId, effort } }
  async setMode() {}
  async fork() { return `${this.nativeSessionId}-fork` }
  async close() { this.alive = false; for (const l of this.exitListeners) l(0, null) }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) { this.exitListeners.push(listener) }
}

const runtimes: Array<import('../../server/chat/runtime').ChatRuntime> = []

function makeRuntime(instance: string, controls?: FakeControls, extra?: {
  relayScripts?: { relay: string, gate: string }
  maxConcurrentLocalTurns?: () => number
  adoptionLiveTimeoutMs?: number
  localWorkspaceRoot?: string
}) {
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
    ...(extra?.relayScripts ? { relayScripts: extra.relayScripts } : {}),
    ...(extra?.maxConcurrentLocalTurns ? { maxConcurrentLocalTurns: extra.maxConcurrentLocalTurns } : {}),
    ...(extra?.adoptionLiveTimeoutMs !== undefined ? { adoptionLiveTimeoutMs: extra.adoptionLiveTimeoutMs } : {}),
    ...(extra?.localWorkspaceRoot ? { localWorkspaceRoot: extra.localWorkspaceRoot } : {}),
  })
  const events: ChatEnvelope[] = []
  runtime.on('event', (e: ChatEnvelope) => events.push(e))
  runtimes.push(runtime)
  return { runtime, controls: owned, events, finishes }
}

/** A stand-in previous release's scripts directory, mirroring the
 *  installed layout (`releases/<release>/poise/scripts/`). */
function oldReleaseScripts(tag: string): { relay: string, gate: string } {
  const dir = join(root, 'switch-releases', tag, 'poise', 'scripts')
  mkdirSync(dir, { recursive: true })
  const from = dirname(relayModule.RELAY_SCRIPT)
  for (const file of ['chat-relay.mjs', 'chat-worker-gate.mjs']) copyFileSync(join(from, file), join(dir, file))
  return { relay: join(dir, 'chat-relay.mjs'), gate: join(dir, 'chat-worker-gate.mjs') }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-relay-switch-'))
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
  relayModule = await import('../../server/chat/relay')
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

function requireTurn(receipt: PromptReceipt): { turnId: string } {
  if (!('turnId' in receipt)) throw new Error(`expected a reserved turn, got update wait ${receipt.waitId}`)
  return receipt
}

const ofType = (events: ChatEnvelope[], id: string, type: ChatEvent['type']) => events.filter((e) => e.sessionId === id && e.event.type === type).map((e) => e.event as any)
const lastStatus = (events: ChatEnvelope[], id: string) => ofType(events, id, 'status.changed').at(-1)?.status

describe('release switch adoption', () => {
  it('adopts a relay-held turn across a release switch and dispatches its queued follow-up', async () => {
    const instance = 'poise-switch-adopt:db'
    const old = oldReleaseScripts('oldrelease')
    const first = makeRuntime(instance, { hosts: [], adapters: [], auto: false, replayTurns: [] }, { relayScripts: old })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    first.runtime.prompt(session.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const pgid = peer.gatePgid
    await waitFor(() => worker.pgidAlive(pgid))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    // A follow-up queued while the turn runs: enqueue never arms it.
    await first.runtime.enqueue(session.id, randomUUID(), { text: 'Follow up', attachments: [], mentions: [] })
    const { turnId } = requireTurn(first.runtime.prompt(session.id, { text: 'Survive the switch', attachments: [], mentions: [] }))
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    await new Promise((r) => setTimeout(r, 200))
    // The premise: the relay and gate run from the previous release.
    const relayRow = storage.getRelay(session.id)!
    const workerRow = storage.getWorker(session.id)!
    expect(spawnSync('ps', ['-o', 'command=', '-p', String(relayRow.relayPid)], { encoding: 'utf8' }).stdout)
      .toContain(join('releases', 'oldrelease'))
    expect(spawnSync('ps', ['-o', 'command=', '-p', String(workerRow.gatePid)], { encoding: 'utf8' }).stdout)
      .toContain(join('releases', 'oldrelease'))

    // The switch: the old server hands the turn over and is gone.
    await first.runtime.stop()
    expect(storage.getOpenTurn(session.id)?.turnId).toBe(turnId)
    expect(worker.pgidAlive(pgid)).toBe(true)

    // The new server runs this release's scripts and adopts the turn.
    let releaseReplay = () => {}
    const gate = new Promise<void>((resolve) => { releaseReplay = resolve })
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [], replayGate: gate })
    await second.runtime.recover()
    try {
      await waitFor(() => second.controls.replayTurns.length === 1)
      expect(second.controls.replayTurns[0].turnId).toBe(turnId)
      // Adopted, not interrupted: running, with the event stream reattached.
      expect(second.runtime.get(session.id)?.status).toBe('running')
      await second.controls.replayTurns[0].live
      releaseReplay()
      await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 1)
      expect(ofType(second.events, session.id, 'turn.finished')[0]).toMatchObject({ turnId, stopReason: 'end_turn' })
      await waitFor(() => second.runtime.get(session.id)?.status === 'idle')
      // The old release's relay and agent retire with the adopted turn.
      await waitFor(() => !worker.pgidAlive(pgid), 10_000)
      expect(storage.getRelay(session.id)).toBeNull()
      expect(storage.getWorker(session.id)).toBeNull()
      // The queued follow-up starts on its own: no Resume, no fresh send.
      // (The adopted turn's own turn.started went to the first server.)
      await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 2, 15_000)
      expect(ofType(second.events, session.id, 'turn.started')).toHaveLength(1)
      expect(ofType(second.events, session.id, 'turn.started')[0].queueItemId).toBeTruthy()
      expect(ofType(second.events, session.id, 'turn.finished')[1]).toMatchObject({ stopReason: 'end_turn' })
      // A fresh relay from this release, resuming the same native session.
      expect(second.controls.adapters).toHaveLength(2)
      expect(second.controls.adapters[1].nativeSessionId).toBe(second.controls.adapters[0].nativeSessionId)
    } finally {
      releaseReplay()
      await second.runtime.stop({ handover: false })
    }
  }, 60_000)

  it('steers an adopted turn', async () => {
    const instance = 'poise-switch-steer:db'
    const first = makeRuntime(instance, { hosts: [], adapters: [], auto: false, replayTurns: [] })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    first.runtime.prompt(session.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    await waitFor(() => worker.pgidAlive(peer.gatePgid))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    requireTurn(first.runtime.prompt(session.id, { text: 'Survive the switch', attachments: [], mentions: [] }))
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    await new Promise((r) => setTimeout(r, 200))
    await first.runtime.stop()

    let releaseReplay = () => {}
    const gate = new Promise<void>((resolve) => { releaseReplay = resolve })
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [], replayGate: gate })
    try {
      await second.runtime.recover()
      await waitFor(() => second.controls.replayTurns.length === 1)
      await second.runtime.steer(session.id, 'hurry up')
      expect(second.controls.adapters[0].steers).toHaveLength(1)
      expect(second.controls.adapters[0].steers[0]).toContain('hurry up')
      releaseReplay()
      await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 1)
      expect(ofType(second.events, session.id, 'turn.finished')[0]).toMatchObject({ stopReason: 'end_turn' })
    } finally {
      releaseReplay()
      await second.runtime.stop({ handover: false })
    }
  }, 60_000)

  it('terminates a stopped turn at shutdown instead of handing it over', async () => {
    const instance = 'poise-switch-stop-handover:db'
    const first = makeRuntime(instance, { hosts: [], adapters: [], auto: false, replayTurns: [] })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    // A first turn starts the agent; the stopped turn below then finds the
    // relay already holding it, so handover would engage without the Stop.
    first.runtime.prompt(session.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const pgid = peer.gatePgid
    await waitFor(() => worker.pgidAlive(pgid))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const { turnId } = requireTurn(first.runtime.prompt(session.id, { text: 'Survive the switch', attachments: [], mentions: [] }))
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    await new Promise((r) => setTimeout(r, 200))
    // The Stop was asked and recorded; shutdown must finish it here.
    const live = (first.runtime as any).live.get(session.id)
    live.record.stopRequestedTurnId = turnId
    storage.saveSession(live.record)
    await first.runtime.stop()
    expect(live.relayDetached).toBe(false)
    expect(storage.getOpenTurn(session.id)).toBeNull()
    await waitFor(() => !worker.pgidAlive(pgid), 10_000)
    expect(ofType(first.events, session.id, 'turn.finished')).toHaveLength(2)
    expect(ofType(first.events, session.id, 'turn.finished')[1]).toMatchObject({ turnId, stopReason: 'cancelled' })
  }, 60_000)

  it('finishes a stopped turn instead of adopting it after a restart', async () => {
    const instance = 'poise-switch-stop-restart:db'
    const queueModule = await import('../../server/chat/message-queue')
    const holdsModule = await import('../../server/chat/control-store')
    const first = makeRuntime(instance, { hosts: [], adapters: [], auto: false, replayTurns: [], exitAware: false })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    // A first turn starts the agent; the stopped turn below then finds the
    // relay already holding it, so adoption would engage without the Stop.
    first.runtime.prompt(session.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const pgid = peer.gatePgid
    await waitFor(() => worker.pgidAlive(pgid))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const { turnId } = requireTurn(first.runtime.prompt(session.id, { text: 'Survive the switch', attachments: [], mentions: [] }))
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    await first.runtime.enqueue(session.id, randomUUID(), { text: 'Later', attachments: [], mentions: [] })
    await new Promise((r) => setTimeout(r, 200))
    // The person's Stop landed and was recorded, with its hold and pause;
    // the crash came before the turn settled.
    const stored = storage.getSession(session.id)!
    storage.saveSession({ ...stored, stopRequestedTurnId: turnId })
    queueModule.pauseQueue(session.id)
    holdsModule.holdChat(instance, session.id, 'stopped', Date.now())
    // Crash: the first server dies with its sockets — a dead link settles
    // nothing — while its relay and agent run on.
    peer.detach()
    // The relay drops the dead client asynchronously; a real restart boots
    // for seconds before probing, so wait for hello to answer again.
    const relayRow = storage.getRelay(session.id)!
    const deadline = Date.now() + 5_000
    for (;;) {
      try {
        const probed = await relayModule.attachRelay({ sessionId: session.id, dir: relayRow.dir,
          socketPath: relayRow.socket, relayPid: relayRow.relayPid, relayIdent: relayRow.relayIdent })
        probed.connection.detach()
        break
      } catch {
        if (Date.now() > deadline) throw new Error('the relay never freed the dead client')
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [] })
    await second.runtime.recover()
    await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 1)
    expect(second.controls.replayTurns).toHaveLength(0)
    expect(ofType(second.events, session.id, 'turn.finished')[0]).toMatchObject({ turnId, stopReason: 'cancelled' })
    await waitFor(() => !worker.pgidAlive(pgid), 10_000)
    expect(storage.getWorker(session.id)).toBeNull()
    expect(storage.getRelay(session.id)).toBeNull()
    // The stopped chat dispatches nothing until the person sends again.
    await new Promise((r) => setTimeout(r, 500))
    expect(ofType(second.events, session.id, 'turn.started')).toHaveLength(0)
    expect(queueModule.readQueue(session.id).ready).toBe(false)
    await second.runtime.stop({ handover: false })
  }, 60_000)

  it('heals a stranded session on resume even after the new agent replaced the worker row', async () => {
    const instance = 'poise-switch-resume-replaced:db'
    const leaseModule = await import('../../server/chat/checkout-lock')
    const first = makeRuntime(instance, { hosts: [], adapters: [], auto: false, replayTurns: [], exitAware: false })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    requireTurn(first.runtime.prompt(session.id, { text: 'Get stranded', attachments: [], mentions: [] }))
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const oldWorker = storage.getWorker(session.id)!
    await waitFor(() => worker.pgidAlive(oldWorker.gatePgid))
    await first.runtime.enqueue(session.id, randomUUID(), { text: 'Follow up', attachments: [], mentions: [] })
    // The incident state: the old worker is gone, its turn is still open,
    // and the orphan notice is set — but the lease file is free, so a
    // resume starts a new agent before reaching the cleanup.
    process.kill(-oldWorker.gatePgid, 'SIGKILL')
    await waitFor(() => !worker.pgidAlive(oldWorker.gatePgid))
    leaseModule.CheckoutLease.releaseByToken(repo, oldWorker.leaseToken!)
    const stored = storage.getSession(session.id)!
    storage.saveSession({ ...stored, orphanNotice: 'a worker recorded for this session is still running but could not be verified; stop it by hand' })
    // Crash: the first server never stops.
    peer.detach()
    // Like a real adapter, starting the new agent spawns a new worker and
    // replaces the worker row before the cleanup below runs.
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [], startWorker: ['sh', '-c', 'sleep 60'] })
    await second.runtime.resume(session.id)
    expect(second.runtime.get(session.id)?.orphanNotice).toBeUndefined()
    await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 1)
    expect(ofType(second.events, session.id, 'turn.finished')[0]).toMatchObject({ stopReason: 'interrupted' })
    expect(ofType(second.events, session.id, 'turn.finished')[0].error).toContain('outcome is unknown')
    // The old row is judged, never the new worker: it survives.
    const current = storage.getWorker(session.id)!
    expect(current.ident).not.toBe(oldWorker.ident)
    expect(worker.pgidAlive(current.gatePgid)).toBe(true)
    // And the follow-up dispatches behind the healed session.
    await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 2, 15_000)
    expect(ofType(second.events, session.id, 'turn.finished')[1]).toMatchObject({ stopReason: 'end_turn' })
    await second.runtime.stop({ handover: false })
  }, 60_000)

  it('records a Stop durably and clears it on the next turn', async () => {
    const instance = 'poise-switch-stop-marker:db'
    const first = makeRuntime(instance, { hosts: [], adapters: [], auto: false, replayTurns: [] })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const { turnId } = requireTurn(first.runtime.prompt(session.id, { text: 'Stop me', attachments: [], mentions: [] }))
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    await first.runtime.cancel(session.id, { kind: 'person' })
    expect(storage.getSession(session.id)?.stopRequestedTurnId).toBe(turnId)
    requireTurn(first.runtime.prompt(session.id, { text: 'Again', attachments: [], mentions: [] }))
    expect(storage.getSession(session.id)?.stopRequestedTurnId).toBeUndefined()
  }, 60_000)

  it('ends a failed adoption and its processes within its bound, then dispatches the queued follow-up', async () => {
    const instance = 'poise-switch-handoff-fails:db'
    const first = makeRuntime(instance, { hosts: [], adapters: [], auto: false, replayTurns: [] })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    first.runtime.prompt(session.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const pgid = peer.gatePgid
    await waitFor(() => worker.pgidAlive(pgid))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    await first.runtime.enqueue(session.id, randomUUID(), { text: 'Follow up', attachments: [], mentions: [] })
    const { turnId } = requireTurn(first.runtime.prompt(session.id, { text: 'Survive the switch', attachments: [], mentions: [] }))
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    await new Promise((r) => setTimeout(r, 200))
    await first.runtime.stop()

    const live = relayModule.livePromise
    const seen: Array<number | undefined> = []
    const spy = vi.spyOn(relayModule, 'livePromise').mockImplementation(((peer: any, timeoutMs?: number) => {
      seen.push(timeoutMs)
      return live(peer, timeoutMs)
    }) as any)
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [], failReplay: 'replay exploded' }, { adoptionLiveTimeoutMs: 1234 })
    try {
      await second.runtime.recover()
      await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 1)
      expect(ofType(second.events, session.id, 'turn.finished')[0]).toMatchObject({ turnId, stopReason: 'interrupted' })
      expect(ofType(second.events, session.id, 'turn.finished')[0].error).toContain('relay handoff failed')
      expect(seen).toEqual([1234])
      await waitFor(() => !worker.pgidAlive(pgid), 10_000)
      expect(storage.getWorker(session.id)).toBeNull()
      expect(storage.getRelay(session.id)).toBeNull()
      await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 2, 15_000)
      expect(ofType(second.events, session.id, 'turn.finished')[1]).toMatchObject({ stopReason: 'end_turn' })
    } finally {
      spy.mockRestore()
      await second.runtime.stop({ handover: false })
    }
  }, 60_000)

  it('reconciles a session stranded by an earlier switch', async () => {
    const instance = 'poise-switch-stranded:db'
    const first = makeRuntime(instance, { hosts: [], adapters: [], auto: false, replayTurns: [], exitAware: false })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    first.runtime.prompt(session.id, { text: 'Get stranded', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const pgid = peer.gatePgid
    await waitFor(() => worker.pgidAlive(pgid))
    await first.runtime.enqueue(session.id, randomUUID(), { text: 'Follow up', attachments: [], mentions: [] })
    // The incident state: relay row deleted, turn finalized as interrupted,
    // orphan set, worker row kept, agent still running.
    const open = storage.getOpenTurn(session.id)!
    storage.forgetRelay(session.id)
    storage.finalizeTurn(session.id, { type: 'turn.finished', turnId: open.turnId, stopReason: 'interrupted', error: 'Poise restarted while this turn was running' })
    const stored = storage.getSession(session.id)!
    storage.saveSession({ ...stored, status: 'interrupted', interruptedTurnId: open.turnId,
      orphanNotice: 'a worker recorded for this session is still running but could not be verified; stop it by hand' })
    // Crash: the first server dies with its sockets — a dead link settles
    // nothing — while its agent runs on, stranded.
    peer.detach()
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [] })
    await second.runtime.recover()
    await waitFor(() => !worker.pgidAlive(pgid), 10_000)
    expect(storage.getWorker(session.id)).toBeNull()
    expect(second.runtime.get(session.id)?.orphanNotice).toBeUndefined()
    await waitFor(() => ofType(second.events, session.id, 'turn.finished').length === 1, 15_000)
    expect(ofType(second.events, session.id, 'turn.finished')[0]).toMatchObject({ stopReason: 'end_turn' })
    await second.runtime.stop({ handover: false })
  }, 60_000)

  it('leaves a deliberately unarmed queue parked when recovering an idle worker', async () => {
    const instance = 'poise-switch-idle-parked:db'
    const queueModule = await import('../../server/chat/message-queue')
    const first = makeRuntime(instance, { hosts: [], adapters: [], auto: false, replayTurns: [] })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    first.runtime.prompt(session.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(session.id)?.status === 'running')
    const peer = await first.controls.hosts[0].spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    await waitFor(() => worker.pgidAlive(peer.gatePgid))
    first.controls.adapters[0].finish()
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    // Parked behind no turn: no interruption strands it.
    await first.runtime.enqueue(session.id, randomUUID(), { text: 'Parked', attachments: [], mentions: [] })
    expect(queueModule.readQueue(session.id).ready).toBe(false)
    // Crash with an idle worker and no orphan notice.
    peer.detach()
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [] })
    await second.runtime.recover()
    await waitFor(() => !worker.pgidAlive(peer.gatePgid), 10_000)
    expect(storage.getWorker(session.id)).toBeNull()
    await new Promise((r) => setTimeout(r, 500))
    expect(queueModule.readQueue(session.id).ready).toBe(false)
    expect(ofType(second.events, session.id, 'turn.started')).toHaveLength(0)
    await second.runtime.stop({ handover: false })
  }, 60_000)

  it('adopts every surviving turn promptly when survivors exceed a lowered cap', async () => {
    const instance = 'poise-switch-cap:db'
    // Two checkouts: each adoption claims its own lease.
    const c1 = join(root, 'switch-cap-1')
    const c2 = join(root, 'switch-cap-2')
    git(['clone', '-q', repo, c1])
    git(['clone', '-q', repo, c2])
    const first = makeRuntime(instance, { hosts: [], adapters: [], auto: false, replayTurns: [] })
    const s1 = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', checkout: c1, branch: { existing: 'main' } })
    const s2 = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', checkout: c2, branch: { existing: 'main' } })
    await waitFor(() => lastStatus(first.events, s1.id) === 'idle' && lastStatus(first.events, s2.id) === 'idle')
    const h1 = first.controls.hosts.find((h) => h.sessionId === s1.id)!
    const h2 = first.controls.hosts.find((h) => h.sessionId === s2.id)!
    // A first turn on each session starts its agent; the surviving turns
    // below then find their relays already holding them.
    first.runtime.prompt(s1.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    first.runtime.prompt(s2.id, { text: 'Prime the relay', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(s1.id)?.status === 'running' && first.runtime.get(s2.id)?.status === 'running')
    const p1 = await h1.spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    const p2 = await h2.spawn('sh', ['-c', 'sleep 60']) as RelayConnection
    await waitFor(() => worker.pgidAlive(p1.gatePgid) && worker.pgidAlive(p2.gatePgid))
    for (const adapter of first.controls.adapters) adapter.finish()
    await waitFor(() => lastStatus(first.events, s1.id) === 'idle' && lastStatus(first.events, s2.id) === 'idle')
    first.runtime.prompt(s1.id, { text: 'Survive the switch', attachments: [], mentions: [] })
    first.runtime.prompt(s2.id, { text: 'Survive the switch', attachments: [], mentions: [] })
    await waitFor(() => first.runtime.get(s1.id)?.status === 'running' && first.runtime.get(s2.id)?.status === 'running')
    await new Promise((r) => setTimeout(r, 200))
    await first.runtime.stop()

    let releaseReplay = () => {}
    const gate = new Promise<void>((resolve) => { releaseReplay = resolve })
    const second = makeRuntime(instance, { hosts: [], adapters: [], auto: true, replayTurns: [], replayGate: gate }, { maxConcurrentLocalTurns: () => 1 })
    try {
      await second.runtime.recover()
      // Both adopted despite the cap of one — never parked behind it.
      await waitFor(() => second.controls.replayTurns.length === 2)
      expect(second.runtime.get(s1.id)?.status).toBe('running')
      expect(second.runtime.get(s2.id)?.status).toBe('running')
      releaseReplay()
      await waitFor(() => ofType(second.events, s1.id, 'turn.finished').length === 1 && ofType(second.events, s2.id, 'turn.finished').length === 1)
    } finally {
      releaseReplay()
      await second.runtime.stop({ handover: false })
    }
  }, 60_000)

  it('keeps the chat ownership of its scratch checkout across an agent-cut branch', async () => {
    const instance = 'poise-switch-scratch:db'
    const first = makeRuntime(instance, undefined, { localWorkspaceRoot: join(root, '.poise-chat-scratch') })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh' })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const branch = first.runtime.get(session.id)!.branch.name
    // The agent cut its own branch and left uncommitted work, then vanished.
    git(['switch', '-q', '-c', 'agent/wip'], session.checkout)
    await writeFile(join(session.checkout, 'wip.txt'), 'uncommitted work\n')
    first.runtime.prompt(session.id, { text: 'Continue', attachments: [], mentions: [] })
    await waitFor(() => ofType(first.events, session.id, 'turn.finished').length === 1, 15_000)
    expect(ofType(first.events, session.id, 'turn.finished')[0]).toMatchObject({ stopReason: 'end_turn' })
    expect(git(['log', '--format=%s', '-1', 'agent/wip'], session.checkout)).toContain('checkpoint')
    expect(git(['branch', '--show-current'], session.checkout)).toBe(branch)
  }, 60_000)

  it('retains a detached-HEAD self-checkpoint on a branch instead of dangling it', async () => {
    const instance = 'poise-switch-detached:db'
    const first = makeRuntime(instance, undefined, { localWorkspaceRoot: join(root, '.poise-chat-detached') })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh' })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    const branch = first.runtime.get(session.id)!.branch.name
    // The agent left the checkout on a detached HEAD with uncommitted work.
    git(['switch', '--quiet', '--detach', 'HEAD'], session.checkout)
    await writeFile(join(session.checkout, 'wip.txt'), 'uncommitted work\n')
    first.runtime.prompt(session.id, { text: 'Continue', attachments: [], mentions: [] })
    await waitFor(() => ofType(first.events, session.id, 'turn.finished').length === 1, 30_000)
    expect(ofType(first.events, session.id, 'turn.finished')[0]).toMatchObject({ stopReason: 'end_turn' })
    const retained = `poise/checkpoint/${session.id.slice(0, 8)}`
    expect(git(['log', '--format=%s', '-1', retained], session.checkout)).toContain('checkpoint')
    expect(git(['show', `${retained}:wip.txt`], session.checkout)).toContain('uncommitted work')
    expect(git(['branch', '--show-current'], session.checkout)).toBe(branch)
  }, 60_000)
})
