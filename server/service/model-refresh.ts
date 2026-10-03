// The daily model-catalogue refresh inside Poise in service mode
// (docs/Service-architecture.md, "Scheduling"): at 07:00 in the timezone set
// in Settings, the same check launchd starts on a personal computer and
// Settings → Models → Check now starts on demand.

export const DAILY_REFRESH_HOUR = 7
const LOCAL_TIME = `${String(DAILY_REFRESH_HOUR).padStart(2, '0')}:00`
const MINUTE_MS = 60_000

export interface RefreshClock {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(timer: unknown): void
}

const systemClock: RefreshClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

interface WallClock { year: number, month: number, day: number, hour: number, minute: number, second: number }

const formatters = new Map<string, Intl.DateTimeFormat>()

/** Throws a RangeError for a name that is not an IANA timezone. */
function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    formatters.set(timeZone, format)
  }
  return format
}

function wallClock(at: number, timeZone: string): WallClock {
  const fields: Record<string, number> = {}
  for (const part of formatter(timeZone).formatToParts(at)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value)
  }
  return { year: fields.year, month: fields.month, day: fields.day, hour: fields.hour, minute: fields.minute, second: fields.second }
}

function offsetAt(at: number, timeZone: string): number {
  const wall = wallClock(at, timeZone)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(at / 1000) * 1000
}

// The offset is read twice: at the wall time taken as UTC, then at the first
// guess, so a day on which daylight saving time changes still lands on the
// zone's own hour.
function instantOf(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour)
  return wall - offsetAt(wall - offsetAt(wall, timeZone), timeZone)
}

/** The first 07:00 in `timeZone` strictly after `after`. */
export function nextDailyRefresh(after: number, timeZone: string): number {
  const today = wallClock(after, timeZone)
  for (let days = 0; days < 3; days++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + days))
    const at = instantOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), DAILY_REFRESH_HOUR, timeZone)
    if (at > after) return at
  }
  throw new Error(`no ${LOCAL_TIME} in ${timeZone} follows ${new Date(after).toISOString()}`)
}

export interface DailyModelRefreshOptions {
  /** The timezone set in Settings; empty when none is. */
  timeZone: () => string
  refresh: () => Promise<Record<string, unknown>>
  /** True while background work is not admitted (a drain). */
  paused: () => boolean
  clock?: RefreshClock
  log?: (line: string) => void
  logError?: (line: string) => void
}

/** Checks once a minute, so a timezone changed in Settings, a daylight saving
 *  change and a clock that jumped all apply to the very next run. */
export class DailyModelRefresh {
  private readonly clock: RefreshClock
  private readonly log: (line: string) => void
  private readonly logError: (line: string) => void
  private timer: unknown = null
  private stopped = true
  private zone: string | null = null
  private nextAt: number | null = null
  private zoneNotice = ''
  private running: Promise<void> | null = null

  constructor(private readonly options: DailyModelRefreshOptions) {
    this.clock = options.clock ?? systemClock
    this.log = options.log ?? ((line) => console.log(line))
    this.logError = options.logError ?? ((line) => console.error(line))
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.check()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
  }

  /** When the next check is due; null while no valid timezone is set. */
  get next(): number | null {
    return this.nextAt
  }

  private notice(line: string, error: boolean): void {
    if (line === this.zoneNotice) return
    this.zoneNotice = line
    if (line) (error ? this.logError : this.log)(line)
  }

  /** The configured zone, UTC only when none is set; null for a name that is
   *  not a timezone, which is reported rather than replaced. */
  private currentZone(): string | null {
    const configured = this.options.timeZone().trim()
    try {
      formatter(configured || 'UTC')
    } catch {
      this.notice(`[models] the timezone "${configured}" in Settings is not an IANA timezone; the daily model check waits until it is corrected`, true)
      return null
    }
    this.notice(configured ? '' : `[models] no timezone is set in Settings; the daily model check runs at ${LOCAL_TIME} UTC`, false)
    return configured || 'UTC'
  }

  private check(): void {
    if (this.stopped) return
    const now = this.clock.now()
    const zone = this.currentZone()
    if (zone !== this.zone) {
      this.zone = zone
      this.nextAt = zone ? nextDailyRefresh(now, zone) : null
      if (zone && this.nextAt !== null) {
        this.log(`[models] daily model check scheduled for ${new Date(this.nextAt).toISOString()} (${LOCAL_TIME} ${zone})`)
      }
    }
    if (zone && this.nextAt !== null && now >= this.nextAt) {
      this.nextAt = nextDailyRefresh(now, zone)
      this.run()
    }
    const toMinute = MINUTE_MS - (now % MINUTE_MS)
    const delay = this.nextAt === null ? toMinute : Math.min(toMinute, Math.max(0, this.nextAt - now))
    this.timer = this.clock.setTimeout(() => {
      this.timer = null
      this.check()
    }, delay)
  }

  private run(): void {
    if (this.options.paused()) {
      this.log('[models] daily model check skipped: Poise is draining')
      return
    }
    if (this.running) {
      this.log('[models] daily model check skipped: the previous one is still running')
      return
    }
    this.running = this.options.refresh().then((report) => {
      const failure = typeof report.error === 'string' && report.error ? report.error : null
      if (failure) this.logError(`[models] daily model check failed: ${failure}`)
      else this.log('[models] daily model check finished')
    }, (error: unknown) => {
      this.logError(`[models] daily model check failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      this.running = null
    })
  }
}
