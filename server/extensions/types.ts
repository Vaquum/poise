// Extensions: the MCP servers Poise chats can use. Shared by the server and
// the Extensions view, so this module holds plain data and pure functions
// only. The per-agent shapes below are exactly what the adapters send; the
// view renders them with secrets masked as its "What chats receive" preview.

import type { AgentId } from '../chat/protocol'

export type Transport = 'stdio' | 'http' | 'sse'
export type AuthKind = 'none' | 'oauth'

/** An environment variable or an HTTP header. A secret's value is write-only:
 *  views carry `set` instead of `value`. */
export interface Field { name: string, value?: string, secret: boolean, set?: boolean }

export interface RegistryRef { name: string, version: string, option: string, websiteUrl?: string, repositoryUrl?: string }

export interface ServerSpec {
  /** What agents call the server (`mcp__<name>__tool`); unique. */
  name: string
  title: string
  source: 'directory' | 'custom'
  transport: Transport
  command?: string
  args?: string[]
  env?: Field[]
  url?: string
  headers?: Field[]
  auth: AuthKind
  registry?: RegistryRef
}

/** On or off per workspace; `default` covers workspaces without their own switch. */
export interface Enablement { default: boolean, workspaces: Record<string, boolean> }

export type ServerState = 'unknown' | 'checking' | 'connected' | 'signin' | 'failed'
export interface ToolInfo { name: string, description?: string }
export interface ServerStatus { state: ServerState, checkedAt?: string, error?: string, tools?: ToolInfo[], toolCount?: number }
export interface ServerEvent { at: string, level: 'info' | 'warning' | 'error', text: string }

export interface ServerView extends ServerSpec {
  id: string
  enabled: Enablement
  status: ServerStatus
  signedIn: boolean
  createdAt: string
  updatedAt: string
}

export interface Workspace { id: string, label: string }

/** A value the person supplies when adding a directory server. `key` is how
 *  the install request names it: `env:NAME`, `header:Name:var`, `url:var`
 *  or `arg:N`. */
export interface DirectoryInput { key: string, label: string, description?: string, required: boolean, secret: boolean, default?: string, choices?: string[] }

/** One way to run a directory server: its remote endpoint or its package. */
export interface InstallOption {
  id: string
  kind: 'remote' | 'package'
  transport: Transport
  /** The endpoint, or the command line Poise runs; placeholders stay visible. */
  summary: string
  inputs: DirectoryInput[]
  /** Why Poise cannot add this option as it stands. */
  unsupported?: string
  /** Remote: the URL, with `{variable}` placeholders for `url:` inputs. */
  url?: string
  /** Remote: each header's template (`{variable}` → `header:Name:variable`), or none when the whole value is an input. */
  headers?: Array<{ name: string, template?: string, secret: boolean }>
  command?: string
  /** Package: literal arguments, or the input that supplies one. */
  args?: Array<string | { input: string }>
}

export interface DirectoryEntry {
  /** Registry name, like `io.github.github/github-mcp-server`. */
  name: string
  title: string
  description: string
  version: string
  /** The namespace owner the registry verified, like `github.com/github`. */
  publisher: string
  websiteUrl?: string
  repositoryUrl?: string
  icon?: string
  options: InstallOption[]
}

export interface DirectoryStatus { count: number, syncing: boolean, completedAt?: string, error?: string }

/** A server as an adapter receives it, every value resolved. Server-side only:
 *  it carries secrets. */
