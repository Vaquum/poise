import type { IncomingMessage, ServerResponse } from 'node:http'
import { MCP_READ_PATH, MCP_RESPONSE_BYTES, mcpRepositoryAllowed, mcpToolNames, parseMcpRead,
  type McpChatMetadataArguments, type McpGrantScope } from '../gateway/src/mcp-contract'
import { getSession, listPendingRequests, sessionInstance } from './chat/storage'
import { chatBindings, chatChildren, timerById, timerSummaries } from './chat/control-store'
import { HttpError, readJson, type RequestAuthority } from './http'
import { mcpInventory } from './mcp-inventory'
import { readMcpWork } from './mcp-work'
import { readMcpChatChanges, readMcpChatList } from './mcp-chat-pages'
import { readChatArtifact } from './mcp-chat-artifacts'
import type { ServiceConfig } from './service/config'

function readChatRecord(instance: string, grant: McpGrantScope, { kind, id }: McpChatMetadataArguments) {
  if (kind === 'chat') {
    if (sessionInstance(id) !== instance) return null
    const chat = getSession(id)
    if (!chat || !mcpRepositoryAllowed(grant, chat.repo || null)) return null
    const approvedChat = (candidate: string | undefined): string | null => {
      const parent = candidate && sessionInstance(candidate) === instance ? getSession(candidate) : null
      return parent && mcpRepositoryAllowed(grant, parent.repo || null) ? parent.id : null
    }
    const repository = grant.repository ?? null
    const workers = chatChildren(instance, id, repository, 11)
    const bindings = chatBindings(instance, id, repository, 11)
    const requests = listPendingRequests(id)
    return { kind, id, title: chat.title, repository: chat.repo || null, role: chat.role ?? 'chat',
      status: chat.status, updatedAt: chat.updatedAt, lastSequence: chat.lastSeq,
      agent: chat.agent, model: chat.model, branch: chat.branch.name,
      createdByChatId: approvedChat(chat.createdBy?.sessionId), forkedFromChatId: approvedChat(chat.forkedFrom),
      workerIds: workers.slice(0, 10), workBindings: bindings.slice(0, 10).map(({ target, created_at }) => ({ target, at: new Date(created_at).toISOString() })),
      requests: requests.slice(0, 10).map(({ requestId, kind, seq, ownerAction }) => ({ id: requestId, kind, sequence: seq, ownerAction })),
      truncated: workers.length > 10 || bindings.length > 10 || requests.length > 10,
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
  let page
  if (read.name === 'poise_get') {
    if ('chatId' in read.arguments ? !authority.mcp.chatArtifacts : !authority.mcp.chatMetadata) {
      throw new HttpError(403, 'the selected Chat data consent is required')
    }
    if (!chatInstance) throw new HttpError(503, 'Chat data is unavailable until the workspace starts')
    const observedAt = new Date().toISOString()
    lookup = 'chatId' in read.arguments ? { observedAt, ...await readChatArtifact(chatInstance, authority.mcp, read.arguments) }
      : { observedAt, record: readChatRecord(chatInstance, authority.mcp, read.arguments) }
  }
  if (read.name === 'poise_list' || read.name === 'poise_changes') {
    if (read.name === 'poise_list' ? !authority.mcp.chatList || !authority.mcp.chatMetadata : !authority.mcp.chatTranscript) {
      throw new HttpError(403, 'the selected Chat data consent is required')
    }
    if (!chatInstance) throw new HttpError(503, 'Chat data is unavailable until the workspace starts')
    page = read.name === 'poise_list' ? readMcpChatList(chatInstance, authority.mcp, read.arguments)
      : readMcpChatChanges(chatInstance, authority.mcp, read.arguments)
  }
  const tools = mcpToolNames(chatInstance ? authority.mcp : {})
  const text = JSON.stringify({ workspace: service.handle, owner: service.owner, capabilities: { tools },
    ...(read.name === 'poise_describe' ? { inventory: mcpInventory(authority.mcp.chatArtifacts) } : {}),
    ...(work ? { work } : {}), ...(lookup ? { lookup } : {}), ...(page ? { page } : {}) })
  if (Buffer.byteLength(text) > MCP_RESPONSE_BYTES) throw new HttpError(503, 'work response exceeds its bound; request a smaller page')
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}
