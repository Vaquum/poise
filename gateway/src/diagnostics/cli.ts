import { readFileSync, statSync } from 'node:fs'
import { diagnosticConfig } from './config.js'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DiagnosticStore, type Coverage } from './store.js'
import { environmentSecrets, redact } from './contract.js'
import { MAX_COVERAGE_JOURNAL_BYTES } from './runtime.js'
import { validateLoggingFilter } from './query-parser.js'
import { executeLoggingRead } from './query-worker.js'
import { relayIngress } from './ingress-ipc.js'

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
      const live = JSON.parse(executeLoggingRead({ path, policy, now: Date.now(), access, operation: 'health', filter: {} }).body) as { collection: { currentStatus: string } }
      write(JSON.stringify({ version: 1, status, currentStatus: live.collection.currentStatus, journalError, journal, sources, bounds: reader.bounds(access), policy }))
    } catch (error) {
      write(JSON.stringify({ version: 1, status: 'unavailable', error: redact(error instanceof Error ? error.message : String(error), environmentSecrets()),
        journalError, journal: journal ? { ...journal, sources: journal.sources?.filter((source) => source.workspace === null || source.workspace === access.workspace) } : null, policy }))
    } finally { reader?.close() }
    return
  }
  if (command === 'ingress' || command === 'ingress-stream') {
    if (options.length) throw new Error(command + ' accepts only bounded stdin')
    await relayIngress(join(process.env.POISE_GATEWAY_DATA ?? '/data', 'logging.ingress.sock'), command, stdin, write)
    return
  }
  const db = new DiagnosticStore(path, policy, Date.now, true)
  try {
    if (command === 'event') {
      if (options.length !== 1) throw new Error('event requires one event ID')
      write(JSON.stringify(db.lookup(access, options[0])))
    } else if (command === 'query' || command === 'export') {
      if (options.length > 1) throw new Error('query/export accept one JSON filter object')
      const filter = validateLoggingFilter(options[0] ? JSON.parse(options[0]) : {}, access)
      const page = db.query(access, filter)
      if (command === 'query') write(JSON.stringify(page))
      else { write(JSON.stringify({ type: 'metadata', ...page, events: undefined })); for (const event of page.events) write(JSON.stringify({ type: 'event', event })) }
    } else throw new Error('Use health, query, event, export, ingress or ingress-stream')
  } finally { db.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOperator(process.argv.slice(2)).catch((error: unknown) => { process.stdin.destroy(); process.stderr.write(redact(error instanceof Error ? error.message : 'Operator diagnostic command failed', environmentSecrets()) + '\n'); process.exitCode = 1 })
}
