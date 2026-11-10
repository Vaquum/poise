import type { IncomingMessage, ServerResponse } from 'node:http'
import { MCP_READ_PATH, MCP_RESPONSE_BYTES, MCP_TOOLS, parseMcpRead } from '../gateway/src/mcp-contract'
import { HttpError, readJson, type RequestAuthority } from './http'
import { readMcpWork } from './mcp-work'
import type { ServiceConfig } from './service/config'

/** This scope terminates here, before ordinary workspace API dispatch. */
export async function handleMcpRead(req: IncomingMessage, res: ServerResponse, service: ServiceConfig | null, authority: RequestAuthority): Promise<void> {
  if (!service || authority.kind !== 'gateway' || authority.scope !== 'mcp' || !authority.mcp) throw new HttpError(403, 'an MCP read assertion is required')
  if (req.method !== 'POST' || req.url !== MCP_READ_PATH) throw new HttpError(405, `MCP reads require POST ${MCP_READ_PATH}`)
  const read = parseMcpRead(await readJson<unknown>(req, 16 * 1024))
  const work = read.name === 'poise_work' ? await readMcpWork(read.arguments, service, authority.mcp) : undefined
  const text = JSON.stringify({ workspace: service.handle, owner: service.owner, capabilities: { tools: MCP_TOOLS.map(tool => tool.name) },
    ...(work ? { work } : {}) })
  if (Buffer.byteLength(text) > MCP_RESPONSE_BYTES) throw new HttpError(503, 'work response exceeds its bound; request a smaller page')
  res.statusCode = 200
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(text)
}
