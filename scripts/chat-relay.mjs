#!/usr/bin/env node
// Per-session relay for Poise Chat: the process that owns a native agent's
// stdio while Poise restarts underneath it (issue #449).
//
// The relay is spawned detached by Poise and survives a Poise restart. It
// owns the agent through the worker gate (scripts/chat-worker-gate.mjs),
// which it spawns itself: the gate still guarantees that nothing runs before
// GO and still tears the agent down when its control descriptor closes —
// that descriptor is held by the relay now, not by Poise. The relay adds no
// proxying the gate does not have; it pumps bytes, both directions, and
// records the current turn:
//
// - agent stdout is appended to the spool file (turn-scoped; dropped when
//   the turn finishes) and forwarded to the connected Poise. The append is
//   synchronous so the spool can never miss a byte the client saw.
// - Poise-to-agent bytes are kept in memory, turn-scoped, and served back on
//   request so a reconnecting Poise can tell a duplicate write from one the
//   agent never received. The relay never parses either direction.
// - agent stderr is forwarded live and never spooled: it is diagnostics,
//   not transcript material.
//
// Protocol (framed over a unix socket; the twin implementation is
// server/chat/relay.ts, and the relay tests exercise both sides together):
// every frame is one kind byte, a four-byte big-endian length, then the
// payload. Control payloads are JSON; stdin/stdout/stderr payloads are raw
// bytes. Client kinds: hello, go, stdin, turnStart, turnFinish, getOutbound,
// shutdown, signal. Server kinds: ready, started, stdout, stderr, exited,
// live, outbound, error.
//
// A reconnecting Poise sends hello and gets the spooled bytes first, then a
// live marker, then live output — one ordered stream, so no byte is skipped
// or repeated. Only one client is attached at a time; a second hello while
// one is attached is refused, so two Poise servers can never share an agent.
// A disconnect before GO exits without spawning anything, exactly like the
// gate's own rule; a disconnect after that keeps the agent for the next
// Poise. The relay exits once its agent is gone.
//
// Usage: node chat-relay.mjs --relay-session <id> --relay-ident <ident>
//   --socket <path> --dir <dir> --gate <gateScript> --lease-worker <ident>
//   -- <command> [args...]