export interface ResolvedServer {
  id: string
  name: string
  title: string
  transport: Transport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export const LOCAL_WORKSPACE = 'local'
export const LOCAL_WORKSPACE_LABEL = 'Poise · local'
export const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const MAX_VALUE = 8192

/** Chats of one repository share a workspace; chats without one share `local`. */
export function workspaceOf(record: { repo: string }): string {
  return record.repo || LOCAL_WORKSPACE
}

export function isWorkspace(value: unknown): value is string {
  return value === LOCAL_WORKSPACE || (typeof value === 'string' && REPO.test(value))
}

export function workspaceLabel(id: string): string {
  return id === LOCAL_WORKSPACE ? LOCAL_WORKSPACE_LABEL : id
}

export function isEnabledIn(enabled: Enablement, workspace: string): boolean {
  return enabled.workspaces[workspace] ?? enabled.default
}

/** A server name derived from a title: lowercase, hyphenated, within the limit. */
export function nameFrom(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'server'
}

function text(value: unknown, what: string, max = MAX_VALUE): string {
  if (typeof value !== 'string') throw new Error(`${what} must be text.`)
  if (value.length > max) throw new Error(`${what} is longer than ${max} characters.`)
  if (/[\r\n\0]/.test(value)) throw new Error(`${what} must be a single line.`)
  return value
}

function fields(value: unknown, kind: 'env' | 'header'): Field[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${kind === 'env' ? 'Environment' : 'Headers'} must be a list of at most 64 entries.`)
  const seen = new Set<string>()
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Each ${kind === 'env' ? 'variable' : 'header'} needs a name.`)
    const entry = raw as Record<string, unknown>
    const name = text(entry.name, kind === 'env' ? 'A variable name' : 'A header name', 128).trim()
    if (!(kind === 'env' ? ENV_NAME : HEADER_NAME).test(name)) throw new Error(`${name || 'An empty name'} is not a valid ${kind === 'env' ? 'environment variable' : 'header'} name.`)
    const key = kind === 'env' ? name : name.toLowerCase()
    if (seen.has(key)) throw new Error(`${name} is listed twice.`)
    seen.add(key)
    const secret = entry.secret === true
    return secret ? { name, secret } : { name, secret, value: text(entry.value ?? '', `The value of ${name}`) }
  })
}

/** Validate a server definition from the browser or the directory. Secret
 *  values are not part of it; they travel separately. */
