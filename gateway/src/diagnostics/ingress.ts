import { classifyHost, hostName } from '../hosts.js'
import { createHash, randomBytes } from 'node:crypto'
import { normalize, environmentSecrets, type LogEvent } from './contract.js'
import { nativeDiagnostic } from './sources.js'
import type { DiagnosticStore, Coverage } from './store.js'

export const INGRESS_LEASE_MS = 90_000
const KEY = 'external-ingress-window'
const access = { workspace: null, operator: true }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Ingress window requires canonical UTC timestamps')
  return Date.parse(value)
}

export async function receiveIngress(db: DiagnosticStore, domain: string, stdin: AsyncIterable<Buffer | string>, write: (line: string) => void, now = Date.now): Promise<void> {
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) throw new Error('POISE_DOMAIN is required for external ingress')
  const expected = db.checkpoint(KEY), issuedAt = now(), challenge = randomBytes(32).toString('hex')
  write(JSON.stringify({ version: 1, domain, checkpoint: expected, challenge, issuedAt: new Date(issuedAt).toISOString() }))
  let size = 0
  const chunks: Buffer[] = []
  // A forced-command credential cannot hold an unbounded maintenance process open.
  const iterator = stdin[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Ingress delivery exceeded 30 seconds')), 30_000); timer.unref() })
  try {
    while (true) {
      const item = await Promise.race([iterator.next(), deadline])
      if (item.done) break
      const bytes = Buffer.isBuffer(item.value) ? item.value : Buffer.from(item.value)
      size += bytes.length
      if (size > 1024 * 1024) throw new Error('Ingress delivery exceeds 1 MiB')
      chunks.push(bytes)
    }
  } finally { clearTimeout(timer) }
  if (!size) return
  const batch: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!object(batch) || batch.version !== 1 || batch.challenge !== challenge || batch.expected !== expected || typeof batch.container !== 'string' || !/^[a-f0-9]{64}$/.test(batch.container)
    || !['complete', 'bounded', 'unavailable'].includes(String(batch.state)) || !Array.isArray(batch.records) || batch.records.length > 100
    || (batch.state === 'unavailable' && batch.records.length)
    || (batch.failure !== undefined && !['clock-skew', 'source-read'].includes(String(batch.failure)))) throw new Error('Invalid ingress delivery envelope or checkpoint')
  const at = now(), from = timestamp(batch.from), until = timestamp(batch.until)
  if (at < issuedAt || at - issuedAt > 30_000 || from > until || until > issuedAt + 5000 || until - from > 31 * 86_400_000) throw new Error('Ingress window is reversed, future or exceeds 31 days')
  const cursor: unknown = expected ? JSON.parse(expected) : null
  if (cursor !== null && (!object(cursor) || typeof cursor.container !== 'string' || typeof cursor.until !== 'string')) throw new Error('Invalid retained ingress checkpoint')
  if (object(cursor) && cursor.container === batch.container && cursor.until !== batch.from) throw new Error('Ingress window must continue the committed checkpoint')
  const events: LogEvent[] = []
  for (const record of batch.records) {
    if (!object(record) || typeof record.id !== 'string' || !/^[a-f0-9]{64}$/.test(record.id) || !object(record.log) || Buffer.byteLength(JSON.stringify(record)) > 64 * 1024) throw new Error('Invalid or oversized ingress record')
    const time = timestamp(record.time)
    if (time < from || time > until) throw new Error('Ingress record lies outside its source window')
    const request = record.log.request
    const header = object(request) && typeof request.host === 'string' ? request.host : record.log.server_name ?? record.log.identifier
    const host = typeof header === 'string' ? hostName(header) : null
    if (typeof header !== 'string' || /:\d+$/.test(header) && Number(header.slice(header.lastIndexOf(':') + 1)) > 65535 || classifyHost(header, domain).kind === 'unknown') throw new Error('Ingress record is outside the configured Poise domain')
    const id = createHash('sha256').update(batch.container + ':' + record.id).digest('hex')
    if (/^http\.log\.access(?:\.|$)/.test(String(record.log.logger))) continue
    const input = nativeDiagnostic(record.log, 'ingress', id, null)
    input.time ??= record.time as string
    input.container = batch.container
    input.stderr = typeof record.log.error === 'string' ? record.log.error : undefined
    input.context = { ...input.context, host, status: typeof record.log.status === 'number' ? record.log.status : null, errorId: record.log.err_id ?? null, errorTrace: record.log.err_trace ?? null, integration: 'external-proxy-window' }
    const event = normalize(input, at, environmentSecrets())
    if (event) events.push(event)
  }
  const previous = db.readCoverage(access).find((source) => source.id === 'external-ingress')
  const gaps: Coverage['gaps'] = (previous?.gaps ?? []).map((gap) => ({ ...gap, to: batch.state === 'unavailable' ? gap.to : gap.to ?? new Date(at).toISOString() }))
  if (batch.retainedFrom !== undefined && batch.retainedFrom !== null) {
    const boundary = timestamp(batch.retainedFrom)
    if (boundary > from && batch.state !== 'unavailable') gaps.push({ from: batch.from as string, to: new Date(Math.min(boundary, until)).toISOString(), reason: 'Source continuity before its oldest retained proxy record cannot be verified' })
  }
  if (object(cursor) && cursor.container !== batch.container) gaps.push({ from: cursor.until as string, to: new Date(Math.max(Date.parse(cursor.until as string), until)).toISOString(), reason: 'External proxy container replaced; preceding source history is unavailable' })
  if (batch.state === 'bounded') gaps.push({ from: batch.from as string, to: batch.until as string, reason: 'External proxy source window exceeded its read bound' })
  if (batch.state === 'unavailable' && !gaps.some((gap) => gap.to === null)) gaps.push({ from: previous?.observedAt ?? batch.from as string, to: null, reason: 'External proxy source is unavailable' })
  const currentStatus = batch.state === 'unavailable' ? 'unavailable' : batch.state === 'bounded' || at - until > 45_000 ? 'partial' : 'connected'
  const coverage: Coverage = { id: 'external-ingress', source: 'ingress', workspace: null, currentStatus,
    status: gaps.length || currentStatus !== 'connected' ? 'partial' : 'connected', observedAt: new Date(issuedAt).toISOString(),
    observationExpiresAt: new Date(issuedAt + INGRESS_LEASE_MS).toISOString(),
    historyIncomplete: previous?.historyIncomplete || gaps.length > 32,
    ingestedAt: events.length ? new Date(at).toISOString() : previous?.ingestedAt ?? null,
    availableFrom: batch.state === 'unavailable' ? previous?.availableFrom ?? null : previous?.availableFrom && Date.parse(previous.availableFrom) < from ? previous.availableFrom : batch.from as string, gaps: gaps.slice(-32),
    error: batch.state === 'unavailable' ? batch.failure === 'clock-skew' ? 'External proxy and gateway clocks differ by more than five seconds' : 'External proxy source could not be read' : currentStatus === 'partial' ? 'External proxy replay is incomplete' : null }
  const next = batch.state === 'unavailable' ? expected : JSON.stringify({ container: batch.container, until: batch.until })
  db.commitCollection(events, KEY, expected, next, coverage)
  write(JSON.stringify({ accepted: true, checkpoint: next, events: events.length, currentStatus }))
}

