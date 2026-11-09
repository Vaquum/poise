export const MCP_READ_PATH = '/api/mcp/read'
export const MCP_SCOPE = 'poise:read'
export const MCP_RESPONSE_BYTES = 16 * 1024
export const MCP_TOOLS = [
  { name: 'poise_describe', description: 'Describe the authorized Poise workspace identity and available tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
] as const

export interface McpGrantScope { resource: string; ownerId: number; handle: string; grantId: string }
export interface McpRead { name: 'poise_describe'; arguments: Record<string, never> }

export function parseMcpRead(value: unknown): McpRead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid tool request')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['name', 'arguments'].includes(key))) throw new Error('unsupported tool request field')
  const args = row.arguments ?? {}
  if (row.name !== 'poise_describe' || !args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).length) throw new Error('only poise_describe without arguments is supported')
  return { name: row.name, arguments: {} }
}
