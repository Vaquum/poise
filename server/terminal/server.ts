// The terminal WebSocket at /ws/terminal: a CLI's login, or a shell, in the
// browser (docs/Service-architecture.md, "Accounts, identities and the
// terminal").
//
// The upgrade is held to the same rules as Chat's: the local host, origin and
// fetch-metadata checks, or in service mode the gateway's assertion, whose
// scope must be the owner's browser. At most TERMINAL_LIMITS.concurrent
// terminals run at once, and one that sees neither input nor output for
// TERMINAL_LIMITS.idleMinutes is closed. Closing or losing the socket hangs
// up the program's process group. Output stops being read while the socket
// is too far behind, so a fast program waits for a slow browser instead of
// filling the server's memory.

import { EventEmitter } from 'node:events'
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { ACCOUNT_IDS } from '../accounts/types'
import { HttpError, enforceApiRequest, type ApiRequestPolicy } from '../http'
import { presetCommand } from './presets'
import { PtyProcess, type TerminalCommand, type TerminalProcess, type TerminalSize } from './pty'
import {
  TERMINAL_CLOSE, TERMINAL_LIMITS, TERMINAL_WS_PATH, isTerminalPreset,
  type TerminalClientFrame, type TerminalPreset, type TerminalServerFrame,
} from './protocol'

const INITIAL_SIZE: TerminalSize = { cols: 80, rows: 24 }
export const OUTPUT_HIGH_WATER = 1024 * 1024
export const OUTPUT_LOW_WATER = 256 * 1024
const CLOSE_REASON_BYTES = 123

/** A close reason must fit in one control frame. */
function closeReason(message: string): string {
  if (Buffer.byteLength(message) <= CLOSE_REASON_BYTES) return message
  const chars = Array.from(message)
  while (Buffer.byteLength(`${chars.join('')}…`) > CLOSE_REASON_BYTES) chars.pop()
  return `${chars.join('')}…`
}

function refuse(socket: Duplex, error: unknown): void {
  const status = error instanceof HttpError ? error.statusCode : 403
  socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Forbidden'}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${error instanceof Error ? error.message : 'forbidden'}`)
  socket.destroy()
}

function inRange(value: unknown, range: { min: number, max: number }): value is number {
  return Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max
}

function clientFrame(text: string): TerminalClientFrame | null {
  let frame: unknown
  try { frame = JSON.parse(text) } catch { return null }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null
  const value = frame as Record<string, unknown>
  if (value.type === 'input' && typeof value.data === 'string') return { type: 'input', data: value.data }
  if (value.type === 'resize' && inRange(value.cols, TERMINAL_LIMITS.cols) && inRange(value.rows, TERMINAL_LIMITS.rows)) {
    return { type: 'resize', cols: value.cols, rows: value.rows }
  }
  return null
}

