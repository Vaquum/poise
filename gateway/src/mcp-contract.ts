export const MCP_READ_PATH = '/api/mcp/read'
export const MCP_CONTROL_PATH = '/api/mcp/manager'
export const MCP_SCOPE = 'poise:read'
export const MCP_RESPONSE_BYTES = 128 * 1024
const MCP_RECORD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
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
  { name: 'poise_get', description: 'Read a Chat session or a live Chat timer by its Poise record ID. Requires the owner’s Chat metadata grant.',
    inputSchema: { type: 'object', required: ['kind', 'id'], properties: {
      kind: { enum: ['chat', 'timer'] }, id: { type: 'string', pattern: MCP_RECORD_ID.source },
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
] as const

export const MCP_WORK_TOOL_NAMES = ['poise_describe', 'poise_work'] as const
export const MCP_MANAGER_TOOLS = [
  { name: 'poise_action_preview', description: 'Preview a delegated Manager send, steer, stop or supervision. Shows the exact effect and current Chat sequence. Requires separately granted Manager controls.',
    inputSchema: { type: 'object', required: ['operation', 'sessionId'],
      properties: { operation: { enum: ['send', 'steer', 'stop', 'supervise'] }, sessionId: { type: 'string', pattern: MCP_RECORD_ID.source },
        text: { type: 'string', minLength: 1, maxLength: 2000 }, intervalMinutes: { type: 'integer', minimum: 1, maximum: 1440 } },
      additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'poise_action_apply', description: 'Apply the exact confirmed Manager preview. Reuse its preview on retry to get the original outcome.',
    inputSchema: { type: 'object', required: ['preview'],
      properties: { preview: { type: 'string', minLength: 1, maxLength: 12000 } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
] as const
export interface McpGrantScope {
  resource: string; ownerId: number; handle: string; grantId: string; chatMetadata?: true; repository?: string; managerClientId?: string
}
export interface McpWorkArguments { repository: string; issue?: number; label?: string; limit?: number; cursor?: string }
export interface McpGetArguments { kind: 'chat' | 'timer'; id: string }
export type McpRead = { name: 'poise_describe'; arguments: Record<string, never> }
  | { name: 'poise_work'; arguments: McpWorkArguments }
  | { name: 'poise_get'; arguments: McpGetArguments }
export type McpManagerAction = { operation: 'send' | 'steer'; sessionId: string; text: string }
  | { operation: 'stop'; sessionId: string }
  | { operation: 'supervise'; sessionId: string; text: string; intervalMinutes: number }
export type McpManagerRequest = { name: 'poise_action_preview'; arguments: McpManagerAction }
  | { name: 'poise_action_apply'; arguments: { preview: string } }
export type McpRequest = McpRead | McpManagerRequest

export const isMcpManagerTool = (name: unknown): name is McpManagerRequest['name'] =>
  MCP_MANAGER_TOOLS.some(tool => name === tool.name)

export function parseMcpManagerRequest(value: unknown): McpManagerRequest {
  if (!value || typeof value !== 'object' || !('name' in value) || !isMcpManagerTool(value.name)
    || !('arguments' in value) || !value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)
    || Object.keys(value).length !== 2) throw new Error('invalid Manager request')
  const args = value.arguments as Record<string, unknown>
  if (value.name === 'poise_action_apply') {
    if (Object.keys(args).length !== 1 || typeof args.preview !== 'string' || !args.preview || args.preview.length > 12000) {
      throw new Error('provide a valid Manager action preview')
    }
    return { name: value.name, arguments: { preview: args.preview } }
  }
  const { operation, sessionId, text, intervalMinutes } = args
  if (!isMcpRecordId(sessionId)) throw new Error('provide an exact Chat session ID')
  if (operation === 'stop' && Object.keys(args).length === 2) return { name: value.name, arguments: { operation, sessionId } }
  if (typeof text === 'string' && text.trim() && text.length <= 2000 && Buffer.byteLength(JSON.stringify(text)) <= 7000) {
    if ((operation === 'send' || operation === 'steer') && Object.keys(args).length === 3) {
      return { name: value.name, arguments: { operation, sessionId, text: text.trim() } }
    }
    if (operation === 'supervise' && Object.keys(args).length === 4 && Number.isSafeInteger(intervalMinutes)
      && Number(intervalMinutes) >= 1 && Number(intervalMinutes) <= 1440) {
      return { name: value.name, arguments: { operation, sessionId, text: text.trim(), intervalMinutes: Number(intervalMinutes) } }
    }
  }
  throw new Error('provide a supported Manager action and its exact text')
}

export const isMcpRecordId = (value: unknown): value is string => typeof value === 'string' && MCP_RECORD_ID.test(value)

export const isMcpRepository = (value: unknown): value is string => typeof value === 'string' && value.length <= 140
  && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]+$/.test(value)

export const mcpRepositoryAllowed = (scope: McpGrantScope, repository: string | null): boolean =>
  scope.repository === undefined || scope.repository.toLowerCase() === repository?.toLowerCase()

export function parseMcpRead(value: unknown): McpRead {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid tool request')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['name', 'arguments'].includes(key))) throw new Error('unsupported tool request field')
  const args = row.arguments ?? {}
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid tool arguments')
  if (row.name === 'poise_describe' && !Object.keys(args).length) return { name: row.name, arguments: {} }
  if (row.name === 'poise_get') {
    const { kind, id } = args as Record<string, unknown>
    if (Object.keys(args).length !== 2 || (kind !== 'chat' && kind !== 'timer') || !isMcpRecordId(id)) throw new Error('provide a Chat or timer record ID')
    return { name: row.name, arguments: { kind, id } }
  }
  if (row.name !== 'poise_work') throw new Error('unsupported tool or arguments')
  const work = args as Record<string, unknown>
  if (Object.keys(work).some(key => !['repository', 'issue', 'label', 'limit', 'cursor'].includes(key))
    || !isMcpRepository(work.repository)) throw new Error('invalid repository or work selector')
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
