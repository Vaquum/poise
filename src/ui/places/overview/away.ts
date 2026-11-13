// The bell away from Overview (#556: the bell on every view counts what the
// level shows). On Overview, Answer here hands over its own entries; on every
// other place this reads the same sources, once a minute while the tab is in
// front, and counts them the way Answer here does. A failed read keeps the last
// and says so under Answer here's own words, so the count is never silently stale.
import { getBehaviorDiagnostics, refreshState } from '../../../behaviors'
import { chatClient } from '../../../chat-client'
import { LOCAL_NOTICE_KINDS, noticeFeed } from '../../../notices'
import { notificationItems, type ChainAttentionRow } from '../../../notification-items'
import type { PrStatus } from '../board/model'
import { decisionEntries, foldWaiting, itemEntries, prKey, requestEntries, requestsFrom, threadEntries, undismissed, type DecisionItem, type Entry, type OpenRequest, type Publication, type PrStatuses, type ThreadReview } from './entries'
import type { Group } from './level'
import { json, reason } from './util'

let requests: readonly OpenRequest[] = []
let decisions: readonly DecisionItem[] = []
let publications: Publication[] = []
/** Each document's open threads as entries, read once per change of its count; null while unread. */
const threadsRead = new Map<string, { openThreads: number, checkedAt: string | null, entries: Entry[] | null }>()
/** Put-away entries Answer here keeps (server/answer-dismissals.ts): key → revision. */
let dismissals = new Map<string, string>()
let attention: ChainAttentionRow[] = []
let chains: ReadonlyMap<string, { sequence: number, held: string | null }> = new Map()
/** Who moves each open pull request next, which decides whom its notice waits on. */
let prs: PrStatuses = new Map()

/** A failed read under Overview's own source and words; Overview's reads and these replace each other. */
const report = (source: string, title: string, error: string): void =>
  noticeFeed.reportReadErrors(source, error ? [{ key: source, title, body: `${error.replace(/\.$/, '')}. The bell may count what was last read.` }] : [])

/** Where an entry opens does not change what it counts. */
const noRole = (): undefined => undefined

export function awayGroups(): Group[] {
  const feed = noticeFeed.current
  const notices = feed.notices.filter((notice) => feed.enabled || (LOCAL_NOTICE_KINDS as readonly string[]).includes(notice.kind))
  const items = notificationItems(notices, getBehaviorDiagnostics(), Date.now(), attention)
  const entries = undismissed(foldWaiting([...itemEntries(items, noRole, chains, prs, Date.now()), ...requestEntries(requests, noRole), ...decisionEntries(decisions, noRole)]), dismissals)
  // A document's open threads, as its sweep counts them, less those put away at
  // what they report now: a reply, or a thread its cache does not list, counts.
  const threads = publications.reduce((sum, publication) => {
    const entries = threadsRead.get(publication.slug)?.entries ?? []
    const putAway = entries.length - undismissed(entries, dismissals).length
    return sum + Math.max(0, publication.openThreads - putAway)
  }, 0)
  return [...entries.map((entry) => entry.group), ...Array<Group>(threads).fill('needs-you')]
}

/** A place's own reads go first: the bell reads a moment after whatever asked
 *  for it, so a load or a move never has its five sources compete with the
 *  reads that draw the place. */
export const AWAY_READ_DELAY_MS = 2_500

/** Reads while `away()`, a moment after it is asked; returns what asks, which
 *  reads unless a read is under a minute old. */
