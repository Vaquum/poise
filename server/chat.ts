import { prepareModelClis } from './provider-clis'
// Reads over the legacy `agent-interface --chat` history plus the two
// agent-interface bridges Chat still drives directly: --debate and
// --author-content. Sending a chat turn went away with the chat pane —
// every surface now runs its conversation as a Chat session
// (server/chat/) and this module only reads back what those calls
// recorded, so a session can import its subject's earlier conversation.
//
// History: agent-interface --logs already projects session_id, so
// filtering for {behavior:'chat', session_id:<id>} gives us the full
// transcript for one legacy conversation. Each entry's `prompt` is
// the user message; the agent's reply lives at
// `agent-interface --read-response <hash>`.

import { createHash } from 'node:crypto'
import { fetchAgentLogs, fetchAgentLogSnapshot, fetchAgentLogsSince, fetchAgentLogWatermark, scopedAgentLogs, type LogEntry } from './agent'
import { db } from './db'
import { HttpError } from './http'
import { claudeAuth } from './claude-auth'
import { MAX_PROCESS_ARG_BYTES, claudeSubscriptionEnvironment, runFile, spawnDetached } from './process'
import { agentInterfaceCwd, isClaudeModel, loadCatalog } from './models'

const AGENT_INTERFACE = 'agent-interface'

// Models are identities from Caller's catalog (server/models.ts);
// the composer offers every catalog row and the settings pane picks the default
// and fallback per place. Nothing here spells a model name.

function assertHttpArgumentSize(value: string, label: string): void {
  if (Buffer.byteLength(value, 'utf8') > MAX_PROCESS_ARG_BYTES) {
    throw new HttpError(413, `${label} exceeds ${MAX_PROCESS_ARG_BYTES} UTF-8 bytes`)
  }
}

// Markers the legacy send path wrapped around the user's message when a
// turn carried a context file. listChatHistory strips the wrapper so the
// import quotes what the person wrote, not the file-read directive.
const CONTEXT_PROMPT_PREFIX = '[Poise context file v1]'
const USER_MESSAGE_MARKER = "\n\n[User's message:]\n"

export interface ChatLogEntry {
  id: string
  session_id: string
  prompt: string
  started_at: string
  status: string
  response: string | null
  error: string
  behavior: 'chat' | 'author_content'
  content_slug?: string
}

// Slug used for editor articles produced by /content in chat. The
// full SHA-256 digest makes the mapping deterministic without relying on a
// collision-prone call-id prefix.
export function contentSlugForCallId(callId: string): string {
  return 'content-' + createHash('sha256').update(String(callId), 'utf8').digest('hex')
}

// Only a completed durable job makes an authored article attributable and
// linkable. A filename (including a legacy short-prefix path) is never enough.
export async function existingContentSlugForCallId(callId: string): Promise<string | null> {
  const mapped = db.prepare(`
    SELECT slug FROM content_jobs WHERE call_id = ? AND status = 'completed'
  `).pluck().get(callId)
  return typeof mapped === 'string' ? mapped : null
}

export function mergeAuthorContentJobState(row: ChatLogEntry): ChatLogEntry {
  if (row.behavior !== 'author_content') return row
  const job = db.prepare(
    'SELECT status, slug, error FROM content_jobs WHERE call_id = ?',
  ).get(row.id) as { status: string, slug: string, error: string | null } | undefined
  if (!job) {
    // A completed agent response is not linkable until durable publication is
    // recorded. Periodic recovery will create the missing job if launch
    // discovery timed out or the server crashed before enqueue.
    return {
      ...row,
      status: row.status === 'failed' ? 'failed' : 'pending',
      content_slug: undefined,
    }
  }
  return {
    ...row,
    status: job.status,
    error: job.status === 'failed' ? String(job.error || row.error || 'failed') : row.error,
    content_slug: job.status === 'completed' ? job.slug : undefined,
  }
}

export async function listChatHistory(sessionId: string): Promise<ChatLogEntry[]> {
  if (!sessionId) return []
  const snapshot = await fetchAgentLogSnapshot()
  // A review row has no session ID. Scope both transcript behaviors so its
  // missing session cannot make unrelated review corruption block every chat.
  scopedAgentLogs(snapshot, { sessionId, behavior: 'chat' })
  const all = scopedAgentLogs(snapshot, { sessionId, behavior: 'author_content' })
  // The snapshot already returns newest-first; flip back
  // for chat (oldest-first reads top-to-bottom like a transcript).
  // We include both `chat` and `author_content` behaviors — author_content
  // calls now carry session_id (agent-interface --author-content
  // --session-id ID) so they belong in the transcript too. The import
  // quotes both as plain turns.
  const rows = all
    .filter((e: any) =>
      (e.behavior === 'chat' || e.behavior === 'author_content')
      && e.session_id === sessionId)
    .reverse() as ChatLogEntry[]
  return rows.map((row) => {
    const marker = row.behavior === 'chat' && row.prompt.startsWith(CONTEXT_PROMPT_PREFIX)
      ? row.prompt.indexOf(USER_MESSAGE_MARKER)
      : -1
    const displayRow = marker >= 0
      ? { ...row, prompt: row.prompt.slice(marker + USER_MESSAGE_MARKER.length) }
      : row
    return mergeAuthorContentJobState(displayRow)
  })
}

