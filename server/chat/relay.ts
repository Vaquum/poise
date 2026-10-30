// Poise side of the per-session chat relay (scripts/chat-relay.mjs): spawn
// the relay, talk to the agent through it, and reconnect to it after a
// restart. The relay owns the agent's stdio and records the current turn;
// this module presents that as an AgentProcess, so adapters parse relayed
// bytes exactly like process stdio, plus the controls the runtime needs
// (GO, turn boundaries, the recorded outbound stream, shutdown).
//
// The frame codec below mirrors the relay script's; the relay tests drive
// both sides together, so drift between the twins breaks tests, not turns.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { CLAUDE_SUBSCRIPTION_CLI } from '../process'
import { WORKER_GATE, pidAlive, scriptIdentityMatches } from './worker'
import type { AgentProcess } from './adapters/types'

// Next to the worker gate: that path is right both from the source tree and
// from the production bundle, which this file's own location is not.
export const RELAY_SCRIPT = join(dirname(CLAUDE_SUBSCRIPTION_CLI), 'chat-relay.mjs')

const HELLO = 1
const GO = 2
const STDIN = 3
const TURN_START = 4
const TURN_FINISH = 5
const GET_OUTBOUND = 6
const SHUTDOWN = 7
const SIGNAL = 8

const READY = 101
const STARTED = 102
const STDOUT = 103
const STDERR = 104
const EXITED = 105
const LIVE = 106
const OUTBOUND = 107
const PROTOCOL_ERROR = 108

const PROTOCOL_VERSION = 1
const CONNECT_BUDGET_MS = 10_000
const CONTROL_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 20_000
const LOG_TAIL_BYTES = 4 * 1024

function encode(kind: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt8(kind, 0)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

const encodeJson = (kind: number, value: unknown): Buffer => encode(kind, Buffer.from(JSON.stringify(value), 'utf8'))

export interface RelayReady {
  version: number
  relayPid: number
  gatePid: number
  gatePgid: number
  spoolTurn: string | null
}

export interface RelaySpawnOptions {
  sessionId: string
  /** The session's relay directory; the spool and log live under it. The
   *  socket defaults to relaySocketFor(dir) in the temp dir. */
  dir: string
  socketPath?: string
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
  log?: (message: string) => void
  /** Process identities for later verification; minted when absent. */
  ident?: string
  gateIdent?: string
  /** Spawn these scripts instead of this release's own. Tests use this to
   *  stand in for a previous release's directory across a switch. */
  relayScript?: string
  gateScript?: string
}

export interface RelayAttachOptions {
  sessionId: string
  dir: string
  socketPath: string
  relayPid: number
  relayIdent: string
  log?: (message: string) => void
}

/** What the runtime needs from a relay besides the agent's stdio. */
export interface RelayControls {
  readonly sessionId: string
  readonly ident: string
  readonly dir: string
  readonly socketPath: string
  readonly relayPid: number
  gatePid: number
  gatePgid: number
  /** True while the relay process has not been observed to exit. */
  readonly healthy: boolean
  /** Resolves after the adapter consumes every stdout byte before LIVE. */
  whenLive(): Promise<void>
  /** Let the relay start the agent. Fails when the relay is gone. */
  go(): Promise<void>
  turnStart(turnId: string): void
  turnFinish(): void
  /** The turn-scoped Poise-to-agent bytes the relay recorded. */
  getOutbound(): Promise<{ truncated: boolean, bytes: Buffer }>
  /** Stop the agent through the relay and wait for the relay to leave. */
  shutdown(): Promise<void>
  /** Drop this client without stopping anything; the agent keeps running. */
  detach(): void
}

class RelayStdout extends PassThrough {
  constructor(private readonly consumed: (bytes: number) => void) { super() }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const emitted = super.emit(event, ...args)
    // Observing with a data listener here would put the stream in flowing
    // mode before an adapter exists, discarding its buffered spool.
    if (event === 'data' && Buffer.isBuffer(args[0])) this.consumed(args[0].length)
    return emitted
  }
}

