import type { ChatSwitches } from '../../../src/chat-switches'
import { expect, type Page, type WebSocketRoute } from '@playwright/test'
import type { ChatEnvelope, ChatEvent, ChatHold, ClientFrame, SessionRecord, SwitchboardState, TimerSummary, TimerView } from '../../../server/chat/protocol'

export interface TimersData { timers: TimerView[], holds: ChatHold[], allHeld: { held: boolean, since: string | null }, scheduler: { running: boolean, lastTickAt: string | null, error?: string } }

export function timersData(overrides: Partial<TimersData> = {}): TimersData {
  return { timers: [], holds: [], allHeld: { held: false, since: null },
    scheduler: { running: true, lastTickAt: new Date().toISOString() }, ...overrides }
}

let timerSeq = 0
export function timerView(overrides: Partial<TimerView> = {}): TimerView {
  timerSeq += 1
  const message = overrides.message ?? 'Check the build'
  const points = Array.from(message)
  return {
    id: `timer-${timerSeq}`, sessionId: 's1', label: 'Check CI', preview: points.length > 200 ? `${points.slice(0, 200).join('')}…` : message,
    schedule: { kind: 'every', minutes: 30 }, nextAt: '2026-09-18T14:35:00.000Z', notBefore: null,
    state: 'active', setBy: { kind: 'chat', sessionId: 'm1', title: 'Manager', role: 'manager' },
    failures: 0, skipped: 0, createdAt: NOW, message, ...overrides,
  }
}

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
  settings: { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 },
}

/** The Switchboard as the server reports it; never started unless a test says so. */
function switchboardState(overrides: Partial<SwitchboardState> = {}): SwitchboardState {
  return { revision: 1, status: 'off', sessionId: null, sessionStatus: null, model: 'muse-spark-1.3-contributor-max', error: null,
    checking: false, lastCheckAt: null, lastCheckTokens: null, nextCheckAt: null, chats: 0, items: [], ...overrides }
}

interface SnippetLibrary {
  snippets: Array<{ trigger: string, replace: string }>
  version: string
  skills: ChatSwitches
}

interface ServerState {
  serverStartedAt?: string
  snippets?: SnippetLibrary
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
  /** Earlier conversations by subject key for GET /api/chat/legacy. */
  legacy?: Record<string, { turns: Array<{ prompt: string, reply: string, at: string, status: string }>, omitted: number } | null>
  /** Answer for POST /api/chat-content; recorded in state.calls. */
  content?: (topic: string, chatSession: string) => { status: number, json: unknown }
  /** Author-content jobs by call_id or launch_id for the status route. */
  contentJobs?: Record<string, unknown>
  /** Answer for POST /api/debate; recorded in state.calls. A test may hold
   *  the answer open to stage what happens while a debate runs. */
  debate?: (topic: string, chatSession: string) => { status: number, json: unknown } | Promise<{ status: number, json: unknown }>
  /** Fail the legacy card-chat endpoints, so a card chat reaching
   *  /api/chat again fails loudly instead of passing against {}. */
  forbidLegacyChat?: boolean
  /** Answer for GET /api/models; the surface reads the chat default. */
  models?: unknown
  /** Answer for GET /api/chat/sessions/<id>/timers, by session. */
  timers?: Record<string, TimersData>
}

