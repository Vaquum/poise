import type { ChatSwitches } from '../../../src/chat-switches'
import { expect, type Page, type WebSocketRoute } from '@playwright/test'
import type { ChatEnvelope, ChatEvent, ClientFrame, SessionRecord, SwitchboardState } from '../../../server/chat/protocol'

// The Chat view against a scripted server: REST through page.route, the
// socket through page.routeWebSocket. The mock says hello, acks every frame
// (unless a test holds the ack back), and lets a test push transcript events.

const NOW = '2026-09-18T09:00:00.000Z'

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1', agent: 'claude', model: 'opus-5-max', modelId: 'claude-opus-5', effort: 'max',
    repo: 'acme/app', checkout: '/tmp/app', branch: { name: 'chat/fix-login', origin: 'new', provisional: true },
    title: 'Fix the login bug', createdAt: NOW, updatedAt: NOW, status: 'idle',
    capabilities: { steer: true, fork: true, thought: true, plan: true, commands: true, modes: true, permissions: true, questions: true, resume: true, images: false },
    mode: 'default', modes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }],
    commands: [{ name: 'review', description: 'Review the branch' }],
    efforts: ['max', 'xhigh'], lastSeq: 0, pendingRequests: [], instance: 'poise-dev:test',
    workspace: { currentBranch: 'chat/fix-login', onBranch: true, dirty: false, dirtyFiles: 0, checkedAt: NOW },
    ...overrides,
  }
}

const AGENTS: { agents: unknown[], defaults: { model: string, fallback: string, fallbackReason?: string }, settings: unknown } = {
  agents: [
    { id: 'claude', label: 'Claude Code', available: true, models: [{ identity: 'opus-5-max', selector: 'claude-opus-5', effort: 'max' }, { identity: 'opus-5-xhigh', selector: 'claude-opus-5', effort: 'xhigh' }, { identity: 'opus-5-high', selector: 'claude-opus-5', effort: 'high' }], efforts: ['max', 'xhigh', 'high'] },
    { id: 'codex', label: 'Codex', available: true, models: [{ identity: 'gpt-6-astra-ultra', selector: 'gpt-6-astra', effort: 'ultra' }, { identity: 'gpt-6-astra-max', selector: 'gpt-6-astra', effort: 'max' }], efforts: ['ultra', 'max'] },
    { id: 'grok', label: 'Grok Build', available: false, reason: 'not signed in', models: [{ identity: 'grok-4.6-xhigh', selector: 'grok-4.6', effort: 'xhigh' }], efforts: ['xhigh'] },
    { id: 'antigravity', label: 'Antigravity (Google)', available: false, reason: 'No interactive permission/question channel', models: [{ identity: 'gemini-3.8-flash-high', selector: 'gemini-3.8-flash', effort: 'high' }, { identity: 'gemini-3.8-flash-medium', selector: 'gemini-3.8-flash', effort: 'medium' }], efforts: ['high', 'medium'] },
    { id: 'muse', label: 'Muse', available: true, models: [{ identity: 'muse-spark-1.3-contributor-max', selector: 'muse-spark-1.3-contributor', effort: 'max' }, { identity: 'muse-spark-1.3-contributor-xhigh', selector: 'muse-spark-1.3-contributor', effort: 'xhigh' }], efforts: ['max', 'xhigh'] },
  ],
  defaults: { model: 'opus-5-max', fallback: 'gpt-6-astra-ultra' },
  settings: { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4 },
}

/** The Switchboard as the server reports it; never started unless a test says so. */
function switchboardState(overrides: Partial<SwitchboardState> = {}): SwitchboardState {
  return { revision: 1, status: 'off', sessionId: null, sessionStatus: null, model: 'muse-spark-1.3-contributor-max', error: null,
    checking: false, lastCheckAt: null, lastCheckTokens: null, nextCheckAt: null, chats: 0, items: [], ...overrides }
}

interface ServerState {
  serverStartedAt?: string
  switchboard?: SwitchboardState
  switchboardStart?: () => { status: number, json: unknown }
  switchboardAnswer?: (id: number, body: { optionId: string } | { text: string }) => SwitchboardState
  switchboardExplain?: (id: number) => SwitchboardState
  switches?: ChatSwitches
  sessions: SessionRecord[]
  history: Record<string, ChatEnvelope[]>
  calls: { method: string, path: string, body: unknown }[]
  settings: Record<string, unknown>
  agents?: typeof AGENTS
  /** Holds the POST /api/chat/sessions answer until released. */
  createDelay?: () => Promise<void>
}

