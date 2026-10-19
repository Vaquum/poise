import { effectiveTimezone, midnightInZone } from './config'

/** Fraction elapsed between the actual calendar edges, including 23/25-hour days. */
export function analyticsDayProgress(since: string, until: string, now = Date.now()): number {
  const start = Date.parse(since)
  return Math.max(0, Math.min(1, (now - start) / (Date.parse(until) - start)))
}

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

/** The edges of the 7-day periods in the year before the selected day, oldest first. The last edge is the selected day's midnight, so the latest period is its 7-day baseline. */
export function analyticsHistoryBounds(offset: number, anchor = new Date(), periods = 52): string[] {
  return Array.from({ length: periods + 1 }, (_, i) => midnightInZone(offset - 7 * (periods - i), anchor).toISOString())
}

/** Seven complete calendar days, including DST days, without another request. */
export function analyticsDailyBounds(offset: number, anchor = new Date()): string[] {
  return Array.from({ length: 8 }, (_, i) => midnightInZone(offset - 7 + i, anchor).toISOString())
}
