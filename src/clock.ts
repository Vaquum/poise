// Poise's clock: how a time reads wherever Poise shows one, on a 24-hour
// en-GB clock in the person's time zone, with the date only when it is not
// today. Chat's turn times (src/chat-turn-time.ts), the notification rail and
// every other view build on it. Kept free of runtime imports so it can be
// tested under the node environment.

type Parts = Record<string, string>

const OPTIONS = {
  time: { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' },
  full: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' },
  day: { year: 'numeric', month: '2-digit', day: '2-digit' },
} satisfies Record<string, Intl.DateTimeFormatOptions>

// Views redraw their times often, and building a formatter costs far more
// than using one, so each is built once per zone.
const formats = new Map<string, Intl.DateTimeFormat>()

// Assembled from parts: a combined en-GB pattern adds commas ("21 Oct, 00:30").
function parts(date: Date, timeZone: string, kind: keyof typeof OPTIONS): Parts {
  const key = `${kind} ${timeZone}`
  let format = formats.get(key)
  if (!format) formats.set(key, format = new Intl.DateTimeFormat('en-GB', { ...OPTIONS[kind], timeZone }))
  return Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]))
}

// The time's parts, and its date when it is not on the day of `now`: the day
// and month this year, with the year in another one.
function dated(at: string | number, timeZone: string, now: number): { time: Parts, date: string | null } {
  const time = parts(new Date(at), timeZone, 'time')
  const today = parts(new Date(now), timeZone, 'time')
  if (time.year !== today.year) return { time, date: `${time.day} ${time.month} ${time.year}` }
  return { time, date: time.month === today.month && time.day === today.day ? null : `${time.day} ${time.month}` }
}

// Every function here throws a RangeError for a string or number that is not a
// time, such as 'not a time' or NaN, or for a time zone Intl does not know:
// neither has a right answer to show.

/** "19:38" on the day of `now`, "20 Oct 17:05" on another day and
 *  "31 Dec 2025 23:05" in another year. */
export function shortTime(at: string | number, timeZone: string, now: number): string {
  const { time, date } = dated(at, timeZone, now)
  return `${date ? `${date} ` : ''}${time.hour}:${time.minute}`
}

/** As shortTime, with seconds, for activity lines a second apart. */
export function logTime(at: string | number, timeZone: string, now: number): string {
  const { time, date } = dated(at, timeZone, now)
  return `${date ? `${date} ` : ''}${time.hour}:${time.minute}:${time.second}`
}

/** "19:38" on the day of `now`, otherwise the date alone, for compact lists. */
export function listTime(at: string | number, timeZone: string, now: number): string {
  const { time, date } = dated(at, timeZone, now)
  return date ?? `${time.hour}:${time.minute}`
}

/** "Wednesday 21 October 2026 at 19:38:12 EEST". */
export function fullTime(at: string | number, timeZone: string): string {
  const full = parts(new Date(at), timeZone, 'full')
  return `${full.weekday} ${full.day} ${full.month} ${full.year} at ${full.hour}:${full.minute}:${full.second} ${full.timeZoneName}`
}

/** The calendar day `now` falls on in `timeZone`, with the zone: a time's
 *  short form can change only when this does. */
export function clockDay(timeZone: string, now: number): string {
  const day = parts(new Date(now), timeZone, 'day')
  return `${timeZone} ${day.year}-${day.month}-${day.day}`
}
