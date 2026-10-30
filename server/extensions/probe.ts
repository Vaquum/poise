// "Check now": connect to a server the way an agent would, list its tools,
// disconnect. A local server runs once in a scratch directory with the same
// command and environment a chat would give it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport as McpTransport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { resolveServer } from './delivery'
import { addEvent, eraseSecret, markOAuth, redactSecrets, setStatus, storedServer } from './store'
import type { ResolvedServer, ServerStatus, ToolInfo } from './types'

// npx and uvx download the package on first use.
const LOCAL_TIMEOUT_MS = 120_000
const REMOTE_TIMEOUT_MS = 30_000
const MAX_TOOLS = 300
const running = new Map<string, Promise<ServerStatus>>()

function status401(error: unknown): boolean {
  return (error instanceof StreamableHTTPError || error instanceof SseError) && error.code === 401
}

/** Whether the server names an OAuth authorization server (RFC 9728, or the
 *  MCP spec's fallback to its own origin): a 401 alone may want a static token. */
async function offersOAuth(url: string): Promise<boolean> {
  try { return !!(await discoverOAuthServerInfo(url)).authorizationServerMetadata } catch { return false }
}

async function listTools(server: ResolvedServer, cwd: string, stderr: string[], signal: AbortSignal): Promise<ToolInfo[]> {
  let transport: McpTransport
  if (server.transport === 'stdio') {
    const stdio = new StdioClientTransport({ command: server.command!, args: server.args ?? [], env: { ...getDefaultEnvironment(), ...(server.env ?? {}) }, cwd, stderr: 'pipe' })
    const sink = new PassThrough()
    sink.on('data', (chunk: Buffer) => { stderr.push(chunk.toString('utf8')); if (stderr.length > 40) stderr.shift() })
    stdio.stderr?.pipe(sink)
    transport = stdio
  } else {
    const requestInit = { headers: server.headers ?? {} }
    transport = server.transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(server.url!), { requestInit })
      : new SSEClientTransport(new URL(server.url!), { requestInit, eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...(server.headers ?? {}) } }) } })
  }
  const client = new Client({ name: 'poise', version: '1.0.0' })
  // Closing ends the connection and a local server's process.
  const close = () => { void client.close().catch(() => undefined) }
  signal.addEventListener('abort', close, { once: true })
  try {
    await client.connect(transport)
    const tools: ToolInfo[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : {})
      for (const tool of page.tools) tools.push({ name: tool.name, ...(tool.description ? { description: tool.description.slice(0, 300) } : {}) })
      cursor = page.nextCursor
    } while (cursor && tools.length < MAX_TOOLS)
    return tools
  } finally {
    signal.removeEventListener('abort', close)
    await client.close().catch(() => undefined) // the check's result stands either way
  }
}

async function run(id: string): Promise<ServerStatus> {
  const stored = storedServer(id)
  setStatus(id, { ...stored.status, state: 'checking' })
  const done = (status: ServerStatus): ServerStatus => {
    setStatus(id, status)
    addEvent(id, status.state === 'connected' ? 'info' : status.state === 'signin' ? 'warning' : 'error',
      status.state === 'connected' ? `Checked: ${status.toolCount} tool${status.toolCount === 1 ? '' : 's'}` : status.state === 'signin' ? 'Checked: needs a sign-in' : `Check failed: ${status.error}`)
    return status
  }
  const checkedAt = () => new Date().toISOString()
  const resolution = await resolveServer(stored)
  if (!('server' in resolution)) return done(resolution.signin ? { state: 'signin', checkedAt: checkedAt() } : { state: 'failed', checkedAt: checkedAt(), error: resolution.problem })
  const server = resolution.server
  const stderr: string[] = []
  const cwd = await mkdtemp(join(tmpdir(), 'poise-extension-'))
  const timeout = server.transport === 'stdio' ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeout)
  try {
    const tools = await listTools(server, cwd, stderr, abort.signal)
    return done({ state: 'connected', checkedAt: checkedAt(), tools, toolCount: tools.length })
  } catch (caught) {
    const error = abort.signal.aborted ? new Error(`no answer within ${timeout / 1000} s`) : caught
    if (status401(error)) {
      const authorized = Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
      if (stored.spec.auth === 'oauth') { eraseSecret(id, 'oauth:tokens'); return done({ state: 'signin', checkedAt: checkedAt() }) }
      if (!authorized && (stored.spec.headers ?? []).length === 0) {
        if (await offersOAuth(server.url!)) { markOAuth(id); return done({ state: 'signin', checkedAt: checkedAt() }) }
        return done({ state: 'failed', checkedAt: checkedAt(), error: 'The server needs credentials (401) and offers no OAuth sign-in. Add its token or headers under Edit.' })
      }
      return done({ state: 'failed', checkedAt: checkedAt(), error: 'The server refused the credentials (401).' })
    }
    const tail = stderr.join('').trim().split('\n').slice(-3).join(' | ')
    const message = `${error instanceof Error ? error.message : String(error)}${tail ? ` — ${tail}` : ''}`
    return done({ state: 'failed', checkedAt: checkedAt(), error: redactSecrets(message).slice(0, 600) })
  } finally {
    clearTimeout(timer)
    await rm(cwd, { recursive: true, force: true })
  }
}

/** Check one server; a check already running is shared. */
export function checkServer(id: string): Promise<ServerStatus> {
  const current = running.get(id)
  if (current) return current
  const check = run(id).finally(() => running.delete(id))
  running.set(id, check)
  return check
}
