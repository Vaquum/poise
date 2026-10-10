// The notifications at the top of the page (server/alerts/notices.ts): read
// every few seconds while this tab is in front, at once when it comes back to
// the front, and after the person acts on one. Every tab of the workspace shows
// the same ones: what one tab puts away, the others drop on their next read.

export const NOTICE_KINDS = ['chat_waiting', 'sign_in_needed', 'behavior_held', 'datastore_sync_failing', 'pr_ready', 'chat_turn_finished'] as const
export type NoticeKind = typeof NOTICE_KINDS[number]

export type NoticeTarget =
  | { view: 'behaviors' }
  | { swarm: string }
  | { settings: 'general' | 'accounts' }
  | { chat: string }
  | { pullRequest: string }

export interface Notice {
  id: string
  kind: NoticeKind
  title: string
  body: string
  /** When the condition began; for a ready pull request, when it became ready. */
  since: string
  /** When this showing became due: `since`, or the latest reminder. */
  due: string
  silenceable: boolean
  target: NoticeTarget | null
}

export interface NoticesState {
  enabled: boolean
  notices: Notice[]
}

export const READ_INTERVAL_MS = 10_000

const PULL_REQUEST_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9][0-9]*$/

function isTarget(value: unknown): value is NoticeTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const target = value as Record<string, unknown>
  if (Object.keys(target).length !== 1) return false
  if ('view' in target) return target.view === 'behaviors'
  if ('swarm' in target) return typeof target.swarm === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(target.swarm)
  if ('settings' in target) return target.settings === 'general' || target.settings === 'accounts'
  if ('chat' in target) return typeof target.chat === 'string' && target.chat.length > 0
  if ('pullRequest' in target) return typeof target.pullRequest === 'string' && PULL_REQUEST_URL.test(target.pullRequest)
  return false
}

function isNotice(value: unknown): value is Notice {
  if (!value || typeof value !== 'object') return false
  const notice = value as Record<string, unknown>
  return typeof notice.id === 'string' && notice.id.length > 0
    && (NOTICE_KINDS as readonly unknown[]).includes(notice.kind)
    && typeof notice.title === 'string'
    && typeof notice.body === 'string'
    && typeof notice.since === 'string' && Number.isFinite(Date.parse(notice.since))
    && typeof notice.due === 'string' && Number.isFinite(Date.parse(notice.due))
    && typeof notice.silenceable === 'boolean'
    && (notice.target === null || isTarget(notice.target))
}

/** The server's answer as state, or null when it is not one. A notice the page
 *  cannot show is left out rather than shown wrong. */
export function noticesFrom(value: unknown): NoticesState | null {
  if (!value || typeof value !== 'object') return null
  const body = value as Record<string, unknown>
  if (typeof body.enabled !== 'boolean' || !Array.isArray(body.notices)) return null
  return { enabled: body.enabled, notices: body.enabled ? body.notices.filter(isNotice) : [] }
}

