import { evidenceAttachment, evidenceReferences, keepKnownEvidence, type EvidenceAttachment } from '../gateway/src/diagnostics/evidence-contract'
// The notifications the notification rail lists (server/alerts/notices.ts):
// read every few seconds while this tab is in front, at once when it comes back
// to the front, and after the person acts on one. Every tab of the workspace
// shows the same ones: what one tab puts away, the others drop on their next read.

export const NOTICE_KINDS = ['chat_waiting', 'sign_in_needed', 'behavior_held', 'datastore_sync_failing', 'pr_ready', 'review_requested', 'pr_conflict', 'chat_turn_finished', 'github_quota_warning', 'github_quota_exhausted', 'storage_low', 'ledger_queue_stalled', 'ledger_capture_loss', 'worker_idle'] as const
export const LOCAL_NOTICE_KINDS = ['read_failed', 'action_failed', 'action_needed', 'action_finished'] as const
export type NoticeKind = typeof NOTICE_KINDS[number] | typeof LOCAL_NOTICE_KINDS[number]

export interface ReadFailure { key: string, title: string, body: string, target?: NoticeTarget }

export type NoticeTarget =
  | { view: 'behaviors' }
  | { swarm: string }
  | { settings: 'general' | 'accounts' }
  | { chat: string }
  | { pullRequest: string }

export interface Notice extends EvidenceAttachment {
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
  /** On a failed behavior: its behavior and target, as Behaviors' diagnostics
   *  name them, which joins the notice to its diagnostic. */
  subject?: NoticeSubject
}

export interface NoticeSubject {
  behavior: string
  target: string
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

function isSubject(value: unknown): value is NoticeSubject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const subject = value as Record<string, unknown>
  return Object.keys(subject).length === 2
    && typeof subject.behavior === 'string' && subject.behavior.length > 0
    && typeof subject.target === 'string' && subject.target.length > 0
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
    && (notice.subject === undefined || (notice.kind === 'behavior_held' && isSubject(notice.subject)))
}

/** The server's answer as state, or null when it is not one. A notice the page
 *  cannot show is left out rather than shown wrong. */
export function noticesFrom(value: unknown): NoticesState | null {
  if (!value || typeof value !== 'object') return null
  const body = value as Record<string, unknown>
  if (typeof body.enabled !== 'boolean' || !Array.isArray(body.notices)) return null
  return { enabled: body.enabled, notices: body.enabled ? body.notices.filter(isNotice).map((notice) => {
    const { evidence: _evidence, evidenceReferences: _refs, evidenceMore: _more, evidenceStatus: _status, ...primary } = notice
    return { ...primary, ...evidenceAttachment(notice) }
  }) : [] }
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

export interface LocalNotice extends ReadFailure {
  kind?: typeof LOCAL_NOTICE_KINDS[number]
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
  private readonly readFailures = new Map<string, LocalNotice[]>()
  private readonly local = new Map<string, Notice>()
  private readonly dismissedLocal = new Set<string>()
  private localSequence = 0
  private sent = 0
  private shown = 0
  private heard = false
  private readonly listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private reading: Promise<void> | null = null
  private readonly onVisible = () => { if (document.visibilityState === 'visible') void this.read() }

  constructor(private readonly request: typeof fetch = (...args) => fetch(...args)) {}

  get current(): NoticesState {
    return this.state
  }

  /** Whether the server has answered yet: until then the state is a placeholder. */
  get answered(): boolean {
    return this.heard
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

  /** Browser read failures belong to the shared rail, not the view. Sources
   *  share a key so day, baseline and history report an account only once.
   *  These tab-local failures never post another request. */
  reportReadErrors(source: string, failures: ReadFailure[]): void {
    this.reportLocalNotices(source, failures)
  }

  /** Tab-local action and read feedback shares dismissal and recovery across views. */
  reportLocalNotices(source: string, failures: LocalNotice[]): void {
    this.readFailures.set(source, failures)
    const pending = new Map([...this.readFailures.values()].flat().map((failure) => [failure.key, failure]))
    for (const [key, notice] of this.local) {
      if (!pending.has(key)) { this.local.delete(key); this.dismissedLocal.delete(notice.id) }
    }
    for (const [key, failure] of pending) {
      const existing = this.local.get(key)
      const kind = failure.kind ?? 'read_failed'
      const previous = existing?.body === failure.body && existing.title === failure.title && existing.kind === kind ? existing : undefined
      if (existing && !previous) this.dismissedLocal.delete(existing.id)
      const at = new Date().toISOString()
      this.local.set(key, { id: previous?.id ?? `read:${++this.localSequence}`, kind,
        title: failure.title, body: failure.body, since: previous?.since ?? at, due: previous?.due ?? at,
        silenceable: false, target: failure.target ?? null })
    }
    this.publish()
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
    if ([...this.local.values()].some((notice) => notice.id === id)) {
      this.dismissedLocal.add(id)
      this.publish()
      return Promise.resolve()
    }
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
  private readonly knownEvidence = new Map<string, EvidenceAttachment>()

  private receive(sent: number, next: NoticesState | null): void {
    if (!next || sent <= this.shown) return
    this.shown = sent
    this.heard = true
    // An answer to a request sent after the server took an action knows of it.
    for (const [id, away] of this.putAway) {
      if (away.settledAt !== null && away.settledAt < sent) this.putAway.delete(id)
    }
    if (next.enabled) {
      const active = new Set(next.notices.map((notice) => notice.id))
      for (const id of this.knownEvidence.keys()) if (!active.has(id)) this.knownEvidence.delete(id)
    }
    this.server = { ...next, notices: next.notices.map((notice) => {
      const retained = keepKnownEvidence(notice, this.knownEvidence.get(notice.id))
      if (evidenceReferences(retained).length) {
        this.knownEvidence.delete(notice.id)
        this.knownEvidence.set(notice.id, retained)
        while (this.knownEvidence.size > 200) this.knownEvidence.delete(this.knownEvidence.keys().next().value!)
      }
      return { ...notice, ...retained }
    }) }
    this.publish()
  }

  private publish(): void {
    const hidden = (notice: Notice) => {
      const away = this.putAway.get(notice.id)
      return !!away && (away.due === null || away.due === notice.due)
    }
    const next = { ...this.server, notices: [...this.server.notices.filter((notice) => !hidden(notice)), ...[...this.local.values()].filter((notice) => !this.dismissedLocal.has(notice.id))] }
    this.state = next
    for (const listener of this.listeners) listener(next)
  }
}

/** The page shares one feed across views and the notification rail. */
export const noticeFeed = new NoticeFeed()
