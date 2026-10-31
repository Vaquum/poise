import { ensureSnippetSwitch, readSwitches, readSkillSnippets, snippetLibraryEvents } from '../snippet-library'
import { MANAGER_SWITCH, WORKER_SWITCH, type ChatSwitches } from '../../src/chat-switches'
import { MANAGER_SNIPPET_DEFAULT } from './manager-default'
import { WORKER_SNIPPET_DEFAULT } from './worker-default'
import { readChatFile } from './file-preview'
import { readMemories, saveMemories } from './memories'
import { markWakeArmed, saveWake } from './manager-settings'
// The browser-facing side of Chat v1: the WebSocket at /ws/chat (events
// down, commands up) and the REST routes under /api/chat.
//
// The WebSocket upgrade is held to the same trust boundary as every API
// request — allowed host, no cross-site fetch metadata, an Origin that
// matches the host — before the socket is accepted; a browser always sends
// Origin on an upgrade, so a missing one is accepted only from loopback like
// a CLI probe. In service mode the gateway's upgrade also needs a browser
// identity assertion. Each command frame carries a client request id: an id the
// server already answered is answered again from a bounded cache instead of
// being executed twice, which is what makes resending after a reconnect safe.
// A subscriber that falls too far behind is disconnected rather than buffered
// without limit; it comes back and asks for everything after its last seq.

import { STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { ATTACHMENT_MAX_BYTES, HttpError, enforceApiRequest, httpStatus, readBuffer, readJson, type ApiRequestPolicy, type RequestAuthority } from '../http'
import { SELF_UPDATE_OFF, SERVICE_MODE_CODE } from '../service/turned-off'
import { runFile } from '../process'
import { handleGhBody } from '../gh'
import { getChatSettings } from '../settings'
import { inspectCheckout } from './git'
import { CHAT_LIMITS, WS_PATH, type Attachment, type ChatCommand, type ChatEnvelope, type ChatSubject, type ClientFrame, type ServerFrame } from './protocol'
import { ChatError, type ChatRuntime } from './runtime'
import type { ChatControl } from './control'
import { legacyIdFor, readLegacyConversation } from './legacy-import'
import * as storage from './storage'
import { executeCommandOnce } from './command-receipts'
import { clientEnvelope } from './event-preview'
import { SWITCHBOARD_CHAT_COMMANDS, SWITCHBOARD_PATH, type Switchboard } from './switchboard'

const MAX_CONNECTION_COMMANDS = 64
const REPLAY_BATCH = 100
const MAX_SUBSCRIPTIONS = 64
const SOCKET_BUFFER_LIMIT = 8 * 1024 * 1024

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function errorBody(error: unknown): { error: string, code?: string, manager?: { id: string } } {
  const message = error instanceof Error ? error.message : String(error)
  return error instanceof ChatError ? { error: message, code: error.code, ...error.detail } : { error: message }
}

function errorStatus(error: unknown): number {
  if (error instanceof ChatError) return error.statusCode
  return httpStatus(error, 400)
}

// ── WebSocket ──────────────────────────────────────────────────────────────

interface Connection {
  socket: WebSocket
  subscriptions: Map<string, number>
  replays: Map<string, symbol>
  activeCommands: number
}

export class ChatSocketServer {
  private readonly wss: WebSocketServer
  private readonly connections = new Set<Connection>()
  private readonly serverStartedAt = `${new Date().toISOString()}:${randomUUID()}`
  private closing: Promise<void> | null = null
  private readonly upgrades = new Map<Server, (req: IncomingMessage, socket: Duplex, head: Buffer) => void>()
  private libraryRevision = -1
  private readonly libraryPoll = setInterval(() => {
    if (!this.connections.size) return
    try { this.onSwitches(readSwitches()) } catch { /* keep the last readable library; GET reports errors */ }
  }, 2_000).unref()
  private readonly onSwitches = (catalogue: ChatSwitches) => {
    if (catalogue.revision === this.libraryRevision) return
    this.libraryRevision = catalogue.revision
    for (const connection of this.connections) this.send(connection, { kind: 'switches.updated', catalogue })
  }
  private readonly onEvent = (envelope: ChatEnvelope) => {
    if (['session.created', 'session.updated', 'session.resumed', 'status.changed', 'model.updated', 'mode.updated', 'timer.changed'].includes(envelope.event.type)) {
      const session = this.runtime.get(envelope.sessionId)
      if (session) for (const connection of this.connections) this.send(connection, {
        kind: envelope.event.type === 'session.created' ? 'session.created' : 'session.updated', session: { ...session, lastSeq: envelope.seq },
      })
    }
    this.broadcast(envelope)
  }
  private readonly onDeleted = (sessionId: string) => {
    for (const connection of this.connections) {
      connection.subscriptions.delete(sessionId)
      connection.replays.delete(sessionId)
    }
  }
  // Every open Chat view hears of it; the pane reads the state over REST.
  private readonly onSwitchboard = (revision: number) => {
    for (const connection of this.connections) this.send(connection, { kind: 'switchboard.updated', revision })
  }
  private readonly onChatRequests = (revision: number) => {
    for (const connection of this.connections) this.send(connection, { kind: 'chatRequests.updated', revision })
  }

  constructor(private readonly runtime: ChatRuntime, private readonly policy: ApiRequestPolicy = {}, private readonly switchboard?: Switchboard, private readonly control?: ChatControl) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: CHAT_LIMITS.frameBytes, perMessageDeflate: false })
    runtime.on('switches', this.onSwitches)
    snippetLibraryEvents.on('changed', this.onSwitches)
    runtime.on('event', this.onEvent)
    runtime.on('deleted', this.onDeleted)
    runtime.on('switchboard', this.onSwitchboard)
    runtime.on('chatRequests', this.onChatRequests)
  }

  /** Attach to an HTTP server's upgrade event. Other upgrades (Vite HMR)
   *  are left alone. */
  attach(server: Server): void {
    if (this.upgrades.has(server)) return
    const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => { this.handleUpgrade(req, socket, head) }
    this.upgrades.set(server, listener)
    server.on('upgrade', listener)
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url || '').split('?')[0]
    if (path !== WS_PATH) return false
    if (this.closing) { socket.destroy(); return true }
    try {
      enforceApiRequest(req, this.policy)
      // enforceApiRequest lets an origin-less request through from loopback;
      // a browser always sends Origin on an upgrade, so that path is a CLI.
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 403
      socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Forbidden'}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${error instanceof Error ? error.message : 'forbidden'}`)
      socket.destroy()
      return true
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws))
    return true
  }

  private accept(socket: WebSocket): void {
    const connection: Connection = { socket, subscriptions: new Map(), replays: new Map(), activeCommands: 0 }
    this.connections.add(connection)
    this.send(connection, { kind: 'hello', instance: this.runtime.instance, serverStartedAt: this.serverStartedAt })
    socket.on('message', (data, isBinary) => {
      if (isBinary) { socket.close(1003, 'binary frames are not accepted'); return }
      if (connection.activeCommands >= MAX_CONNECTION_COMMANDS) { socket.close(1008, 'too many commands in flight'); return }
      connection.activeCommands++
      void this.onFrame(connection, data.toString('utf8'))
        .catch(() => socket.close(1011, 'command handling failed'))
        .finally(() => { connection.activeCommands-- })
    })
    socket.on('close', () => this.connections.delete(connection))
    socket.on('error', () => this.connections.delete(connection))
  }

  private send(connection: Connection, frame: ServerFrame): boolean {
    const { socket } = connection
    if (socket.readyState !== WebSocket.OPEN) return false
    const encoded = JSON.stringify(frame.kind === 'event' ? { ...frame, envelope: clientEnvelope(frame.envelope) } : frame)
    if (socket.bufferedAmount + Buffer.byteLength(encoded) > SOCKET_BUFFER_LIMIT) {
      socket.close(1013, 'subscriber is too far behind; reconnect and resubscribe from your last seq')
      return false
    }
    socket.send(encoded, error => { if (error) socket.terminate() })
    return true
  }

  private broadcast(envelope: ChatEnvelope): void {
    for (const connection of this.connections) {
      const last = connection.subscriptions.get(envelope.sessionId)
      if (last === undefined || connection.replays.has(envelope.sessionId)) continue
      if (envelope.seq <= last) continue
      if (envelope.seq > last + 1) {
        this.send(connection, { kind: 'gap', sessionId: envelope.sessionId, fromSeq: last, toSeq: envelope.seq })
      }
      if (this.send(connection, { kind: 'event', envelope })) connection.subscriptions.set(envelope.sessionId, envelope.seq)
    }
  }

  private async onFrame(connection: Connection, text: string): Promise<void> {
    let frame: ClientFrame
    try {
      frame = JSON.parse(text)
    } catch {
      connection.socket.close(1007, 'frame is not JSON')
      return
    }
    if (!frame || Array.isArray(frame) || typeof frame !== 'object' || typeof frame.id !== 'string' || !frame.id || frame.id.length > 128
      || !frame.command || Array.isArray(frame.command) || typeof frame.command !== 'object' || typeof (frame.command as any).type !== 'string') {
      connection.socket.close(1007, 'malformed command frame')
      return
    }
    const execute = async (): Promise<Extract<ServerFrame, { kind: 'ack' }>> => {
      try {
        const result = await this.execute(connection, frame.command)
        return { kind: 'ack', id: frame.id, ok: true, result }
      } catch (error) {
        const body = errorBody(error)
        return { kind: 'ack', id: frame.id, ok: false, error: body.error, code: body.code }
      }
    }
    // Subscription state belongs to a socket and must be registered again
    // after reconnect; only mutations use durable at-most-once receipts.
    const local = ['subscribe', 'unsubscribe', 'session.list'].includes(frame.command.type)
    const ack = await (local ? execute() : executeCommandOnce(this.runtime.instance, frame.id, frame.command, execute))
    this.send(connection, ack)
  }

  private async execute(connection: Connection, command: ChatCommand): Promise<unknown> {
    const runtime = this.runtime
    const target = 'sessionId' in command ? command.sessionId : 'id' in command ? command.id : undefined
    // Poise runs the Switchboard chat; the person only follows it and answers what it asks.
    // A timer on it is refused with the timers' own error instead.
    if (typeof target === 'string' && this.switchboard?.isSwitchboard(target) && !SWITCHBOARD_CHAT_COMMANDS.has(command.type)
      && command.type !== 'timer.create') {
      throw new ChatError(409, 'Poise runs the Switchboard chat; use the Switchboard pane', 'invalid')
    }
    switch (command.type) {
      case 'switch.create':
        return { catalogue: await runtime.createSwitch(command) }
      case 'subscribe': {
        const sessionId = String(command.sessionId || '')
        const afterSeq = Number.isSafeInteger(command.afterSeq) && command.afterSeq >= 0 ? command.afterSeq : 0
        const session = runtime.get(sessionId)
        if (!session) throw new ChatError(404, 'unknown session', 'unknown_session')
        if (connection.subscriptions.size >= MAX_SUBSCRIPTIONS && !connection.subscriptions.has(sessionId)) {
          throw new ChatError(429, 'too many subscriptions on one connection', 'invalid')
        }
        if (afterSeq > session.lastSeq) throw new ChatError(400, 'subscription sequence is beyond the transcript', 'invalid')
        const generation = Symbol(sessionId)
        connection.replays.set(sessionId, generation)
        connection.subscriptions.set(sessionId, afterSeq)
        let cursor = afterSeq
        try {
          while (connection.socket.readyState === WebSocket.OPEN && connection.replays.get(sessionId) === generation) {
            const page = storage.listEvents(sessionId, cursor, REPLAY_BATCH)
            for (const envelope of page.events) {
              if (!this.send(connection, { kind: 'event', envelope })) return { session, lastSeq: cursor }
              cursor = envelope.seq
              connection.subscriptions.set(sessionId, cursor)
            }
            // No await between the final page and live registration. Events
            // arriving while we yielded are read from the mirror next time.
            if (!page.truncated) break
            await new Promise<void>(resolve => setImmediate(resolve))
          }
        } finally {
          if (connection.replays.get(sessionId) === generation) connection.replays.delete(sessionId)
        }
        return { session, lastSeq: cursor }
      }
      case 'unsubscribe':
        connection.subscriptions.delete(String(command.sessionId || ''))
        connection.replays.delete(String(command.sessionId || ''))
        return {}
      case 'session.list':
        return { sessions: runtime.list() }
      case 'session.new': {
        if (command.role !== undefined) throw new ChatError(400, 'A Manager or Worker is created from the New session dialog in the browser.', 'invalid')
        const request = localSessionRequest(command)
        if (request.subject) {
          const { session, existing } = await runtime.createForSubject({ ...request, subject: request.subject })
          return { session, existing }
        }
        return { session: await runtime.create(request) }
      }
      case 'context.reset':
        return { session: await runtime.reset(String(command.sessionId || '')) }
      case 'session.resume':
        return { session: await runtime.resume(String(command.id || '')) }
      case 'session.fork':
        return { session: await runtime.fork(String(command.id || '')) }
      case 'session.close':
        return { session: await runtime.close(String(command.id || '')) }
      case 'session.delete':
        return await runtime.delete(String(command.id || ''))
      case 'session.rename':
        return { session: await runtime.rename(String(command.id || ''), String(command.title || '')) }
      case 'prompt':
        return await runtime.prompt(String(command.sessionId || ''), {
          text: String(command.text || ''),
          attachments: validAttachments(command.attachments),
          mentions: Array.isArray(command.mentions) ? command.mentions.filter((m) => m && typeof m.path === 'string').slice(0, 50) : [],
        })
      case 'queue.add':
        return { queue: await runtime.enqueue(String(command.sessionId || ''), String(command.itemId || ''), {
          text: String(command.text || ''), attachments: validAttachments(command.attachments),
          mentions: Array.isArray(command.mentions) ? command.mentions.filter(m => m && typeof m.path === 'string').slice(0, 50) : [],
        }, command.model, command.effort) }
      case 'queue.update':
        return { queue: await runtime.updateQueue(String(command.sessionId || ''), String(command.itemId || ''), String(command.model || ''), command.effort) }
      case 'queue.remove':
        return { queue: runtime.removeQueue(String(command.sessionId || ''), String(command.itemId || '')) }
      case 'steer':
        await runtime.steer(String(command.sessionId || ''), String(command.text || ''), {
          attachments: validAttachments(command.attachments),
          mentions: Array.isArray(command.mentions) ? command.mentions.filter(m => m && typeof m.path === 'string').slice(0, 50) : [],
        })
        return {}
      case 'cancel':
        return await runtime.cancel(String(command.sessionId || ''), { kind: 'person' })
      case 'timer.create': {
        if (!this.control) throw new ChatError(503, 'chat control is not started', 'invalid')
        const timer = this.control.createTimer({ sessionId: String(command.sessionId || ''), label: String(command.label ?? ''),
          message: String(command.message ?? ''),
          ...(command.delayMinutes === undefined ? {} : { delayMinutes: command.delayMinutes }),
          ...(command.everyMinutes === undefined ? {} : { everyMinutes: command.everyMinutes }) }, { kind: 'person' })
        return { timer }
      }
      case 'timer.cancel': {
        if (!this.control) throw new ChatError(503, 'chat control is not started', 'invalid')
        return { timer: this.control.cancelTimer(String(command.timerId || ''), { kind: 'person' }) }
      }
      case 'timer.rearm': {
        if (!this.control) throw new ChatError(503, 'chat control is not started', 'invalid')
        return { timer: this.control.rearmTimer(String(command.timerId || ''), { kind: 'person' }) }
      }
      case 'chat.hold': {
        if (!this.control) throw new ChatError(503, 'chat control is not started', 'invalid')
        if (typeof command.held !== 'boolean') throw new ChatError(400, 'held must be a boolean', 'invalid')
        this.control.setHold(String(command.sessionId || ''), command.held)
        return { session: runtime.get(String(command.sessionId || '')) }
      }
      case 'timers.holdAll': {
        if (!this.control) throw new ChatError(503, 'chat control is not started', 'invalid')
        if (typeof command.held !== 'boolean') throw new ChatError(400, 'held must be a boolean', 'invalid')
        this.control.setAllHeld(command.held)
        return { held: command.held }
      }
      case 'permission.respond':
        runtime.respondPermission(String(command.sessionId || ''), String(command.id || ''), String(command.optionId || ''))
        return {}
      case 'question.answer':
        runtime.answerQuestion(String(command.sessionId || ''), String(command.id || ''), command.answers)
        return {}
      case 'set_model':
        return { session: await runtime.setModel(String(command.sessionId || ''), String(command.model || ''), command.effort ? String(command.effort) : undefined) }
      case 'set_safe_mode':
        return await runtime.setSafeMode(String(command.sessionId || ''), command.enabled)
      case 'set_auto_merge':
        return await runtime.setAutoMerge(String(command.sessionId || ''), command.enabled)
      case 'set_mode':
        await runtime.setMode(String(command.sessionId || ''), String(command.mode || ''))
        return {}
      case 'revert':
        await runtime.revert(String(command.sessionId || ''), String(command.diffId || ''))
        return {}
      case 'edit.decide': {
        const decision = command.decision
        if (decision !== 'applied' && decision !== 'declined' && decision !== 'conflict') {
          throw new ChatError(400, 'decision must be applied, declined or conflict', 'invalid')
        }
        if (!Number.isSafeInteger(command.index) || command.index < 0) {
          throw new ChatError(400, 'index must be a non-negative integer', 'invalid')
        }
        await runtime.decideEdit(String(command.sessionId || ''), {
          turnId: String(command.turnId || ''), messageId: String(command.messageId || ''),
          index: command.index, decision,
        })
        return {}
      }
      case 'poise.change': {
        if (this.policy.service) throw new ChatError(409, SELF_UPDATE_OFF, SERVICE_MODE_CODE)
        // Only these three fields exist: the browser never names a
        // repository, branch or path for a change — the controller does.
        const changeId = String(command.changeId || '')
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(changeId)) throw new ChatError(400, 'changeId must be a UUID', 'invalid')
        const result: import('./protocol').PoiseChangeAck = await runtime.startPoiseChange(String(command.sessionId || ''), String(command.text || ''), changeId, {
          switches: command.switches, attachments: validAttachments(command.attachments),
          mentions: Array.isArray(command.mentions) ? command.mentions.filter(m => m && typeof m.path === 'string').slice(0, 50) : [],
        })
        return result
      }
      default:
        throw new ChatError(400, `unknown command ${String((command as any).type)}`, 'invalid')
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.runtime.off('switches', this.onSwitches)
    snippetLibraryEvents.off('changed', this.onSwitches)
    clearInterval(this.libraryPoll)
    this.runtime.off('event', this.onEvent)
    this.runtime.off('deleted', this.onDeleted)
    this.runtime.off('switchboard', this.onSwitchboard)
    this.runtime.off('chatRequests', this.onChatRequests)
    for (const [server, listener] of this.upgrades) server.off('upgrade', listener)
    this.upgrades.clear()
    this.closing = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        for (const connection of this.connections) connection.socket.terminate()
      }, 500)
      timer.unref()
      for (const connection of this.connections) connection.socket.close(1001, 'server shutting down')
      this.wss.close(() => { clearTimeout(timer); this.connections.clear(); resolve() })
    })
    return this.closing
  }

}

