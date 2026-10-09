// The notifications at the top of the page (server/alerts/notices.ts): read
// every few seconds while this tab is in front, at once when it comes back to
// the front, and after the person acts on one. Every tab of the workspace shows
// the same ones: what one tab puts away, the others drop on their next read.

export const NOTICE_KINDS = ['chat_waiting', 'sign_in_needed', 'behavior_held', 'datastore_sync_failing', 'pr_ready', 'chat_turn_finished'] as const
export type NoticeKind = typeof NOTICE_KINDS[number]

export type NoticeTarget =
  | { view: 'behaviors' }
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

type Listener = (state: NoticesState) => void

/** The notices this tab shows, kept in step with the server. */
export class NoticeFeed {
  private state: NoticesState = { enabled: false, notices: [] }
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

  /** Reads what the server shows now; an answer that is not one changes nothing. */
  read(): Promise<void> {
    if (this.reading) return this.reading
    this.reading = (async () => {
      try {
        const res = await this.request('/api/notices', { headers: { Accept: 'application/json' } })
        if (!res.ok) return
        this.apply(noticesFrom(await res.json()))
      } catch {
        // Offline or restarting: the next read tries again.
      } finally {
        this.reading = null
      }
    })()
    return this.reading
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
    this.apply({ ...this.state, notices: this.state.notices.filter((notice) => notice.id !== id) })
    try {
      const res = await this.request(`/api/notices/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: { Accept: 'application/json' } })
      const next = noticesFrom(await res.json().catch(() => null))
      if (res.ok && next) {
        this.apply(next)
        return
      }
    } catch {
      // Fall through: the server says what still stands.
    }
    await this.read()
  }

  private apply(next: NoticesState | null): void {
    if (!next) return
    this.state = next
    for (const listener of this.listeners) listener(next)
  }
}
