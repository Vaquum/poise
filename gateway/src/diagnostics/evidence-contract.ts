/** Optional read-time references. These identify retained events, never a product action. */
export interface DiagnosticEvidence { eventId: string; incidentId: string; from: string; to: string }
export interface EvidenceAttachment {
  evidence?: DiagnosticEvidence
  evidenceReferences?: DiagnosticEvidence[]
  evidenceMore?: boolean
  evidenceStatus?: 'retained' | 'pending' | 'unavailable'
}
const EVENT = /^evt_[a-f0-9]{16}_[a-f0-9]{64}$/
const INCIDENT = /^inc_[a-f0-9]{16}_[a-f0-9]{64}$/
const ZONED = /(?:Z|[+-]\d{2}:\d{2})$/
export function diagnosticEvidence(value: unknown): DiagnosticEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.eventId !== 'string' || !EVENT.test(row.eventId) || typeof row.incidentId !== 'string' || !INCIDENT.test(row.incidentId)
    || row.eventId.split('_')[1] !== row.incidentId.split('_')[1]
    || typeof row.from !== 'string' || typeof row.to !== 'string' || !ZONED.test(row.from) || !ZONED.test(row.to)
    || !Number.isFinite(Date.parse(row.from)) || !Number.isFinite(Date.parse(row.to)) || Date.parse(row.from) > Date.parse(row.to)) return null
  return { eventId: row.eventId, incidentId: row.incidentId, from: row.from, to: row.to }
}
export function evidenceAttachment(value: unknown): EvidenceAttachment {
  if (!value || typeof value !== 'object') return {}
  const row = value as Record<string, unknown>
  const evidence = diagnosticEvidence(row.evidence)
  const references = Array.isArray(row.evidenceReferences) ? row.evidenceReferences.slice(0, 20).map(diagnosticEvidence).filter((ref): ref is DiagnosticEvidence => ref !== null) : []
  return { ...(evidence ? { evidence } : {}), ...(references.length ? { evidenceReferences: references } : {}),
    ...(row.evidenceMore === true ? { evidenceMore: true } : {}),
    ...(['retained', 'pending', 'unavailable'].includes(String(row.evidenceStatus)) ? { evidenceStatus: row.evidenceStatus as EvidenceAttachment['evidenceStatus'] } : {}) }
}
export function evidenceReferences(value: EvidenceAttachment): DiagnosticEvidence[] {
  const safe = evidenceAttachment(value)
  return [...new Map([...(safe.evidence ? [safe.evidence] : []), ...(safe.evidenceReferences ?? [])].map((ref) => [ref.eventId, ref])).values()].slice(0, 20)
}

/** A previously validated link can still explain 410 expiry or a sink outage. */
export function keepKnownEvidence(current: EvidenceAttachment, previous?: EvidenceAttachment): EvidenceAttachment {
  const safe = evidenceAttachment(current)
  if (evidenceReferences(safe).length) return safe
  const known = previous ? evidenceReferences(previous) : []
  return known.length ? { ...safe, evidence: known[0], evidenceReferences: known } : safe
}