function validAttachments(value: unknown): Attachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) throw new ChatError(400, 'attachments must be an array of at most 20 uploaded files', 'invalid')
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new ChatError(400, 'invalid attachment', 'invalid')
    const a = item as Record<string, unknown>
    if (typeof a.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(a.id)
      || typeof a.name !== 'string' || !a.name || a.name.length > 200
      || typeof a.path !== 'string' || !a.path || a.path.length > 1024
      || typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size < 0 || a.size > CHAT_LIMITS.attachmentBytes) {
      throw new ChatError(400, 'attachment must match a file uploaded to this session', 'invalid')
    }
    // The runtime looks up this server-issued ID and reads the authoritative
    // bytes under its checkout lease. Never forward browser-supplied text.
    return { id: a.id, name: a.name, path: a.path, size: a.size }
  })
}

// ── REST ───────────────────────────────────────────────────────────────────

export async function listFiles(checkout: string, query: string): Promise<string[]> {
  const q = query.trim().toLowerCase()
  const tracked = (await runFile('git', ['ls-files', '-z'], { cwd: checkout, timeoutMs: 15_000, maxOutputBytes: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' }))).stdout.split('\0')
  const untracked = (await runFile('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: checkout, timeoutMs: 15_000, maxOutputBytes: 16 * 1024 * 1024 }).catch(() => ({ stdout: '' }))).stdout.split('\0')
  const out: string[] = []
  const seen = new Set<string>()
  for (const list of [tracked, untracked]) {
    for (const path of list) {
      if (!path || seen.has(path) || path.startsWith('.poise-chat/')) continue
      seen.add(path)
      if (!q || path.toLowerCase().includes(q)) out.push(path)
      if (out.length >= 50) return out
    }
  }
  return out
}

/** Whether a request speaks for the person: a browser's request carries
 *  Origin (checked against the host by enforceApiRequest); the control
 *  command's api operation sends none. In service mode it must also have come
 *  through the gateway. A local process can still forge the header: this keeps
 *  cooperating agents out, it is not a security boundary. */
export function speaksForPerson(req: IncomingMessage, service: boolean, authority: RequestAuthority): boolean {
  return !!req.headers.origin && (!service || authority.kind === 'gateway')
}

/** Handle /api/chat/* routes; returns false when the url is not ours.
 *  `person`: the request has the person's authority (see Switchboard.handle). */
export async function handleChatApi(req: IncomingMessage, res: ServerResponse, url: string, runtime: ChatRuntime, switchboard?: Switchboard, person = true, control?: ChatControl): Promise<boolean> {
  const path = url.split('?')[0]
  const query = new URLSearchParams(url.split('?')[1] || '')
  if (!path.startsWith('/api/chat/')) return false
  if (switchboard && (path === SWITCHBOARD_PATH || path.startsWith(`${SWITCHBOARD_PATH}/`))) {
    await switchboard.handle(req, res, path, person)
    return true
  }
  try {
    if (path === '/api/chat/switches') {
      if (req.method === 'GET') return json(res, 200, (await readSkillSnippets()).skills), true
      return json(res, 405, { error: 'Use GET to read saved switches.' }), true
    }
    if (path === '/api/chat/memories') {
      if (req.method === 'GET') return json(res, 200, readMemories()), true
      if (req.method === 'PUT') {
        if (!person) return json(res, 403, { error: 'Memories are edited in the browser.' }), true
        return json(res, 200, saveMemories(await readJson(req))), true
      }
      return json(res, 405, { error: 'Use GET or PUT for memories.' }), true
    }
    if (path === '/api/chat/manager/wake') {
      if (req.method === 'GET') {
        if (!control) throw new ChatError(503, 'chat control is not started', 'invalid')
        return json(res, 200, control.managerWakeView()), true
      }
      if (req.method === 'PUT') {
        if (!person) return json(res, 403, { error: 'The Manager\'s wake interval is changed in the browser.' }), true
        if (!control) throw new ChatError(503, 'chat control is not started', 'invalid')
        saveWake(await readJson(req))
        // Synced before returning, so the view already shows the new nextAt.
        await control.syncManagerWake()
        return json(res, 200, control.managerWakeView()), true
      }
      return json(res, 405, { error: 'Use GET or PUT for the Manager wake interval.' }), true
    }
    if (path === '/api/chat/agents' && req.method === 'GET') {
      const { agents, catalog } = await runtime.agents()
      const { resolvePlace, resolveSlots } = await import('../models')
      const { getModelSettings } = await import('../settings')
      const { launchable } = await import('../review-model')
      const { claudeAuth } = await import('../claude-auth')
      const stored = getModelSettings()
      const choice = resolvePlace(catalog, 'chat', stored)
      const slots = resolveSlots(catalog, stored.slots)
      const effective = launchable(catalog, undefined, choice, slots)
      const fallbackReason = effective !== choice.model
        ? `${choice.model} needs the Claude.ai sign-in (${claudeAuth.snapshot().status}); ${effective} is available`
        : undefined
      const settings = getChatSettings()
      return json(res, 200, {
        agents: agents.map((a) => ({ id: a.id, label: a.label, available: a.available, reason: a.reason, models: a.models, efforts: a.efforts })),
        defaults: { model: choice.model, fallback: effective, fallbackReason },
        settings,
      }), true
    }
    if (path === '/api/chat/repo' && req.method === 'GET') {
      const repo = query.get('repo') || ''
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ChatError(400, 'repo must be owner/name', 'invalid')
      const checkout = await runtime.checkoutFor(repo)
      const state = await inspectCheckout(checkout)
      let prs: Array<{ number: number, title: string, branch: string }> = []
      try {
        const result = await handleGhBody({ operation: 'list', record_type: 'pull_request', record_state: 'open', limit: 200 })
        const records = ((result.body as any)?.records || []) as Array<{ repo: string, number: number, title: string }>
        prs = records.filter((r) => r.repo === repo).map((r) => ({ number: r.number, title: r.title, branch: `github-interface-pr-${r.number}` }))
      } catch { /* the datastore is optional here */ }
      return json(res, 200, { checkout, currentBranch: state.currentBranch, defaultBranch: state.defaultBranch, dirty: state.dirty, dirtyFiles: state.dirtyFiles, branches: state.branches, prs }), true
    }
    if (path === '/api/chat/files' && req.method === 'GET') {
      const session = runtime.get(query.get('session') || '')
      if (!session) throw new ChatError(404, 'unknown session', 'unknown_session')
      return json(res, 200, { files: await listFiles(session.checkout, query.get('q') || '') }), true
    }
    if (path === '/api/chat/file' && req.method === 'GET') {
      const session = runtime.get(query.get('session') || '')
      if (!session) throw new ChatError(404, 'unknown session', 'unknown_session')
      return json(res, 200, await readChatFile(session.checkout, query.get('path') || '')), true
    }
    if (path === '/api/chat/diff' && req.method === 'GET') {
      const session = runtime.get(query.get('session') || '')
      if (!session) throw new ChatError(404, 'unknown session', 'unknown_session')
      const diffId = query.get('id') || ''
      if (!diffId || diffId.length > 200) throw new ChatError(400, 'invalid diff ID', 'invalid')
      const diff = storage.getDiffEvent(session.id, diffId)
      if (!diff) throw new ChatError(404, 'unknown diff', 'unknown_diff')
      return json(res, 200, { diff }), true
    }
    if (path === '/api/chat/attachments' && req.method === 'POST') {
      const body = await readBuffer(req, ATTACHMENT_MAX_BYTES)
      const attachment = await runtime.saveAttachment(query.get('session') || '', query.get('filename') || '', body)
      return json(res, 200, { attachment }), true
    }
    if (path === '/api/chat/sessions' && req.method === 'GET') {
      const subjectParam = query.get('subject')
      if (subjectParam !== null) {
        const filter = subjectFilter(subjectParam)
        const id = storage.sessionForSubject(runtime.instance, filter.surface, filter.key)
        return json(res, 200, { session: id ? runtime.get(id) : null, instance: runtime.instance }), true
      }
      const legacyParam = query.get('legacy')
      if (legacyParam !== null) {
        if (!legacyParam) throw new ChatError(400, 'legacy must not be empty', 'invalid')
        const found = runtime.list().find((record) => record.importedFrom === legacyParam) ?? null
        return json(res, 200, { session: found, instance: runtime.instance }), true
      }
      return json(res, 200, { sessions: runtime.list(), instance: runtime.instance }), true
    }
    // Every open permission and question request of this instance with
    // its stored content, newest first: one consistent snapshot carrying
    // its revision. Clients read again on `chatRequests.updated`, after a
    // reconnect or a restart, and discard a response older than a frame
    // they have seen.
    if (path === '/api/chat/requests' && req.method === 'GET') {
      return json(res, 200, storage.listOpenChatRequests(runtime.instance)), true
    }
    if (path === '/api/chat/legacy' && req.method === 'GET') {
      const subjectParam = query.get('subject')
      if (!subjectParam) throw new ChatError(400, 'subject is required', 'invalid')
      const filter = subjectFilter(subjectParam)
      const legacyId = await legacyIdFor({ surface: filter.surface, key: filter.key, label: '' })
      if (!legacyId) return json(res, 200, { conversation: null }), true
      try {
        return json(res, 200, { conversation: await readLegacyConversation(legacyId) }), true
      } catch (error) {
        throw new ChatError(502, `Earlier conversation could not be read: ${error instanceof Error ? error.message : String(error)}`, 'legacy_unreadable')
      }
    }
    if (path === '/api/chat/sessions' && req.method === 'POST') {
      const body = await readJson<any>(req)
      if (body?.role !== undefined) {
        if (!person) throw new ChatError(403, 'A Manager or Worker is created from the New session dialog in the browser.', 'invalid')
        const session = await runtime.create({ ...localSessionRequest(body), role: body.role })
        const charter = session.role === 'worker'
          ? { name: WORKER_SWITCH, text: WORKER_SNIPPET_DEFAULT }
          : { name: MANAGER_SWITCH, text: MANAGER_SNIPPET_DEFAULT }
        try {
          if (await ensureSnippetSwitch(charter.name, charter.text) === 'unreadable') {
            runtime.emit('log', `[chat] /${charter.name} could not be read; Snippets shows the problem`)
          }
        } catch (error) {
          runtime.emit('log', `[chat] creating /${charter.name} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (session.role === 'manager') {
          // The person created a Manager: the wake lifecycle arms, and the
          // saved interval applies from creation. A sync failure must not
          // fail the creation — the tick retries within a second.
          markWakeArmed(runtime.instance)
          try {
            await control?.syncManagerWake()
          } catch (error) {
            runtime.emit('log', `[chat control] wake schedule sync failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return json(res, 201, { session }), true
      }
      const request = localSessionRequest(body)
      if (request.subject) {
        const { session, existing } = await runtime.createForSubject({ ...request, subject: request.subject })
        return json(res, existing ? 200 : 201, { session, existing }), true
      }
      const session = await runtime.create(request)
      return json(res, 201, { session }), true
    }
    const match = path.match(/^\/api\/chat\/sessions\/([0-9a-f-]{36})(?:\/([a-z]+))?$/)
    if (match) {
      const [, id, action] = match
      if (action === 'timers' && req.method === 'GET') {
        if (!control) throw new ChatError(503, 'chat control is not started', 'invalid')
        return json(res, 200, { ...control.timersOf(id), scheduler: control.status() }), true
      }
      if (switchboard?.isSwitchboard(id) && (req.method === 'PATCH' || ['fork', 'handoff', 'close'].includes(action ?? ''))) {
        throw new ChatError(409, 'Poise runs the Switchboard chat; use the Switchboard pane', 'invalid')
      }
      // The person's actions on a chat answer only the person's browser.
      // Chats use the control operations; the control's api operation sends
      // no Origin, so it never speaks for the person.
      const personOnly = (!action && (req.method === 'PATCH' || req.method === 'DELETE'))
        || (action && req.method === 'POST' && ['cancel', 'close', 'fork', 'handoff'].includes(action))
      if (personOnly && !person) throw new ChatError(403, 'This is the person\'s action, taken in the browser. Chats use the control operations.', 'invalid')
      if (!action && req.method === 'GET') {
        const session = runtime.get(id)
        if (!session) throw new ChatError(404, 'unknown session', 'unknown_session')
        const after = Number(query.get('after') || 0)
        const { events, truncated } = runtime.events(id, Number.isSafeInteger(after) && after >= 0 ? after : 0)
        return json(res, 200, { session, events: events.map(clientEnvelope), truncated }), true
      }
      if (!action && req.method === 'PATCH') {
        const body = await readJson<any>(req)
        return json(res, 200, { session: await runtime.rename(id, String(body.title || '')) }), true
      }
      if (!action && req.method === 'DELETE') {
        const { workspaceRemoved } = await runtime.delete(id)
        return json(res, 200, { ok: true, workspaceRemoved }), true
      }
      if (action && req.method === 'POST') {
        if (action === 'resume') return json(res, 200, { session: await runtime.resume(id) }), true
        if (action === 'fork') return json(res, 200, { session: await runtime.fork(id) }), true
        if (action === 'close') return json(res, 200, { session: await runtime.close(id) }), true
        if (action === 'cancel') return json(res, 200, await runtime.cancel(id, { kind: 'person' })), true
        if (action === 'handoff') {
          const body = await readJson<any>(req)
          return json(res, 200, { session: await runtime.handoff(id, { agent: body.agent, model: String(body.model || ''), effort: body.effort ? String(body.effort) : undefined }) }), true
        }
      }
    }
    return json(res, 404, { error: 'chat route not found' }), true
  } catch (error) {
    return json(res, errorStatus(error), errorBody(error)), true
  }
}

function sanitizeContext(value: any): import('./protocol').SessionContext | undefined {
  const kind = value.kind
  if (kind !== 'card' && kind !== 'document' && kind !== 'handoff') return undefined
  return {
    kind,
    title: String(value.title || '').slice(0, 300),
    body: typeof value.body === 'string' ? value.body.slice(0, 64 * 1024) : undefined,
    url: typeof value.url === 'string' && /^https:\/\/github\.com\//.test(value.url) ? value.url.slice(0, 500) : undefined,
    headSha: typeof value.headSha === 'string' && /^[0-9a-f]{40}$/.test(value.headSha) ? value.headSha : undefined,
    slug: typeof value.slug === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/.test(value.slug) ? value.slug : undefined,
    fromSession: typeof value.fromSession === 'string' && /^[0-9a-f-]{36}$/.test(value.fromSession) ? value.fromSession : undefined,
  }
}

/** Browser requests never choose a repository, branch or filesystem path. */
function localSessionRequest(body: any): import('./protocol').NewSessionRequest {
  return {
    agent: body.agent,
    model: String(body.model || ''),
    effort: body.effort ? String(body.effort) : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    context: body.context && typeof body.context === 'object' ? sanitizeContext(body.context) : undefined,
    subject: body?.subject === undefined ? undefined : sanitizeSubject(body.subject),
    skipLegacy: body?.skipLegacy === true ? true : undefined,
    deferStart: body.deferStart,
    fallbackModel: typeof body.fallbackModel === 'string' ? body.fallbackModel : undefined,
    ...(body.autoMerge !== undefined ? { autoMerge: body.autoMerge } : {}),
    ...(body.safeMode !== undefined ? { safeMode: body.safeMode } : {}),
  }
}

/** An Editor slug: the same pattern `sanitizeContext` accepts. */
const EDITOR_SLUG_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/
/** An annotation or review id: 1–200 printable ASCII characters, none of
 *  them a space or a colon. */
const EDITOR_ID_PATTERN = /^[\x21-\x39\x3B-\x7E]{1,200}$/

/** `current` keys are the legacy chat ids the card builders make. Editor
 *  keys are `<slug>`, `<slug>:<annotationId>` and `<slug>:<reviewId>`; a
 *  slug never contains a colon, so the first one separates it from the
 *  id. Unlike `sanitizeContext`, which drops what it cannot use, an
 *  invalid subject is refused: it is never ignored. */
function sanitizeSubject(value: unknown): ChatSubject {
  if (!value || typeof value !== 'object') throw new ChatError(400, 'subject must be an object', 'invalid')
  const candidate = value as Record<string, unknown>
  const surface = candidate.surface
  if (surface !== 'current' && surface !== 'editor-document' && surface !== 'editor-passage' && surface !== 'editor-review') {
    throw new ChatError(400, `unknown subject surface ${String(surface)}`, 'invalid')
  }
  const key = candidate.key
  let valid = false
  if (typeof key === 'string') {
    if (surface === 'current') {
      valid = /^poise\.card\.\d+$/.test(key) || /^poise\.(issue|pr)\.[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.\d+$/.test(key)
    } else if (surface === 'editor-document') {
      valid = EDITOR_SLUG_PATTERN.test(key)
    } else {
      const at = key.indexOf(':')
      valid = at > 0 && EDITOR_SLUG_PATTERN.test(key.slice(0, at)) && EDITOR_ID_PATTERN.test(key.slice(at + 1))
    }
  }
  if (!valid) throw new ChatError(400, 'invalid subject key', 'invalid')
  const label = typeof candidate.label === 'string' ? candidate.label.slice(0, 200) : ''
  if (!label) throw new ChatError(400, 'subject label is required', 'invalid')
  const url = candidate.url
  if (url !== undefined && (typeof url !== 'string' || !/^https:\/\/github\.com\//.test(url))) throw new ChatError(400, 'subject url must start with https://github.com/', 'invalid')
  return { surface, key: key as string, label, ...(url !== undefined ? { url: (url as string).slice(0, 500) } : {}) }
}

/** A `?subject=<surface>:<key>` filter carries no label or url; the key
 *  rules are the same as for creation. */
function subjectFilter(value: string): Pick<ChatSubject, 'surface' | 'key'> {
  const at = value.indexOf(':')
  const checked = sanitizeSubject(at < 0 ? value : { surface: value.slice(0, at), key: value.slice(at + 1), label: 'lookup' })
  return { surface: checked.surface, key: checked.key }
}
