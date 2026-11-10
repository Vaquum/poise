export const MCP_READ_PATH = '/api/mcp/read'
export const MCP_SCOPE = 'poise:read'
export const MCP_RESPONSE_BYTES = 128 * 1024
export const MCP_TOOLS = [
  { name: 'poise_describe', description: 'Describe the authorized Poise workspace identity and available tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'poise_work', description: 'Read an exact issue or a bounded repository and label page, with recorded work, receipt coverage and links. Missing or stale evidence does not establish completion.',
    inputSchema: { type: 'object', required: ['repository'], properties: {
      repository: { type: 'string', maxLength: 140 }, issue: { type: 'integer', minimum: 1 },
      label: { type: 'string', minLength: 1, maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 10 },
      cursor: { type: 'string', maxLength: 2048 },
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
] as const

export interface McpGrantScope { resource: string; ownerId: number; handle: string; grantId: string }
export interface McpWorkArguments { repository: string; issue?: number; label?: string; limit?: number; cursor?: string }
export type McpRead = { name: 'poise_describe'; arguments: Record<string, never> }
  | { name: 'poise_work'; arguments: McpWorkArguments }

export function parseMcpRead(value: unknown): McpRead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid tool request')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['name', 'arguments'].includes(key))) throw new Error('unsupported tool request field')
  const args = row.arguments ?? {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid tool arguments')
  if (row.name === 'poise_describe' && !Object.keys(args).length) return { name: row.name, arguments: {} }
  if (row.name !== 'poise_work') throw new Error('unsupported tool or arguments')
  const work = args as Record<string, unknown>
  if (Object.keys(work).some(key => !['repository', 'issue', 'label', 'limit', 'cursor'].includes(key))
    || typeof work.repository !== 'string' || work.repository.length > 140
    || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/.test(work.repository)) throw new Error('invalid repository or work selector')
  if (work.issue !== undefined) {
    if (!Number.isSafeInteger(work.issue) || Number(work.issue) < 1
      || Object.keys(work).some(key => !['repository', 'issue'].includes(key))) throw new Error('an exact issue accepts only repository and issue')
    return { name: row.name, arguments: { repository: work.repository, issue: Number(work.issue) } }
  }
  if (typeof work.label !== 'string' || !work.label.trim() || work.label.length > 100
    || (work.limit !== undefined && (!Number.isSafeInteger(work.limit) || Number(work.limit) < 1 || Number(work.limit) > 10))
    || (work.cursor !== undefined && (typeof work.cursor !== 'string' || !work.cursor || work.cursor.length > 2048))) throw new Error('a label page requires a label and a limit from 1 to 10')
  return { name: row.name, arguments: { repository: work.repository, label: work.label,
    limit: work.limit === undefined ? 5 : Number(work.limit), ...(typeof work.cursor === 'string' ? { cursor: work.cursor } : {}) } }
}