/** A relay as an agent process: stdio-compatible for adapters, controllable
 *  for the runtime. Construct, then connect; the constructor starts nothing
 *  so tests can subclass and stub the transport. */
export class RelayConnection extends EventEmitter implements AgentProcess, RelayControls {
  readonly stdin: Writable
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  gatePid = 0
  gatePgid = 0
  relayPid: number
  protected socket: Socket | null = null
  protected child: ChildProcess | null
  private readonly sessionIdValue: string
  private readonly identValue: string
  private readonly dirValue: string
  private readonly socketPathValue: string
  protected readonly log: (message: string) => void
  private buffer: Buffer = Buffer.alloc(0)
  private exitedEmitted = false
  private liveResolve: (() => void) | null = null
  private livePromise: Promise<void>
  private stdoutBytes = 0
  private consumedStdoutBytes = 0
  private liveStdoutBoundary: number | null = null
  private pendingOutbound: { resolve: (value: { truncated: boolean, bytes: Buffer }) => void, reject: (error: Error) => void } | null = null
  private pendingStarted: { resolve: () => void, reject: (error: Error) => void } | null = null

  constructor(options: { sessionId: string, ident: string, dir: string, socketPath: string, relayPid?: number, child?: ChildProcess | null, log?: (message: string) => void }) {
    super()
    this.sessionIdValue = options.sessionId
    this.identValue = options.ident
    this.dirValue = options.dir
    this.socketPathValue = options.socketPath
    this.relayPid = options.relayPid ?? 0
    this.child = options.child ?? null
    this.log = options.log ?? (() => {})
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (!this.socket || this.exitedEmitted) { callback(new Error('the relay is gone')); return }
        try {
          this.socket.write(encode(STDIN, Buffer.from(chunk)), callback)
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)))
        }
      },
    })
    this.stdin.on('error', () => { /* reported through the link, like a dead pipe */ })
    this.stdout = new RelayStdout(bytes => {
      this.consumedStdoutBytes += bytes
      this.resolveLiveWhenConsumed()
    })
    this.stderr = new PassThrough()
    this.livePromise = new Promise((resolve) => { this.liveResolve = resolve })
  }

  get sessionId(): string { return this.sessionIdValue }
  get ident(): string { return this.identValue }
  get dir(): string { return this.dirValue }
  get socketPath(): string { return this.socketPathValue }
  get liveReceived(): boolean { return this.liveStdoutBoundary !== null }
  get exited(): boolean { return this.exitedEmitted }

  get healthy(): boolean {
    if (this.exitedEmitted) return false
    if (this.child) return this.child.exitCode === null && this.child.signalCode === null
    return pidAlive(this.relayPid)
  }

  whenLive(): Promise<void> { return this.livePromise }

  private resolveLiveWhenConsumed(): void {
    if (this.liveStdoutBoundary === null || this.consumedStdoutBytes < this.liveStdoutBoundary) return
    this.liveResolve?.()
    this.liveResolve = null
  }

  /** Connect and hello; resolves with the relay's ready. Rejects when the
   *  relay is unreachable, speaks another protocol, holds another session,
   *  or already has a client. */
  async connect(timeoutMs = CONNECT_BUDGET_MS): Promise<RelayReady> {
    const socket = await this.openSocket(timeoutMs)
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.once('close', () => this.onSocketClose(socket))
    socket.on('error', () => { /* close handling covers it */ })
    socket.write(encodeJson(HELLO, { version: PROTOCOL_VERSION, session: this.sessionIdValue }))
    const ready = await this.awaitReady(socket, timeoutMs)
    this.gatePid = ready.gatePid
    this.gatePgid = ready.gatePgid
    this.relayPid = ready.relayPid
    return ready
  }

  protected openSocket(timeoutMs: number): Promise<Socket> {
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (this.child && this.child.exitCode !== null) {
          reject(new Error(`the relay exited before listening (${relayLogTail(this.dirValue)})`))
          return
        }
        const socket = connect(this.socketPathValue)
        socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket) })
        socket.once('error', (error: Error & { code?: string }) => {
          socket.destroy()
          if ((error.code === 'ENOENT' || error.code === 'ECONNREFUSED') && Date.now() - started < timeoutMs) {
            setTimeout(attempt, 25)
            return
          }
          reject(new Error(`could not reach the relay at ${this.socketPathValue}: ${error.message}`))
        })
      }
      attempt()
    })
  }

  private awaitReady(socket: Socket, timeoutMs: number): Promise<RelayReady> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('the relay did not answer hello')) }, timeoutMs)
      timer.unref()
      const onFrame = (kind: number, payload: Buffer) => {
        if (kind === READY) {
          const ready = JSON.parse(payload.toString('utf8')) as RelayReady
          if (ready?.version !== PROTOCOL_VERSION) {
            clearTimeout(timer)
            reject(new Error(`relay protocol ${ready?.version} is not ${PROTOCOL_VERSION}`))
            return
          }
          clearTimeout(timer)
          this.off('frame', onFrame)
          resolve(ready)
          return
        }
        if (kind === PROTOCOL_ERROR || kind === EXITED) {
          clearTimeout(timer)
          this.off('frame', onFrame)
          const body = JSON.parse(payload.toString('utf8')) as { message?: string, code?: number }
          reject(new Error(kind === EXITED
            ? `the relay's agent is already gone (code ${body.code ?? 'unknown'})`
            : `the relay refused hello: ${body.message ?? 'unknown reason'}`))
        }
      }
      this.on('frame', onFrame)
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= 5) {
      const kind = this.buffer.readUInt8(0)
      const length = this.buffer.readUInt32BE(1)
      if (!Number.isSafeInteger(length) || length > 256 * 1024 * 1024) {
        this.log(`relay frame of ${length} bytes is over the bound`)
        this.socket?.destroy()
        return
      }
      if (this.buffer.length < 5 + length) return
      const payload = this.buffer.subarray(5, 5 + length)
      this.buffer = this.buffer.subarray(5 + length)
      this.emit('frame', kind, payload)
      this.onFrame(kind, payload)
    }
  }

  private onFrame(kind: number, payload: Buffer): void {
    switch (kind) {
      case STDOUT:
        this.stdoutBytes += payload.length
        this.stdout.write(payload.length ? Buffer.from(payload) : Buffer.alloc(0))
        return
      case STDERR:
        this.stderr.write(payload.length ? Buffer.from(payload) : Buffer.alloc(0))
        return
      case LIVE:
        this.liveStdoutBoundary = this.stdoutBytes
        this.resolveLiveWhenConsumed()
        return
      case EXITED: {
        const body = JSON.parse(payload.toString('utf8')) as { code?: number }
        this.settled(typeof body.code === 'number' ? body.code : 1, null)
        return
      }
      case STARTED:
        this.pendingStarted?.resolve()
        this.pendingStarted = null
        return
      case OUTBOUND: {
        const pending = this.pendingOutbound
        this.pendingOutbound = null
        if (!pending) return
        try {
          const body = JSON.parse(payload.toString('utf8')) as { truncated?: boolean, bytes?: string }
          pending.resolve({ truncated: body.truncated === true, bytes: Buffer.from(body.bytes ?? '', 'base64') })
        } catch (error) {
          pending.reject(error instanceof Error ? error : new Error(String(error)))
        }
        return
      }
      case PROTOCOL_ERROR: {
        const body = JSON.parse(payload.toString('utf8')) as { message?: string }
        const message = body.message ?? 'unknown relay error'
        // A relay error never fails the link: the turn it concerns keeps
        // running, and a reconnect falls back when replay is impossible.
        // Replay listens for 'relay-error' and fails loud instead.
        this.log(`relay: ${message}`)
        this.emit('relay-error', message)
        // A refused GO surfaces at the waiter, not as a stray log line.
        const started = this.pendingStarted
        this.pendingStarted = null
        started?.reject(new Error(message))
        return
      }
      case READY:
        return // consumed by awaitReady
      default:
        this.log(`relay sent unknown frame kind ${kind}`)
    }
  }

  private onSocketClose(socket: Socket): void {
    // A detach destroys the socket on purpose; its close is not a death.
    if (socket !== this.socket || this.exitedEmitted) return
    this.socket = null
    // The socket is local: losing it means the relay is gone or broken. A
    // broken relay is terminated — it holds the agent's stdio, so leaving
    // it would orphan the agent from every future Poise.
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.log('relay socket lost while the relay lives; terminating the relay')
      try { this.child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => {
        try {
          if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
        } catch { /* gone */ }
      }, 5_000).unref()
      this.child.once('exit', (code, signal) => this.settled(code, signal))
      return
    }
    if (this.child) {
      const code = this.child.exitCode
      const signal = this.child.signalCode
      // A child that died without reporting either is still gone: report 1
      // rather than leave the peer looking alive to the adapter.
      this.settled(code ?? (signal ? null : 1), signal)
      return
    }
    // Adopted: the relay deliberately keeps the agent after dropping a
    // client (replay overflow, spool failure), so a living relay is a dead
    // link, not a dead agent. Settle it like a detach — no code, no
    // signal — so the runtime keeps the worker and relay rows (and the
    // lease) for a verified shutdown. Only a dead relay is death.
    if (pidAlive(this.relayPid)) {
      this.log('relay socket lost; the relay lives on without this link')
      this.settled(null, null)
      return
    }
    this.log('relay socket lost; the relay is gone')
    this.settled(1, null)
  }

  private settled(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitedEmitted) return
    this.exitedEmitted = true
    this.exitCode = code
    this.signalCode = signal
    this.pendingStarted?.reject(new Error('the relay is gone'))
    this.pendingStarted = null
    this.pendingOutbound?.reject(new Error('the relay is gone'))
    this.pendingOutbound = null
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, signal)
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true
    if (!this.socket || this.socket.destroyed || this.exitedEmitted) return false
    try {
      this.socket.write(encodeJson(SIGNAL, { signal }))
      return true
    } catch {
      return false
    }
  }

  async go(): Promise<void> {
    if (!this.socket || this.exitedEmitted) throw new Error('the relay is gone')
    if (this.pendingStarted) throw new Error('GO is already in flight')
    const sent = new Promise<void>((resolve, reject) => { this.pendingStarted = { resolve, reject } })
    this.socket.write(encodeJson(GO, {}))
    const timeout = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingStarted) { this.pendingStarted = null; reject(new Error('the relay did not confirm GO')) }
      }, CONTROL_TIMEOUT_MS)
      timer.unref()
    })
    await Promise.race([sent, timeout])
  }

  turnStart(turnId: string): void {
    try { this.socket?.write(encodeJson(TURN_START, { turnId })) } catch { /* the relay is gone; the turn fails through the link */ }
  }

  turnFinish(): void {
    try { this.socket?.write(encodeJson(TURN_FINISH, {})) } catch { /* already gone */ }
  }

  async getOutbound(): Promise<{ truncated: boolean, bytes: Buffer }> {
    if (!this.socket || this.exitedEmitted) throw new Error('the relay is gone')
    if (this.pendingOutbound) throw new Error('an outbound read is already in flight')
    let waiter!: NonNullable<RelayConnection['pendingOutbound']>
    const read = new Promise<{ truncated: boolean, bytes: Buffer }>((resolve, reject) => { this.pendingOutbound = waiter = { resolve, reject } })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (this.pendingOutbound !== waiter) return
        this.pendingOutbound = null
        reject(new Error('the relay did not answer the outbound read'))
      }, CONTROL_TIMEOUT_MS)
      timer.unref()
    })
    try {
      this.socket.write(encodeJson(GET_OUTBOUND, {}))
      return await Promise.race([read, timeout])
    } finally {
      clearTimeout(timer)
      if (this.pendingOutbound === waiter) this.pendingOutbound = null
    }
  }

  async shutdown(): Promise<void> {
    const child = this.child
    const asked = !!(this.socket && !this.socket.destroyed && !this.exitedEmitted)
    try { this.socket?.write(encodeJson(SHUTDOWN, {})) } catch { /* already gone */ }
    if (!child) { await this.shutdownAdopted(asked); return }
    if (child.exitCode !== null || child.signalCode !== null) return
    const waitExit = (ms: number): Promise<boolean> => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      timer.unref()
      child.once('exit', () => { clearTimeout(timer); resolve(true) })
    })
    // A graceful shutdown was asked for: give it its window. Without a
    // socket nothing was asked, so go straight to signals.
    let exited = asked ? await waitExit(SHUTDOWN_TIMEOUT_MS) : false
    if (!exited) {
      // Our own child, signalled as the worker gate is: this handle spawned it.
      try { child.kill('SIGTERM') } catch { /* gone */ }
      exited = await waitExit(5_000)
    }
    if (!exited) {
      try { child.kill('SIGKILL') } catch { /* gone */ }
      await waitExit(5_000)
    }
    if (child.exitCode === null && child.signalCode === null) throw new Error(`relay ${child.pid} (${this.sessionIdValue}) is still alive after SIGKILL`)
  }

  /** Shut down a relay another Poise spawned: no child handle, so the
   *  recorded relay pid is waited on and, when it outlasts SHUTDOWN,
   *  signalled — but only after its identity proves it is still our
   *  relay. An unproven pid is left alone; the runtime's group probe
   *  then decides whether the agent is gone. */
  private async shutdownAdopted(asked: boolean): Promise<void> {
    const pid = this.relayPid
    if (asked) await waitPidGone(pid, SHUTDOWN_TIMEOUT_MS)
    if (!pidAlive(pid)) return
    if (!(await relayIdentityMatches(pid, this.identValue))) return
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    if (await waitPidGone(pid, 5_000)) return
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    if (await waitPidGone(pid, 5_000)) return
    throw new Error(`relay ${pid} (${this.sessionIdValue}) is still alive after SIGKILL`)
  }

  detach(): void {
    this.removeAllListeners('frame')
    try { this.socket?.destroy() } catch { /* gone */ }
    this.socket = null
    // The relay keeps running for the next Poise; this handle must not pin
    // the event loop or observe an exit nobody waits for.
    try { this.child?.unref() } catch { /* gone */ }
    // The link died, not the agent: settle local waiters as an exit nobody
    // mistakes for agent death (both codes stay null, so `alive` still
    // reads true) so the runtime hands the turn over instead of waiting on
    // a dead link. Never shut down after a detach: that would kill the
    // relay the next Poise is about to adopt.
    this.settled(null, null)
  }
}