import { spawn } from 'node:child_process'
import { appendFileSync, createReadStream, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'

// Client kinds.
const HELLO = 1
const GO = 2
const STDIN = 3
const TURN_START = 4
const TURN_FINISH = 5
const GET_OUTBOUND = 6
const SHUTDOWN = 7
const SIGNAL = 8
// Server kinds.
const READY = 101
const STARTED = 102
const STDOUT = 103
const STDERR = 104
const EXITED = 105
const LIVE = 106
const OUTBOUND = 107
const PROTOCOL_ERROR = 108

const PROTOCOL_VERSION = 1
/** Poise-to-agent bytes kept per turn; past this the replay cannot prove what the agent got. */
const MAX_OUTBOUND_BYTES = 16 * 1024 * 1024
/** Live bytes queued while a reconnecting client is still reading the spool. */
const MAX_REPLAY_QUEUE_BYTES = 64 * 1024 * 1024
const SHUTDOWN_GRACE_MS = 5_000

const argv = process.argv.slice(2)
function flag(name) {
  const at = argv.indexOf(name)
  if (at === -1 || at + 1 >= argv.length) return null
  return argv[at + 1]
}
const separator = argv.indexOf('--')
const sessionId = flag('--relay-session')
const relayIdent = flag('--relay-ident')
const socketPath = flag('--socket')
const dir = flag('--dir')
const gateScript = flag('--gate')
const gateIdent = flag('--lease-worker')
const command = separator === -1 ? null : argv[separator + 1]
const commandArgs = separator === -1 ? [] : argv.slice(separator + 2)
if (!sessionId || !relayIdent || !socketPath || !dir || !gateScript || !gateIdent || !command) {
  process.stderr.write('usage: chat-relay.mjs --relay-session <id> --relay-ident <ident> --socket <path> --dir <dir> --gate <script> --lease-worker <ident> -- <command> [args...]\n')
  process.exit(64)
}

const spoolPath = `${dir}/turn.spool`
const logPath = `${dir}/relay.log`

function log(line) {
  try { appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`) } catch { /* diagnostics only */ }
}

function encode(kind, payload) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const header = Buffer.alloc(5)
  header.writeUInt8(kind, 0)
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}
const encodeJson = (kind, value) => encode(kind, JSON.stringify(value))

class Decoder {
  constructor(onFrame) {
    this.buffer = Buffer.alloc(0)
    this.onFrame = onFrame
  }
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= 5) {
      const kind = this.buffer.readUInt8(0)
      const length = this.buffer.readUInt32BE(1)
      if (!Number.isSafeInteger(length) || length > 256 * 1024 * 1024) throw new Error(`frame of ${length} bytes is over the bound`)
      if (this.buffer.length < 5 + length) return
      const payload = this.buffer.subarray(5, 5 + length)
      this.buffer = this.buffer.subarray(5 + length)
      this.onFrame(kind, payload)
    }
  }
}

let gate = null
let gateControl = null
let gateExited = null // { code } once the gate is gone
let gateExitSent = false
let goSent = false
let client = null
let clientGone = null // resolves when the active client disconnects
let spoolTurnId = null
let spoolFailed = null
let outbound = []
let outboundBytes = 0
let outboundTruncated = false
let replayQueue = []
let replayQueueBytes = 0
let replaying = false
let shuttingDown = false

function dropSpool() {
  spoolTurnId = null
  try { unlinkSync(spoolPath) } catch { /* already gone */ }
}

function clearOutbound() {
  outbound = []
  outboundBytes = 0
  outboundTruncated = false
}

function send(socket, frame) {
  if (!socket || socket.destroyed) return
  try { socket.write(frame) } catch { /* the client is gone */ }
}

function sendError(socket, message) {
  send(socket, encodeJson(PROTOCOL_ERROR, { message }))
}

function finish(exitCode) {
  if (shuttingDown === 'done') return
  shuttingDown = 'done'
  try { unlinkSync(socketPath) } catch { /* already gone */ }
  process.exit(exitCode)
}

async function settleGate() {
  if (!gate || gate.exitCode !== null || gate.signalCode !== null) return
  try { gateControl?.write('TERM\n') } catch { /* gone */ }
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)
    timer.unref()
    gate.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
  if (exited) return
  try { gateControl?.write('KILL\n') } catch { /* gone */ }
  await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS)
    timer.unref()
    gate.once('exit', () => { clearTimeout(timer); resolve(true) })
  })
}

async function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  log('shutdown')
  dropSpool()
  await settleGate().catch(() => undefined)
  finish(exitCode)
}

function onAgentOutput(chunk) {
  // The spool first, synchronously: a byte the client saw must be replayable.
  if (spoolTurnId && !spoolFailed) {
    try {
      appendFileSync(spoolPath, chunk)
    } catch (error) {
      spoolFailed = error instanceof Error ? error.message : String(error)
      log(`spool failed: ${spoolFailed}`)
      if (client) sendError(client, `the turn spool failed (${spoolFailed}); this turn cannot be replayed after a restart`)
    }
  }
  if (!client) return
  if (replaying) {
    replayQueue.push(chunk)
    replayQueueBytes += chunk.length
    if (replayQueueBytes > MAX_REPLAY_QUEUE_BYTES) {
      log('replay queue over the bound; dropping the client')
      sendError(client, 'the relay is over its replay buffer; reconnect to fall back')
      client.destroy()
    }
    return
  }
  send(client, encode(STDOUT, chunk))
}

function onAgentStderr(chunk) {
  if (client && !replaying) send(client, encode(STDERR, chunk))
}

function onGateExit(code) {
  gateExited = { code: code ?? 1 }
  log(`gate exited (${gateExited.code})`)
  finishGateOutput()
}

function finishGateOutput() {
  // A gate can close while its spool is still replaying. The final live
  // bytes are queued behind that spool and must precede EXITED as well.
  if (!gateExited || replaying || gateExitSent) return
  gateExitSent = true
  // The relay holds an agent, not a session: with the agent gone it leaves.
  // The spool goes with it; a turn the agent outlived needs no replay.
  dropSpool()
  if (!client || client.destroyed) { finish(0); return }
  // end() flushes queued STDOUT and EXITED in order before the relay leaves.
  client.once('close', () => finish(0))
  client.end(encodeJson(EXITED, gateExited), () => finish(0))
}

function streamSpool(socket, onDone) {
  let size = 0
  try { size = statSync(spoolPath).size } catch { size = 0 }
  if (!size) {
    onDone()
    return
  }
  // A replacement supersedes any replay still in flight: every byte the
  // old queue holds was appended before this hello, so the bounded stream
  // below already covers it — drop the queue or those bytes go out twice.
  replaying = true
  replayQueue = []
  replayQueueBytes = 0
  // Bounded to the bytes the hello saw: live chunks appended while this
  // streams travel through the replay queue instead, so no byte goes out
  // twice. (This runs in one tick with the stat above, so nothing lands
  // between the size and the queue taking over.)
  const stream = createReadStream(spoolPath, { end: size - 1 })
  stream.on('data', (chunk) => send(socket, encode(STDOUT, chunk)))
  stream.on('error', (error) => {
    log(`spool read failed: ${error instanceof Error ? error.message : String(error)}`)
    sendError(socket, 'the turn spool could not be read; this session falls back')
    socket.destroy()
  })
  stream.on('end', onDone)
}

function attach(socket, hello) {
  if (hello?.session !== sessionId) {
    sendError(socket, 'this relay holds another session')
    socket.destroy()
    return
  }
  if (gateExited) {
    send(socket, encodeJson(EXITED, gateExited))
    socket.destroy()
    return
  }
  if (client && !client.destroyed && !client.readableEnded) {
    sendError(socket, 'another Poise is already attached to this relay')
    socket.destroy()
    return
  }
  if (client) {
    // Its FIN arrived but the close has not been processed yet; it is gone.
    try { client.destroy() } catch { /* gone */ }
    client = null
  }
  client = socket
  let resolveGone
  clientGone = new Promise((resolve) => { resolveGone = resolve })
  socket.once('close', () => {
    // A replaced client (the readableEnded branch above) closes after its
    // replacement already streams the spool: only the active client's
    // close resets replay or ends a relay that never got GO.
    if (client !== socket) { resolveGone(); return }
    client = null
    replaying = false
    replayQueue = []
    replayQueueBytes = 0
    resolveGone()
    if (gateExited) { finishGateOutput(); return }
    if (!goSent && !shuttingDown) {
      // Poise died before GO: nothing may ever have started.
      log('client gone before GO; leaving without spawning')
      void shutdown(3)
    }
  })
  send(socket, encodeJson(READY, {
    version: PROTOCOL_VERSION,
    relayPid: process.pid,
    gatePid: gate.pid,
    gatePgid: gate.pid,
    spoolTurn: spoolTurnId,
  }))
  if (!goSent || !spoolTurnId) {
    send(socket, encode(LIVE, Buffer.alloc(0)))
    return
  }
  if (spoolFailed) {
    sendError(socket, `the turn spool failed (${spoolFailed}); this session falls back`)
    socket.destroy()
    return
  }
  streamSpool(socket, () => {
    if (client !== socket) return
    for (const chunk of replayQueue) send(socket, encode(STDOUT, chunk))
    replayQueue = []
    replayQueueBytes = 0
    replaying = false
    send(socket, encode(LIVE, Buffer.alloc(0)))
    finishGateOutput()
  })
}

function handleFrame(socket, kind, payload) {
  if (kind === HELLO) {
    let hello = null
    try { hello = JSON.parse(payload.toString('utf8')) } catch { /* rejected below */ }
    if (hello?.version !== PROTOCOL_VERSION) {
      sendError(socket, `relay protocol ${hello?.version} is not ${PROTOCOL_VERSION}`)
      socket.destroy()
      return
    }
    attach(socket, hello)
    return
  }
  if (socket !== client) return // a stranger's frames are ignored
  switch (kind) {
    case GO: {
      if (goSent || gateExited) {
        sendError(socket, 'the agent is already started')
        return
      }
      goSent = true
      try {
        gateControl.write('GO\n')
      } catch (error) {
        sendError(socket, `GO failed: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      send(socket, encodeJson(STARTED, {}))
      return
    }
    case STDIN: {
      if (!goSent) {
        sendError(socket, 'the agent is not started')
        return
      }
      if (gateExited) return
      if (spoolTurnId && !outboundTruncated) {
        if (outboundBytes + payload.length > MAX_OUTBOUND_BYTES) {
          outboundTruncated = true
          log('outbound log over the bound; replay must fall back')
        } else {
          outbound.push(payload)
          outboundBytes += payload.length
        }
      }
      try { gate.stdin.write(payload) } catch { /* the gate is gone; its exit covers it */ }
      return
    }
    case TURN_START: {
      let turn = null
      try { turn = JSON.parse(payload.toString('utf8')) } catch { /* rejected below */ }
      if (!turn || typeof turn.turnId !== 'string' || !turn.turnId) {
        sendError(socket, 'turnStart needs a turnId')
        return
      }
      spoolTurnId = turn.turnId
      spoolFailed = null
      clearOutbound()
      try { writeFileSync(spoolPath, Buffer.alloc(0)) } catch (error) {
        spoolFailed = error instanceof Error ? error.message : String(error)
        log(`spool rotate failed: ${spoolFailed}`)
        sendError(socket, `the turn spool failed (${spoolFailed}); this turn cannot be replayed after a restart`)
      }
      return
    }
    case TURN_FINISH: {
      dropSpool()
      clearOutbound()
      return
    }
    case GET_OUTBOUND: {
      send(socket, encodeJson(OUTBOUND, {
        truncated: outboundTruncated,
        bytes: Buffer.concat(outbound).toString('base64'),
      }))
      return
    }
    case SHUTDOWN: {
      void shutdown(0)
      return
    }
    case SIGNAL: {
      let request = null
      try { request = JSON.parse(payload.toString('utf8')) } catch { /* ignored */ }
      const signal = request?.signal ?? 'SIGTERM'
      try {
        // The gate leads its own group: this is the agent and its children,
        // never the relay.
        process.kill(-gate.pid, signal)
      } catch { /* already gone */ }
      return
    }
    default:
      sendError(socket, `unknown frame kind ${kind}`)
  }
}

