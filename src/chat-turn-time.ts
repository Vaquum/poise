// When a Chat turn ended, as its meta row shows it: Poise's short time
// (src/clock.ts), and in full with how the turn ended. Kept free of runtime
// imports beyond the clock, which has none, so it can be tested under the node
// environment.

import type { StopReason } from '../server/chat/protocol'
import { fullTime, shortTime } from './clock'

export interface TurnTime {
  /** "19:38", "20 Oct 17:05" or "31 Dec 2025 23:05". */
  text: string
  /** Everything, in words: "Finished Wednesday 21 October 2026 at 19:38:12 EEST". */
  label: string
}

// How each ending reads before its full time, in the words of the meta row's
// stop label where that is a verb. Restart recovery writes an interrupted
// turn's end when Poise next starts, so that time is only when it was recorded.
const ENDED: Record<StopReason, string> = {
  end_turn: 'Finished',
  cancelled: 'Stopped',
  max_tokens: 'Hit the output limit',
  refusal: 'Refused',
  error: 'Failed',
  interrupted: 'Recorded as interrupted',
}

/** `at` is the time the server stamped on the turn's turn.finished event; it
 *  throws as the clock does for a value that is not a time or an unknown zone. */
export function turnTime(at: string, stopReason: StopReason, timeZone: string, now: number): TurnTime {
  return { text: shortTime(at, timeZone, now), label: `${ENDED[stopReason]} ${fullTime(at, timeZone)}` }
}

/** Elapsed time as "45s", "12m" or "1h 5m": the header's live "Running ·
 *  since …" for the turn on screen. Floored, so it never overstates a turn
 *  still running; a start that is not a time, or lies ahead, reads zero. */
export function shortElapsed(from: string | number, now: number): string {
  const ms = now - new Date(from).valueOf()
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
