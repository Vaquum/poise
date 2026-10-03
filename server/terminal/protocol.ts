// The terminal WebSocket (docs/Service-architecture.md, "Accounts,
// identities and the terminal"). Shared with the browser, so nothing here may
// depend on Node.

import { isAccountId, type AccountId } from '../accounts/types'

export const TERMINAL_WS_PATH = '/ws/terminal'

/** A CLI's own login, or the person's login shell. */
export type TerminalPreset = AccountId | 'shell'

export function isTerminalPreset(value: unknown): value is TerminalPreset {
  return value === 'shell' || isAccountId(value)
}

export const TERMINAL_LIMITS = {
  /** Terminals open at once, across every browser tab. */
  concurrent: 2,
  /** A terminal with neither input nor output for this long is closed. */
  idleMinutes: 15,
  /** One frame from the browser: typing, a paste or a resize. */
  frameBytes: 64 * 1024,
  /** A terminal's size, as the browser may ask for it. */
  cols: { min: 2, max: 500 },
  rows: { min: 2, max: 200 },
} as const

/** Browser to server. `data` is text as typed or pasted. */
export type TerminalClientFrame =
  | { type: 'input', data: string }
  | { type: 'resize', cols: number, rows: number }

/** Server to browser. `data` is the terminal's raw output, base64-encoded. */
export type TerminalServerFrame =
  | { type: 'output', data: string }
  | { type: 'exit', code: number }

// WebSocket close codes the server ends a terminal with, beyond the standard
// 1000 (the program exited) and 1001 (the server is shutting down).
export const TERMINAL_CLOSE = {
  /** Two terminals are already open. */
  busy: 1013,
  /** Neither side did anything for TERMINAL_LIMITS.idleMinutes. */
  idle: 4000,
  /** The terminal could not start, for the reason given. */
  failed: 1011,
} as const