mkdirSync(dir, { recursive: true, mode: 0o700 })
try { mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 }) } catch { /* inside dir */ }
try { unlinkSync(socketPath) } catch { /* first relay for this session */ }

gate = spawn(process.execPath, [gateScript, '--lease-worker', gateIdent, '--', command, ...commandArgs], {
  // The relay is spawned in the checkout, so the gate — and the agent — inherit it.
  cwd: process.cwd(),
  env: process.env,
  detached: true,
  stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
if (!gate.pid || !gate.stdin || !gate.stdout || !gate.stdio[3]) {
  try { gate.kill('SIGKILL') } catch { /* never started */ }
  log('could not spawn the worker gate')
  process.exit(65)
}
gateControl = gate.stdio[3]
gateControl.on('error', () => { /* the gate is gone; its exit covers it */ })
gate.stdout.on('data', onAgentOutput)
gate.stderr.on('data', onAgentStderr)
// exit can precede the final stdout chunks. close follows stdio EOF.
gate.once('close', (code) => onGateExit(code))
gate.once('error', (error) => log(`gate error: ${error.message}`))

const server = createServer((socket) => {
  const decoder = new Decoder((kind, payload) => {
    try {
      handleFrame(socket, kind, payload)
    } catch (error) {
      sendError(socket, error instanceof Error ? error.message : String(error))
      socket.destroy()
    }
  })
  socket.on('data', (chunk) => {
    try {
      decoder.push(chunk)
    } catch (error) {
      sendError(socket, error instanceof Error ? error.message : String(error))
      socket.destroy()
    }
  })
  socket.on('error', () => { /* close handling covers it */ })
})
server.on('error', (error) => {
  log(`socket failed: ${error.message}`)
  process.exit(65)
})
// The socket lives in the shared temp dir (see relaySocketFor): bind it
// owner-only. The gate already runs, so this umask never reaches it or
// the agent — only the socket and files the relay itself writes meanwhile.
const prevUmask = process.umask(0o077)
server.listen(socketPath, () => { process.umask(prevUmask) })
log(`relay ${relayIdent} for session ${sessionId}: gate ${gate.pid}, socket ${socketPath}`)

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => { void shutdown(0) })
}