export function validateSpec(input: unknown): ServerSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A server definition must be an object.')
  const raw = input as Record<string, unknown>
  const name = text(raw.name, 'The name', 48).trim()
  if (!SERVER_NAME.test(name)) throw new Error('Use a name of lowercase letters, digits and hyphens, starting with a letter or digit (at most 48).')
  const title = text(raw.title ?? name, 'The title', 120).trim() || name
  const source = raw.source === 'directory' ? 'directory' : raw.source === 'custom' ? 'custom' : null
  if (!source) throw new Error('A server comes from the directory or is custom.')
  const transport = raw.transport
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') throw new Error('Choose a local command, Streamable HTTP or SSE.')
  const auth: AuthKind = raw.auth === 'oauth' ? 'oauth' : 'none'
  const spec: ServerSpec = { name, title, source, transport, auth }
  if (transport === 'stdio') {
    const command = text(raw.command, 'The command', 1024).trim()
    if (!command) throw new Error('Enter the command that starts the server.')
    if (!Array.isArray(raw.args ?? []) || ((raw.args as unknown[] | undefined)?.length ?? 0) > 128) throw new Error('Arguments must be a list of at most 128 entries.')
    spec.command = command
    spec.args = ((raw.args as unknown[] | undefined) ?? []).map((arg, index) => text(arg, `Argument ${index + 1}`))
    spec.env = fields(raw.env, 'env')
    if (auth === 'oauth') throw new Error('OAuth sign-in is for remote servers.')
  } else {
    const url = text(raw.url, 'The URL', 2048).trim()
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('Enter the server URL, like https://example.com/mcp.') }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('The URL must start with https:// or http://.')
    if (parsed.username || parsed.password) throw new Error('Put credentials in a header or a token, not in the URL.')
    spec.url = parsed.href
    spec.headers = fields(raw.headers, 'header')
  }
  if (source === 'directory') {
    const registry = raw.registry as Record<string, unknown> | undefined
    if (!registry || typeof registry !== 'object') throw new Error('A directory server names its registry entry.')
    spec.registry = {
      name: text(registry.name, 'The registry name', 256),
      version: text(registry.version, 'The registry version', 128),
      option: text(registry.option, 'The install option', 64),
      ...(typeof registry.websiteUrl === 'string' && /^https:\/\//i.test(registry.websiteUrl) ? { websiteUrl: registry.websiteUrl } : {}),
      ...(typeof registry.repositoryUrl === 'string' && /^https:\/\//i.test(registry.repositoryUrl) ? { repositoryUrl: registry.repositoryUrl } : {}),
    }
  }
  return spec
}

/** The secret slots a definition names; each must have a stored value. */
export function secretSlots(spec: ServerSpec): string[] {
  return [
    ...(spec.env ?? []).filter((field) => field.secret).map((field) => `env:${field.name}`),
    ...(spec.headers ?? []).filter((field) => field.secret).map((field) => `header:${field.name}`),
  ]
}

// ── What each agent receives ───────────────────────────────────────────

export interface Skipped { name: string, reason: string }

type Strings = Record<string, string>
const some = (record?: Strings) => record && Object.keys(record).length ? record : undefined

export type ClaudeServer = { type: 'stdio', command: string, args: string[], env?: Strings } | { type: 'http' | 'sse', url: string, headers?: Strings }
export type CodexServer = { command: string, args: string[], env?: Strings, startup_timeout_sec: number } | { url: string, http_headers?: Strings }
export type AcpServer = { name: string, command: string, args: string[], env: Array<{ name: string, value: string }> } | { type: 'http' | 'sse', name: string, url: string, headers: Array<{ name: string, value: string }> }
export type MuseServer = { transport: 'stdio', command: string, args: string[], env?: Strings } | { transport: 'streamableHttp', url: string, headers?: Strings }

/** Claude Agent SDK `setMcpServers()` (sent over the control channel, never argv). */
export function forClaude(servers: readonly ResolvedServer[]): Record<string, ClaudeServer> {
  return Object.fromEntries(servers.map((server): [string, ClaudeServer] => [server.name, server.transport === 'stdio'
    ? { type: 'stdio', command: server.command!, args: server.args ?? [], ...(some(server.env) ? { env: server.env } : {}) }
    : { type: server.transport, url: server.url!, ...(some(server.headers) ? { headers: server.headers } : {}) }]))
}

/** Codex app-server `config` overrides: one dotted key per server, so the
 *  person's own `mcp_servers` in config.toml are left alone. */
export function forCodex(servers: readonly ResolvedServer[]): { config: Record<string, CodexServer>, skipped: Skipped[] } {
  const config: Record<string, CodexServer> = {}
  const skipped: Skipped[] = []
  for (const server of servers) {
    if (server.transport === 'sse') { skipped.push({ name: server.title, reason: 'Codex takes local commands and Streamable HTTP servers, not SSE' }); continue }
    config[`mcp_servers.${server.name}`] = server.transport === 'stdio'
      // npx and uvx fetch the package on first use; Codex's default is 10 s.
      ? { command: server.command!, args: server.args ?? [], ...(some(server.env) ? { env: server.env } : {}), startup_timeout_sec: 60 }
      : { url: server.url!, ...(some(server.headers) ? { http_headers: server.headers } : {}) }
  }
  return { config, skipped }
}

/** ACP `session/new` and `session/resume` `mcpServers` (Grok). */
export function forAcp(servers: readonly ResolvedServer[], capabilities: { http?: boolean, sse?: boolean }): { mcpServers: AcpServer[], skipped: Skipped[] } {
  const mcpServers: AcpServer[] = []
  const skipped: Skipped[] = []
  const pairs = (record?: Strings) => Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))
  for (const server of servers) {
    if (server.transport === 'stdio') { mcpServers.push({ name: server.name, command: server.command!, args: server.args ?? [], env: pairs(server.env) }); continue }
    if (!capabilities[server.transport]) { skipped.push({ name: server.title, reason: `this Grok does not accept ${server.transport === 'sse' ? 'SSE' : 'HTTP'} MCP servers` }); continue }
    mcpServers.push({ type: server.transport, name: server.name, url: server.url!, headers: pairs(server.headers) })
  }
  return { mcpServers, skipped }
}

