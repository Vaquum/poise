import { effectiveTimezone, midnightInZone } from './config'

/** Calendar days in Settings' timezone, including the seven completed days before selection. */
export function analyticsDay(offset: number, anchor = new Date()): { label: string, isToday: boolean, since: string, until: string, baselineSince: string } {
  const start = midnightInZone(offset, anchor)
  const isToday = start.getTime() === midnightInZone().getTime()
  return {
    isToday,
    label: isToday ? 'Today' : start.getTime() === midnightInZone(-1).getTime() ? 'Yesterday' : new Intl.DateTimeFormat('en-GB', {
      timeZone: effectiveTimezone(), day: 'numeric', month: 'short', year: 'numeric',
    }).format(start),
    since: start.toISOString(),
    until: midnightInZone(offset + 1, anchor).toISOString(),
    baselineSince: midnightInZone(offset - 7, anchor).toISOString(),
  }
}
