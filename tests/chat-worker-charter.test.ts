import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities, ChatEnvelope, ChatEvent, PromptInput, QueuedMessage } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'
import type { ChatControl } from '../server/chat/control'
import type { ResolvedServer } from '../server/extensions/types'
import { WORKER_SNIPPET_DEFAULT } from '../server/chat/worker-default'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
const workerDefault = vi.hoisted(() => ({ override: undefined as string | undefined }))
vi.mock('../server/chat/worker-default', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/chat/worker-default')>()
  return { get WORKER_SNIPPET_DEFAULT() { return workerDefault.override ?? actual.WORKER_SNIPPET_DEFAULT } }
})

const executeFile = promisify(execFile)
const caps: Capabilities = { steer: true, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
let root: string
let matchFile: string
let runtime: ChatRuntime
let control: ChatControl
let server: Server
let origin: string
let instance: string
let workspaceRoot: string
let store: typeof import('../server/chat/control-store')
let storage: typeof import('../server/chat/storage')
let database: typeof import('../server/db')
let Runtime: typeof ChatRuntime
let Control: typeof ChatControl
let transportModule: typeof import('../server/chat/transport')
let snippetApi: typeof import('../server/snippet-api')
let messageQueue: typeof import('../server/chat/message-queue')
let logging: typeof import('../server/logging')
const prompts = new Map<string, PromptInput[]>()
const finishes = new Map<string, (result: TurnResult) => void>()
const steers = new Map<string, string[]>()
const seen = new Map<string, ChatEvent[]>()
let servers: ResolvedServer[] = []

function scripted(host: AdapterHost): Adapter {
  let alive = false
  const nativeSessionId = randomUUID()
  const finish = () => { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) }
  return {
    agent: 'grok', nativeSessionId, capabilities: caps, get alive() { return alive },
    async start(options) {
      alive = true
      return { nativeSessionId, capabilities: caps, modelId: options.modelId, effort: options.effort }
    },
    async prompt(_turn, input) {
      prompts.set(host.sessionId, [...(prompts.get(host.sessionId) ?? []), input])
      return new Promise<TurnResult>(done => finishes.set(host.sessionId, done))
    },
    async cancel() { finish() }, async close() { alive = false; finish() },
    async steer(text) { steers.set(host.sessionId, [...(steers.get(host.sessionId) ?? []), text]) },
    async setMode() {}, async setModel(modelId, effort) { return { modelId, effort } },
    async fork() { return randomUUID() }, onExit() {},
  }
}
const adapter = (host: AdapterHost) => scripted(host)

