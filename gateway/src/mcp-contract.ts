export const MCP_READ_PATH = '/api/mcp/read'
export const MCP_CONTROL_PATH = '/api/mcp/manager'
export const MCP_OWNER_PATH = '/api/mcp/owner'
export const MCP_SCOPE = 'poise:read'
export const MCP_RESPONSE_BYTES = 128 * 1024
const MCP_RECORD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const pageProperties = { limit: { type: 'integer', minimum: 1, maximum: 10 }, cursor: { type: 'string', maxLength: 2048 } } as const
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
  { name: 'poise_list', description: 'List a bounded page of current or archived Chat session records by repository and UTC update window.',
    inputSchema: { type: 'object', required: ['kind'], properties: {
      kind: { const: 'chat' }, repository: { type: 'string', maxLength: 140 },
      since: { type: 'string', format: 'date-time' }, until: { type: 'string', format: 'date-time' }, ...pageProperties,
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'poise_changes', description: 'Read a bounded page of retained Chat transcript events by sequence. Use the continuation to resume.',
    inputSchema: { type: 'object', required: ['kind', 'id'], properties: {
      kind: { const: 'chat' }, id: { type: 'string', pattern: MCP_RECORD_ID.source },
      afterSequence: { type: 'integer', minimum: 0 }, ...pageProperties,
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
export const MCP_OWNER_TOOLS = [
  { name: 'poise_chain_preview', description: 'Preview an owner-delegated hold or resume for one existing Behavior chain.',
    inputSchema: { type: 'object', required: ['operation', 'repository', 'issue'], properties: {
      operation: { enum: ['hold', 'resume'] }, repository: { type: 'string', maxLength: 140 },
      issue: { type: 'integer', minimum: 1 },
    }, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'poise_chain_apply', description: 'Apply an exact owner-delegated chain preview. Reuse the preview to recover the original receipt.',
    inputSchema: { type: 'object', required: ['preview'], properties: { preview: { type: 'string', minLength: 1, maxLength: 2048 } },
      additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
] as const
export interface McpGrantScope {
  resource: string
  ownerId: number
  handle: string
  grantId: string
  chatMetadata?: true
  chatList?: true
  chatTranscript?: true
  managerClientId?: string
  ownerClientId?: string
  repository?: string
}
export interface McpWorkArguments { repository: string; issue?: number; label?: string; limit?: number; cursor?: string }
export interface McpGetArguments { kind: 'chat' | 'timer'; id: string }
export interface McpChatListArguments { kind: 'chat'; repository: string | null; since: string | null; until: string | null; limit: number; cursor?: string }
export interface McpChatChangesArguments { kind: 'chat'; id: string; limit: number; afterSequence?: number; cursor?: string }
export type McpRead = { name: 'poise_describe'; arguments: Record<string, never> }
  | { name: 'poise_work'; arguments: McpWorkArguments }
  | { name: 'poise_get'; arguments: McpGetArguments }
  | { name: 'poise_list'; arguments: McpChatListArguments }
  | { name: 'poise_changes'; arguments: McpChatChangesArguments }
export type McpManagerAction = { operation: 'send' | 'steer'; sessionId: string; text: string }
  | { operation: 'stop'; sessionId: string }
  | { operation: 'supervise'; sessionId: string; text: string; intervalMinutes: number }
export type McpManagerRequest = { name: 'poise_action_preview'; arguments: McpManagerAction }
  | { name: 'poise_action_apply'; arguments: { preview: string } }
export interface McpOwnerAction { operation: 'hold' | 'resume'; repository: string; issue: number }
export type McpOwnerRequest = { name: 'poise_chain_preview'; arguments: McpOwnerAction }
  | { name: 'poise_chain_apply'; arguments: { preview: string } }
export type McpRequest = McpRead | McpManagerRequest | McpOwnerRequest

export const isMcpManagerTool = (name: unknown): name is McpManagerRequest['name'] =>
  MCP_MANAGER_TOOLS.some(tool => name === tool.name)
export const isMcpOwnerTool = (name: unknown): name is McpOwnerRequest['name'] =>
  MCP_OWNER_TOOLS.some(tool => name === tool.name)

export function parseMcpOwnerRequest(value: unknown): McpOwnerRequest {
  if (!value || typeof value !== 'object' || !('name' in value) || !isMcpOwnerTool(value.name)
    || !('arguments' in value) || !value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)
    || Object.keys(value).length !== 2) throw new Error('invalid owner control request')
  const args = value.arguments as Record<string, unknown>
  if (value.name === 'poise_chain_apply' && Object.keys(args).length === 1
    && typeof args.preview === 'string' && args.preview && args.preview.length <= 2048) {
    return { name: value.name, arguments: { preview: args.preview } }
  }
  const { operation, repository, issue } = args
  if (value.name === 'poise_chain_preview' && Object.keys(args).length === 3 && (operation === 'hold' || operation === 'resume')
    && isMcpRepository(repository) && Number.isSafeInteger(issue) && Number(issue) >= 1) {
    return { name: value.name, arguments: { operation, repository, issue: Number(issue) } }
  }
  throw new Error('provide a supported owner action and an exact repository and issue')
}

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

export function mcpToolNames(scope: Pick<McpGrantScope, 'chatMetadata' | 'chatList' | 'chatTranscript' | 'managerClientId' | 'ownerClientId'>): string[] {
  const tools: string[] = [...MCP_WORK_TOOL_NAMES]
  if (scope.chatMetadata === true) tools.push('poise_get')
  if (scope.chatMetadata === true && scope.chatList === true) tools.push('poise_list')
  if (scope.chatTranscript === true) tools.push('poise_changes')
  if (scope.managerClientId) tools.push(...MCP_MANAGER_TOOLS.map(tool => tool.name))
  if (scope.ownerClientId) tools.push(...MCP_OWNER_TOOLS.map(tool => tool.name))
  return tools
}

function pageTime(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('use UTC date-time bounds')
  }
  const normalized = new Date(value).toISOString()
  if (normalized.slice(0, 19) !== value.slice(0, 19)) throw new Error('use a valid UTC date-time')
  return normalized
}

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
  if (row.name === 'poise_list' || row.name === 'poise_changes') {
    const page = args as Record<string, unknown>
    const limit = page.limit ?? 5
    const cursor = page.cursor
    if (page.kind !== 'chat' || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 10
      || (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048))) throw new Error('invalid Chat page selector')
    const bounds = { kind: 'chat' as const, limit: Number(limit), ...(typeof cursor === 'string' ? { cursor } : {}) }
    if (row.name === 'poise_list') {
      const repository = page.repository ?? null
      if (Object.keys(page).some(key => !['kind', 'repository', 'since', 'until', 'limit', 'cursor'].includes(key))
        || (repository !== null && !isMcpRepository(repository))) throw new Error('invalid Chat list selector')
      const since = pageTime(page.since), until = pageTime(page.until)
      if (since && until && since >= until) throw new Error('Chat list requires since before until')
      return { name: row.name, arguments: { ...bounds, repository, since, until } }
    }
    const afterSequence = page.afterSequence
    if (Object.keys(page).some(key => !['kind', 'id', 'afterSequence', 'limit', 'cursor'].includes(key))
      || !isMcpRecordId(page.id)
      || (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || Number(afterSequence) < 0 || cursor !== undefined))) {
      throw new Error('invalid Chat change selector')
    }
    return { name: row.name, arguments: { ...bounds, id: page.id,
      ...(afterSequence === undefined ? {} : { afterSequence: Number(afterSequence) }) } }
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
