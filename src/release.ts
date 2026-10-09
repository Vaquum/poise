// The menu's first line: the commit this Poise runs, linked to it on
// autonomio/poise, where the source lives, and when Poise was updated to it.
// Kept free of imports so it can be tested under the node environment.

export interface RunningRelease {
  commit: string | null
  since: string | null
}

export interface ReleaseLine {
  /** The short hash shown. */
  commit: string
  href: string
  /** When, in the cleanest form: "9 Oct 21:40", with the year when it is not this one. */
  when: string | null
  /** Everything, in words, for hovering and assistive technology. */
  label: string
}

const SOURCE = 'https://github.com/autonomio/poise/commit/'
const COMMIT = /^[0-9a-f]{40}$/

function parts(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).formatToParts(date).map((part) => [part.type, part.value]))
}

/** The line for `release`, or null when there is no commit to show. */
export function releaseLine(release: unknown, timeZone: string, now = Date.now()): ReleaseLine | null {
  if (!release || typeof release !== 'object') return null
  const { commit, since } = release as Partial<RunningRelease>
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return null
  const short = commit.slice(0, 7)
  const at = typeof since === 'string' && Number.isFinite(Date.parse(since)) ? new Date(since) : null
  if (!at) return { commit: short, href: `${SOURCE}${commit}`, when: null, label: `Poise runs autonomio/poise@${short}` }
  const date = parts(at, timeZone, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const thisYear = parts(new Date(now), timeZone, { year: 'numeric' }).year
  const when = `${date.day} ${date.month}${date.year === thisYear ? '' : ` ${date.year}`} ${date.hour}:${date.minute}`
  const long = parts(at, timeZone, { day: 'numeric', month: 'long', year: 'numeric' })
  return {
    commit: short,
    href: `${SOURCE}${commit}`,
    when,
    label: `Poise runs autonomio/poise@${short}, since ${long.day} ${long.month} ${long.year} at ${date.hour}:${date.minute}`,
  }
}
