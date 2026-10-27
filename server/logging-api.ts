import type { EvidenceSelector } from '../gateway/src/diagnostics/query-evidence'
import { evidenceAttachment, type EvidenceAttachment } from '../gateway/src/diagnostics/evidence-contract'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LoggingQueryPool } from '../gateway/src/diagnostics/query-pool'
import { diagnosticConfig } from '../gateway/src/diagnostics/config'
import { serveLogging } from '../gateway/src/diagnostics/query-http'
import { loggingPath, loggingWorkspace } from './logging'

let queries: LoggingQueryPool | null = null

export async function localLogging(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = loggingPath()
  await serveLogging(req, res, new URL(req.url ?? '/', 'http://localhost'), (req.url ?? '').split('?')[0].slice('/api/logging'.length), {
    pool: queries ??= new LoggingQueryPool(), path, policy: diagnosticConfig(process.env).policy, workspace: loggingWorkspace(),
    isAdmin: false, now: Date.now(), audit: () => { throw new Error('Instance diagnostics are not available through the local workspace API') },
  })
}

export async function stopLoggingApi(): Promise<void> {
  await queries?.close()
  queries = null
}

/** Shares LOG-02's bounded worker and owner admission with browser reads. Never ingests. */
export async function retainedEvidence(selectors: EvidenceSelector[]): Promise<EvidenceAttachment[]> {
  if (!selectors.length) return []
  const unavailable = () => selectors.map((): EvidenceAttachment => ({ evidenceStatus: 'unavailable' }))
  const path = loggingPath()
  if (!path) return unavailable()
  const abort = new AbortController()
  try {
    const lease = await (queries ??= new LoggingQueryPool()).read({ path, policy: diagnosticConfig(process.env).policy, now: Date.now(),
      access: { workspace: loggingWorkspace(), operator: false }, operation: 'evidence', filter: {}, selectors }, loggingWorkspace(), abort.signal, () => abort.abort())
    try {
      const body: unknown = JSON.parse(lease.reply.body)
      if (!Array.isArray(body) || body.length !== selectors.length) throw new Error('Invalid retained evidence response')
      return body.map(evidenceAttachment)
    } finally { lease.release() }
  } catch {
    // Optional association never suppresses the primary condition or asserts an empty healthy source.
    return unavailable()
  }
}
