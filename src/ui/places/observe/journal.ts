// A task's timeline is its chain's journal (#728). The journal reads 20 events
// at a time, oldest first from a cursor, and its sequence numbers are shared by
// every chain; it cannot be read backwards. To show the newest events first,
// this finds a window ending at the chain's latest event that holds at least a
// page of them, widening fourfold from the end, then reads that window whole.
// Older events come the same way from the window's start, and a window is
// always contiguous: nothing between two loaded events is ever skipped.
import type { JournalEvent } from './chains'

export type ReadPage = (after: number) => Promise<{ events: JournalEvent[], next: number | null }>

export interface JournalWindow {
  /** Ascending, every event of the chain with lo < sequence <= hi. */
  events: JournalEvent[]
  lo: number
  hi: number
  /** Nothing newer than hi was there when it was read. */
  complete: boolean
  /** lo is 0: nothing older exists. */
  start: boolean
}

export const JOURNAL_PAGE = 20
const FIRST_SPAN = 64
const MAX_PAGES = 40

export class JournalTooLong extends Error {}

async function page(read: ReadPage, after: number): Promise<{ events: JournalEvent[], next: number | null }> {
  const value = await read(after)
  if (value.next !== null && value.next <= after) throw new Error('The journal cursor did not advance.')
  return value
}

/** Reads on from `after` until `stop` says enough or the journal ends, a bounded number of pages. */
async function readOn(read: ReadPage, after: number, stop: (events: JournalEvent[]) => boolean, limit = MAX_PAGES): Promise<{ events: JournalEvent[], next: number | null }> {
  const events: JournalEvent[] = []
  let next: number | null = after
  for (let pages = 0; next !== null && pages < limit; pages++) {
    const p = await page(read, next)
    events.push(...p.events)
    next = p.next
    if (stop(p.events)) break
  }
  return { events, next }
}

/** The newest events of a chain whose latest event is `newest`: at least a page of them, or all there are. */
export async function readNewest(read: ReadPage, newest: number, want = JOURNAL_PAGE): Promise<JournalWindow> {
  for (let span = FIRST_SPAN; ; span *= 4) {
    const after = Math.max(0, newest - span)
    const first = await page(read, after)
    if (after > 0 && first.next === null && first.events.length < want) continue
    const rest = first.next === null ? { events: [], next: null } : await readOn(read, first.next, () => false)
    const events = [...first.events, ...rest.events]
    if (rest.next !== null) throw new JournalTooLong('The journal is too long to read here at once.')
    return { events, lo: after, hi: events.length ? events[events.length - 1].sequence : after, complete: true, start: after === 0 }
  }
}

/** A page or more of the events just before the window, joined to it without a gap. */
export async function readOlder(read: ReadPage, window: JournalWindow, want = JOURNAL_PAGE): Promise<JournalWindow> {
  if (window.start) return window
  const bound = window.lo
  for (let span = FIRST_SPAN; ; span *= 4) {
    const after = Math.max(0, bound - span)
    const first = await page(read, after)
    const older = first.events.filter((e) => e.sequence <= bound)
    if (after > 0 && older.length < want) continue
    const reached = first.next === null || first.events.some((e) => e.sequence > bound)
    const rest = reached ? { events: [], next: null } : await readOn(read, first.next!, (events) => events.some((e) => e.sequence > bound))
    if (!reached && rest.next !== null && !rest.events.some((e) => e.sequence > bound)) throw new JournalTooLong('The journal is too long to read here at once.')
    const events = [...older, ...rest.events.filter((e) => e.sequence <= bound)]
    return { ...window, events: [...events, ...window.events], lo: after, start: after === 0 }
  }
}

/** The events after the window's newest, a few pages at a time. */
export async function readLater(read: ReadPage, window: JournalWindow, pages = 5): Promise<JournalWindow> {
  const rest = await readOn(read, window.hi, () => false, pages)
  const events = [...window.events, ...rest.events]
  return { ...window, events, hi: events.length ? events[events.length - 1].sequence : window.hi, complete: rest.next === null }
}

/** From a step a notice or a diagnostic names: that event and the ones after it. */
export async function readFrom(read: ReadPage, after: number, pages = 3): Promise<JournalWindow> {
  const rest = await readOn(read, after, () => false, pages)
  return { events: rest.events, lo: after, hi: rest.events.length ? rest.events[rest.events.length - 1].sequence : after, complete: rest.next === null, start: after === 0 }
}
