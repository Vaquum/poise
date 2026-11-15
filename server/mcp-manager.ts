import type { IncomingMessage, ServerResponse } from 'node:http'
import { MCP_CONTROL_PATH, parseMcpManagerRequest } from '../gateway/src/mcp-contract'
import type { ChatControl } from './chat/control'
import { endJson, HttpError, readJson, type RequestAuthority } from './http'

export async function handleMcpControl(req: IncomingMessage, res: ServerResponse, authority: RequestAuthority,
  control: ChatControl | null): Promise<void> {
  if (authority.kind !== 'gateway' || authority.scope !== 'mcp' || !authority.mcp?.managerClientId) {
    throw new HttpError(403, 'a delegated Manager assertion is required')
  }
  if (req.method !== 'POST' || req.url !== MCP_CONTROL_PATH) throw new HttpError(405, 'Manager controls require POST ' + MCP_CONTROL_PATH)
  if (!control) throw new HttpError(503, 'the workspace Manager control is unavailable')
  const request = parseMcpManagerRequest(await readJson<unknown>(req, 16 * 1024))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json')
  let action
  try { action = await control.delegated(authority.mcp, request) }
  catch (error) {
    if (!(error instanceof HttpError) || error.statusCode >= 500) throw error
    action = { status: 'refused', code: 'invalid_action', error: error.message }
  }
  endJson(res, JSON.stringify({ workspace: authority.mcp.handle, action }))
}