async function until(check: () => boolean) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) { if (check()) return; await new Promise(done => setTimeout(done, 15)) }
  throw new Error('charter fixture readiness deadline')
}
function watch(target: ChatRuntime) {
  target.on('event', (envelope: ChatEnvelope) => {
    seen.set(envelope.sessionId, [...(seen.get(envelope.sessionId) ?? []), envelope.event])
  })
}
function makeRuntime() {
  const created = new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: adapter },
    requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => 4,
    controlContext: id => control.context(id), leaseProbes: {},
    extensions: { resolve: async () => ({ servers, notices: [], fingerprint: JSON.stringify(servers) }), delivered: () => {}, scrub: event => event, redact: text => text } })
  watch(created)
  return created
}
async function restart() {
  const stopped = runtime.stop()
  await control.stop(stopped)
  runtime = makeRuntime()
  control = new Control(runtime, {})
  control.attach(server)
  await runtime.recover()
  control.start()
}
async function config(id: string) {
  const context = await control.context(id)
  const path = /"([^"\n]+\.json)"/.exec(context)?.[1]
  if (!path) throw new Error('native control connection missing')
  return { path, ...JSON.parse(await readFile(path, 'utf8')) as { token: string, sessionId: string, origin: string } }
}
/** The real native command against this test's server. Resolves stdout on exit 0; rejects with code/stderr otherwise. */
function api(connectionPath: string, input: Record<string, unknown>): Promise<{ stdout: string, stderr: string }> {
  return executeFile(process.execPath, [resolve('scripts/poise-chat-control.mjs'), connectionPath, JSON.stringify(input)])
}
const GROK_MODEL = 'grok-4.6-xhigh'

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-worker-charter-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  vi.stubEnv('POISE_ESPANSO_MATCH_DIR', join(root, 'match'))
  matchFile = join(root, 'match', 'poise.yml')
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  ;({ ChatControl: Control } = await import('../server/chat/control'))
  store = await import('../server/chat/control-store')
  storage = await import('../server/chat/storage')
  database = await import('../server/db')
  transportModule = await import('../server/chat/transport')
  snippetApi = await import('../server/snippet-api')
  messageQueue = await import('../server/chat/message-queue')
  logging = await import('../server/logging')
})
beforeEach(async () => {
  prompts.clear(); finishes.clear(); steers.clear(); seen.clear()
  servers = []
  workerDefault.override = undefined
  database.setMeta('chat_custom_switches', '')
  database.db.prepare("DELETE FROM meta WHERE key LIKE 'chat_snippet_%'").run()
  await rm(join(root, 'match'), { recursive: true, force: true })
  await logging.stopLogging()
  await rm(join(root, 'logging.db'), { force: true })
  logging.startLogging()
  instance = `worker-charter:${randomUUID()}`
  workspaceRoot = join(root, randomUUID())
  runtime = makeRuntime()
  control = new Control(runtime, {})
  server = createServer((req, res) => {
    const url = req.url || ''
    if (url === '/api/chat/control') { void control.handle(req, res); return }
    const person = transportModule.speaksForPerson(req, false, { kind: 'local' })
    void snippetApi.handleSnippetApi(req, res, url, person).then(handled => {
      if (!handled) void transportModule.handleChatApi(req, res, url, runtime, undefined, person)
    })
  })
  control.attach(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture needs TCP')
  origin = `http://127.0.0.1:${address.port}`
  control.start()
})
afterEach(async () => {
  await control?.stop()
  await runtime?.stop()
  await new Promise<void>(done => server.close(() => done()))
  await logging.stopLogging()
})
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

function postSessions(body: unknown, withOrigin: boolean) {
  return fetch(`${origin}/api/chat/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(withOrigin ? { Origin: origin } : {}) },
    body: JSON.stringify(body) })
}
function getSnippets() {
  return fetch(`${origin}/api/snippets`).then(async res => ({ status: res.status, json: await res.json() as { snippets: Array<{ trigger: string, replace: string }>, version: string, skills: { revision: number, switches: Array<{ name: string, content: string, revision: number, snippetTrigger?: string }> } } }))
}
function putSnippets(body: unknown, withOrigin: boolean) {
  return fetch(`${origin}/api/snippets`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(withOrigin ? { Origin: origin } : {}) },
    body: JSON.stringify(body) })
}
async function finishTurn(id: string, stopReason: TurnResult['stopReason'] = 'end_turn') {
  const finishedBefore = seen.get(id)?.filter(event => event.type === 'turn.finished').length ?? 0
  await until(() => finishes.has(id))
  finishes.get(id)!({ stopReason })
  finishes.delete(id)
  await until(() => (seen.get(id)?.filter(event => event.type === 'turn.finished').length ?? 0) > finishedBefore)
}
async function runPrompt(id: string, text: string) {
  runtime.prompt(id, { text, attachments: [], mentions: [] })
  await finishTurn(id)
}
function charterChanged() {
  logging.loggingRuntime()!.flush()
  const found: ReturnType<typeof logging.diagnosticPage>['events'] = []
  let cursor: string | null = null
  for (;;) {
    const page = logging.diagnosticPage(cursor)
    found.push(...page.events.filter(record => record.operation === 'chat.worker.charter.changed'))
    if (!page.hasMore) return found
    cursor = page.cursor
  }
}
async function createWorkerViaBrowser() {
  const created = await postSessions({ agent: 'grok', model: GROK_MODEL, role: 'worker' }, true)
  expect(created.status).toBe(201)
  return (await created.json() as { session: { id: string } }).session
}

it('creates /worker from the default file while a worker exists and never replaces it', async () => {
  await control.tick(); await control.tick(); await control.tick()
  expect((await getSnippets()).status).toBe(200)
  expect(existsSync(matchFile)).toBe(false)

  const worker = await createWorkerViaBrowser()
  expect(await readFile(matchFile, 'utf8')).toContain(';worker')
  const listed = await getSnippets()
  expect(listed.json.snippets).toContainEqual({ trigger: ';worker', replace: WORKER_SNIPPET_DEFAULT })
  expect(WORKER_SNIPPET_DEFAULT).toContain('Open the PR early.')
  expect(WORKER_SNIPPET_DEFAULT).toContain('npm run test:e2e -- <spec>')
  expect(WORKER_SNIPPET_DEFAULT).toContain('one at a time per workspace')
  expect(WORKER_SNIPPET_DEFAULT).toContain('CI runs the full suite.')
  expect(WORKER_SNIPPET_DEFAULT).toContain('Poise wakes you')
  expect(WORKER_SNIPPET_DEFAULT).not.toContain('muse-spark')
  expect(WORKER_SNIPPET_DEFAULT).not.toContain('native merge queue')
  expect(listed.json.skills.switches).toContainEqual(expect.objectContaining({ name: 'worker', content: WORKER_SNIPPET_DEFAULT }))
  expect(charterChanged()).toHaveLength(1)
  expect(charterChanged()[0]).toMatchObject({ context: { revision: 1, created: true } })

  const edited = await putSnippets({ snippets: [{ trigger: ';worker', replace: 'Edited' }], base_version: listed.json.version }, true)
  expect(edited.status).toBe(200)
  const bytesBefore = await readFile(matchFile)
  workerDefault.override = 'Changed default'
  try {
    await restart()
    expect(await readFile(matchFile)).toEqual(bytesBefore)
    expect((await getSnippets()).json.snippets).toContainEqual({ trigger: ';worker', replace: 'Edited' })

    await writeFile(matchFile, 'matches: []\n')
    await runPrompt(worker.id, 'Check the workspace')
    const input = prompts.get(worker.id)!.at(-1)!
    expect(input.text).toContain('Changed default')
    expect(await readFile(matchFile, 'utf8')).toContain(';worker')
  } finally {
    workerDefault.override = undefined
  }
}, 30_000)

it('adopts an existing snippet named worker as the built-in', async () => {
  const initial = await getSnippets()
  const seeded = await putSnippets({ snippets: [{ trigger: ':worker', replace: 'Mine' }], base_version: initial.json.version }, true)
  expect(seeded.status).toBe(200)
  const bytesBefore = await readFile(matchFile, 'utf8')
  expect(bytesBefore).toContain(':worker')

  await createWorkerViaBrowser()
  const bytesAfter = await readFile(matchFile, 'utf8')
  expect(bytesAfter).toEqual(bytesBefore)
  expect(bytesAfter).not.toContain(';worker')

  const worker = runtime.list().find(session => session.role === 'worker')!
  await runPrompt(worker.id, 'Check the workspace')
  const input = prompts.get(worker.id)!.at(-1)!
  expect(input.text).toContain('[Worker charter —')
  expect(input.text).toContain('Mine')

  const current = await getSnippets()
  const removed = await putSnippets({ snippets: [], base_version: current.json.version }, true)
  expect(removed.status).toBe(400)
  expect(await removed.json()).toEqual({ error: '/worker is built in. You can edit its text, but not delete it or change its trigger.' })
}, 30_000)

it('refuses to delete /worker or change its trigger on every path and lets the person edit it', async () => {
  await createWorkerViaBrowser()
  const listed = await getSnippets()
  const bytesBefore = await readFile(matchFile)

  const deleted = await putSnippets({ snippets: [], base_version: listed.json.version }, true)
  expect(deleted.status).toBe(400)
  expect(await deleted.json()).toEqual({ error: '/worker is built in. You can edit its text, but not delete it or change its trigger.' })
  const retriggered = await putSnippets({ snippets: [{ trigger: ';drone', replace: WORKER_SNIPPET_DEFAULT }], base_version: listed.json.version }, true)
  expect(retriggered.status).toBe(400)
  expect(await retriggered.json()).toEqual({ error: '/worker is built in. You can edit its text, but not delete it or change its trigger.' })
  expect(await readFile(matchFile)).toEqual(bytesBefore)

  const edited = await putSnippets({ snippets: [{ trigger: ';worker', replace: 'Person text' }], base_version: listed.json.version }, true)
  expect(edited.status).toBe(200)
  expect((await getSnippets()).json.snippets).toContainEqual({ trigger: ';worker', replace: 'Person text' })

  const oversized = await putSnippets({ snippets: [{ trigger: ';worker', replace: 'x'.repeat(65_537) }], base_version: (await getSnippets()).json.version }, true)
  expect(oversized.status).toBe(413)
  expect(await oversized.json()).toEqual({ error: 'The /worker snippet holds up to 64 KiB. Nothing was saved.' })

  const imported = await fetch(`${origin}/api/snippets/import`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ yaml: 'matches:\n  - trigger: ;worker\n    replace: Imported\n' }) })
  expect(imported.status).toBe(200)
  const report = await imported.json() as { added: string[], skipped: Array<{ trigger: string | null, reason: string }> }
  expect(report.added).toEqual([])
  expect(report.skipped).toContainEqual(expect.objectContaining({ trigger: ';worker', reason: 'duplicate' }))
  expect((await getSnippets()).json.snippets).toContainEqual({ trigger: ';worker', replace: 'Person text' })
}, 30_000)

it('refuses /worker changes through the native control api operation', async () => {
  const worker = await createWorkerViaBrowser()
  const connection = await config(worker.id)
  const listed = await getSnippets()
  await putSnippets({ snippets: [...listed.json.snippets, { trigger: ';other', replace: 'Other' }], base_version: listed.json.version }, true)

  const rewrite = await api(connection.path, { operation: 'api', path: '/api/snippets', method: 'PUT',
    body: { snippets: [{ trigger: ';worker', replace: 'Injected' }, { trigger: ';other', replace: 'Other' }], base_version: (await getSnippets()).json.version } })
    .then(() => null, error => error as { code?: number, stderr?: string })
  expect(rewrite?.code).toBe(1)
  expect(String(rewrite?.stderr)).toContain('"status":403')
  expect(String(rewrite?.stderr)).toContain('The /worker snippet is edited in the browser.')
  expect((await getSnippets()).json.snippets).toContainEqual({ trigger: ';worker', replace: WORKER_SNIPPET_DEFAULT })

  const other = await api(connection.path, { operation: 'api', path: '/api/snippets', method: 'PUT',
    body: { snippets: [{ trigger: ';worker', replace: WORKER_SNIPPET_DEFAULT }, { trigger: ';other', replace: 'Changed' }], base_version: (await getSnippets()).json.version } })
  expect(JSON.parse(other.stdout).snippets).toContainEqual({ trigger: ';other', replace: 'Changed' })
}, 30_000)

it('places /worker between the control context and the request in worker turns only', async () => {
  const worker = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'worker', title: 'Worker task' })
  const ordinary = await runtime.create({ agent: 'grok', model: GROK_MODEL })
  const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
  expect(worker.title).toBe('Worker task')
  const positions = (text: string) => ({
    control: text.indexOf('[Poise native control]'),
    charter: text.indexOf('[Worker charter — the /worker snippet, revision 1'),
    charterText: text.indexOf(WORKER_SNIPPET_DEFAULT),
    request: text.indexOf('[Request]'),
  })

  await runPrompt(worker.id, 'Do the thing')
  let found = positions(prompts.get(worker.id)!.at(-1)!.text)
  expect(found.control).toBeGreaterThanOrEqual(0)
  expect(found.charter).toBeGreaterThan(found.control)
  expect(found.charterText).toBeGreaterThan(found.charter)
  expect(found.request).toBeGreaterThan(found.charterText)
  expect(prompts.get(worker.id)!.at(-1)!.text.slice(found.request)).toContain('Do the thing')

  store.message(instance, worker.id, 'manager-session', 'Manager note')
  await control.tick()
  await finishTurn(worker.id)
  found = positions(prompts.get(worker.id)!.at(-1)!.text)
  expect(found.charter).toBeGreaterThan(found.control)
  expect(found.request).toBeGreaterThan(found.charter)

  await runPrompt(ordinary.id, 'Ordinary work')
  expect(prompts.get(ordinary.id)!.at(-1)!.text).not.toContain('[Worker charter')
  expect(prompts.get(ordinary.id)!.at(-1)!.text).not.toContain('[Manager charter')

  await runPrompt(manager.id, 'Manager work')
  expect(prompts.get(manager.id)!.at(-1)!.text).toContain('[Manager charter —')
  expect(prompts.get(manager.id)!.at(-1)!.text).not.toContain('[Worker charter')

  await writeFile(matchFile, 'matches:\n  - trigger: ;worker\n    replace: \'   \'\n')
  await runPrompt(worker.id, 'After a hand edit')
  expect(prompts.get(worker.id)!.at(-1)!.text).toContain('[Worker charter] The /worker snippet is empty. Ask the person to write it in Snippets.')
}, 60_000)

it('carries the effective policy on the turns of workers the Manager created', async () => {
  const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
  const owned = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'worker' })
  const lone = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'worker' })
  store.addChild(instance, manager.id, owned.id)

  await runPrompt(owned.id, 'Do the thing')
  const carried = prompts.get(owned.id)!.at(-1)!.text
  const policy = carried.indexOf('[Manager controls — policy version 0.]')
  const charter = carried.indexOf('[Worker charter —')
  expect(policy).toBeGreaterThan(carried.indexOf('[Poise native control]'))
  expect(charter).toBeGreaterThan(policy)

  await runPrompt(lone.id, 'Do the thing')
  expect(prompts.get(lone.id)!.at(-1)!.text).not.toContain('[Manager controls —')
}, 60_000)

it('applies a /worker edit from the next turn and says it supersedes earlier revisions', async () => {
  const worker = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'worker' })
  runtime.prompt(worker.id, { text: 'Long task', attachments: [], mentions: [] })
  await until(() => prompts.has(worker.id))
  expect(prompts.get(worker.id)!.at(-1)!.text).toContain('[Worker charter — the /worker snippet, revision 1')

  const listed = await getSnippets()
  const edited = await putSnippets({ snippets: [{ trigger: ';worker', replace: 'Second revision' }], base_version: listed.json.version }, true)
  expect(edited.status).toBe(200)
  expect(prompts.get(worker.id)!.at(-1)!.text).toContain('[Worker charter — the /worker snippet, revision 1')
  expect(prompts.get(worker.id)!.at(-1)!.text).not.toContain('Second revision')
  await finishTurn(worker.id)

  await runPrompt(worker.id, 'Next task')
  const input = prompts.get(worker.id)!.at(-1)!.text
  expect(input).toContain('[Worker charter — the /worker snippet, revision 2')
  expect(input).toContain('Second revision')
  expect(input).toContain('It supersedes all earlier revisions.')
  expect(input).toContain('a direct request from the person in this chat takes precedence, and it takes precedence over Memories where they conflict.')
}, 30_000)

it('fails worker turns with a named error while /worker cannot be read or is too large', async () => {
  const worker = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'worker' })
  const ordinary = await runtime.create({ agent: 'grok', model: GROK_MODEL })
  await runPrompt(worker.id, 'First task')
  expect(prompts.get(worker.id)).toHaveLength(1)

  await writeFile(matchFile, 'matches: [')
  const finishedBefore = seen.get(worker.id)!.filter(event => event.type === 'turn.finished').length
  runtime.prompt(worker.id, { text: 'Broken library', attachments: [], mentions: [] })
  await until(() => seen.get(worker.id)!.filter(event => event.type === 'turn.finished').length > finishedBefore)
  expect(prompts.get(worker.id)).toHaveLength(1)
  const broken = seen.get(worker.id)!.filter(event => event.type === 'error').at(-1)
  expect(broken).toMatchObject({ message: expect.stringContaining('The /worker snippet could not be read:') })
  await runPrompt(ordinary.id, 'Ordinary work')
  expect(prompts.get(ordinary.id)).toHaveLength(1)

  await writeFile(matchFile, `matches:\n  - trigger: ;worker\n    replace: ${'y'.repeat(65_537)}\n`)
  const finishedBeforeOversized = seen.get(worker.id)!.filter(event => event.type === 'turn.finished').length
  runtime.prompt(worker.id, { text: 'Oversized charter', attachments: [], mentions: [] })
  await until(() => seen.get(worker.id)!.filter(event => event.type === 'turn.finished').length > finishedBeforeOversized)
  expect(prompts.get(worker.id)).toHaveLength(1)
  const oversized = seen.get(worker.id)!.filter(event => event.type === 'error').at(-1)
  expect(oversized).toMatchObject({ message: 'The /worker snippet is larger than 64 KiB. Shorten it in Snippets.' })

  await writeFile(matchFile, 'matches: []\n')
  await runPrompt(worker.id, 'Recovered')
  expect(prompts.get(worker.id)).toHaveLength(2)
  expect(prompts.get(worker.id)!.at(-1)!.text).toContain('[Worker charter —')
}, 60_000)

it('records a worker diagnostic only when the /worker revision advances', async () => {
  expect(charterChanged()).toHaveLength(0)
  await createWorkerViaBrowser()
  await getSnippets()
  expect(charterChanged()).toHaveLength(1)
  expect(charterChanged()[0]).toMatchObject({ context: { revision: 1, created: true } })

  const listed = await getSnippets()
  const edited = await putSnippets({ snippets: [{ trigger: ';worker', replace: 'Work the ticket' }], base_version: listed.json.version }, true)
  expect(edited.status).toBe(200)
  expect(charterChanged()).toHaveLength(2)
  expect(charterChanged()[1]).toMatchObject({ context: { revision: 2, bytes: 15 } })
  expect(charterChanged()[1]).not.toHaveProperty('context.created')
  expect(JSON.stringify(charterChanged()[1])).not.toContain('Work the ticket')
}, 30_000)

it('refuses /worker in non-worker chats before any turn starts', async () => {
  const worker = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'worker' })
  const ordinary = await runtime.create({ agent: 'grok', model: GROK_MODEL })
  const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
  await runPrompt(worker.id, 'Seed the charter')
  expect(prompts.get(worker.id)).toHaveLength(1)

  for (const id of [ordinary.id, manager.id]) {
    expect(() => runtime.prompt(id, { text: '/worker Do X', attachments: [], mentions: [] }))
      .toThrow('/worker is not supported in non-worker chats.')
    expect(seen.get(id)?.some(event => event.type === 'turn.started')).toBe(false)
    expect(prompts.has(id)).toBe(false)
  }

  const queueBefore = messageQueue.readQueue(messageQueue.queueOwner(ordinary.id))
  await expect(runtime.enqueue(ordinary.id, randomUUID(), { text: '/worker Later', attachments: [], mentions: [] }))
    .rejects.toThrow('/worker is not supported in non-worker chats.')
  expect(messageQueue.readQueue(messageQueue.queueOwner(ordinary.id))).toEqual(queueBefore)

  runtime.prompt(ordinary.id, { text: 'Running work', attachments: [], mentions: [] })
  await until(() => finishes.has(ordinary.id))
  await expect(runtime.steer(ordinary.id, '/worker Now')).rejects.toThrow('/worker is not supported in non-worker chats.')
  expect(steers.get(ordinary.id) ?? []).toHaveLength(0)
  await finishTurn(ordinary.id)

  const item: QueuedMessage = { id: randomUUID(), sourceSessionId: ordinary.id, prompt: { text: '/worker Later', attachments: [], mentions: [] },
    agent: 'grok', model: GROK_MODEL, effort: 'xhigh', createdAt: new Date().toISOString(), state: 'waiting' }
  storage.commitQueueMutation(ordinary.id, () => messageQueue.enqueueMessage(messageQueue.queueOwner(ordinary.id), item))
  await runPrompt(ordinary.id, 'Arm the queue')
  await until(() => seen.get(ordinary.id)?.some(event => event.type === 'error' && event.message.includes('/worker is not supported in non-worker chats.')) ?? false)
  expect(prompts.get(ordinary.id)!.every(input => !input.text.includes('/worker Later'))).toBe(true)

  await runPrompt(worker.id, '/worker Check CI')
  const input = prompts.get(worker.id)!.at(-1)!.text
  expect(input.match(/\[Worker charter — the \/worker snippet/g)).toHaveLength(1)
  expect(input.match(/\[Saved switch: \/worker\]/g)).toHaveLength(1)
}, 60_000)

it('refuses unseeded /worker and /manager in the wrong chats instead of sending them to the model', async () => {
  const ordinary = await runtime.create({ agent: 'grok', model: GROK_MODEL })
  // No worker or Manager turn ran, so neither charter was seeded.
  expect((await getSnippets()).json.skills.switches).toEqual([])
  expect(() => runtime.prompt(ordinary.id, { text: '/worker Do X', attachments: [], mentions: [] }))
    .toThrow('/worker is not supported in non-worker chats.')
  expect(() => runtime.prompt(ordinary.id, { text: '/manager Do X', attachments: [], mentions: [] }))
    .toThrow('/manager is not supported in regular chats.')
  expect(() => runtime.prompt(ordinary.id, { text: '/reset /worker task', attachments: [], mentions: [] }))
    .toThrow('/worker is not supported in non-worker chats.')
  expect(seen.get(ordinary.id)?.some(event => event.type === 'turn.started')).toBe(false)
  expect(prompts.has(ordinary.id)).toBe(false)
}, 30_000)

it('lets workers coexist with the Manager and with each other', async () => {
  const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
  const first = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'worker', title: 'First ticket' })
  const second = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'worker', title: 'Second ticket' })
  expect(manager.role).toBe('manager')
  expect(first.role).toBe('worker')
  expect(second.role).toBe('worker')
  expect(storage.getSession(first.id)?.role).toBe('worker')
  expect(runtime.list().filter(s => s.role === 'worker')).toHaveLength(2)
  await expect(runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'boss' as 'worker' }))
    .rejects.toMatchObject({ statusCode: 400, code: 'invalid', message: 'role must be "manager", "worker" or absent' })
}, 30_000)

it('validates roles on subject creation: workers allowed, Managers and unknown roles refused', async () => {
  const subject = { surface: 'current' as const, key: `card:${randomUUID()}`, label: 'A card' }
  const { session, existing } = await runtime.createForSubject({ agent: 'grok', model: GROK_MODEL, role: 'worker', subject, skipLegacy: true })
  expect(existing).toBe(false)
  expect(session.role).toBe('worker')
  expect(session.subject).toMatchObject({ surface: 'current' })
  await expect(runtime.createForSubject({ agent: 'grok', model: GROK_MODEL, role: 'manager', subject: { ...subject, key: `card:${randomUUID()}` } }))
    .rejects.toMatchObject({ statusCode: 400, code: 'invalid', message: 'A Manager has no subject.' })
  await expect(runtime.createForSubject({ agent: 'grok', model: GROK_MODEL, role: 'boss' as 'worker', subject: { ...subject, key: `card:${randomUUID()}` } }))
    .rejects.toMatchObject({ statusCode: 400, code: 'invalid', message: 'role must be "manager", "worker" or absent' })
}, 30_000)
