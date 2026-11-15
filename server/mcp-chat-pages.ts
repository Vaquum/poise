import { isMcpRecordId, mcpRepositoryAllowed, type McpChatChangesArguments, type McpChatListArguments, type McpGrantScope } from '../gateway/src/mcp-contract'
import type { ChatEvent } from './chat/protocol'
import { getSession, listEvents, pageChatSessions, sessionInstance, type ChatPageSelector } from './chat/storage'
import { HttpError } from './http'
import { mcpCursor } from './mcp-cursor'

export function readMcpChatList(instance: string, grant: McpGrantScope, args: McpChatListArguments) {
  const { since, until, limit } = args
  const repository = args.repository ?? grant.repository ?? null
  if (!mcpRepositoryAllowed(grant, repository)) throw new HttpError(403, 'repository is outside this grant')
  const cursor = mcpCursor(grant, ['chat-list-v1', repository?.toLowerCase(), since, until, limit])
  let before: ChatPageSelector['before'] = null
  if (args.cursor) {
    const value = cursor.decode(args.cursor)
    if (!value || typeof value !== 'object' || !('updatedAt' in value) || !('id' in value)
      || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || !isMcpRecordId(value.id)) throw new HttpError(400, 'invalid Chat listing cursor')
    before = { updatedAt: value.updatedAt, id: value.id }
  }
  const items = pageChatSessions(instance, { repository, since, until, before, limit: limit + 1 })
  const records = items.slice(0, limit)
  const last = records.at(-1)
  return { repository, since, until, observedAt: new Date().toISOString(), items: records,
    nextCursor: items.length > limit && last ? cursor.encode({ updatedAt: last.updatedAt, id: last.id }) : null }
}

function textPreview(text: string) {
  return { text: text.slice(0, 1200), truncated: text.length > 1200 }
}

/** The event journal can also carry native tool input and internal prompts.
 *  Select transcript fields explicitly rather than serializing the envelopes. */
function eventDetail(event: ChatEvent) {
  switch (event.type) {
    case 'turn.started':
      return { turnId: event.turnId, callId: event.callId ?? null, ...textPreview(event.prompt.text),
        attachmentIds: (event.prompt.attachments ?? []).filter(item => isMcpRecordId(item.id)).map(item => item.id) }
    case 'text.delta':
      return { turnId: event.turnId, messageId: event.messageId, ...textPreview(event.delta) }
    case 'steer.sent':
      return { turnId: event.turnId, ...textPreview(event.text),
        attachmentIds: (event.attachments ?? []).filter(item => isMcpRecordId(item.id)).map(item => item.id) }
    case 'turn.finished':
      return { turnId: event.turnId, stopReason: event.stopReason, durationMs: event.durationMs ?? null }
    case 'timer.changed':
      return { timerId: event.timer.id, state: event.timer.state, change: event.change }
    case 'status.changed':
      return { status: event.status }
    case 'plan.updated':
      return { turnId: event.turnId, entries: event.entries.slice(0, 10).map(({ content, status, priority }) =>
        ({ content: content.slice(0, 150), status, priority })), truncated: event.entries.length > 10 || event.entries.some(row => row.content.length > 150) }
    case 'diff':
      return { turnId: event.turnId, diffId: event.diffId, metadataOnly: true }
    default:
      return { metadataOnly: true }
  }
}

export function readMcpChatChanges(instance: string, grant: McpGrantScope, args: McpChatChangesArguments) {
  const cursor = mcpCursor(grant, ['chat-changes-v1', args.id, args.limit])
  const requested = args.cursor ? cursor.decode(args.cursor) : args.afterSequence ?? 0
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 0) {
    throw new HttpError(400, 'invalid Chat change cursor')
  }
  const observedAt = new Date().toISOString()
  const session = sessionInstance(args.id) === instance ? getSession(args.id) : null
  if (!session || !mcpRepositoryAllowed(grant, session.repo || null)) {
    return { observedAt, chatId: args.id, found: false, coverage: 'complete', items: [], nextCursor: null }
  }
  if (session.contextResetting) {
    return { observedAt, chatId: args.id, repository: session.repo || null, found: true, coverage: 'unavailable',
      reason: 'Chat context is resetting', items: [], nextCursor: null }
  }
  if (requested > session.lastSeq) throw new HttpError(400, 'requested sequence is ahead of the Chat journal')
  const floor = session.contextResetSeq ? session.contextResetSeq - 1 : 0
  const after = Math.max(requested, floor)
  const page = listEvents(args.id, after, args.limit)
  const items = page.events.map(({ seq, at, event }) => ({ sequence: seq, at, type: event.type, detail: eventDetail(event) }))
  const retainedFrom = session.contextResetSeq ?? null
  const coverage = requested < floor ? 'expired'
    : items.some(({ detail }) => ('truncated' in detail && detail.truncated) || detail.metadataOnly) ? 'partial' : 'complete'
  const watermark = items.at(-1)?.sequence ?? after
  return { observedAt, chatId: args.id, repository: session.repo || null, found: true, coverage, retainedFrom, watermark, hasMore: page.truncated,
    items, nextCursor: cursor.encode(watermark) }
}
