// The bell away from Overview (#556: the bell on every view counts what the
// level shows). On Overview, Answer here hands over its own entries; on every
// other place this reads the same sources, once a minute while the tab is in
// front, and counts them the way Answer here does. A failed read keeps the last.
import { getBehaviorDiagnostics, refreshState } from '../../../behaviors'
import { chatClient } from '../../../chat-client'
import { LOCAL_NOTICE_KINDS, noticeFeed } from '../../../notices'
import { notificationItems, type ChainAttentionRow } from '../../../notification-items'
import { decisionEntries, foldWaiting, itemEntries, requestEntries, requestsFrom, type DecisionItem, type OpenRequest } from './entries'
import type { Group } from './level'
import { json } from './util'

let requests: readonly OpenRequest[] = []
let decisions: readonly DecisionItem[] = []
let threads = 0
let attention: ChainAttentionRow[] = []
let chains: ReadonlyMap<string, { sequence: number, held: string | null }> = new Map()

/** Where an entry opens does not change what it counts. */
const noRole = (): undefined => undefined

export function awayGroups(): Group[] {
  const feed = noticeFeed.current
  const notices = feed.notices.filter((notice) => feed.enabled || (LOCAL_NOTICE_KINDS as readonly string[]).includes(notice.kind))
  const items = notificationItems(notices, getBehaviorDiagnostics(), Date.now(), attention)
  const entries = foldWaiting([...itemEntries(items, noRole, chains), ...requestEntries(requests, noRole), ...decisionEntries(decisions, noRole)])
  return [...entries.map((entry) => entry.group), ...Array<Group>(threads).fill('needs-you')]
}

/** Reads while `away()`; returns what reads now unless a read is under a minute old. */
export function watchAway(away: () => boolean, changed: () => void): () => void {
  let readAt = 0
  let reading = false
  const read = async (): Promise<void> => {
    if (reading || !away() || document.visibilityState !== 'visible' || Date.now() - readAt < 60_000) return
    reading = true
    readAt = Date.now()
    const [r, b, v, c] = await Promise.allSettled([
      json('/api/chat/requests'),
      chatClient.switchboard(),
      json<{ publications?: { openThreads?: number }[] }>('/api/editor/reviews'),
      json<{ chains?: { id: string, sequence: number, held: string | null }[], attention?: ChainAttentionRow[] }>('/api/behavior-chains?state=active'),
      refreshState(),
    ])
    reading = false
    if (r.status === 'fulfilled') requests = requestsFrom(r.value)?.requests ?? requests
    if (b.status === 'fulfilled') { const items = (b.value as { items?: unknown } | null)?.items; if (Array.isArray(items)) decisions = items as DecisionItem[] }
    if (v.status === 'fulfilled' && Array.isArray(v.value.publications)) threads = v.value.publications.reduce((sum, publication) => sum + (publication.openThreads ?? 0), 0)
    if (c.status === 'fulfilled' && Array.isArray(c.value.chains) && Array.isArray(c.value.attention)) {
      chains = new Map(c.value.chains.map((chain) => [chain.id, { sequence: chain.sequence, held: chain.held }]))
      attention = c.value.attention
    }
    changed()
  }
  setInterval(() => { void read() }, 60_000)
  document.addEventListener('visibilitychange', () => { void read() })
  void read()
  return () => { void read() }
}
