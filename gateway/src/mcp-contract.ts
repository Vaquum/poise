export const MCP_READ_PATH = '/api/mcp/read'
export const MCP_CONTROL_PATH = '/api/mcp/manager'
export const MCP_OWNER_PATH = '/api/mcp/owner'
export const MCP_SCOPE = 'poise:read'
export const MCP_RESPONSE_BYTES = 128 * 1024
const MCP_RECORD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const CALL_ID = /^[a-fA-F0-9]{32}$/
const DIAGNOSTIC_ID = /^evt_[a-f0-9]{16}_[a-f0-9]{64}$/
const LOG_KINDS = ['logging', 'instance-logging'] as const
const GATEWAY_VIEWS = ['link-devices', 'logging-health', 'instance-logging-health'] as const
export type McpLoggingKind = typeof LOG_KINDS[number]
export type McpGatewayView = typeof GATEWAY_VIEWS[number]
const CONTENT_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/
const pageProperties = { limit: { type: 'integer', minimum: 1, maximum: 10 }, cursor: { type: 'string', maxLength: 2048 } } as const
export const MCP_WORKSPACE_VIEWS = ['settings', 'accounts', 'models', 'behaviors', 'release', 'health', 'storage',
  'github-quota', 'analytics-health', 'analytics-history', 'behavior-estimates', 'notices', 'handling', 'extensions', 'memories', 'snippets', 'current', 'repositories', 'switchboard'] as const
