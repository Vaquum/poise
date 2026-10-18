import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { diagnosticConfig } from './config.js'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DiagnosticStore, type Coverage } from './store.js'
import { environmentSecrets, normalize, redact } from './contract.js'
import { nativeDiagnostic } from './sources.js'
import { MAX_COVERAGE_JOURNAL_BYTES } from './runtime.js'

interface JournalHealth { version: number; stopped: boolean; sinkError: string | null; coverageError?: string | null; reportError?: string | null; writtenAt: string; sources: Coverage[]; dropped?: number; rejected?: number }

/** Operator access is Docker/host ownership, never a workspace browser assertion. */
export async function runOperator(args: string[], write: (line: string) => void = (line) => process.stdout.write(line + '\n'), stdin: AsyncIterable<Buffer | string> = process.stdin): Promise<void> {
  const [command = 'health', ...options] = args
  const path = join(process.env.POISE_GATEWAY_DATA ?? '/data', 'logging.db')
  const { policy } = diagnosticConfig(process.env)
  const access = { workspace: null, operator: true }
  if (command === 'health') {
    let journal: JournalHealth | null = null
    let journalError: string | null = null
    try {
      if (statSync(path + '.coverage.json').size > MAX_COVERAGE_JOURNAL_BYTES) throw new Error('Coverage journal exceeds 8 MiB')
      journal = JSON.parse(readFileSync(path + '.coverage.json', 'utf8')) as JournalHealth
      if (!journal || journal.version !== 1 || !Array.isArray(journal.sources) || !Number.isFinite(Date.parse(journal.writtenAt))) throw new Error('Coverage journal is incompatible')
      journal.sources = journal.sources.filter((source) => source.workspace === null || source.workspace === access.workspace)
    } catch (error) { journalError = redact(error instanceof Error ? error.message : String(error), environmentSecrets()) }
    let reader: DiagnosticStore | null = null
    try {
      reader = new DiagnosticStore(path, policy, Date.now, true)
      const sources = reader.readCoverage(access)
      const partial = !!journal?.coverageError || !!journal?.reportError || (journal?.dropped ?? 0) > 0 || (journal?.rejected ?? 0) > 0 || [...sources, ...(journal?.sources ?? [])].some((source) => source.status !== 'connected')
      const status = journalError ? 'partial' : journal?.sinkError ? 'unavailable' : journal?.stopped ? 'stopped'
        : !journal?.writtenAt || Date.now() - Date.parse(journal.writtenAt) > 60_000 ? 'stale' : partial ? 'partial' : 'connected'
      write(JSON.stringify({ version: 1, status, journalError, journal, sources, bounds: reader.bounds(access), policy }))
    } catch (error) {
      write(JSON.stringify({ version: 1, status: 'unavailable', error: redact(error instanceof Error ? error.message : String(error), environmentSecrets()),
        journalError, journal: journal ? { ...journal, sources: journal.sources?.filter((source) => source.workspace === null || source.workspace === access.workspace) } : null, policy }))
    } finally { reader?.close() }
    return
  }
  const db = new DiagnosticStore(path, policy, Date.now, command !== 'ingress')
  try {
    if (command === 'event') {
      if (options.length !== 1) throw new Error('event requires one event ID')
      write(JSON.stringify(db.lookup(access, options[0])))
    } else if (command === 'query' || command === 'export') {
      if (options.length > 1) throw new Error('query/export accept one JSON filter object')
      const filter = options[0] ? JSON.parse(options[0]) as Parameters<DiagnosticStore['query']>[1] : {}
      if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Error('Filter must be an object')
      const allowed = ['severities', 'from', 'to', 'source', 'component', 'workspace', 'account', 'repository', 'callId', 'correlationId', 'incidentId', 'search', 'cursor', 'after', 'limit']
      if (Object.keys(filter).some((key) => !allowed.includes(key))) throw new Error('Unknown Logging filter')
      const page = db.query(access, filter)
      if (command === 'query') write(JSON.stringify(page))
      else { write(JSON.stringify({ type: 'metadata', ...page, events: undefined })); for (const event of page.events) write(JSON.stringify({ type: 'event', event })) }
    } else if (command === 'ingress') {
      if (options.length) throw new Error('ingress reads one bounded JSON record from stdin')
      let size = 0; const chunks: Buffer[] = []
      for await (const chunk of stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bytes.length
        if (size > 64 * 1024) throw new Error('Ingress record exceeds 64 KiB')
        chunks.push(bytes)
      }
      const text = Buffer.concat(chunks).toString('utf8')
      const row = JSON.parse(text) as { request?: { host?: string }; request_id?: string }
      const domain = process.env.POISE_DOMAIN
      const host = row.request?.host?.split(':')[0].toLowerCase()
      if (!domain || !host || (host !== domain && !host.endsWith('.' + domain))) throw new Error('Ingress record is outside the configured Poise domain')
      const input = nativeDiagnostic(row, 'ingress', createHash('sha256').update(text).digest('hex'), null)
      input.context = { host, integration: 'operator-stdin' }
      const event = normalize(input, Date.now(), environmentSecrets())
      if (event) db.append([event])
      const at = new Date().toISOString()
      const previous = db.readCoverage(access).find((source) => source.id === 'external-ingress')
      db.coverage({ id: 'external-ingress', source: 'ingress', workspace: null, status: 'partial', observedAt: at, ingestedAt: event ? at : previous?.ingestedAt ?? null,
        availableFrom: previous?.availableFrom ?? at, error: 'Record delivery observed; continuous external proxy coverage is unverified', gaps: previous?.gaps ?? [] })
      write(JSON.stringify({ accepted: true, eventId: event?.id ?? null }))
    } else throw new Error('Use health, query, event, export or ingress')
  } finally { db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOperator(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(redact(error instanceof Error ? error.message : 'Operator diagnostic command failed', environmentSecrets()) + '\n'); process.exitCode = 1 })
}