async function installRoutes(page: Page, state: ServerState): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const method = req.method()
    const body = method === 'POST' || method === 'PATCH' || method === 'PUT' ? (req.postDataJSON?.() ?? null) : null
    if (path.startsWith('/api/chat') || path === '/api/debate' || path === '/api/settings' || path === '/api/repos' || path === '/api/snippets') state.calls.push({ method, path, body })
    if (path === '/api/chat' && state.forbidLegacyChat) {
      await route.fulfill({ status: 500, json: { error: 'legacy card chat is forbidden in this spec' } })
      return
    }
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
    if (path === '/api/models') { await route.fulfill({ json: state.models || { catalog: { models: [], review_providers: [], path: '' }, places: [], fixed: [], refresh: null } }); return }
    if (path === '/api/chat/legacy' && method === 'GET') {
      const subject = url.searchParams.get('subject') || ''
      const key = subject.slice(subject.indexOf(':') + 1)
      await route.fulfill({ json: { conversation: state.legacy?.[key] ?? { turns: [], omitted: 0 } } })
      return
    }
    if (path === '/api/chat-content' && method === 'POST') {
      const { topic, chatSession } = (body || {}) as { topic: string, chatSession: string }
      const answer = state.content ? state.content(topic, chatSession) : { status: 200, json: { call_id: 'c1', status: 'pending' } }
      await route.fulfill(answer)
      return
    }
    if (path === '/api/chat-content/status' && method === 'GET') {
      const job = state.contentJobs?.[url.searchParams.get('call_id') || ''] ?? state.contentJobs?.[url.searchParams.get('launch_id') || '']
      if (!job) { await route.fulfill({ status: 404, json: { error: 'author-content job not found' } }); return }
      await route.fulfill({ json: job })
      return
    }
    if (path === '/api/debate' && method === 'POST') {
      const { topic, chatSession } = (body || {}) as { topic: string, chatSession: string }
      const answer = state.debate ? await state.debate(topic, chatSession) : { status: 200, json: { id: 'd1', synthesis: 'Debated.', rounds: [] } }
      await route.fulfill(answer)
      return
    }
    if (path === '/api/claude-auth') { await route.fulfill({ json: { status: 'authenticated', reason: null, checkedAt: NOW, verifiedAt: NOW, authMethod: 'claude.ai', subscriptionType: 'max', loginInProgress: false } }); return }
    if (path === '/api/repos') { await route.fulfill({ json: { repos: ['acme/app', 'acme/docs'] } }); return }
    if (path === '/api/chat/switches') { await route.fulfill({ json: state.switches || { revision: 0, switches: [] } }); return }
    if (path === '/api/snippets') {
      state.snippets ??= { snippets: [], version: 'fixture-v1', skills: { revision: 0, switches: [] } }
      if (method === 'PUT') {
        const incoming = (body as { snippets?: SnippetLibrary['snippets'], base_version?: unknown } | null)?.snippets
        if (Array.isArray(incoming)) state.snippets = { snippets: incoming, version: `fixture-v${state.calls.length}`, skills: state.snippets.skills }
      }
      await route.fulfill({ json: state.snippets })
      return
    }
    if (path === '/api/chat/agents') { await route.fulfill({ json: state.agents || AGENTS }); return }
    if (path === '/api/chat/repo') {
      await route.fulfill({ json: { checkout: '/tmp/app', currentBranch: 'main', defaultBranch: 'main', dirty: false, dirtyFiles: 0, branches: ['main', 'feature/x'], prs: [{ number: 42, title: 'Add login', branch: 'feature/login' }] } })
      return
    }
    if (path === '/api/chat/files') { await route.fulfill({ json: { files: ['src/main.ts', 'src/menu.ts'].filter((f) => f.includes(url.searchParams.get('q') || '')) } }); return }
    if (path === '/api/chat/sessions' && method === 'GET') {
      const subject = url.searchParams.get('subject')
      if (subject !== null) {
        const at = subject.indexOf(':')
        const found = state.sessions.find((s) => s.subject?.surface === subject.slice(0, at) && s.subject?.key === subject.slice(at + 1)) || null
        await route.fulfill({ json: { session: found, instance: 'poise-dev:test' } })
        return
      }
      await route.fulfill({ json: { sessions: state.sessions, instance: 'poise-dev:test' } })
      return
    }
    if (path === '/api/chat/sessions' && method === 'POST') {
      if (state.createDelay) await state.createDelay()
      const req2 = body as { agent: SessionRecord['agent'], model: string, effort: string, autoMerge?: boolean, safeMode?: boolean, deferStart?: boolean, role?: string, subject?: SessionRecord['subject'], skipLegacy?: boolean, title?: string }
      if (req2.role === 'manager') {
        const existing = state.sessions.find((s) => s.role === 'manager')
        if (existing) {
          await route.fulfill({ status: 409, json: { error: 'A Manager already exists.', code: 'manager_exists', manager: { id: existing.id } } })
          return
        }
      }
      if (req2.subject) {
        const winner = state.sessions.find((s) => s.subject?.surface === req2.subject!.surface && s.subject?.key === req2.subject!.key)
        if (winner) {
          await route.fulfill({ json: { session: winner, existing: true } })
          return
        }
      }
      const created = session({ id: `new-${state.sessions.length + 1}`, agent: req2.agent, model: req2.model, effort: req2.effort, autoMerge: req2.autoMerge, safeMode: req2.safeMode === true,
        repo: '', checkout: '/poise/.poise-chat/workspace', workspaceKind: 'poise-local', title: req2.title || '', status: req2.deferStart ? 'idle' : 'starting', createdAt: new Date().toISOString(),
        branch: { name: 'chat/generated', origin: 'new', provisional: true },
        ...(req2.subject ? { subject: req2.subject } : {}),
        ...(req2.role === 'manager' ? { role: 'manager' as const, title: 'Manager' } : {}) })
      state.sessions.unshift(created)
      state.history[created.id] = []
      await route.fulfill({ status: 201, json: { session: created, ...(req2.subject ? { existing: false } : {}) } })
      return
    }
    const t = /^\/api\/chat\/sessions\/([^/]+)\/timers$/.exec(path)
    if (t && method === 'GET') {
      await route.fulfill({ json: state.timers?.[decodeURIComponent(t[1])] || timersData() })
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
      } else if (sock.autoAck && ['timer.create', 'timer.cancel', 'timer.rearm', 'chat.hold', 'timers.holdAll'].includes(frame.command.type) && state) {
        const command = frame.command
        if (command.type === 'timer.create') {
          const created = timerView({ sessionId: command.sessionId, label: command.label, message: command.message,
            schedule: command.everyMinutes !== undefined ? { kind: 'every', minutes: command.everyMinutes } : { kind: 'once', delayMinutes: command.delayMinutes! } })
          const data = state.timers?.[command.sessionId]
          if (data) data.timers.push(created)
          sock.ack(frame, true, '', undefined, { timer: created })
        } else if (command.type === 'timer.cancel' || command.type === 'timer.rearm') {
          for (const data of Object.values(state.timers || {})) {
            const timer = data.timers.find(t => t.id === (command as { timerId: string }).timerId)
            if (timer) {
              if (command.type === 'timer.cancel') { timer.state = 'cancelled'; timer.nextAt = null }
              else { timer.state = 'active'; timer.failures = 0; timer.notBefore = null }
              sock.ack(frame, true, '', undefined, { timer: { ...timer } })
              return
            }
          }
          sock.ack(frame)
        } else if (command.type === 'chat.hold') {
          const s = state.sessions.find(s => s.id === command.sessionId)!
          const data = state.timers?.[command.sessionId]
          if (command.held) {
            if (data && !data.holds.some(h => h.sessionId === s.id)) data.holds.push({ sessionId: s.id, cause: 'held', since: NOW })
            if (data) for (const timer of data.timers) if (timer.state === 'active') { timer.state = 'held'; timer.reason = 'person_held' }
          } else {
            if (data) data.holds = data.holds.filter(h => h.sessionId !== s.id)
            if (data) for (const timer of data.timers) if (timer.state === 'held') { timer.state = 'active'; timer.reason = undefined }
          }
          if (data) {
            const summaries: TimerSummary[] = data.timers.filter(t => t.state === 'active' || t.state === 'held' || t.state === 'tripped')
              .map((t) => ({ id: t.id, sessionId: t.sessionId, label: t.label, preview: t.preview, schedule: t.schedule,
                nextAt: t.nextAt, notBefore: t.notBefore, state: t.state, reason: t.reason, setBy: t.setBy,
                failures: t.failures, skipped: t.skipped, pending: t.pending, createdAt: t.createdAt }))
            s.timers = summaries
            s.lastSeq = sock.seq + 1
            sock.push(s.id, { type: 'session.updated', session: { ...s } })
          }
          sock.ack(frame, true, '', undefined, { session: { ...s } })
        } else if (command.type === 'timers.holdAll') {
          for (const data of Object.values(state.timers || {})) {
            data.allHeld = { held: command.held, since: command.held ? NOW : null }
            for (const timer of data.timers) {
              if (command.held && timer.state === 'active') { timer.state = 'held'; timer.reason = 'all_held' }
              if (!command.held && timer.state === 'held' && timer.reason === 'all_held') { timer.state = 'active'; timer.reason = undefined }
            }
          }
          sock.ack(frame, true, '', undefined, { held: command.held })
        }
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
  return { sessions, history, calls: [], settings: { org: 'acme', me: 'octocat', timezone: 'UTC', models: {}, chat: { branchPrefix: 'chat/', idleTimeoutMinutes: 120, maxConcurrentLocalTurns: 4, updateTurnBoundMinutes: 15 } } }
}

const input = (page: Page) => page.locator('.chat-v-composer .chat-input')


export { NOW, AGENTS, session, installRoutes, installSocket, env, makeState, input, switchboardState }
