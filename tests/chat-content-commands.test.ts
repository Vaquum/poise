// /content and /consensus as Chat composer commands: chain parsing, the
// server's refusal to run them as turns, transcript recording through the
// existing routes, and launch-id status. Launches and debates are faked;
// the routes, the runtime and the durable tables are real.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG } from './model-catalog-fixture'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities, ChatEvent, PromptInput } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
vi.mock('../server/models', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/models')>()
  const { CATALOG: fixture } = await import('./model-catalog-fixture')
  return { ...original, loadCatalog: async () => fixture as any }
})

const fakes = vi.hoisted(() => ({
  authorContent: null as null | ((topic: string, sessionId: string) => Promise<{ call_id: string, started_at: string }>),
  debate: null as null | ((topic: string, rounds: number) => Promise<{ synthesis: string, rounds: unknown[] }>),
  contents: [] as string[],
  debates: [] as string[],
}))

vi.mock('../server/chat', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/chat')>()
  return {
    ...original,
    startAuthorContent: async (topic: string, sessionId: string) => {
      fakes.contents.push(topic)
      if (!fakes.authorContent) throw new Error('no author-content fake')
      return fakes.authorContent(topic, sessionId)
    },
    runDebate: async (topic: string, rounds: number) => {
      fakes.debates.push(topic)
      if (!fakes.debate) throw new Error('no debate fake')
      return fakes.debate(topic, rounds)
    },
  }
})

const caps: Capabilities = { steer: true, fork: true, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
const prompts = new Map<string, PromptInput[]>()
const finishes = new Map<string, (result: TurnResult) => void>()

function adapter(host: AdapterHost): Adapter {
  let alive = false
  const nativeSessionId = randomUUID()
  const finish = () => { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) }
  return {
    agent: 'grok', nativeSessionId, capabilities: caps, get alive() { return alive },
    async start(options) { alive = true; return { nativeSessionId, capabilities: caps, modelId: options.modelId, effort: options.effort } },
    async prompt(_turn, input) {
      prompts.set(host.sessionId, [...(prompts.get(host.sessionId) ?? []), input])
      return new Promise<TurnResult>(done => finishes.set(host.sessionId, done))
    },
    async cancel() { finish() }, async close() { alive = false; finish() },
    async steer() {}, async setMode() {}, async setModel(modelId, effort) { return { modelId, effort } },
    async fork() { return randomUUID() }, onExit() {},
  }
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) { if (check()) return; await new Promise(done => setTimeout(done, 15)) }
  throw new Error(`deadline waiting for ${what}`)
}

let root: string
let instance: string
let workspaceRoot: string
let runtime: ChatRuntime
let storage: typeof import('../server/chat/storage')
let database: typeof import('../server/db')
let Runtime: typeof ChatRuntime
let cache: typeof import('../server/cache-plugin')
let server: Server
let origin: string

function makeRuntime() {
  return new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG as any,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: adapter }, requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0 })
}

async function post(path: string, body: unknown): Promise<{ status: number, json: any }> {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, json: await response.json() }
}