export type McpWorkspaceView = typeof MCP_WORKSPACE_VIEWS[number]
export const MCP_TOOLS = [
  { name: 'poise_describe', description: 'Describe the authorized Poise workspace identity and available tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'poise_work', description: 'Read an exact issue or a bounded repository and label page, with recorded work, receipt coverage and links. Missing or stale evidence does not establish completion.',
    inputSchema: { type: 'object', required: ['repository'], properties: {
      repository: { type: 'string', maxLength: 140 }, issue: { type: 'integer', minimum: 1 },
      label: { type: 'string', minLength: 1, maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 10 },
      since: { type: 'string', description: 'Inclusive issue creation time in UTC (YYYY-MM-DDTHH:MM:SSZ)' },
      until: { type: 'string', description: 'Exclusive issue creation time in UTC (YYYY-MM-DDTHH:MM:SSZ)' },
      cursor: { type: 'string', maxLength: 2048 },
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'poise_get', description: 'Read an exact retained record or named workspace snapshot. Requires consent for the selected data.',
    inputSchema: { type: 'object', required: ['kind', 'id'], properties: {
      kind: { enum: ['chat', 'timer', 'chat-attachment', 'chat-diff', 'workspace', 'call', 'invocation', 'document', 'snippet', 'memory', 'gateway', ...LOG_KINDS] },
      id: { type: 'string', maxLength: 120 },
      chatId: { type: 'string', pattern: MCP_RECORD_ID.source, description: 'Required for a Chat attachment or diff' },
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'poise_list', description: 'List a bounded page of Chat sessions, documents, Caller records or Logging events. Requires consent for the selected data.',
    inputSchema: { type: 'object', required: ['kind'], properties: {
      kind: { enum: ['chat', 'document', 'call', ...LOG_KINDS] }, repository: { type: 'string', maxLength: 140 },
      since: { type: 'string', format: 'date-time' }, until: { type: 'string', format: 'date-time' }, ...pageProperties,
    }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'poise_changes', description: 'Read a bounded page of retained Chat transcript events by sequence. Use the continuation to resume.',
    inputSchema: { type: 'object', required: ['kind'], properties: {
      kind: { enum: ['chat', ...LOG_KINDS] }, id: { type: 'string', pattern: MCP_RECORD_ID.source },
      afterSequence: { type: 'integer', minimum: 0 }, afterWatermark: { type: 'string', maxLength: 2048 },
      repository: { type: 'string', maxLength: 140 }, since: { type: 'string', format: 'date-time' }, until: { type: 'string', format: 'date-time' },
      ...pageProperties,
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
  { name: 'poise_chain_preview', description: 'Preview an owner-delegated hold or resume of a Behavior chain, or add the configured intake label to an exact open GitHub issue.',
    inputSchema: { type: 'object', required: ['operation', 'repository', 'issue'], properties: {
      operation: { enum: ['hold', 'resume', 'label'] }, repository: { type: 'string', maxLength: 140 },
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
  chatArtifacts?: true
  workspaceData?: true
  operatorLogs?: true
  contentData?: true
  managerClientId?: string
  ownerClientId?: string
  repository?: string
}
export interface McpWorkArguments { repository: string; issue?: number; label?: string; limit?: number; cursor?: string; since?: string; until?: string }
export interface McpChatMetadataArguments { kind: 'chat' | 'timer'; id: string }
export interface McpChatArtifactArguments { kind: 'chat-attachment' | 'chat-diff'; id: string; chatId: string }
export type McpGetArguments = McpChatMetadataArguments | McpChatArtifactArguments | { kind: 'workspace'; id: McpWorkspaceView }
  | { kind: 'call'; id: string } | { kind: 'invocation'; id: string }
  | { kind: 'gateway'; id: McpGatewayView } | { kind: McpLoggingKind; id: string }
  | { kind: 'document'; id: string } | { kind: 'snippet'; id: string } | { kind: 'memory'; id: 'current' }
export interface McpChatListArguments { kind: 'chat'; repository: string | null; since: string | null; until: string | null; limit: number; cursor?: string }
export interface McpDocumentListArguments { kind: 'document'; limit: number; cursor?: string }
export interface McpCallerListArguments { kind: 'call'; limit: number; cursor?: string }
export interface McpChatChangesArguments { kind: 'chat'; id: string; limit: number; afterSequence?: number; cursor?: string }
export interface McpLoggingArguments { kind: McpLoggingKind; repository: string | null; since: string | null; until: string | null;
  limit: number; cursor?: string; afterWatermark?: string }
export type McpRead = { name: 'poise_describe'; arguments: Record<string, never> }
  | { name: 'poise_work'; arguments: McpWorkArguments }
  | { name: 'poise_get'; arguments: McpGetArguments }
  | { name: 'poise_list'; arguments: McpChatListArguments | McpDocumentListArguments | McpCallerListArguments | McpLoggingArguments }
  | { name: 'poise_changes'; arguments: McpChatChangesArguments | McpLoggingArguments }
export type McpManagerAction = { operation: 'send' | 'steer'; sessionId: string; text: string }
  | { operation: 'stop'; sessionId: string }
  | { operation: 'supervise'; sessionId: string; text: string; intervalMinutes: number }
export type McpManagerRequest = { name: 'poise_action_preview'; arguments: McpManagerAction }
  | { name: 'poise_action_apply'; arguments: { preview: string } }
export interface McpOwnerAction { operation: 'hold' | 'resume' | 'label'; repository: string; issue: number }
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
  if (value.name === 'poise_chain_preview' && Object.keys(args).length === 3 && (operation === 'hold' || operation === 'resume' || operation === 'label')
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

const workWindowTime = (value: unknown): value is string => typeof value === 'string'
  && /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value

export const isMcpRepository = (value: unknown): value is string => typeof value === 'string' && value.length <= 140
  && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(value)

export const mcpRepositoryAllowed = (scope: McpGrantScope, repository: string | null): boolean =>
  scope.repository === undefined || scope.repository.toLowerCase() === repository?.toLowerCase()

export function mcpToolNames(scope: Pick<McpGrantScope, 'chatMetadata' | 'chatList' | 'chatTranscript' | 'chatArtifacts' | 'workspaceData' | 'operatorLogs' | 'contentData' | 'repository' | 'managerClientId' | 'ownerClientId'>): string[] {
  const tools: string[] = [...MCP_WORK_TOOL_NAMES]
  const gatewayRead = mcpWorkspaceAllowed(scope) || (scope.operatorLogs === true && scope.repository === undefined)
  if (scope.chatMetadata === true || scope.chatArtifacts === true || gatewayRead || mcpContentAllowed(scope)) tools.push('poise_get')
  if (scope.chatMetadata === true && scope.chatList === true || gatewayRead || mcpContentAllowed(scope)) tools.push('poise_list')
  if (scope.chatTranscript === true || gatewayRead) tools.push('poise_changes')
  if (scope.managerClientId) tools.push(...MCP_MANAGER_TOOLS.map(tool => tool.name))
  if (scope.ownerClientId) tools.push(...MCP_OWNER_TOOLS.map(tool => tool.name))
  return tools
}

export const mcpWorkspaceAllowed = (scope: Pick<McpGrantScope, 'repository' | 'workspaceData'>): boolean =>
  scope.repository === undefined && scope.workspaceData === true

export const isMcpLoggingKind = (kind: unknown): kind is McpLoggingKind => (LOG_KINDS as readonly unknown[]).includes(kind)

export const mcpContentAllowed = (scope: Pick<McpGrantScope, 'repository' | 'contentData'>): boolean =>
  scope.repository === undefined && scope.contentData === true

export const isMcpContentKind = (kind: string): kind is 'document' | 'snippet' | 'memory' =>
  kind === 'document' || kind === 'snippet' || kind === 'memory'

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
    const { kind, id, chatId } = args as Record<string, unknown>
    if ((kind === 'chat-attachment' || kind === 'chat-diff') && Object.keys(args).length === 3 && isMcpRecordId(id) && isMcpRecordId(chatId)) {
      return { name: row.name, arguments: { kind, id, chatId } }
    }
    if (Object.keys(args).length === 2) {
      if ((kind === 'chat' || kind === 'timer') && isMcpRecordId(id)) return { name: row.name, arguments: { kind, id } }
      if (kind === 'workspace' && (MCP_WORKSPACE_VIEWS as readonly unknown[]).includes(id)) {
        return { name: row.name, arguments: { kind, id: id as McpWorkspaceView } }
      }
      if ((kind === 'call' || kind === 'invocation') && typeof id === 'string'
        && (CALL_ID.test(id) || (kind === 'invocation' && isMcpRecordId(id)))) {
        return { name: row.name, arguments: { kind, id: id.toLowerCase() } }
      }
      if (isMcpLoggingKind(kind) && typeof id === 'string' && DIAGNOSTIC_ID.test(id)) return { name: row.name, arguments: { kind, id } }
      if (kind === 'gateway' && (GATEWAY_VIEWS as readonly unknown[]).includes(id)) {
        return { name: row.name, arguments: { kind, id: id as McpGatewayView } }
      }
      if ((kind === 'document' || kind === 'snippet') && typeof id === 'string' && CONTENT_ID.test(id)) {
        return { name: row.name, arguments: { kind, id } }
      }
      if (kind === 'memory' && id === 'current') return { name: row.name, arguments: { kind, id } }
    }
    throw new Error('provide a supported snapshot name or exact record ID, plus the owning Chat ID for an artifact')
  }
  if (row.name === 'poise_list' || row.name === 'poise_changes') {
    const page = args as Record<string, unknown>
    const limit = page.limit ?? 5
    const cursor = page.cursor
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 10
      || (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 2048))) throw new Error('invalid Chat page selector')
    if (isMcpLoggingKind(page.kind)) {
      const repository = page.repository ?? null, afterWatermark = page.afterWatermark
      const fields = ['kind', 'repository', 'since', 'until', 'limit', 'cursor', ...(row.name === 'poise_changes' ? ['afterWatermark'] : [])]
      if (Object.keys(page).some(field => !fields.includes(field)) || (repository !== null && !isMcpRepository(repository))
        || (row.name === 'poise_changes' && (typeof afterWatermark !== 'string' || !afterWatermark || afterWatermark.length > 2048))) {
        throw new Error('provide a supported Logging selector and change watermark')
      }
      const since = pageTime(page.since), until = pageTime(page.until)
      if (since && until && since >= until) throw new Error('Logging requires since before until')
      return { name: row.name, arguments: { kind: page.kind, repository, since, until, limit: Number(limit),
        ...(typeof cursor === 'string' ? { cursor } : {}), ...(typeof afterWatermark === 'string' ? { afterWatermark } : {}) } }
    }
    if (row.name === 'poise_list' && (page.kind === 'document' || page.kind === 'call')) {
      if (Object.keys(page).some(key => !['kind', 'limit', 'cursor'].includes(key))) throw new Error('invalid retained record page selector')
      return { name: row.name, arguments: { kind: page.kind, limit: Number(limit), ...(typeof cursor === 'string' ? { cursor } : {}) } }
    }
    if (page.kind !== 'chat') throw new Error('invalid Chat page selector')
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
  if (Object.keys(work).some(key => !['repository', 'issue', 'label', 'limit', 'cursor', 'since', 'until'].includes(key))
    || !isMcpRepository(work.repository)) throw new Error('invalid repository or work selector')
  if (work.issue !== undefined) {
    if (!Number.isSafeInteger(work.issue) || Number(work.issue) < 1
      || Object.keys(work).some(key => !['repository', 'issue'].includes(key))) throw new Error('an exact issue accepts only repository and issue')
    return { name: row.name, arguments: { repository: work.repository, issue: Number(work.issue) } }
  }
  if (typeof work.label !== 'string' || !work.label.trim() || work.label.length > 100
    || (work.limit !== undefined && (!Number.isSafeInteger(work.limit) || Number(work.limit) < 1 || Number(work.limit) > 10))
    || (work.cursor !== undefined && (typeof work.cursor !== 'string' || !work.cursor || work.cursor.length > 2048))) throw new Error('a label page requires a label and a limit from 1 to 10')
  const { since, until } = work
  if ((since !== undefined && !workWindowTime(since)) || (until !== undefined && !workWindowTime(until))
    || (since && until && since >= until)) throw new Error('provide a valid UTC issue creation window')
  return { name: row.name, arguments: { repository: work.repository, label: work.label,
    limit: work.limit === undefined ? 5 : Number(work.limit), ...(typeof work.cursor === 'string' ? { cursor: work.cursor } : {}),
    ...(since ? { since } : {}), ...(until ? { until } : {}) } }
}
