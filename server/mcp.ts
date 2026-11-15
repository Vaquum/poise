import type { IncomingMessage, ServerResponse } from 'node:http'
import { MCP_READ_PATH, MCP_RESPONSE_BYTES, isMcpContentKind, mcpContentAllowed, mcpRepositoryAllowed, mcpToolNames, mcpWorkspaceAllowed, parseMcpRead,
  type McpChatMetadataArguments, type McpGrantScope } from '../gateway/src/mcp-contract'
import { getSession, listPendingRequests, sessionInstance } from './chat/storage'
import { chatBindings, chatChildren, inbox, timerById, timerSummaries, watches } from './chat/control-store'
import { sourceItems } from './chat/switchboard-store'
import { HttpError, readJson, type RequestAuthority } from './http'
import { mcpInventory } from './mcp-inventory'
import { readMcpWork } from './mcp-work'
import { readMcpChatChanges, readMcpChatList } from './mcp-chat-pages'
import { listCallerRecords, readCallerRecord } from './mcp-caller'
import { listContentDocuments, readContentRecord } from './mcp-editor-content'
import { readWorkspaceView } from './mcp-workspace-views'
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
    const deliveries = inbox(instance, id, 0, 11)
    const supervision = watches(instance, id, 11)
    const switchboard = sourceItems(instance, id, 11)
    return { kind, id, title: chat.title, repository: chat.repo || null, role: chat.role ?? 'chat',
      status: chat.status, updatedAt: chat.updatedAt, lastSequence: chat.lastSeq,
      agent: chat.agent, model: chat.model, branch: chat.branch.name,
      createdByChatId: approvedChat(chat.createdBy?.sessionId), forkedFromChatId: approvedChat(chat.forkedFrom),
      workerIds: workers.slice(0, 10), workBindings: bindings.slice(0, 10).map(({ target, created_at }) => ({ target, at: new Date(created_at).toISOString() })),
      requests: requests.slice(0, 10).map(({ requestId, kind, seq, ownerAction }) => ({ id: requestId, kind, sequence: seq, ownerAction })),
      inbox: deliveries.slice(0, 10).map(({ seq, state, turn_id, sender, sender_role, created_at, timer_id }) => ({
        sequence: seq, delivery: state, turnId: turn_id, senderId: approvedChat(sender), senderRole: sender_role, at: created_at,
        timerId: timer_id,
      })),
      supervision: supervision.slice(0, 10).map(({ id, enabled, next_at, interval_ms, targets }) => ({
        id, enabled: enabled === 1, nextAt: next_at, intervalMs: interval_ms,
        targetChatIds: (JSON.parse(targets) as string[]).map(approvedChat).filter((target): target is string => target !== null),
      })),
      switchboard: switchboard.slice(0, 10).map(({ id, source_seq, kind, created_at, answered_at, resolved_at, dismissed_at, explain_state }) => ({
        id, sourceSequence: source_seq, kind, at: created_at, answeredAt: answered_at, resolvedAt: resolved_at, dismissedAt: dismissed_at,
        explanationState: explain_state,
      })),
      truncated: [workers, bindings, requests, deliveries, supervision, switchboard].some(rows => rows.length > 10),
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
  authority: RequestAuthority, chatInstance?: string, managerRunning = false): Promise<void> {
  if (!service || authority.kind !== 'gateway' || authority.scope !== 'mcp' || !authority.mcp) throw new HttpError(403, 'an MCP read assertion is required')
  if (req.method !== 'POST' || req.url !== MCP_READ_PATH) throw new HttpError(405, `MCP reads require POST ${MCP_READ_PATH}`)
  const read = parseMcpRead(await readJson<unknown>(req, 16 * 1024))
  const work = read.name === 'poise_work' ? await readMcpWork(read.arguments, service, authority.mcp) : undefined
  let lookup
  let page
  if (read.name === 'poise_get') {
    if (read.arguments.kind === 'workspace') {
      if (!mcpWorkspaceAllowed(authority.mcp)) throw new HttpError(403, 'workspace data consent is required')
      lookup = await readWorkspaceView(read.arguments.id, chatInstance)
    } else if (read.arguments.kind === 'call' || read.arguments.kind === 'invocation') {
      if (!mcpWorkspaceAllowed(authority.mcp)) throw new HttpError(403, 'workspace data consent is required')
      lookup = await readCallerRecord(read.arguments.kind, read.arguments.id)
    } else if (isMcpContentKind(read.arguments.kind)) {
      if (!mcpContentAllowed(authority.mcp)) throw new HttpError(403, 'workspace content consent is required')
      lookup = await readContentRecord(read.arguments.kind, read.arguments.id)
    } else if ('chatId' in read.arguments) {
      if (!authority.mcp.chatArtifacts) throw new HttpError(403, 'Chat artifact consent is required')
      if (!chatInstance) throw new HttpError(503, 'Chat data is unavailable until the workspace starts')
      lookup = { observedAt: new Date().toISOString(), ...await readChatArtifact(chatInstance, authority.mcp, read.arguments) }
    } else if (read.arguments.kind === 'chat' || read.arguments.kind === 'timer') {
      if (!authority.mcp.chatMetadata) throw new HttpError(403, 'Chat metadata consent is required')
      if (!chatInstance) throw new HttpError(503, 'Chat metadata is unavailable until the workspace starts')
      lookup = { observedAt: new Date().toISOString(), record: readChatRecord(chatInstance, authority.mcp, read.arguments) }
    } else throw new HttpError(403, 'the selected read belongs to the gateway')
  }
  if (read.name === 'poise_list' || read.name === 'poise_changes') {
    if (read.arguments.kind === 'document') {
      if (!mcpContentAllowed(authority.mcp)) throw new HttpError(403, 'workspace content consent is required')
      page = await listContentDocuments(authority.mcp, read.arguments)
    } else if (read.arguments.kind === 'call') {
      if (!mcpWorkspaceAllowed(authority.mcp)) throw new HttpError(403, 'workspace data consent is required')
      page = await listCallerRecords(authority.mcp, read.arguments)
    } else if (read.arguments.kind === 'chat') {
      if (read.name === 'poise_list' ? !authority.mcp.chatList || !authority.mcp.chatMetadata : !authority.mcp.chatTranscript) {
        throw new HttpError(403, 'the selected Chat data consent is required')
      }
      if (!chatInstance) throw new HttpError(503, 'Chat data is unavailable until the workspace starts')
      page = read.name === 'poise_list' ? readMcpChatList(chatInstance, authority.mcp, read.arguments)
        : readMcpChatChanges(chatInstance, authority.mcp, read.arguments)
    } else throw new HttpError(403, 'the selected read belongs to the gateway')
  }
  const tools = mcpToolNames({ ...(chatInstance ? authority.mcp : { workspaceData: authority.mcp.workspaceData, contentData: authority.mcp.contentData }), managerClientId: managerRunning ? authority.mcp.managerClientId : undefined })
  const text = JSON.stringify({ workspace: service.handle, owner: service.owner, capabilities: { tools },
    ...(read.name === 'poise_describe' ? { inventory: mcpInventory() } : {}),
    ...(work ? { work } : {}), ...(lookup ? { lookup } : {}), ...(page ? { page } : {}) })
  if (Buffer.byteLength(text) > MCP_RESPONSE_BYTES) throw new HttpError(503, 'work response exceeds its bound; request a smaller page')
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}