export function watchAway(away: () => boolean, changed: () => void): () => void {
  let readAt = 0
  let reading = false
  let pending: ReturnType<typeof setTimeout> | null = null
  const read = async (): Promise<void> => {
    if (reading || !away() || document.visibilityState !== 'visible' || Date.now() - readAt < 60_000) return
    reading = true
    readAt = Date.now()
    const [r, b, v, c, , d, p] = await Promise.allSettled([
      json('/api/chat/requests'),
      chatClient.switchboard(),
      json<{ publications?: Publication[] }>('/api/editor/reviews'),
      json<{ chains?: { id: string, sequence: number, held: string | null }[], attention?: ChainAttentionRow[] }>('/api/behavior-chains?state=active'),
      refreshState(),
      json<{ dismissals?: { key: string, revision: string }[] }>('/api/answers/dismissals'),
      json<{ rows?: PrStatus[] }>('/api/behavior-ledger/pr-status?limit=100'),
    ])
    reading = false
    const unread = 'the service answered with something this page cannot read'
    const failed = (result: PromiseSettledResult<unknown>, ok: boolean): string => result.status === 'rejected' ? reason(result.reason) : ok ? '' : unread
    const requestsRead = r.status === 'fulfilled' ? requestsFrom(r.value) : null
    if (requestsRead) requests = requestsRead.requests
    const items = b.status === 'fulfilled' ? (b.value as { items?: unknown } | null)?.items : null
    if (Array.isArray(items)) decisions = items as DecisionItem[]
    const read = v.status === 'fulfilled' ? v.value.publications : null
    if (Array.isArray(read)) {
      publications = read.filter((publication) => typeof publication?.slug === 'string' && (publication.openThreads ?? 0) > 0)
      for (const slug of threadsRead.keys()) if (!publications.some((publication) => publication.slug === slug)) threadsRead.delete(slug)
      await Promise.all(publications.map(async (publication) => {
        const before = threadsRead.get(publication.slug)
        // Read again when the sweep checked it since: a reply brings a put-away thread back.
        if (before?.entries && before.openThreads === publication.openThreads && before.checkedAt === publication.checkedAt) return
        try {
          const cached = await json<{ reviews?: ThreadReview[] }>(`/api/editor/doc/${encodeURIComponent(publication.slug)}/reviews`)
          threadsRead.set(publication.slug, { openThreads: publication.openThreads, checkedAt: publication.checkedAt, entries: Array.isArray(cached.reviews) ? threadEntries(publication, cached.reviews, () => '') : null })
        } catch {
          threadsRead.set(publication.slug, { openThreads: publication.openThreads, checkedAt: publication.checkedAt, entries: null })
        }
      }))
    }
    const putAway = d.status === 'fulfilled' ? d.value.dismissals : null
    if (Array.isArray(putAway)) dismissals = new Map(putAway.map((row) => [row.key, row.revision]))
    const chainsRead = c.status === 'fulfilled' && Array.isArray(c.value.chains) && Array.isArray(c.value.attention) ? c.value : null
    if (chainsRead) {
      chains = new Map(chainsRead.chains!.map((chain) => [chain.id, { sequence: chain.sequence, held: chain.held }]))
      attention = chainsRead.attention!
    }
    report('overview-requests', 'Your chats’ requests could not be read', failed(r, !!requestsRead))
    report('overview-switchboard', 'The Switchboard’s decisions could not be read', failed(b, Array.isArray(items)))
    report('overview-reviews', 'Review threads could not be read', failed(v, Array.isArray(read)))
    report('overview-dismissals', 'Put-away entries could not be read', failed(d, Array.isArray(putAway)))
    report('overview-chains', 'Attention evidence unavailable', failed(c, !!chainsRead))
    const rows = p.status === 'fulfilled' ? p.value.rows : null
    if (Array.isArray(rows)) prs = new Map(rows.map((row) => [prKey(row.repository, row.number), row]))
    report('overview-prs', 'Pull requests’ status could not be read', failed(p, Array.isArray(rows)))
    changed()
  }
  const soon = (): void => {
    if (pending !== null) return
    pending = setTimeout(() => { pending = null; void read() }, AWAY_READ_DELAY_MS)
  }
  setInterval(soon, 60_000)
  document.addEventListener('visibilitychange', soon)
  soon()
  return soon
}