async function installRoutes(page: Page, state: ServerState): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const method = req.method()
    const body = method === 'POST' || method === 'PATCH' ? (req.postDataJSON?.() ?? null) : null
    if (path.startsWith('/api/chat') || path === '/api/settings' || path === '/api/repos') state.calls.push({ method, path, body })
    if (path === '/api/settings') {
      if (method === 'POST') state.settings = { ...state.settings, ...(body as object) }
      await route.fulfill({ json: state.settings })
      return
    }
    if (path === '/api/chat/switchboard' || path.startsWith('/api/chat/switchboard/')) {
      const board = state.switchboard ?? switchboardState()
      const item = /\/items\/(\d+)\/(answer|explain)$/.exec(path)
      if (path.endsWith('/start') && state.switchboardStart) { const answer = state.switchboardStart(); await route.fulfill({ status: answer.status, json: answer.json }); return }
      if (item?.[2] === 'answer' && state.switchboardAnswer) { await route.fulfill({ json: state.switchboardAnswer(Number(item[1]), body as { optionId: string } | { text: string }) }); return }
      if (item?.[2] === 'explain' && state.switchboardExplain) { await route.fulfill({ json: state.switchboardExplain(Number(item[1])) }); return }
      if (path.endsWith('/check')) { await route.fulfill({ json: { queued: false, reason: 'nothing changed', state: board } }); return }
      if (path.endsWith('/off')) { state.switchboard = switchboardState({ revision: board.revision + 1, items: board.items }); await route.fulfill({ json: state.switchboard }); return }
      if (path.endsWith('/restart')) { state.switchboard = { ...board, revision: board.revision + 1, status: 'live', error: null }; await route.fulfill({ json: state.switchboard }); return }
      await route.fulfill({ json: board })
      return
    }
    if (path === '/api/models') { await route.fulfill({ json: { catalog: { models: [], review_providers: [], path: '' }, places: [], fixed: [], refresh: null } }); return }
    if (path === '/api/claude-auth') { await route.fulfill({ json: { status: 'authenticated', reason: null, checkedAt: NOW, verifiedAt: NOW, authMethod: 'claude.ai', subscriptionType: 'max', loginInProgress: false } }); return }
    if (path === '/api/repos') { await route.fulfill({ json: { repos: ['acme/app', 'acme/docs'] } }); return }
    if (path === '/api/chat/switches') { await route.fulfill({ json: state.switches || { revision: 0, switches: [] } }); return }
    if (path === '/api/chat/agents') { await route.fulfill({ json: state.agents || AGENTS }); return }
    if (path === '/api/chat/repo') {
      await route.fulfill({ json: { checkout: '/tmp/app', currentBranch: 'main', defaultBranch: 'main', dirty: false, dirtyFiles: 0, branches: ['main', 'feature/x'], prs: [{ number: 42, title: 'Add login', branch: 'feature/login' }] } })
      return
    }
    if (path === '/api/chat/files') { await route.fulfill({ json: { files: ['src/main.ts', 'src/menu.ts'].filter((f) => f.includes(url.searchParams.get('q') || '')) } }); return }
    if (path === '/api/chat/sessions' && method === 'GET') { await route.fulfill({ json: { sessions: state.sessions, instance: 'poise-dev:test' } }); return }
    if (path === '/api/chat/sessions' && method === 'POST') {
      if (state.createDelay) await state.createDelay()
      const req2 = body as { agent: SessionRecord['agent'], model: string, effort: string, autoMerge?: boolean, safeMode?: boolean, deferStart?: boolean, role?: string }
      if (req2.role === 'manager') {
        const existing = state.sessions.find((s) => s.role === 'manager')
        if (existing) {
          await route.fulfill({ status: 409, json: { error: 'A Manager already exists.', code: 'manager_exists', manager: { id: existing.id } } })
          return
        }
      }
      const created = session({ id: `new-${state.sessions.length + 1}`, agent: req2.agent, model: req2.model, effort: req2.effort, autoMerge: req2.autoMerge, safeMode: req2.safeMode === true,
        repo: '', checkout: '/poise/.poise-chat/workspace', workspaceKind: 'poise-local', title: '', status: req2.deferStart ? 'idle' : 'starting', createdAt: new Date().toISOString(),
        branch: { name: 'chat/generated', origin: 'new', provisional: true },
        ...(req2.role === 'manager' ? { role: 'manager' as const, title: 'Manager' } : {}) })
      state.sessions.unshift(created)
      state.history[created.id] = []
      await route.fulfill({ status: 201, json: { session: created } })
      return
    }
    const m = /^\/api\/chat\/sessions\/([^/]+)(?:\/(resume|fork|close|handoff))?$/.exec(path)
    if (m) {
      const id = decodeURIComponent(m[1])
      const s = state.sessions.find((x) => x.id === id)
      if (!s) { await route.fulfill({ status: 404, json: { error: 'unknown session' } }); return }
      if (m[2] === 'resume') { s.status = 'idle'; s.interruptedTurnId = undefined; await route.fulfill({ json: { session: s } }); return }
      if (m[2] === 'fork' || m[2] === 'handoff') {
        const forked = session({ ...s, id: `${id}-${m[2]}`, title: `${m[2]} of ${s.title}`, createdAt: new Date().toISOString(), forkedFrom: id })
        state.sessions.unshift(forked)
        state.history[forked.id] = []
        await route.fulfill({ json: { session: forked } })
        return
      }
      if (method === 'PATCH') { s.title = (body as { title: string }).title; await route.fulfill({ json: { session: s } }); return }
      if (method === 'DELETE') { state.sessions = state.sessions.filter((x) => x.id !== id); await route.fulfill({ json: { ok: true, workspaceRemoved: false } }); return }
      const after = Number(url.searchParams.get('after') || 0)
      await route.fulfill({ json: { session: s, events: (state.history[id] || []).filter((e) => e.seq > after) } })
      return
    }
    await route.fulfill({ json: {} })
  })
}