/** Spawn a relay for one agent process. Resolves once the relay listens and
 *  answers hello; the agent itself starts only when the caller sends GO, so
 *  lease registration still precedes the first byte the agent could write. */
export async function spawnRelay(options: RelaySpawnOptions): Promise<RelayConnection> {
  const ident = options.ident ?? randomUUID()
  const gateIdent = options.gateIdent ?? randomUUID()
  const socketPath = options.socketPath ?? relaySocketFor(options.dir)
  const log = options.log ?? (() => {})
  const child = spawn(process.execPath, [
    options.relayScript ?? RELAY_SCRIPT,
    '--relay-session', options.sessionId,
    '--relay-ident', ident,
    '--socket', socketPath,
    '--dir', options.dir,
    '--gate', options.gateScript ?? WORKER_GATE,
    '--lease-worker', gateIdent,
    '--', options.command, ...options.args,
  ], { cwd: options.cwd, env: options.env, detached: true, stdio: 'ignore', windowsHide: true })
  if (!child.pid) {
    try { child.kill('SIGKILL') } catch { /* never started */ }
    throw new Error('could not spawn the chat relay')
  }
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => { child.removeAllListeners('error'); resolve() })
  })
  try {
    await spawned
  } catch (error) {
    throw new Error(`could not spawn the chat relay: ${error instanceof Error ? error.message : String(error)}`)
  }
  const connection = new RelayConnection({ sessionId: options.sessionId, ident, dir: options.dir, socketPath, relayPid: child.pid, child, log })
  try {
    await connection.connect()
  } catch (error) {
    try { child.kill('SIGKILL') } catch { /* gone */ }
    throw error
  }
  return connection
}

