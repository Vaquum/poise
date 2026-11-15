import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { mcpRepositoryAllowed, type McpChatArtifactArguments, type McpGrantScope } from '../gateway/src/mcp-contract'
import { attachmentPath, inlineText, safeAttachmentName, sha256Of, type AttachmentRecord } from './chat/attachments'
import { visibleChatPath } from './chat/file-preview'
import { resolveInsideCheckout } from './chat/git'
import { getAttachment, getDiffEvent, getSession, sessionInstance } from './chat/storage'

const MAX_ATTACHMENT_BYTES = 16 * 1024
const MAX_DIFF_CHARS = 6 * 1024

async function attachmentText(checkout: string, row: AttachmentRecord): Promise<string | null> {
  if (row.size > MAX_ATTACHMENT_BYTES || row.size < 0 || !visibleChatPath(row.name)
    || row.name !== safeAttachmentName(row.name) || row.path !== attachmentPath(row.sessionId, row.id, row.name)) return null
  try {
    const path = await resolveInsideCheckout(checkout, row.path)
    const handle = await open(path.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== row.size) return null
      const buffer = Buffer.alloc(row.size + 1)
      let read = 0
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
        if (!bytesRead) break
        read += bytesRead
      }
      const bytes = buffer.subarray(0, read)
      if (read !== row.size || sha256Of(bytes) !== row.sha256) return null
      return inlineText(bytes) ?? null
    } finally { await handle.close() }
  } catch { return null }
}

export async function readChatArtifact(instance: string, grant: McpGrantScope, { kind, id, chatId }: McpChatArtifactArguments) {
  const session = sessionInstance(chatId) === instance ? getSession(chatId) : null
  if (!session || !mcpRepositoryAllowed(grant, session.repo || null)) return { coverage: 'complete', record: null }
  if (session.contextResetting) return { coverage: 'unavailable', record: null, reason: 'Chat context is resetting' }
  const common = { kind, id, chatId, repository: session.repo || null }
  if (kind === 'chat-attachment') {
    const saved = getAttachment(id)
    if (!saved || saved.sessionId !== chatId) return { coverage: 'complete', record: null }
    const text = await attachmentText(session.checkout, saved)
    const latest = sessionInstance(chatId) === instance ? getSession(chatId) : null
    if (!latest || latest.repo !== session.repo || latest.checkout !== session.checkout || latest.contextResetting) {
      return { coverage: 'unavailable', record: null, reason: 'The Chat changed while the attachment was read' }
    }
    return { coverage: text === null ? 'partial' : 'complete',
      ...(text === null ? { reason: 'The retained attachment has no verified bounded text preview' } : {}),
      record: { ...common, name: saved.name, size: saved.size, createdAt: saved.createdAt, text } }
  }
  const diff = getDiffEvent(chatId, id)
  if (!diff) return { coverage: 'complete', record: null }
  const path = relative(session.checkout, resolve(session.checkout, diff.path)).replaceAll('\\', '/')
  if (!path || path === '..' || path.startsWith('../') || isAbsolute(path) || !visibleChatPath(path)) {
    return { coverage: 'partial', record: null, reason: 'The retained diff is outside the Chat’s previewable checkout files' }
  }
  const truncated = diff.oldText.length > MAX_DIFF_CHARS || diff.newText.length > MAX_DIFF_CHARS || !!diff.previewOnly
  return { coverage: truncated ? 'partial' : 'complete', record: { ...common, path, turnId: diff.turnId,
    oldText: diff.oldText.slice(0, MAX_DIFF_CHARS), newText: diff.newText.slice(0, MAX_DIFF_CHARS),
    oldExists: diff.oldExists, newExists: diff.newExists, unified: diff.unified === true, truncated } }
}
