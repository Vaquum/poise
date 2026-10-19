import type { LogEvent } from './contract.js'
import type { DiagnosticStore } from './store.js'
import type { LogAccess } from './query-contract.js'
import type { EvidenceAttachment } from './evidence-contract.js'
import { failureCause, materialFailureCause } from './material-cause.js'

/** Internal exact-key join; public Logging HTTP routes cannot submit these selectors. */
export interface EvidenceSelector {
  eventId?: string
  incidentId?: string
  callId?: string
  correlationId?: string
  source: 'caller' | 'poise' | 'collection'
  operation?: string
  behavior?: string
  target?: string
  account?: string
  repository?: string
  from?: string
  cause?: string
  context?: Record<string, string | number>
}
function matches(event: LogEvent, selector: EvidenceSelector): boolean {
  if (event.version !== 1) throw new Error('Unsupported retained diagnostic version')
  for (const key of ['source', 'operation', 'callId', 'correlationId', 'behavior', 'target', 'account', 'repository'] as const) {
    if (selector[key] !== undefined && event[key] !== selector[key]) return false
  }
  if (selector.from && (event.eventTime ?? event.ingestedAt) < selector.from) return false
  if (selector.context && Object.entries(selector.context).some(([key, value]) => event.context[key] !== value)) return false
  if (selector.cause !== undefined) {
    const canonicalCause = (value: string) => materialFailureCause(failureCause(value).replace(/[\x00-\x1f\x7f]/g, ' '))
    const expected = canonicalCause(selector.cause)
    const tail = event.stderr?.trim().split('\n').pop()?.trim()
    const candidates = [event.message, event.stderr ?? '', tail ? `${event.message}: ${tail}` : event.message]
    if (!candidates.some((cause) => canonicalCause(cause) === expected)) return false
  }
  return true
}
export function joinEvidence(db: DiagnosticStore, access: LogAccess, selectors: EvidenceSelector[]): EvidenceAttachment[] {
  if (selectors.length > 20) throw new Error('At most twenty evidence joins are permitted')
  let remaining = 20
  return selectors.map((selector) => {
    if (!(selector.eventId || selector.incidentId || /^[a-f0-9]{32}$/.test(selector.callId ?? '')
      || /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(selector.correlationId ?? ''))) throw new Error('Evidence needs an exact retained identity')
    let events: LogEvent[]
    let more = false
    if (selector.eventId) {
      const lookup = db.lookup(access, selector.eventId)
      events = lookup.status === 'found' ? [lookup.event] : []
    } else {
      const page = db.query(access, { callId: selector.callId, correlationId: selector.correlationId, incidentId: selector.incidentId,
        source: selector.source, account: selector.account, repository: selector.repository, from: selector.from, limit: 21 })
      events = page.events
      more = page.nextCursor !== null
    }
    const matching = events.filter((event) => matches(event, selector))
    const references = matching.slice(0, remaining).map((event) => {
      const at = Date.parse(event.eventTime ?? event.ingestedAt)
      return { eventId: event.id, incidentId: event.incidentId, from: new Date(Math.max(0, at - 3_600_000)).toISOString(), to: new Date(at + 3_600_000).toISOString() }
    })
    remaining -= references.length
    return { ...(references[0] ? { evidence: references[0], evidenceReferences: references } : {}),
      evidenceStatus: references.length ? 'retained' : 'pending', ...(more || matching.length > references.length ? { evidenceMore: true } : {}) }
  })
}