// ── /consensus → agent-interface --debate ─────────────────────────────
// Synchronous wrapper around the local `agent-interface --debate`
// runner. The CLI writes a row to agent-interface's calls log when it
// fires, so the run appears in Swarm alongside chat/pr_review/etc.
// Returns the parsed `{synthesis, rounds}` payload verbatim so /api/debate
// can record the synthesis as the Chat session's agent turn.
const DEBATE_MAX_ROUNDS = 8
// agent-interface --debate already caps each call at 60 min internally
// (debate.py: timeout_s=3600 default). Poise's outer timeout is set
// slightly higher (65 min) so the CLI gets to write `finish(...)`
// before we'd ever SIGTERM it — otherwise the row stays stuck at
// `running` in agent-interface's calls log and Swarm can't tell the
// difference between "still going" and "Poise killed it."
const DEBATE_TIMEOUT_MS = 65 * 60_000
const DEBATE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export interface DebateResult { synthesis: string; rounds: any[] }
export async function runDebate(topic: string, rounds: number = 1): Promise<DebateResult> {
  const t = String(topic || '').trim()
  if (!t) throw new Error('topic is required')
  assertHttpArgumentSize(t, 'debate topic')
  const catalog = await loadCatalog()
  const models = [catalog.behaviors.debate_moderator, ...catalog.debate_participants]
  if (models.some((model) => isClaudeModel(catalog, model))) await claudeAuth.requireReady()
  const modelCliEnv = await prepareModelClis(catalog, models)
  const r = Math.min(Math.max(Number.isFinite(rounds) ? rounds : 1, 1), DEBATE_MAX_ROUNDS)
  let stdout: string
  try {
    ({ stdout } = await runFile(
      AGENT_INTERFACE,
      ['--debate', t, '--rounds', String(r)],
      {
        cwd: agentInterfaceCwd(),
        timeoutMs: DEBATE_TIMEOUT_MS,
        maxOutputBytes: DEBATE_MAX_OUTPUT_BYTES,
        env: { ...claudeSubscriptionEnvironment(), ...modelCliEnv },
      },
    ))
  } catch (err: any) {
    // Unattributable across five providers: a debate failure must not move
    // the Claude gate, whose observers guarantee Claude attribution.
    const detail = String(err?.stderr || err?.stdout || '').trim()
    if (detail) throw new Error(detail)
    throw err
  }
  try {
    // The CLI wraps the debate output as
    //   { id, model, rounds, response: "<json-string>" }
    // where `response` is itself JSON containing {synthesis, rounds}.
    // Unwrap one level to get the actual payload.
    const wrapper = JSON.parse(stdout.trim()) as { response?: string }
    if (typeof wrapper.response !== 'string') {
      throw new Error('debate output missing wrapper.response')
    }
    const inner = JSON.parse(wrapper.response) as Partial<DebateResult>
    if (typeof inner.synthesis !== 'string' || !Array.isArray(inner.rounds)) {
      throw new Error('debate inner payload missing synthesis or rounds')
    }
    return { synthesis: inner.synthesis, rounds: inner.rounds }
  } catch (err) {
    throw new Error(`debate JSON parse failed: ${(err as Error).message}`)
  }
}

// ── /content slash-command bridge ─────────────────────────────────────
// Spawns `agent-interface --author-content TOPIC` (no --pwd; the
// behavior isn't pinned to a repo). Because the spawn is detached
// fire-and-forget, we briefly poll --logs immediately after to find
// the freshly-minted call row and grab its id; the front-end then
// polls /api/chat-content/status?call_id=… for completion.
//
// `--session-id` ties the author_content log row back to this chat, so
// history can surface the authored turn and later messages can inject the
// article's current editor contents.

export const AUTHOR_CONTENT_TOPIC_MAX_BYTES = 64 * 1024

export function normalizeAuthorContentTopic(topic: string): string {
  const trimmed = String(topic || '').trim()
  if (!trimmed) throw new HttpError(400, 'topic is required')
  if (Buffer.byteLength(trimmed, 'utf8') > AUTHOR_CONTENT_TOPIC_MAX_BYTES) {
    throw new HttpError(413, `topic exceeds ${AUTHOR_CONTENT_TOPIC_MAX_BYTES} UTF-8 bytes`)
  }
  return trimmed
}