async function transcript(id: string): Promise<ChatEvent[]> {
  const response = await fetch(`${origin}/api/chat/sessions/${id}`)
  const body = await response.json() as { events: Array<{ event: ChatEvent }> }
  return body.events.map(({ event }) => event)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-content-commands-test-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.stubEnv('POISE_EDITOR_DIR', join(root, 'editor'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  vi.stubEnv('POISE_CHAT_ATTACHMENTS_DIR', join(root, 'chat'))
  vi.stubEnv('AGENT_INTERFACE_ROOT', join(root, 'agent-interface'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  storage = await import('../server/chat/storage')
  database = await import('../server/db')
  cache = await import('../server/cache-plugin')
  const middleware = cache.createPoiseMiddleware({ claudeAuth: createAuthenticatedClaudeAuth() })
  server = createServer((req, res) => {
    void middleware(req, res, () => { res.statusCode = 404; res.end() })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  origin = `http://127.0.0.1:${address.port}`
}, 120_000)

beforeEach(async () => {
  prompts.clear()
  finishes.clear()
  fakes.contents.length = 0
  fakes.debates.length = 0
  fakes.authorContent = null
  fakes.debate = null
  instance = `content:${randomUUID()}`
  workspaceRoot = join(root, randomUUID())
  runtime = makeRuntime()
})

afterEach(async () => {
  await runtime?.stop()
})

afterAll(async () => {
  await cache.stopPoiseRuntime()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  database.closeDatabase()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function chatSession(): Promise<string> {
  const created = await post('/api/chat/sessions', { agent: 'grok', model: 'grok-4.6-xhigh', deferStart: true })
  expect(created.status).toBe(201)
  return created.json.session.id as string
}

describe('/content and /consensus commands', () => {
  it('parses /content and /consensus anywhere in the leading command chain', async () => {
    const { parseChatCommandChain } = await import('../server/chat/commands')
    const chained = parseChatCommandChain('/model x /content Release notes')
    expect(chained.model).toBe('x')
    expect(chained.content).toBe('Release notes')
    expect(chained.text).toBe('')
    expect(parseChatCommandChain('/consensus Deep thought').consensus).toBe('Deep thought')
    expect(parseChatCommandChain('/content').content).toBe('')
    const plain = parseChatCommandChain('/contents are great')
    expect(plain.content).toBeUndefined()
    expect(plain.text).toBe('/contents are great')
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', deferStart: true })
    let code: string | undefined
    try {
      runtime.prompt(session.id, { text: '/content', attachments: [], mentions: [] })
    } catch (error: any) {
      code = error?.code
    }
    expect(code).toBe('invalid')
    expect(prompts.get(session.id) ?? []).toHaveLength(0)
  }, 60_000)

  it('refuses a prompt, steer or queued message that carries /content or /consensus', async () => {
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', deferStart: true })
    for (const text of ['/content Release notes', '/model x /consensus Deep thought']) {
      for (const send of [
        () => runtime.prompt(session.id, { text, attachments: [], mentions: [] }),
        () => runtime.enqueue(session.id, randomUUID(), { text, attachments: [], mentions: [] }),
      ]) {
        let code: string | undefined
        try {
          await send()
        } catch (error: any) {
          code = error?.code
        }
        expect(code).toBe('invalid')
      }
    }
    runtime.prompt(session.id, { text: 'plain work', attachments: [], mentions: [] })
    await until(() => (prompts.get(session.id)?.length ?? 0) > 0, 'the plain turn to start')
    let steerCode: string | undefined
    try {
      await runtime.steer(session.id, '/content Release notes')
    } catch (error: any) {
      steerCode = error?.code
    }
    expect(steerCode).toBe('invalid')
    expect(prompts.get(session.id)?.map((input) => input.text)).toEqual(['plain work'])
    finishes.get(session.id)?.({ stopReason: 'end_turn' })
    await until(() => !storage.getOpenTurn(session.id), 'the plain turn to settle')
  }, 120_000)

  it('records /content in the transcript and resolves its article by launch id', async () => {
    const id = await chatSession()
    const callId = 'e'.repeat(32)
    fakes.authorContent = async () => ({ call_id: callId, started_at: new Date().toISOString() })
    const launched = await post('/api/chat-content', { topic: 'Release notes', chatSession: id })
    expect(launched.status).toBe(200)
    expect(launched.json.call_id).toBe(callId)
    const events = await transcript(id)
    const started = events.find((event) => event.type === 'content.started')
    expect(started).toMatchObject({ type: 'content.started', topic: 'Release notes', callId })
    const launchId = (started as Extract<ChatEvent, { type: 'content.started' }>).launchId
    expect(typeof launchId).toBe('string')
    const byCall = await fetch(`${origin}/api/chat-content/status?call_id=${callId}`)
    expect(byCall.status).toBe(200)
    expect(((await byCall.json()) as any).call_id).toBe(callId)
    const byLaunch = await fetch(`${origin}/api/chat-content/status?launch_id=${launchId}`)
    expect(byLaunch.status).toBe(200)
    expect(((await byLaunch.json()) as any).call_id).toBe(callId)
    database.db.prepare("UPDATE content_jobs SET status = 'completed', article_created = 1, updated_at = ? WHERE call_id = ?")
      .run(new Date().toISOString(), callId)
    expect((((await (await fetch(`${origin}/api/chat-content/status?launch_id=${launchId}`)).json())) as any).status).toBe('completed')
    expect(events.some((event) => event.type === 'turn.started')).toBe(false)

    const pendingId = await chatSession()
    fakes.authorContent = async () => { throw Object.assign(new Error('discovery timed out'), { code: 'AUTHOR_CONTENT_DISCOVERY_TIMEOUT' }) }
    const pending = await post('/api/chat-content', { topic: 'Pending notes', chatSession: pendingId })
    expect(pending.status).toBe(202)
    expect(pending.json.launch_id).toBeTruthy()
    const pendingEvents = await transcript(pendingId)
    const pendingStarted = pendingEvents.find((event) => event.type === 'content.started')
    expect(pendingStarted).toMatchObject({ type: 'content.started', topic: 'Pending notes', launchId: pending.json.launch_id })
    expect((pendingStarted as Extract<ChatEvent, { type: 'content.started' }>).callId).toBeUndefined()
    const pendingStatus = await fetch(`${origin}/api/chat-content/status?launch_id=${pending.json.launch_id}`)
    expect(pendingStatus.status).toBe(200)
    expect(await pendingStatus.json()).toMatchObject({ launch_id: pending.json.launch_id, status: 'pending' })
    database.db.prepare('UPDATE content_launches SET registration_deadline_at = ? WHERE launch_id = ?').run(Date.now() - 1, pending.json.launch_id)
    fakes.authorContent = async () => ({ call_id: 'f'.repeat(32), started_at: new Date().toISOString() })
    expect((await post('/api/chat-content', { topic: 'Next notes', chatSession: pendingId })).status).toBe(200)
    const expired = await fetch(`${origin}/api/chat-content/status?launch_id=${pending.json.launch_id}`)
    expect(expired.status).toBe(200)
    expect(await expired.json()).toMatchObject({ launch_id: pending.json.launch_id, status: 'failed' })
  }, 180_000)

  it('records a /consensus synthesis or error without starting a native turn', async () => {
    const id = await chatSession()
    const synthesis = `${'x'.repeat(65535)}€${'tail'.repeat(20000)}`
    fakes.debate = async () => ({ synthesis, rounds: [] })
    const done = await post('/api/debate', { topic: 'Deep thought', chatSession: id })
    expect(done.status).toBe(200)
    expect(typeof done.json.id).toBe('string')
    const events = await transcript(id)
    expect(events.find((event) => event.type === 'consensus.started')).toMatchObject({ type: 'consensus.started', id: done.json.id, topic: 'Deep thought' })
    const finished = events.find((event) => event.type === 'consensus.finished')
    expect(finished).toMatchObject({ type: 'consensus.finished', id: done.json.id, truncated: true })
    const cut = (finished as Extract<ChatEvent, { type: 'consensus.finished' }>).synthesis!
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(cut).not.toContain('�')
    expect(events.some((event) => event.type === 'turn.started')).toBe(false)

    const failedId = await chatSession()
    fakes.debate = async () => { throw new Error('no quorum') }
    const failed = await post('/api/debate', { topic: 'Hard thought', chatSession: failedId })
    expect(failed.status).toBe(500)
    const failedEvents = await transcript(failedId)
    expect(failedEvents.find((event) => event.type === 'consensus.finished')).toMatchObject({ type: 'consensus.finished', error: 'no quorum' })
    expect(failedEvents.some((event) => event.type === 'turn.started')).toBe(false)
  }, 180_000)

  it('refuses /content and /consensus for an unknown or foreign session', async () => {
    const foreign = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', deferStart: true })
    fakes.authorContent = async () => ({ call_id: '1'.repeat(32), started_at: new Date().toISOString() })
    fakes.debate = async () => ({ synthesis: 'never', rounds: [] })
    const unknownId = randomUUID()
    expect((await post('/api/chat-content', { topic: 'x', chatSession: unknownId })).status).toBe(404)
    expect((await post('/api/chat-content', { topic: 'x', chatSession: foreign.id })).status).toBe(409)
    expect((await post('/api/debate', { topic: 'x', chatSession: unknownId })).status).toBe(404)
    expect((await post('/api/debate', { topic: 'x', chatSession: foreign.id })).status).toBe(409)
    expect(fakes.contents).toHaveLength(0)
    expect(fakes.debates).toHaveLength(0)
  }, 120_000)
})