interface Socket {
  frames: ClientFrame[]
  ws: WebSocketRoute | null
  autoAck: boolean
  held: ClientFrame[]
  seq: number
  push(sessionId: string, event: ChatEvent): ChatEnvelope
  ack(frame: ClientFrame, ok?: boolean, error?: string, code?: string, result?: unknown): void
  ready(): Promise<void>
  /** Resolves once the page has subscribed to the session, so pushed
   *  events are not dropped as belonging to nobody. */
  subscribed(sessionId: string): Promise<void>
  framesOf(type: string): ClientFrame[]
}

async function installSocket(page: Page, state?: ServerState): Promise<Socket> {
  const sock: Socket = {
    frames: [], ws: null, autoAck: true, held: [], seq: 0,
    push(sessionId, event) {
      const envelope: ChatEnvelope = { seq: ++sock.seq, sessionId, at: new Date().toISOString(), event }
      sock.ws!.send(JSON.stringify({ kind: 'event', envelope }))
      return envelope
    },
    ack(frame, ok = true, error = 'failed', code, result) {
      sock.ws!.send(JSON.stringify(ok ? { kind: 'ack', id: frame.id, ok: true, result } : { kind: 'ack', id: frame.id, ok: false, error, code }))
    },
    async ready() { await expect.poll(() => sock.ws !== null).toBe(true) },
    async subscribed(sessionId) {
      await expect.poll(() => sock.frames.some((f) => f.command.type === 'subscribe' && f.command.sessionId === sessionId)).toBe(true)
    },
    framesOf(type) { return sock.frames.filter((f) => f.command.type === type) },
  }
  await page.routeWebSocket('**/ws/chat', (ws) => {
    sock.ws = ws
    ws.send(JSON.stringify({ kind: 'hello', instance: 'poise-dev:test', serverStartedAt: state?.serverStartedAt || NOW }))
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as ClientFrame
      sock.frames.push(frame)
      if (sock.autoAck && frame.command.type === 'switch.create' && state) {
        const command = frame.command
        const before = state.switches || { revision: 0, switches: [] }
        const old = before.switches.find(item => item.name === command.name)
        const item = { name: command.name, content: command.content, revision: (old?.revision || 0) + 1, updatedAt: NOW }
        state.switches = { revision: before.revision + 1, switches: [...before.switches.filter(row => row.name !== command.name), item] }
        ws.send(JSON.stringify({ kind: 'switches.updated', catalogue: state.switches }))
        sock.ack(frame, true, '', undefined, { catalogue: state.switches })
      } else if (sock.autoAck && ['queue.add', 'queue.update', 'queue.remove'].includes(frame.command.type) && state) {
        const cmd = frame.command
        if (cmd.type !== 'queue.add' && cmd.type !== 'queue.update' && cmd.type !== 'queue.remove') throw new Error('Unexpected queue command')
        const s = state.sessions.find(s => s.id === cmd.sessionId)!
        const queue = structuredClone(s.queue || { revision: 0, ready: false, items: [] })
        if (cmd.type === 'queue.remove') queue.items = queue.items.filter(item => item.id !== cmd.itemId)
        else {
          const model = cmd.model || s.model
          const agent = ((state.agents || AGENTS).agents as Array<{ id: SessionRecord['agent'], models: Array<{ identity: string, effort: string }> }>).find(agent => agent.models.some(m => m.identity === model))!
          const effort = cmd.effort || agent.models.find(m => m.identity === model)!.effort
          if (cmd.type === 'queue.add') queue.items.push({ id: cmd.itemId, prompt: { text: cmd.text, attachments: cmd.attachments || [], mentions: cmd.mentions || [] },
            agent: agent.id, model, effort, state: 'waiting', createdAt: NOW })
          else queue.items = queue.items.map(item => item.id === cmd.itemId ? { ...item, agent: agent.id, model, effort } : item)
        }
        queue.revision++
        s.queue = queue
        sock.push(s.id, { type: 'queue.updated', queue })
        sock.ack(frame, true, '', undefined, { queue })
      } else if (sock.autoAck && frame.command.type === 'context.reset' && state) {
        const id = frame.command.sessionId
        const s = state.sessions.find(s => s.id === id)!
        sock.seq = Math.max(sock.seq, s.lastSeq, ...(state.history[s.id] || []).map(e => e.seq)) + 3
        Object.assign(s, { contextResetSeq: sock.seq + 1, lastSeq: sock.seq + 1, contextResetting: false, contextCompacting: false, status: 'idle', nativeSessionId: undefined, context: undefined, pendingRequests: [] })
        const envelope = sock.push(s.id, { type: 'session.reset', session: { ...s } })
        state.history[s.id] = [envelope]
        sock.ack(frame, true, '', undefined, { session: { ...s } })
      } else if (sock.autoAck && frame.command.type === 'set_model' && state) {
        const command = frame.command
        const s = state.sessions.find(s => s.id === command.sessionId)!
        const agent = (AGENTS.agents as Array<{ id: SessionRecord['agent'], models: Array<{ identity: string, selector: string, effort: string }> }>).find(agent => agent.models.some(model => model.identity === command.model))!
        const model = agent.models.find(model => model.identity === command.model)!
        Object.assign(s, { agent: agent.id, model: model.identity, modelId: model.selector, effort: command.effort || model.effort, lastSeq: sock.seq + 1 })
        sock.push(s.id, { type: 'session.updated', session: { ...s } })
        sock.ack(frame, true, '', undefined, { session: { ...s } })
      } else if (sock.autoAck && frame.command.type === 'set_safe_mode' && state) {
        const command = frame.command
        const s = state.sessions.find(s => s.id === command.sessionId)!
        s.safeMode = command.enabled
        s.lastSeq = sock.seq + 1
        sock.push(s.id, { type: 'session.updated', session: { ...s } })
        sock.ack(frame, true, '', undefined, { session: { ...s }, applies: 'current_turn' })
      } else if (sock.autoAck && frame.command.type === 'set_auto_merge' && state) {
        const command = frame.command
        const s = state.sessions.find(s => s.id === command.sessionId)!
        s.autoMerge = command.enabled
        s.lastSeq = sock.seq + 1
        sock.push(s.id, { type: 'session.updated', session: { ...s } })
        sock.ack(frame, true, '', undefined, { session: { ...s }, applies: 'current_turn' })
      } else if (sock.autoAck) sock.ack(frame)
      else sock.held.push(frame)
    })
  })
  return sock
}

function env(sessionId: string, seq: number, event: ChatEvent): ChatEnvelope {
  return { seq, sessionId, at: NOW, event }
}

function makeState(sessions: SessionRecord[], history: Record<string, ChatEnvelope[]> = {}): ServerState {
  return { sessions, history, calls: [], settings: { org: 'acme', me: 'octocat', timezone: 'UTC', models: {}, chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4 } } }
}

const input = (page: Page) => page.locator('.chat-v-composer .chat-input')


export { NOW, AGENTS, session, installRoutes, installSocket, env, makeState, input, switchboardState }
