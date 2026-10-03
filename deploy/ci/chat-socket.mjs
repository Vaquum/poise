// Opens Chat's WebSocket the way the browser does, for deploy/ci/e2e.sh:
//
//   node chat-socket.mjs URL ORIGIN COOKIE IDLE_SECONDS
//
// Prints `connected` when Poise's hello frame arrives, keeps the socket
// silent for IDLE_SECONDS, then lists the Chat sessions over it and prints
// `answered`. An upgrade the server refuses prints `refused <status>` and
// exits with 2; anything else that goes wrong exits with 1.
import WebSocket from 'ws'

const [url, origin, cookie, idle] = process.argv.slice(2)
const idleMs = Number(idle) * 1000
const headers = { origin, ...(cookie ? { cookie } : {}) }
let answered = false

const deadline = setTimeout(() => {
  console.error(`no answer within ${idleMs / 1000 + 30} seconds`)
  process.exit(1)
}, idleMs + 30_000)

const socket = new WebSocket(url, { headers })
socket.on('unexpected-response', (_request, response) => {
  console.log(`refused ${response.statusCode}`)
  process.exit(2)
})
socket.on('error', (error) => {
  console.error(error.message)
  process.exit(1)
})
socket.on('message', (data) => {
  const frame = JSON.parse(String(data))
  if (frame.kind === 'hello') {
    console.log('connected')
    setTimeout(() => socket.send(JSON.stringify({ id: 'e2e-sessions', command: { type: 'session.list' } })), idleMs)
  } else if (frame.kind === 'ack' && frame.id === 'e2e-sessions') {
    if (!frame.ok || !Array.isArray(frame.result?.sessions)) {
      console.error(`session.list failed: ${JSON.stringify(frame)}`)
      process.exit(1)
    }
    console.log('answered')
    answered = true
    clearTimeout(deadline)
    socket.close()
  }
})
socket.on('close', (code, reason) => {
  if (answered) process.exit(0)
  console.error(`closed (${code} ${String(reason)}) before the answer`)
  process.exit(1)
})
