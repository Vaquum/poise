import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MCP_OWNER_PATH, mcpRepositoryAllowed, parseMcpOwnerRequest, type McpGrantScope, type McpOwnerAction } from '../gateway/src/mcp-contract'
import { invalidateBehaviorChainReads } from './behavior-chain-api'
import { BehaviorChainJournal, BehaviorChainRevisionConflict, chainIdentity, type ChainEvent } from './behavior-chain-store'
import { db, getMeta } from './db'
import { requireConfiguredRepository } from './gh'
import { endJson, HttpError, readJson, type RequestAuthority } from './http'

const PREVIEW_MS = 5 * 60_000
const SECRET = 'mcp_owner_action_signing_key'
interface Preview {
  action: McpOwnerAction
  requestId: string
  sequence: number
  expiresAt: number
}

function signature(grant: McpGrantScope, payload: string): Buffer {
  let key = getMeta(SECRET)
  if (!key) {
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(SECRET, randomBytes(32).toString('hex'))
    key = getMeta(SECRET)
  }
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw new HttpError(503, 'Owner action signing is unavailable')
  const binding = JSON.stringify([grant.resource, grant.ownerId, grant.handle, grant.grantId, grant.ownerClientId, grant.repository ?? null])
  return createHmac('sha256', Buffer.from(key, 'hex')).update(binding).update('.').update(payload).digest()
}

function decode(grant: McpGrantScope, token: string): Preview {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, 'Invalid owner action preview')
  const [payload, encoded] = token.split('.')
  const received = Buffer.from(encoded, 'base64url')
  if (received.length !== 32 || !timingSafeEqual(received, signature(grant, payload))) throw new HttpError(400, 'Invalid owner action preview for this grant')
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Preview
}

function scopedChain(journal: BehaviorChainJournal, grant: McpGrantScope, action: McpOwnerAction) {
  if (!mcpRepositoryAllowed(grant, action.repository)) throw new HttpError(403, 'repository is outside this grant')
  requireConfiguredRepository(action.repository)
  const chain = journal.read(chainIdentity(action.repository, action.issue))
  if (!chain) throw new HttpError(404, 'behavior chain not found')
  return chain
}

function requireActionState(chain: NonNullable<ReturnType<BehaviorChainJournal['read']>>, operation: McpOwnerAction['operation']): void {
  if (chain.mergeSha || chain.supersession) throw new HttpError(409, 'The chain is terminal')
  if (operation === 'hold' ? chain.held !== null : chain.held === null) throw new HttpError(409,
    operation === 'hold' ? 'The chain is already held' : 'The chain has no hold to resume')
}

export async function handleMcpOwner(req: IncomingMessage, res: ServerResponse, authority: RequestAuthority): Promise<void> {
  if (authority.kind !== 'gateway' || authority.scope !== 'mcp' || !authority.mcp?.ownerClientId) {
    throw new HttpError(403, 'an owner-delegated assertion is required')
  }
  if (req.method !== 'POST' || req.url !== MCP_OWNER_PATH) throw new HttpError(405, 'Use POST ' + MCP_OWNER_PATH)
  const grant = authority.mcp
  const request = parseMcpOwnerRequest(await readJson<unknown>(req, 16 * 1024))
  const journal = new BehaviorChainJournal(db)
  const reply = (action: unknown) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    endJson(res, JSON.stringify({ workspace: grant.handle, action }))
  }
  try {
    if (request.name === 'poise_chain_preview') {
      const action = request.arguments
      const chain = scopedChain(journal, grant, action)
      requireActionState(chain, action.operation)
      const data: Preview = { action, requestId: randomUUID(), sequence: chain.sequence, expiresAt: Date.now() + PREVIEW_MS }
      const payload = Buffer.from(JSON.stringify(data)).toString('base64url')
      return reply({ status: 'preview', ...data, clientId: grant.ownerClientId, chainId: chain.id, permission: 'delegated-owner',
        humanDecisionRequired: false, effect: action.operation === 'hold' ? 'Hold new chain invocations' : 'Release the chain hold for normal admission',
        preview: payload + '.' + signature(grant, payload).toString('base64url') })
    }
    const preview = decode(grant, request.arguments.preview)
    const { action, requestId, sequence, expiresAt } = preview
    const chain = scopedChain(journal, grant, action)
    const delegation = { grantId: grant.grantId, clientId: grant.ownerClientId!, expectedSequence: sequence, ownerId: grant.ownerId }
    const event: ChainEvent = action.operation === 'hold'
      ? { type: 'chain.held', reason: 'New invocations held by a delegated owner client', delegation }
      : { type: 'chain.resumed', recovery: { origin: 'operator' }, delegation }
    let receipt = journal.eventReceipt(chain.id, requestId)
    if (receipt && JSON.stringify(receipt.event) !== JSON.stringify(event)) throw new HttpError(409, 'The request ID belongs to another action')
    if (!receipt) {
      if (expiresAt <= Date.now() || chain.sequence !== sequence) throw new HttpError(409, 'The owner action preview is stale')
      requireActionState(chain, action.operation)
      journal.append(chain.id, requestId, sequence, event)
      invalidateBehaviorChainReads()
      receipt = journal.eventReceipt(chain.id, requestId)
    }
    return reply({ status: receipt ? 'applied' : 'uncertain', requestId, clientId: grant.ownerClientId, chainId: chain.id, action,
      receipt: receipt ? { sequence: receipt.sequence, at: new Date(receipt.at).toISOString(), event: receipt.event.type } : null })
  } catch (error) {
    if (error instanceof BehaviorChainRevisionConflict) return reply({ status: 'refused', error: 'The chain changed after preview' })
    if (!(error instanceof HttpError) || error.statusCode >= 500) throw error
    return reply({ status: 'refused', error: error.message })
  }
}
