// When a Chat turn ended, as its meta row shows it: the time alone for a turn
// that ended today, with the date for another day and the year for another
// year, in the person's timezone. The notification rail's history uses the
// same short time. Kept free of runtime imports so it can be tested under the
// node environment.

import type { StopReason } from '../server/chat/protocol'

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

const OPTIONS = {
  ended: { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' },
  long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  day: { year: 'numeric', month: '2-digit', day: '2-digit' },
} satisfies Record<string, Intl.DateTimeFormatOptions>

// Every turn's row is redrawn on each context change, and building a
// formatter costs far more than using one, so each is built once per zone.
const formats = new Map<string, Intl.DateTimeFormat>()

// Assembled from parts: a combined en-GB pattern adds commas ("21 Oct, 00:30").
function parts(date: Date, timeZone: string, kind: keyof typeof OPTIONS): Record<string, string> {
  const key = `${kind} ${timeZone}`
  let format = formats.get(key)
  if (!format) formats.set(key, format = new Intl.DateTimeFormat('en-GB', { ...OPTIONS[kind], timeZone }))
  return Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]))
}

/** The calendar day `now` falls on in `timeZone`, with the zone: a turn's
 *  label can change only when this does. */
export function clockDay(timeZone: string, now: number): string {
  const day = parts(new Date(now), timeZone, 'day')
  return `${timeZone} ${day.year}-${day.month}-${day.day}`
}

function short(at: Record<string, string>, today: Record<string, string>): string {
  const time = `${at.hour}:${at.minute}`
  const thisYear = at.year === today.year
  return thisYear && at.month === today.month && at.day === today.day ? time
    : `${at.day} ${at.month}${thisYear ? '' : ` ${at.year}`} ${time}`
}

/** "19:38" on the day of `now`, "20 Oct 17:05" on another day and
 *  "31 Dec 2025 23:05" in another year. A value that is not a time, or a time
 *  zone Intl does not know, throws a RangeError: neither has a right answer
 *  to show. */
export function shortTime(at: string, timeZone: string, now: number): string {
  return short(parts(new Date(at), timeZone, 'ended'), parts(new Date(now), timeZone, 'ended'))
}

/** `at` is the time the server stamped on the turn's turn.finished event;
 *  it throws as `shortTime` does. */
export function turnTime(at: string, stopReason: StopReason, timeZone: string, now: number): TurnTime {
  const date = new Date(at)
  const ended = parts(date, timeZone, 'ended')
  const long = parts(date, timeZone, 'long')
  return {
    text: short(ended, parts(new Date(now), timeZone, 'ended')),
    label: `${ENDED[stopReason]} ${long.weekday} ${long.day} ${long.month} ${long.year} at ${ended.hour}:${ended.minute}:${ended.second} ${ended.timeZoneName}`,
  }
}