/** How long an adoption waits for the LIVE boundary before the handoff
 *  fails. This bounds the attachment and catch-up only: once live, a
 *  healthy long turn runs on without a deadline. */
export const ADOPTION_LIVE_TIMEOUT_MS = 60_000

/** Resolves once the peer carries live bytes; rejects when the relay
 *  reports the replay cannot be exact or goes away mid-replay. A turn that
 *  already settled keeps its result: only a replay still waiting fails.
 *  With `timeoutMs`, a handoff that never goes live fails instead of
 *  hanging: the runtime then ends the turn and its processes. An adapter
 *  that rejects its replay before subscribing must not take Poise down
 *  with it, so the promise carries its own rejection handler: consumers
 *  still observe the rejection, but a dropped promise never surfaces as
 *  an unhandled rejection. */
export function livePromise(peer: RelayConnection, timeoutMs?: number): Promise<void> {
  const pending = new Promise<void>((resolve, reject) => {
    const onError = (message: unknown) => { cleanup(); reject(new Error(`relay: ${String(message)}`)) }
    const onExit = () => {
      // An actual LIVE frame can precede EXITED in the same decoder callback.
      // Its buffered stdout must still reach the adapter before replay ends.
      if (peer.liveReceived) return
      cleanup()
      reject(new Error('the relay went away during replay'))
    }
    const onTimeout = () => {
      cleanup()
      reject(new Error(`the relay did not go live within ${timeoutMs} ms`))
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    if (timeoutMs !== undefined) {
      timer = setTimeout(onTimeout, timeoutMs)
      timer.unref()
    }
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      peer.off('relay-error', onError)
      peer.off('exit', onExit)
    }
    peer.once('relay-error', onError)
    peer.once('exit', onExit)
    void peer.whenLive().then(() => { cleanup(); resolve() })
    if (peer.exited) onExit()
  })
  // Marks the promise handled without consuming it: awaiting consumers
  // still observe resolve and reject as before.
  void pending.catch(() => undefined)
  return pending
}