/** "4 min", "1 h 5 min": how long a condition has stood, for a reminder. */
export function standingFor(since: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** Sends the newest of a series of choices, one request at a time: a choice
 *  made while another is being sent waits for it, and of those waiting only
 *  the newest is sent. So the last choice made is the one that stays, whatever
 *  order the server would have taken simultaneous requests in. `failed` hears
 *  of a failure only when no newer choice is waiting to replace it. */
export function sendLatest<T>(send: (value: T) => Promise<void>, failed: (error: unknown, value: T) => void): (value: T) => void {
  let waiting: { value: T } | null = null
  let sending = false
  async function drain(): Promise<void> {
    sending = true
    while (waiting) {
      const { value } = waiting
      waiting = null
      try {
        await send(value)
      } catch (error) {
        if (!waiting) failed(error, value)
      }
    }
    sending = false
  }
  return (value) => {
    waiting = { value }
    if (!sending) void drain()
  }
}

type Listener = (state: NoticesState) => void

/** A notice this tab put away, kept away until an answer that knows of it. */
interface PutAway {
  /** The showing dismissed: a later reminder of the same notice shows. Null
   *  for a silence, which no reminder of that notice outlasts. */
  due: string | null
  /** The request count once the server had taken it; null while it is being sent. */
  settledAt: number | null
}

/** The notices this tab shows, kept in step with the server. Requests are
 *  numbered as they are sent: an answer older than one already shown is
 *  dropped, and a notice put away stays away until an answer to a request sent
 *  after the server took it, so no answer in flight can bring it back. */
export class NoticeFeed {
  private state: NoticesState = { enabled: false, notices: [] }
  private server: NoticesState = { enabled: false, notices: [] }
  private readonly putAway = new Map<string, PutAway>()
  private sent = 0
  private shown = 0
  private readonly listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private reading: Promise<void> | null = null
  private readonly onVisible = () => { if (document.visibilityState === 'visible') void this.read() }

  constructor(private readonly request: typeof fetch = (...args) => fetch(...args)) {}

  get current(): NoticesState {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.timer) return
    // A tab in the background reads nothing: Poise Link covers the desktop.
    this.timer = setInterval(() => { if (document.visibilityState === 'visible') void this.read() }, READ_INTERVAL_MS)
    document.addEventListener('visibilitychange', this.onVisible)
    window.addEventListener('focus', this.onVisible)
    void this.read()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    document.removeEventListener('visibilitychange', this.onVisible)
    window.removeEventListener('focus', this.onVisible)
  }

  /** Reads what the server shows now, joining a read already on its way; an
   *  answer that is not one changes nothing. */
  read(): Promise<void> {
    if (this.reading) return this.reading
    // Cleared once settled, never before it is recorded.
    const current: Promise<void> = this.fetchState().finally(() => {
      if (this.reading === current) this.reading = null
    })
    this.reading = current
    return current
  }

  /** Reads anew, never joining a read sent before: after a change, such as
   *  turning notifications off, only an answer sent after it is current. */
  refresh(): Promise<void> {
    return this.fetchState()
  }

  private async fetchState(): Promise<void> {
    const sent = ++this.sent
    try {
      const res = await this.request('/api/notices', { headers: { Accept: 'application/json' } })
      if (!res.ok) return
      this.receive(sent, noticesFrom(await res.json()))
    } catch {
      // Offline or restarting: the next read tries again.
    }
  }

  /** Puts a notice away here at once, then on the server, whose answer wins. */
  dismiss(id: string): Promise<void> {
    return this.act(id, 'dismiss')
  }

  /** Asks to hear no more about a ready pull request. */
  silence(id: string): Promise<void> {
    return this.act(id, 'silence')
  }

  private async act(id: string, action: 'dismiss' | 'silence'): Promise<void> {
    const due = this.state.notices.find((notice) => notice.id === id)?.due ?? ''
    const away: PutAway = { due: action === 'silence' ? null : due, settledAt: null }
    this.putAway.set(id, away)
    this.publish()
    const sent = ++this.sent
    try {
      const res = await this.request(`/api/notices/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { Accept: 'application/json' } })
      const next = noticesFrom(await res.json().catch(() => null))
      if (res.ok && next) {
        away.settledAt = this.sent
        this.receive(sent, next)
        return
      }
    } catch {
      // Fall through: the server says what still stands.
    }
    if (this.putAway.get(id) === away) this.putAway.delete(id)
    this.publish()
    await this.refresh()
  }

  /** The server's answer to request `sent`, unless a later one is shown already. */
  private receive(sent: number, next: NoticesState | null): void {
    if (!next || sent <= this.shown) return
    this.shown = sent
    // An answer to a request sent after the server took an action knows of it.
    for (const [id, away] of this.putAway) {
      if (away.settledAt !== null && away.settledAt < sent) this.putAway.delete(id)
    }
    this.server = next
    this.publish()
  }

  private publish(): void {
    const hidden = (notice: Notice) => {
      const away = this.putAway.get(notice.id)
      return !!away && (away.due === null || away.due === notice.due)
    }
    const next = { ...this.server, notices: this.server.notices.filter((notice) => !hidden(notice)) }
    this.state = next
    for (const listener of this.listeners) listener(next)
  }
}
