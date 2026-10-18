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
