/** Pure civil-time validation, shared by query adapters and browser deep links. */
export function readLoggingTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match) throw new Error('Times must be zoned ISO timestamps.')
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match
  const civil = new Date(0)
  civil.setUTCFullYear(Number(year), Number(month), 0)
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > civil.getUTCDate()
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59
    || !Number.isFinite(Date.parse(value))) throw new Error('The timestamp is not a valid civil time.')
  return new Date(value).toISOString()
}