function idleText(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} idle minutes` : `${ms} idle milliseconds`
}

export interface TerminalSessionHooks {
  idleMs: number
  /** The program exited; the browser hears of it next. */
  onExit: (code: number) => void
  /** The process is gone: the session no longer counts. */
  onEnd: () => void
}

/** One terminal: a socket and its process, until the process has exited. */
export class TerminalSession {
  private readonly idle: NodeJS.Timeout
  private paused = false
  private failed = false
  private exited = false

  constructor(
    private readonly socket: WebSocket,
    private readonly pty: TerminalProcess,
    private readonly hooks: TerminalSessionHooks,
  ) {
    this.idle = setTimeout(() => {
      this.socket.close(TERMINAL_CLOSE.idle, closeReason(`Closed after ${idleText(hooks.idleMs)}.`))
      this.pty.close()
    }, hooks.idleMs)
    this.idle.unref()
    pty.on('output', (chunk) => this.output(chunk))
    pty.on('error', (error) => this.fail(error))
    pty.once('exit', (code) => this.exit(code))
    socket.on('message', (data, isBinary) => this.input(data, isBinary))
    socket.on('close', () => this.pty.close())
    // ws follows an error with close.
    socket.on('error', () => this.socket.terminate())
  }

  /** The server is going away. */
  shutdown(): void {
    this.socket.close(1001, 'Poise is shutting down.')
    this.pty.close()
  }

  private send(frame: TerminalServerFrame, sent?: () => void): void {
    if (this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(frame), (error) => {
      if (error) this.socket.terminate()
      else sent?.()
    })
  }

  private output(chunk: Buffer): void {
    this.idle.refresh()
    this.send({ type: 'output', data: chunk.toString('base64') }, () => {
      if (this.paused && this.socket.bufferedAmount <= OUTPUT_LOW_WATER) {
        this.paused = false
        this.pty.resume()
      }
    })
    if (!this.paused && this.socket.bufferedAmount > OUTPUT_HIGH_WATER) {
      this.paused = true
      this.pty.pause()
    }
  }

  private input(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.socket.close(1003, 'binary frames are not accepted')
      return
    }
    const frame = clientFrame(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'))
    if (!frame) {
      this.socket.close(1007, 'malformed terminal frame')
      return
    }
    if (this.exited) return
    this.idle.refresh()
    if (frame.type === 'resize') {
      this.pty.resize(frame)
      return
    }
    if (!this.pty.write(Buffer.from(frame.data, 'utf8'))) {
      this.socket.pause()
      this.pty.once('drain', () => this.socket.resume())
    }
  }

  private fail(error: Error): void {
    this.failed = true
    console.error(`[terminal] ${error.message}`)
    this.socket.close(TERMINAL_CLOSE.failed, closeReason(error.message))
  }

  private exit(code: number): void {
    this.exited = true
    clearTimeout(this.idle)
    this.hooks.onExit(code)
    if (!this.failed) {
      this.send({ type: 'exit', code })
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'exited')
    }
    this.hooks.onEnd()
  }
}

export interface TerminalServerOptions {
  /** What a preset runs. Tests replace the CLIs' logins with harmless programs. */
  command?: (preset: TerminalPreset) => TerminalCommand
  concurrent?: number
  idleMs?: number
}

export interface TerminalServerEvents {
  /** A terminal's program exited: a login may have changed an account. */
  exit: [preset: TerminalPreset, code: number]
}

export class TerminalSocketServer extends EventEmitter<TerminalServerEvents> {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_LIMITS.frameBytes, perMessageDeflate: false })
  private readonly sessions = new Set<TerminalSession>()
  private readonly upgrades = new Map<Server, (req: IncomingMessage, socket: Duplex, head: Buffer) => void>()
  private closing: Promise<void> | null = null
  private ended: (() => void) | null = null

  constructor(
    private readonly policy: ApiRequestPolicy = {},
    private readonly options: TerminalServerOptions = {},
  ) {
    super()
  }

  /** Terminals running now, each until its program has exited. */
  get size(): number {
    return this.sessions.size
  }

  /** Attach to an HTTP server's upgrade event; other paths are left alone. */
  attach(server: Server): void {
    if (this.upgrades.has(server)) return
    const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) => { this.handleUpgrade(req, socket, head) }
    this.upgrades.set(server, listener)
    server.on('upgrade', listener)
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = req.url || ''
    const queryAt = url.indexOf('?')
    if ((queryAt < 0 ? url : url.slice(0, queryAt)) !== TERMINAL_WS_PATH) return false
    if (this.closing) {
      socket.destroy()
      return true
    }
    let preset: TerminalPreset
    try {
      const authority = enforceApiRequest(req, this.policy)
      // Only the browser scope reaches this path at all; a shell is worth
      // saying so twice.
      if (authority.kind === 'gateway' && authority.scope !== 'browser') {
        throw new HttpError(403, 'the terminal is open to the workspace owner\'s browser only')
      }
      const requested = new URLSearchParams(queryAt < 0 ? '' : url.slice(queryAt + 1)).get('preset')
      if (!isTerminalPreset(requested)) throw new HttpError(400, `preset must be one of ${[...ACCOUNT_IDS, 'shell'].join(', ')}`)
      preset = requested
    } catch (error) {
      refuse(socket, error)
      return true
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.open(ws, preset))
    return true
  }

  private open(socket: WebSocket, preset: TerminalPreset): void {
    if (this.closing) {
      socket.close(1001, 'Poise is shutting down.')
      return
    }
    const limit = this.options.concurrent ?? TERMINAL_LIMITS.concurrent
    if (this.sessions.size >= limit) {
      socket.close(TERMINAL_CLOSE.busy, `At most ${limit} terminals can be open at a time; close one first.`)
      return
    }
    let pty: TerminalProcess
    try {
      pty = new PtyProcess((this.options.command ?? presetCommand)(preset), INITIAL_SIZE)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[terminal] ${preset}: ${message}`)
      socket.close(TERMINAL_CLOSE.failed, closeReason(message))
      return
    }
    const session: TerminalSession = new TerminalSession(socket, pty, {
      idleMs: this.options.idleMs ?? TERMINAL_LIMITS.idleMinutes * 60_000,
      onExit: (code) => this.emit('exit', preset, code),
      onEnd: () => {
        this.sessions.delete(session)
        if (!this.sessions.size) this.ended?.()
      },
    })
    this.sessions.add(session)
  }

  /** Hang up every terminal and wait until their programs have exited. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    for (const [server, listener] of this.upgrades) server.off('upgrade', listener)
    this.upgrades.clear()
    const ended = new Promise<void>((resolve) => {
      if (!this.sessions.size) resolve()
      else this.ended = resolve
    })
    for (const session of this.sessions) session.shutdown()
    this.closing = ended.then(() => new Promise<void>((resolve) => {
      // A browser that never answers the closing handshake would hold the
      // server for ws's 30-second close timeout.
      for (const client of this.wss.clients) client.terminate()
      this.wss.close(() => resolve())
    }))
    return this.closing
  }
}