/** Muse MSP `session/start` and `session/resume` `config.mcpServers`. */
export function forMuse(servers: readonly ResolvedServer[]): { mcpServers: Record<string, MuseServer>, skipped: Skipped[] } {
  const mcpServers: Record<string, MuseServer> = {}
  const skipped: Skipped[] = []
  for (const server of servers) {
    if (server.transport === 'sse') { skipped.push({ name: server.title, reason: 'Muse takes local commands and Streamable HTTP servers, not SSE' }); continue }
    mcpServers[server.name] = server.transport === 'stdio'
      ? { transport: 'stdio', command: server.command!, args: server.args ?? [], ...(some(server.env) ? { env: server.env } : {}) }
      : { transport: 'streamableHttp', url: server.url!, ...(some(server.headers) ? { headers: server.headers } : {}) }
  }
  return { mcpServers, skipped }
}

/** What a chat shows for a server its agent could not take. */
export function skippedNotice(skipped: Skipped): string {
  return `Extensions: ${skipped.name} is not available in this chat: ${skipped.reason}.`
}

export const AGENT_LABEL: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex', muse: 'Muse', grok: 'Grok' }

/** Which agents take a server of this transport (Grok as its ACP advertises today). */
export function reaches(transport: Transport): Array<{ agent: AgentId, ok: boolean, reason?: string }> {
  return (['claude', 'codex', 'muse', 'grok'] as const).map((agent) =>
    transport === 'sse' && (agent === 'codex' || agent === 'muse')
      ? { agent, ok: false, reason: `${AGENT_LABEL[agent]} takes Streamable HTTP, not SSE` }
      : { agent, ok: true })
}

// ── Pasted mcpServers blocks (Claude Desktop, Cursor, VS Code) ─────────

const SECRET_NAME = /authorization|cookie|password|passwd|secret|credential|token|api.?key|private.?key|^auth$/i
const SECRET_VALUE = /^(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|sntrys|glpat|lin_api)[-_]|^Bearer\s+\S{8,}/i

export interface ImportedServer { spec: ServerSpec, secrets: Record<string, string> }

/** Read a pasted `{ "mcpServers": { … } }` (or `servers`) block. Values whose
 *  names or shapes look like credentials become secrets. */
export function parseImport(json: string): ImportedServer[] {
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch (error) { throw new Error(`That is not JSON: ${(error as Error).message}`) }
  const block = parsed && typeof parsed === 'object' ? ((parsed as Record<string, unknown>).mcpServers ?? (parsed as Record<string, unknown>).servers) : undefined
  if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('No mcpServers block found.')
  const entries = Object.entries(block as Record<string, unknown>)
  if (!entries.length) throw new Error('The mcpServers block is empty.')
  return entries.map(([key, value]) => {
    if (!value || typeof value !== 'object') throw new Error(`${key} is not a server definition.`)
    const entry = value as Record<string, unknown>
    const secrets: Record<string, string> = {}
    const toFields = (record: unknown, kind: 'env' | 'header') => Object.entries((record && typeof record === 'object' ? record : {}) as Record<string, unknown>).map(([name, raw]) => {
      const value = String(raw)
      if (SECRET_NAME.test(name) || SECRET_VALUE.test(value)) { secrets[`${kind}:${name}`] = value; return { name, secret: true } }
      return { name, value, secret: false }
    })
    const remote = typeof entry.url === 'string' || typeof entry.serverUrl === 'string'
    const type = String(entry.type ?? entry.transport ?? '')
    const spec = validateSpec({
      name: nameFrom(key), title: key, source: 'custom',
      transport: remote ? (type === 'sse' ? 'sse' : 'http') : 'stdio',
      ...(remote ? { url: entry.url ?? entry.serverUrl, headers: toFields(entry.headers, 'header') } : { command: entry.command, args: entry.args ?? [], env: toFields(entry.env, 'env') }),
    })
    return { spec, secrets }
  })
}