/** Connect to a relay another Poise left running. The caller proves the pid
 *  first with relayIdentityMatches; this only speaks the protocol. */
export async function attachRelay(options: RelayAttachOptions): Promise<{ connection: RelayConnection, ready: RelayReady }> {
  const connection = new RelayConnection({
    sessionId: options.sessionId, ident: options.relayIdent, dir: options.dir,
    socketPath: options.socketPath, relayPid: options.relayPid, log: options.log,
  })
  const ready = await connection.connect()
  return { connection, ready }
}

export function relayDirFor(chatRoot: string, sessionId: string): string {
  return join(chatRoot, 'relays', sessionId)
}

/** Where a session's relay listens. Unix socket paths are capped at 108
 *  bytes, which a nested relay dir exceeds — the bind then truncates
 *  while unlink targets the full path, so a respawned relay meets its
 *  own stale file as EADDRINUSE. The socket therefore lives in the
 *  system temp dir under a hash of its relay dir: short, stable per
 *  session (a replacement unlinks the same stale path), and unique per
 *  dir. The spool and log stay under the relay dir; only the socket has
 *  the length limit. */
export function relaySocketFor(dir: string): string {
  return join(tmpdir(), `poise-chat-relay-${createHash('sha256').update(dir).digest('hex').slice(0, 16)}.sock`)
}

export function relayLogTail(dir: string): string {
  try {
    const log = readFileSync(join(dir, 'relay.log'), 'utf8')
    const tail = log.slice(-LOG_TAIL_BYTES).trim().split('\n').slice(-3).join(' | ')
    return tail || 'no relay log'
  } catch {
    return 'no relay log'
  }
}

async function waitPidGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

/** Whether `pid` is still the relay recorded: its command line must be the
 *  relay script carrying `--relay-ident <ident>` as its own argument. The
 *  script may run from any release's scripts directory (see
 *  scriptIdentityMatches); a release switch must not break verification. */
export async function relayIdentityMatches(pid: number, ident: string): Promise<boolean> {
  return scriptIdentityMatches(pid, ident, 'chat-relay.mjs', 'relay-ident')
}
