// The time ranges Current filters by, shared with the Analytics panel so both
// mean the same thing by "Today" or "This week": the person's timezone, from
// Settings → General.

import { midnightInZone, startOfWeekInZone } from './config'

export type TimeRange = 'all' | 'today' | 'yesterday' | 'week'

export const TIME_RANGES: { key: TimeRange, label: string }[] = [
  { key: 'all',       label: 'Any time'  },
  { key: 'today',     label: 'Today'     },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week',      label: 'This week' },
]

export function isTimeRange(value: unknown): value is TimeRange {
  return TIME_RANGES.some((range) => range.key === value)
}

/** `since` is inclusive, `until` exclusive; an absent bound is open. */
export function timeRangeWindow(range: TimeRange): { since?: string; until?: string } {
  if (range === 'today')     return { since: midnightInZone(0).toISOString() }
  if (range === 'yesterday') return { since: midnightInZone(-1).toISOString(), until: midnightInZone(0).toISOString() }
  if (range === 'week')      return { since: startOfWeekInZone().toISOString() }
  return {}
}

/** Where Current keeps its filters across reloads. */
export const CURRENT_FILTER_KEY = 'poise-current-filters'

/** The range Current shows; Analytics opens on it. */
export function currentViewTimeRange(): TimeRange {
  try {
    const time = JSON.parse(localStorage.getItem(CURRENT_FILTER_KEY) || '{}').time
    return isTimeRange(time) ? time : 'all'
  } catch {
    return 'all'
  }
}
