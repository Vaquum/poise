import type { IncomingMessage, ServerResponse } from 'node:http'
import { MCP_READ_PATH, MCP_RESPONSE_BYTES, MCP_TOOLS, MCP_WORK_TOOL_NAMES, mcpRepositoryAllowed, parseMcpRead, type McpGetArguments, type McpGrantScope } from '../gateway/src/mcp-contract'
import { getSession, sessionInstance } from './chat/storage'
import { timerById, timerSummaries } from './chat/control-store'
import { HttpError, readJson, type RequestAuthority } from './http'
import { mcpInventory } from './mcp-inventory'
import { readMcpWork } from './mcp-work'
import type { ServiceConfig } from './service/config'

function readChatRecord(instance: string, grant: McpGrantScope, { kind, id }: McpGetArguments) {
  if (kind === 'chat') {
    if (sessionInstance(id) !== instance) return null
    const chat = getSession(id)
    if (!chat || !mcpRepositoryAllowed(grant, chat.repo || null)) return null
    return { kind, id, title: chat.title, repository: chat.repo || null, role: chat.role ?? 'chat',
      status: chat.status, updatedAt: chat.updatedAt, lastSequence: chat.lastSeq,
      timerIds: timerSummaries(instance, id).map(timer => timer.id) }
  }
  const timer = timerById(instance, id)
  if (!timer || timer.state === 'done' || timer.state === 'expired' || timer.state === 'cancelled'
    || sessionInstance(timer.sessionId) !== instance) return null
  const chat = getSession(timer.sessionId)
  const repository = chat?.repo || null
  if (!chat || !mcpRepositoryAllowed(grant, repository)) return null
  return { kind, id, chatId: timer.sessionId, repository, label: timer.label, state: timer.state, reason: timer.reason ?? null,
    schedule: timer.schedule, nextAt: timer.nextAt, pendingDelivery: timer.pending ?? null, failures: timer.failures, skipped: timer.skipped }
}

/** This scope terminates here, before ordinary workspace API dispatch. */
export async function handleMcpRead(req: IncomingMessage, res: ServerResponse, service: ServiceConfig | null,
  authority: RequestAuthority, chatInstance?: string): Promise<void> {
  if (!service || authority.kind !== 'gateway' || authority.scope !== 'mcp' || !authority.mcp) throw new HttpError(403, 'an MCP read assertion is required')
  if (req.method !== 'POST' || req.url !== MCP_READ_PATH) throw new HttpError(405, `MCP reads require POST ${MCP_READ_PATH}`)
  const read = parseMcpRead(await readJson<unknown>(req, 16 * 1024))
  const work = read.name === 'poise_work' ? await readMcpWork(read.arguments, service, authority.mcp) : undefined
  let lookup
  if (read.name === 'poise_get') {
    if (!authority.mcp.chatMetadata) throw new HttpError(403, 'Chat metadata consent is required')
    if (!chatInstance) throw new HttpError(503, 'Chat metadata is unavailable until the workspace starts')
    lookup = { observedAt: new Date().toISOString(), record: readChatRecord(chatInstance, authority.mcp, read.arguments) }
  }
  const tools = authority.mcp.chatMetadata && chatInstance ? MCP_TOOLS.map(tool => tool.name) : MCP_WORK_TOOL_NAMES
  const text = JSON.stringify({ workspace: service.handle, owner: service.owner, capabilities: { tools },
    ...(read.name === 'poise_describe' ? { inventory: mcpInventory() } : {}),
    ...(work ? { work } : {}), ...(lookup ? { lookup } : {}) })
  if (Buffer.byteLength(text) > MCP_RESPONSE_BYTES) throw new HttpError(503, 'work response exceeds its bound; request a smaller page')
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}