export abstract class AuthorContentDiscoveryPendingError extends Error {
  abstract readonly code: string
}

export class AuthorContentDiscoveryTimeoutError extends AuthorContentDiscoveryPendingError {
  readonly code = 'AUTHOR_CONTENT_DISCOVERY_TIMEOUT'

  constructor(message = 'agent-interface --author-content did not register a new call within 3s') {
    super(message)
    this.name = 'AuthorContentDiscoveryTimeoutError'
  }
}

export class AuthorContentDiscoveryUnavailableError extends AuthorContentDiscoveryPendingError {
  readonly code = 'AUTHOR_CONTENT_DISCOVERY_UNAVAILABLE'

  constructor(cause: unknown) {
    super(
      'agent-interface log discovery failed after author-content launch; correlation remains pending',
      { cause },
    )
    this.name = 'AuthorContentDiscoveryUnavailableError'
  }
}

export function isAuthorContentDiscoveryPendingError(
  error: unknown,
): error is AuthorContentDiscoveryPendingError {
  const code = String((error as { code?: unknown } | null)?.code || '')
  return error instanceof AuthorContentDiscoveryPendingError
    || code === 'AUTHOR_CONTENT_DISCOVERY_TIMEOUT'
    || code === 'AUTHOR_CONTENT_DISCOVERY_UNAVAILABLE'
}

export async function startAuthorContent(topic: string, sessionId: string): Promise<{ call_id: string, started_at: string }> {
  // Enforce the portable one-argument budget before any CLI work. Linux's
  // common per-string argv ceiling is 128 KiB; 64 KiB leaves headroom for
  // encoding and platform variance.
  const trimmed = normalizeAuthorContentTopic(topic)
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) throw new HttpError(400, 'session is required')
  assertHttpArgumentSize(normalizedSessionId, 'session')
  const catalog = await loadCatalog()
  const claude = isClaudeModel(catalog, catalog.behaviors.author_content)
  if (claude) await claudeAuth.requireReady()
  const modelCliEnv = await prepareModelClis(catalog, [catalog.behaviors.author_content])
  // Capture the insertion boundary before launch; an indexed session query
  // then sees new candidates even if they finish before the first poll.
  const before = await fetchAgentLogWatermark()

  // --session-id ties this call to the chat session, so the chat
  // history can include this turn (listChatHistory filters by
  // session_id across both behaviors).
  if (claude) await claudeAuth.requireReady()
  await spawnDetached(
    AGENT_INTERFACE,
    ['--author-content', trimmed, '--session-id', normalizedSessionId],
    {
      cwd: agentInterfaceCwd(),
      env: { ...claudeSubscriptionEnvironment(), ...modelCliEnv },
      onExit: (result) => { claudeAuth.observeProcessFailure(result) },
    },
  )

  const deadline = Date.now() + 3000
  let ambiguous = false
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    let fresh: LogEntry[]
    try {
      const snapshot = await fetchAgentLogsSince(before,
        { session: normalizedSessionId, behavior: 'author_content', prompt: trimmed }, { fresh: true })
      fresh = scopedAgentLogs(snapshot, { sessionId: normalizedSessionId, behavior: 'author_content' }).filter((entry) => {
        const id = String(entry.id || '')
        return entry.behavior === 'author_content'
          && entry.session_id === normalizedSessionId
          && String(entry.prompt || '').trim() === trimmed
          && /^[0-9a-fA-F]{32}$/.test(id)
      })
    } catch (error) {
      // spawnDetached has already observed the child's spawn event. A log
      // lookup failure cannot prove that no call exists, so durable intent
      // recovery must retain ownership of this launch.
      throw new AuthorContentDiscoveryUnavailableError(error)
    }
    if (fresh.length === 1) {
      return { call_id: String(fresh[0].id), started_at: String(fresh[0].started_at || '') }
    }
    if (fresh.length > 1) ambiguous = true
  }
  throw new AuthorContentDiscoveryTimeoutError(ambiguous
    ? 'multiple matching author-content calls registered; correlation remains pending'
    : undefined)
}

export async function authorContentStatus(callId: string): Promise<{
  status: string,
  response_hash?: string,
  body?: string,
  error?: string,
}> {
  const all = await fetchAgentLogs({ identity: { id: callId } })
  const row = all.find((e: any) => e.id === callId)
  if (!row) return { status: 'unknown' }
  return {
    status: String(row.status || ''),
    response_hash: row.response ? String(row.response) : undefined,
    error: row.error ? String(row.error) : undefined,
  }
}
