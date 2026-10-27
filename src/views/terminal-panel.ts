// A terminal inside Settings: xterm.js drawing /ws/terminal (server/terminal),
// which runs a CLI's own login, or a shell, in the workspace. Settings loads
// this module the first time it opens a terminal.

import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './terminal-panel.css'
import {
  TERMINAL_CLOSE, TERMINAL_LIMITS, TERMINAL_WS_PATH,
  type TerminalClientFrame, type TerminalPreset, type TerminalServerFrame,
} from '../../server/terminal/protocol'

export interface TerminalEnd {
  /** The program's exit code; null when the terminal ended without one. */
  code: number | null
  /** Why it ended, in words for the person. */
  message: string
  ok: boolean
}

export interface TerminalPanelOptions {
  preset: TerminalPreset
  /** The command it runs, as the person reads it. */
  title: string
  onEnd: (end: TerminalEnd) => void
  /** Closed by the person: the panel is gone. */
  onDispose: () => void
}

export interface TerminalPanel {
  readonly element: HTMLElement
  /** Until the program has exited or the connection has closed. */
  readonly running: boolean
  focus(): void
  /** End the terminal (Poise hangs up its program) and remove the panel. */
  dispose(): void
}

// Neutrals follow the theme, so every colour a program uses stays readable on
// the terminal's background; the eight colours are the design accents.
function themeFromTokens(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  return {
    background: token('--bg'),
    foreground: token('--text'),
    cursor: token('--text'),
    cursorAccent: token('--bg'),
    selectionBackground: token('--hover'),
    black: token('--n6'),
    brightBlack: token('--n4'),
    red: token('--a5'),
    brightRed: token('--a5'),
    green: token('--a3'),
    brightGreen: token('--a3'),
    yellow: token('--a4'),
    brightYellow: token('--a4'),
    blue: token('--a1'),
    brightBlue: token('--a1'),
    magenta: token('--a7'),
    brightMagenta: token('--a7'),
    cyan: token('--a2'),
    brightCyan: token('--a2'),
    white: token('--n5'),
    brightWhite: token('--n7'),
  }
}

function endMessage(event: CloseEvent): string {
  if (event.code === TERMINAL_CLOSE.idle) return `Closed after ${TERMINAL_LIMITS.idleMinutes} idle minutes.`
  if (event.code === TERMINAL_CLOSE.busy || event.code === TERMINAL_CLOSE.failed) return event.reason
  if (event.code === 1001) return 'Poise stopped, and the terminal with it.'
  // A refused upgrade reaches the browser only as an abnormal close.
  if (event.code === 1006) return 'Poise refused the terminal or lost the connection to it.'
  return event.reason || `The terminal closed (${event.code}).`
}

function decode(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function openTerminal(options: TerminalPanelOptions): TerminalPanel {
  const element = document.createElement('div')
  element.className = 'st-terminal'
  element.dataset.preset = options.preset
  element.setAttribute('role', 'group')
  element.setAttribute('aria-label', `Terminal: ${options.title}`)
  const head = document.createElement('div')
  head.className = 'st-terminal-head'
  const title = document.createElement('code')
  title.className = 'st-terminal-title'
  title.textContent = options.title
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'st-clear st-terminal-close'
  close.textContent = 'Close'
  head.append(title, close)
  const screen = document.createElement('div')
  screen.className = 'st-terminal-screen'
  const box = document.createElement('div')
  box.className = 'st-terminal-fit'
  screen.append(box)
  const status = document.createElement('div')
  status.className = 'st-help st-help-info st-terminal-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  status.textContent = 'Starting…'
  element.append(head, screen, status)

  const terminal = new Terminal({
    fontFamily: '\'SF Mono\', \'JetBrains Mono\', Menlo, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 2000,
    theme: themeFromTokens(),
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)

  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${scheme}//${location.host}${TERMINAL_WS_PATH}?preset=${encodeURIComponent(options.preset)}`)
  let running = true
  let exitCode: number | null = null
  let disposed = false

  const send = (frame: TerminalClientFrame) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }
  const sendSize = () => {
    const cols = Math.min(Math.max(terminal.cols, TERMINAL_LIMITS.cols.min), TERMINAL_LIMITS.cols.max)
    const rows = Math.min(Math.max(terminal.rows, TERMINAL_LIMITS.rows.min), TERMINAL_LIMITS.rows.max)
    send({ type: 'resize', cols, rows })
  }
  const refit = () => {
    // Hidden (another Settings tab), the box has no size to fit.
    if (!disposed && box.clientWidth > 0 && box.clientHeight > 0) fit.fit()
  }
  const finish = (end: TerminalEnd) => {
    if (!running) return
    running = false
    terminal.options.disableStdin = true
    terminal.options.cursorBlink = false
    status.textContent = end.message
    status.className = `st-help st-help-${end.ok ? 'info' : 'error'} st-terminal-status`
    options.onEnd(end)
  }

  terminal.onData((data) => send({ type: 'input', data }))
  terminal.onResize(sendSize)
  socket.addEventListener('open', () => {
    status.textContent = 'Running in your workspace. Close ends it.'
    sendSize()
  })
  socket.addEventListener('message', (event: MessageEvent<string>) => {
    let frame: TerminalServerFrame
    try {
      frame = JSON.parse(event.data)
    } catch {
      socket.close(1007, 'frame is not JSON')
      return
    }
    if (frame.type === 'output') terminal.write(decode(frame.data))
    else if (frame.type === 'exit') exitCode = frame.code
  })
  socket.addEventListener('close', (event) => {
    if (exitCode !== null) finish({ code: exitCode, ok: exitCode === 0, message: `Exited with code ${exitCode}.` })
    else finish({ code: null, ok: false, message: endMessage(event) })
  })

  const observer = new ResizeObserver(refit)
  const onTheme = () => { terminal.options.theme = themeFromTokens() }
  window.addEventListener('poise:theme-changed', onTheme)

  const panel: TerminalPanel = {
    element,
    get running() { return running },
    focus: () => terminal.focus(),
    dispose: () => {
      if (disposed) return
      disposed = true
      observer.disconnect()
      window.removeEventListener('poise:theme-changed', onTheme)
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000, 'closed')
      terminal.dispose()
      element.remove()
      options.onDispose()
    },
  }
  close.addEventListener('click', panel.dispose)

  // Opened once the element is in the document, so xterm can measure it.
  queueMicrotask(() => {
    if (disposed) return
    terminal.open(box)
    refit()
    observer.observe(box)
    terminal.focus()
  })
  return panel
}