/** Preserve the original manual occurrence namespace; it cannot renew a scan lease. */
export async function receiveManualIngress(db: DiagnosticStore, domain: string, stdin: AsyncIterable<Buffer | string>, write: (line: string) => void): Promise<void> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 64 * 1024) throw new Error('Ingress record exceeds 64 KiB')
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const row: unknown = JSON.parse(text)
  const request = object(row) ? row.request : null
  const header = object(request) ? request.host : null
  if (typeof header !== 'string' || /:\d+$/.test(header) && Number(header.slice(header.lastIndexOf(':') + 1)) > 65535 || classifyHost(header, domain).kind === 'unknown') throw new Error('Ingress record is outside the configured Poise domain')
  const input = nativeDiagnostic(row, 'ingress', createHash('sha256').update(text).digest('hex'), null)
  input.context = { host: header.split(':')[0].toLowerCase(), integration: 'operator-stdin' }
  const event = normalize(input, db.now(), environmentSecrets())
  const previous = db.readCoverage(access).find((source) => source.id === 'external-ingress')
  const at = new Date(db.now()).toISOString()
  const coverage: Coverage = previous && previous.status !== 'not-configured' ? { ...previous, ingestedAt: event ? at : previous.ingestedAt } : {
    id: 'external-ingress', source: 'ingress', workspace: null, status: 'partial', currentStatus: 'initializing', observedAt: null,
    ingestedAt: event ? at : previous?.ingestedAt ?? null, availableFrom: previous?.availableFrom ?? at, error: 'Manual delivery cannot establish continuous collection', gaps: previous?.gaps ?? [],
  }
  db.commitCollection(event ? [event] : [], KEY, db.checkpoint(KEY), null, coverage)
  write(JSON.stringify({ accepted: true, eventId: event?.id ?? null }))
}
