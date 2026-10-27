// One-shot Caller-log decode worker: JSON.parse plus per-row validation run
// here instead of the server's event loop. The main thread freezes the
// returned snapshot; a freeze would not survive the trip back.
import { parentPort } from 'node:worker_threads'
import { parseAgentLogStdout } from './agent-log-parse'

export interface AgentLogParseRequest {
  stdout: string
  source: string
}

export type AgentLogParseReply = { ok: true, snapshot: ReturnType<typeof parseAgentLogStdout> }
  | { ok: false, error: { name: string, message: string, causeMessage: string | null } }

export function executeAgentLogParse(request: AgentLogParseRequest): AgentLogParseReply {
  try {
    return { ok: true, snapshot: parseAgentLogStdout(request.stdout, request.source) }
  } catch (error) {
    const cause = (error as { cause?: unknown } | null)?.cause
    return { ok: false, error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      causeMessage: cause instanceof Error ? cause.message : (cause === undefined || cause === null ? null : String(cause)),
    } }
  }
}

if (parentPort) {
  const port = parentPort
  port.on('message', (request: AgentLogParseRequest) => {
    port.postMessage(executeAgentLogParse(request))
  })
}
