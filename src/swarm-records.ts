// Stable alert identity for unreadable Swarm rows, retained per organization.
// The notice feed renews a tab-local notice whenever its body changes and
// forgets its dismissal when a report goes empty; Swarm rebuilds this body
// from whatever rows are currently loaded and empties it on every search or
// organization reset, so known rows re-alerted as "now" and undismissed
// themselves. The checkpoint retains the observed record identities, the
// notice's age and its dismissal independently of the loaded rows: only an
// unseen identity renews the alert.
//
// Retention is per organization filter: a clean, fully loaded organization
// never erases another's checkpoint, so dismissed rows stay dismissed when
// their organization is revisited. A complete, unfiltered, error-free read
// proves absence, so identities it no longer carries are forgotten and
// re-alert if they return; any other read — a subset page, an empty filtered
// page, a reset awaiting its poll, a failed read — only adds. Storage is read
// once and written only when retention actually changes, so the search and
// pagination hot paths never touch it.

export interface SwarmRecordsCheckpoint {
  ids: string[]
  since: string
  due: string
  dismissed: boolean
  body: string
}

const CHECKPOINT_KEY = 'poise:swarm-quarantine:v1'

/** Memory backstop, far above observed quarantines: eviction past it drops
 *  rows absent from the current read first, so capped retention keeps its
 *  dismissal promise for the rows still on screen. */
export const SWARM_RECORDS_CHECKPOINT_LIMIT = 500

function isCheckpoint(value: unknown): value is SwarmRecordsCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return Array.isArray(entry.ids) && entry.ids.every((id) => typeof id === 'string')
    && typeof entry.since === 'string' && typeof entry.due === 'string'
    && typeof entry.dismissed === 'boolean' && typeof entry.body === 'string'
}

export function loadRecordsCheckpoints(): Record<string, SwarmRecordsCheckpoint> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CHECKPOINT_KEY) ?? 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const checkpoints: Record<string, SwarmRecordsCheckpoint> = {}
    for (const [org, entry] of Object.entries(parsed)) {
      if (!isCheckpoint(entry)) continue
      checkpoints[org] = { ...entry, ids: capIds(entry.ids, new Set(entry.ids)) }
    }
    return checkpoints
  } catch {
    return {}
  }
}

export function saveRecordsCheckpoints(checkpoints: Record<string, SwarmRecordsCheckpoint>): void {
  try {
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoints))
  } catch {
    // Private browsing keeps session-only behavior: the in-memory checkpoint
    // still stabilizes this tab, it just does not survive a reload.
  }
}

/** Next retained identities after observing `fresh`. */
export function retainQuarantineIds(previous: string[], fresh: string[], complete: boolean): string[] {
  if (complete) return capIds(fresh, new Set(fresh))
  const seen = new Set(previous)
  const merged = [...previous]
  for (const id of fresh) {
    if (!seen.has(id)) { seen.add(id); merged.push(id) }
  }
  return capIds(merged, new Set(fresh))
}

function capIds(ids: string[], fresh: Set<string>): string[] {
  if (ids.length <= SWARM_RECORDS_CHECKPOINT_LIMIT) return ids
  const present = ids.filter((id) => fresh.has(id))
  if (present.length >= SWARM_RECORDS_CHECKPOINT_LIMIT) return present.slice(-SWARM_RECORDS_CHECKPOINT_LIMIT)
  const absent = ids.filter((id) => !fresh.has(id))
  return [...absent.slice(-(SWARM_RECORDS_CHECKPOINT_LIMIT - present.length)), ...present]
}
