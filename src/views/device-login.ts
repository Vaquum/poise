// GitHub's device sign-in without a terminal on screen. gh's own `auth login`
// (ACCOUNT_LOGINS.gh) runs in the workspace through the terminal socket, as a
// Connect terminal does. This reads the one-time code from what gh prints,
// answers its two questions with their defaults (git signs in through gh;
// Enter, after which it starts waiting for GitHub), and keeps the rest of its
// output for whoever wants to read it.

import {
  TERMINAL_CLOSE, TERMINAL_LIMITS, TERMINAL_WS_PATH,
  type TerminalClientFrame, type TerminalServerFrame,
} from '../../server/terminal/protocol'

// CSI and OSC sequences and two-byte escapes; carriage returns become newlines.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function plainText(output: string): string {
  return output.replace(ESCAPES, '').replace(/\r\n?/g, '\n')
}

export interface DeviceLoginState {
  /** gh's one-time code, once it has printed it. */
  code: string | null
  /** Whether git should sign in through gh; Enter takes the default, yes. */
  askedGit: boolean
  /** gh waits for Enter, then tries to open a browser and starts waiting for GitHub. */
  askedEnter: boolean
}

export function readDeviceLogin(output: string): DeviceLoginState {
  const text = plainText(output)
  return {
    code: /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(text)?.[1] ?? null,
    askedGit: /Authenticate Git with your GitHub credentials\?/.test(text),
    askedEnter: /Press Enter to open\b/.test(text),
  }
}

export interface DeviceLoginEnd {
  ok: boolean
  /** gh's exit code; null when the connection ended without one. */
  exitCode: number | null
  message: string
}

export interface DeviceLoginHandlers {
  code(code: string): void
  /** Everything gh printed so far, as plain text. */
  output(text: string): void
  end(end: DeviceLoginEnd): void
}

export interface DeviceLogin {
  readonly running: boolean
  /** Hangs up gh. */
  cancel(): void
}

function closeMessage(event: CloseEvent): string {
  if (event.code === TERMINAL_CLOSE.idle) return `GitHub's sign-in was closed after ${TERMINAL_LIMITS.idleMinutes} idle minutes.`
  if (event.code === TERMINAL_CLOSE.busy || event.code === TERMINAL_CLOSE.failed) return event.reason
  if (event.code === 1001) return 'Poise stopped, and GitHub\'s sign-in with it.'
  if (event.code === 1006) return 'Poise refused GitHub\'s sign-in or lost the connection to it.'
  return event.reason || `GitHub's sign-in ended (${event.code}).`
}

function decode(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function startDeviceLogin(handlers: DeviceLoginHandlers): DeviceLogin {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${scheme}//${location.host}${TERMINAL_WS_PATH}?preset=gh`)
  const decoder = new TextDecoder()
  const answered = { git: false, enter: false, code: false }
  let output = ''
  let exitCode: number | null = null
  let running = true

  const send = (frame: TerminalClientFrame) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }
  // Wide enough that gh never wraps the line that holds the code.
  socket.addEventListener('open', () => send({ type: 'resize', cols: 160, rows: 40 }))
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    let frame: TerminalServerFrame
    try {
      frame = JSON.parse(event.data)
    } catch {
      socket.close(1007, 'frame is not JSON')
      return
    }
    if (frame.type === 'exit') {
      exitCode = frame.code
      return
    }
    output += decoder.decode(decode(frame.data), { stream: true })
    const state = readDeviceLogin(output)
    if (state.askedGit && !answered.git) {
      answered.git = true
      send({ type: 'input', data: '\r' })
    }
    if (state.code && !answered.code) {
      answered.code = true
      handlers.code(state.code)
    }
    if (state.askedEnter && !answered.enter) {
      answered.enter = true
      send({ type: 'input', data: '\r' })
    }
    handlers.output(plainText(output))
  })
  socket.addEventListener('close', (event) => {
    running = false
    if (exitCode !== null) {
      handlers.end({ ok: exitCode === 0, exitCode, message: exitCode === 0 ? 'GitHub approved the sign-in.' : `gh stopped with code ${exitCode}.` })
    } else {
      handlers.end({ ok: false, exitCode: null, message: closeMessage(event) })
    }
  })
  return {
    get running() { return running },
    cancel: () => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000, 'cancelled')
    },
  }
}
