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
import { MANAGER_SNIPPET_DEFAULT } from '../server/chat/manager-default'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
const managerDefault = vi.hoisted(() => ({ override: undefined as string | undefined }))
vi.mock('../server/chat/manager-default', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/chat/manager-default')>()
  return { get MANAGER_SNIPPET_DEFAULT() { return managerDefault.override ?? actual.MANAGER_SNIPPET_DEFAULT } }
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
let library: typeof import('../server/snippet-library')
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
  root = await mkdtemp(join(tmpdir(), 'poise-manager-charter-'))
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
  library = await import('../server/snippet-library')
  messageQueue = await import('../server/chat/message-queue')
  logging = await import('../server/logging')
})
beforeEach(async () => {
  prompts.clear(); finishes.clear(); steers.clear(); seen.clear()
  servers = []
  managerDefault.override = undefined
  database.setMeta('chat_custom_switches', '')
  database.db.prepare("DELETE FROM meta WHERE key LIKE 'chat_snippet_%'").run()
  await rm(join(root, 'match'), { recursive: true, force: true })
  await logging.stopLogging()
  await rm(join(root, 'logging.db'), { force: true })
  logging.startLogging()
  instance = `charter:${randomUUID()}`
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
function putMemories(body: unknown, withOrigin: boolean) {
  return fetch(`${origin}/api/chat/memories`, { method: 'PUT',
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
    found.push(...page.events.filter(record => record.operation === 'chat.manager.charter.changed'))
    if (!page.hasMore) return found
    cursor = page.cursor
  }
}
async function createManagerViaBrowser() {
  const created = await postSessions({ agent: 'grok', model: GROK_MODEL, role: 'manager' }, true)
  expect(created.status).toBe(201)
  return (await created.json() as { session: { id: string } }).session
}

it('creates /manager from the default file while a Manager exists and never replaces it', async () => {
  await control.tick(); await control.tick(); await control.tick()
  expect((await getSnippets()).status).toBe(200)
  expect(existsSync(matchFile)).toBe(false)

  const manager = await createManagerViaBrowser()
  expect(await readFile(matchFile, 'utf8')).toContain(';manager')
  const listed = await getSnippets()
  expect(listed.json.snippets).toContainEqual({ trigger: ';manager', replace: MANAGER_SNIPPET_DEFAULT })
  expect(MANAGER_SNIPPET_DEFAULT).toContain('standalone PRD labelled prd')
  expect(MANAGER_SNIPPET_DEFAULT).toContain('live work table')
  expect(MANAGER_SNIPPET_DEFAULT).toContain('take precedence over this charter')
  expect(MANAGER_SNIPPET_DEFAULT).not.toContain('native merge queue')
  expect(MANAGER_SNIPPET_DEFAULT).not.toContain('muse-spark')
  expect(listed.json.skills.switches).toContainEqual(expect.objectContaining({ name: 'manager', content: MANAGER_SNIPPET_DEFAULT }))
  expect(charterChanged()).toHaveLength(1)
  expect(charterChanged()[0]).toMatchObject({ context: { revision: 1, created: true } })

  const edited = await putSnippets({ snippets: [{ trigger: ';manager', replace: 'Edited' }], base_version: listed.json.version }, true)
  expect(edited.status).toBe(200)
  const bytesBefore = await readFile(matchFile)
  managerDefault.override = 'Changed default'
  try {
    await restart()
    expect(await readFile(matchFile)).toEqual(bytesBefore)
    expect((await getSnippets()).json.snippets).toContainEqual({ trigger: ';manager', replace: 'Edited' })

    await writeFile(matchFile, 'matches: []\n')
    await runPrompt(manager.id, 'Check the workspace')
    const input = prompts.get(manager.id)!.at(-1)!
    expect(input.text).toContain('Changed default')
    expect(await readFile(matchFile, 'utf8')).toContain(';manager')
  } finally {
    managerDefault.override = undefined
  }
}, 30_000)

it('adopts an existing snippet named manager as the built-in', async () => {
  const initial = await getSnippets()
  const seeded = await putSnippets({ snippets: [{ trigger: ':manager', replace: 'Mine' }], base_version: initial.json.version }, true)
  expect(seeded.status).toBe(200)
  const bytesBefore = await readFile(matchFile, 'utf8')
  expect(bytesBefore).toContain(':manager')

  await createManagerViaBrowser()
  const bytesAfter = await readFile(matchFile, 'utf8')
  expect(bytesAfter).toEqual(bytesBefore)
  expect(bytesAfter).not.toContain(';manager')

  const manager = runtime.list().find(session => session.role === 'manager')!
  await runPrompt(manager.id, 'Check the workspace')
  const input = prompts.get(manager.id)!.at(-1)!
  expect(input.text).toContain('[Manager charter —')
  expect(input.text).toContain('Mine')

  const current = await getSnippets()
  const removed = await putSnippets({ snippets: [], base_version: current.json.version }, true)
  expect(removed.status).toBe(400)
  expect(await removed.json()).toEqual({ error: '/manager is built in. You can edit its text, but not delete it or change its trigger.' })
}, 30_000)

it('refuses to delete /manager or change its trigger on every path and lets the person edit it', async () => {
  await createManagerViaBrowser()
  const listed = await getSnippets()
  const bytesBefore = await readFile(matchFile)

  const deleted = await putSnippets({ snippets: [], base_version: listed.json.version }, true)
  expect(deleted.status).toBe(400)
  expect(await deleted.json()).toEqual({ error: '/manager is built in. You can edit its text, but not delete it or change its trigger.' })
  const retriggered = await putSnippets({ snippets: [{ trigger: ';boss', replace: MANAGER_SNIPPET_DEFAULT }], base_version: listed.json.version }, true)
  expect(retriggered.status).toBe(400)
  expect(await retriggered.json()).toEqual({ error: '/manager is built in. You can edit its text, but not delete it or change its trigger.' })
  expect(await readFile(matchFile)).toEqual(bytesBefore)

  const edited = await putSnippets({ snippets: [{ trigger: ';manager', replace: 'Person text' }], base_version: listed.json.version }, true)
  expect(edited.status).toBe(200)
  expect((await getSnippets()).json.snippets).toContainEqual({ trigger: ';manager', replace: 'Person text' })

  const catalogue = await getSnippets()
  const revision = catalogue.json.skills.switches.find(item => item.name === 'manager')!.revision
  const created = await runtime.createSwitch({ name: 'manager', content: 'Via create', revision })
  expect(created.switches.find(item => item.name === 'manager')?.content).toBe('Via create')
  await expect(runtime.createSwitch({ name: 'manager', content: '   ', revision: revision + 1 }))
    .rejects.toThrow('The switch instructions cannot be empty.')
  expect((await getSnippets()).json.snippets).toContainEqual({ trigger: ';manager', replace: 'Via create' })

  const oversized = await putSnippets({ snippets: [{ trigger: ';manager', replace: 'x'.repeat(65_537) }], base_version: (await getSnippets()).json.version }, true)
  expect(oversized.status).toBe(413)
  expect(await oversized.json()).toEqual({ error: 'The /manager snippet holds up to 64 KiB. Nothing was saved.' })

  const imported = await fetch(`${origin}/api/snippets/import`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ yaml: 'matches:\n  - trigger: ;manager\n    replace: Imported\n' }) })
  expect(imported.status).toBe(200)
  const report = await imported.json() as { added: string[], skipped: Array<{ trigger: string | null, reason: string }> }
  expect(report.added).toEqual([])
  expect(report.skipped).toContainEqual(expect.objectContaining({ trigger: ';manager', reason: 'duplicate' }))
  expect((await getSnippets()).json.snippets).toContainEqual({ trigger: ';manager', replace: 'Via create' })
}, 30_000)

it('refuses /manager and Memories changes through the native control api operation', async () => {
  const manager = await createManagerViaBrowser()
  const connection = await config(manager.id)
  const listed = await getSnippets()
  await putSnippets({ snippets: [...listed.json.snippets, { trigger: ';other', replace: 'Other' }], base_version: listed.json.version }, true)

  const rewrite = await api(connection.path, { operation: 'api', path: '/api/snippets', method: 'PUT',
    body: { snippets: [{ trigger: ';manager', replace: 'Injected' }, { trigger: ';other', replace: 'Other' }], base_version: (await getSnippets()).json.version } })
    .then(() => null, error => error as { code?: number, stderr?: string })
  expect(rewrite?.code).toBe(1)
  expect(String(rewrite?.stderr)).toContain('"status":403')
  expect(String(rewrite?.stderr)).toContain('The /manager snippet is edited in the browser.')
  expect((await getSnippets()).json.snippets).toContainEqual({ trigger: ';manager', replace: MANAGER_SNIPPET_DEFAULT })

  const other = await api(connection.path, { operation: 'api', path: '/api/snippets', method: 'PUT',
    body: { snippets: [{ trigger: ';manager', replace: MANAGER_SNIPPET_DEFAULT }, { trigger: ';other', replace: 'Changed' }], base_version: (await getSnippets()).json.version } })
  expect(JSON.parse(other.stdout).snippets).toContainEqual({ trigger: ';other', replace: 'Changed' })

  await writeFile(matchFile, 'matches:\n  - trigger: ;other\n    replace: Changed\n')
  const inject = await api(connection.path, { operation: 'api', path: '/api/snippets', method: 'POST',
    body: { trigger: ';manager', replace: 'Injected' } }).then(() => null, error => error as { code?: number, stderr?: string })
  expect(inject?.code).toBe(1)
  expect(String(inject?.stderr)).toContain('"status":403')
  expect(await readFile(matchFile, 'utf8')).not.toContain('Injected')

  const memories = await (await fetch(`${origin}/api/chat/memories`)).json() as { text: string, revision: number }
  const steal = await api(connection.path, { operation: 'api', path: '/api/chat/memories', method: 'PUT',
    body: { text: 'Injected standing instruction', revision: memories.revision } }).then(() => null, error => error as { code?: number, stderr?: string })
  expect(steal?.code).toBe(1)
  expect(String(steal?.stderr)).toContain('"status":403')
  expect(String(steal?.stderr)).toContain('Memories are edited in the browser.')
  expect(((await (await fetch(`${origin}/api/chat/memories`)).json()) as { text: string }).text).toBe(memories.text)

  const saved = await putMemories({ text: 'Person memories', revision: memories.revision }, true)
  expect(saved.status).toBe(200)
}, 30_000)

it('places /manager between the control context and the request in Manager turns only, in every Auto-merge state', async () => {
  const memories = await (await fetch(`${origin}/api/chat/memories`)).json() as { text: string, revision: number }
  expect((await putMemories({ text: 'Saved memories', revision: memories.revision }, true)).status).toBe(200)
  const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
  const ordinary = await runtime.create({ agent: 'grok', model: GROK_MODEL })
  const positions = (text: string) => ({
    modeOn: text.indexOf('[Poise session mode: Auto-merge ON'),
    modeOff: text.indexOf('[Poise session mode: Auto-merge OFF'),
    userRequest: text.indexOf('[User request]'),
    control: text.indexOf('[Poise native control]'),
    charter: text.indexOf('[Manager charter — the /manager snippet, revision 1'),
    charterText: text.indexOf(MANAGER_SNIPPET_DEFAULT),
    request: text.indexOf('[Request]'),
  })

  await runPrompt(manager.id, 'Do the thing')
  let found = positions(prompts.get(manager.id)!.at(-1)!.text)
  expect(found.modeOn).toBe(-1); expect(found.modeOff).toBe(-1); expect(found.userRequest).toBe(-1)
  expect(found.control).toBeGreaterThanOrEqual(0)
  expect(found.charter).toBeGreaterThan(found.control)
  expect(found.charterText).toBeGreaterThan(found.charter)
  expect(found.request).toBeGreaterThan(found.charterText)
  expect(prompts.get(manager.id)!.at(-1)!.text.slice(found.request)).toContain('Do the thing')

  store.message(instance, manager.id, 'worker-session', 'Worker needs help')
  await control.tick()
  await finishTurn(manager.id)
  found = positions(prompts.get(manager.id)!.at(-1)!.text)
  expect(found.charter).toBeGreaterThan(found.control)
  expect(found.request).toBeGreaterThan(found.charter)
  expect(found.userRequest).toBe(-1)

  await runtime.setAutoMerge(manager.id, true)
  await runPrompt(manager.id, 'Do the thing')
  const on = prompts.get(manager.id)!.at(-1)!
  found = positions(on.text)
  for (const [earlier, later] of [['modeOn', 'userRequest'], ['userRequest', 'control'], ['control', 'charter'], ['charter', 'charterText'], ['charterText', 'request']] as const) {
    expect(found[earlier]).toBeGreaterThanOrEqual(0)
    expect(found[later]).toBeGreaterThan(found[earlier])
  }
  expect(on.text.slice(found.request)).toContain('Do the thing')
  expect(on.memories).toBe('Saved memories')
  store.message(instance, manager.id, 'worker-session', 'Worker needs help')
  await control.tick()
  await finishTurn(manager.id)
  found = positions(prompts.get(manager.id)!.at(-1)!.text)
  expect(found.modeOn).toBeGreaterThanOrEqual(0)
  expect(found.userRequest).toBe(-1)
  expect(found.charter).toBeGreaterThan(found.control)
  expect(found.request).toBeGreaterThan(found.charter)

  await runtime.setAutoMerge(manager.id, false)
  await runPrompt(manager.id, 'Do the thing')
  const off = prompts.get(manager.id)!.at(-1)!
  found = positions(off.text)
  expect(found.modeOff).toBeGreaterThanOrEqual(0)
  expect(found.userRequest).toBeGreaterThan(found.modeOff)
  expect(found.charter).toBeGreaterThan(found.control)
  expect(found.request).toBeGreaterThan(found.charterText)
  store.message(instance, manager.id, 'worker-session', 'Worker needs help')
  await control.tick()
  await finishTurn(manager.id)
  found = positions(prompts.get(manager.id)!.at(-1)!.text)
  expect(found.modeOff).toBeGreaterThanOrEqual(0)
  expect(found.userRequest).toBe(-1)
  expect(found.charter).toBeGreaterThan(found.control)
  expect(found.request).toBeGreaterThan(found.charter)

  await runtime.setAutoMerge(ordinary.id, true)
  await runPrompt(ordinary.id, 'Ordinary work')
  expect(prompts.get(ordinary.id)!.at(-1)!.text).not.toContain('[Manager charter')

  await writeFile(matchFile, 'matches:\n  - trigger: ;manager\n    replace: \'   \'\n')
  await runPrompt(manager.id, 'After a hand edit')
  expect(prompts.get(manager.id)!.at(-1)!.text).toContain('[Manager charter] The /manager snippet is empty. Ask the person to write it in Snippets.')
}, 60_000)

it('carries the effective policy above the charter on every Manager turn', async () => {
  const { setSettings } = await import('../server/settings')
  const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
  const text = async () => prompts.get(manager.id)!.at(-1)!.text
  await runPrompt(manager.id, 'Do the thing')
  const control = (await text()).indexOf('[Poise native control]')
  const policy = (await text()).indexOf('[Manager controls — policy version 0.]')
  const charter = (await text()).indexOf('[Manager charter —')
  expect(policy).toBeGreaterThan(control)
  expect(charter).toBeGreaterThan(policy)
  expect(await text()).toContain('Rhythm: 5 Manager slots.')
  expect(await text()).toContain('Precedence: a direct request from the person in this chat first, then these controls, then the charter, then Memories.')

  setSettings({ manager: { rhythm: 2 } as never })
  await runPrompt(manager.id, 'Do the next thing')
  expect(await text()).toContain('[Manager controls — policy version 1.]')
  expect(await text()).toContain('Rhythm: 2 Manager slots.')
}, 60_000)

it('applies a /manager edit from the next turn and says it supersedes earlier revisions', async () => {
  const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
  runtime.prompt(manager.id, { text: 'Long task', attachments: [], mentions: [] })
  await until(() => prompts.has(manager.id))
  expect(prompts.get(manager.id)!.at(-1)!.text).toContain('[Manager charter — the /manager snippet, revision 1')

  const listed = await getSnippets()
  const edited = await putSnippets({ snippets: [{ trigger: ';manager', replace: 'Second revision' }], base_version: listed.json.version }, true)
  expect(edited.status).toBe(200)
  expect(prompts.get(manager.id)!.at(-1)!.text).toContain('[Manager charter — the /manager snippet, revision 1')
  expect(prompts.get(manager.id)!.at(-1)!.text).not.toContain('Second revision')
  await finishTurn(manager.id)

  await runPrompt(manager.id, 'Next task')
  const input = prompts.get(manager.id)!.at(-1)!.text
  expect(input).toContain('[Manager charter — the /manager snippet, revision 2')
  expect(input).toContain('Second revision')
  expect(input).toContain('It supersedes all earlier revisions.')
  expect(input).toContain('a direct request from the person in this chat takes precedence, and it takes precedence over Memories where they conflict.')
}, 30_000)

it('fails Manager turns with a named error while /manager cannot be read or is too large', async () => {
  const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
  const ordinary = await runtime.create({ agent: 'grok', model: GROK_MODEL })
  await runPrompt(manager.id, 'First task')
  expect(prompts.get(manager.id)).toHaveLength(1)

  await writeFile(matchFile, 'matches: [')
  const finishedBefore = seen.get(manager.id)!.filter(event => event.type === 'turn.finished').length
  runtime.prompt(manager.id, { text: 'Broken library', attachments: [], mentions: [] })
  await until(() => seen.get(manager.id)!.filter(event => event.type === 'turn.finished').length > finishedBefore)
  expect(prompts.get(manager.id)).toHaveLength(1)
  const broken = seen.get(manager.id)!.filter(event => event.type === 'error').at(-1)
  expect(broken).toMatchObject({ message: expect.stringContaining('The /manager snippet could not be read:') })
  await runPrompt(ordinary.id, 'Ordinary work')
  expect(prompts.get(ordinary.id)).toHaveLength(1)

  await writeFile(matchFile, `matches:\n  - trigger: ;manager\n    replace: ${'y'.repeat(65_537)}\n`)
  const finishedBeforeOversized = seen.get(manager.id)!.filter(event => event.type === 'turn.finished').length
  runtime.prompt(manager.id, { text: 'Oversized charter', attachments: [], mentions: [] })
  await until(() => seen.get(manager.id)!.filter(event => event.type === 'turn.finished').length > finishedBeforeOversized)
  expect(prompts.get(manager.id)).toHaveLength(1)
  const oversized = seen.get(manager.id)!.filter(event => event.type === 'error').at(-1)
  expect(oversized).toMatchObject({ message: 'The /manager snippet is larger than 64 KiB. Shorten it in Snippets.' })

  await writeFile(matchFile, 'matches: []\n')
  await runPrompt(manager.id, 'Recovered')
  expect(prompts.get(manager.id)).toHaveLength(2)
  expect(prompts.get(manager.id)!.at(-1)!.text).toContain('[Manager charter —')
}, 60_000)

it('lets /manager write failures throw instead of reporting unreadable', async () => {
  // Fill the library to just under the 1 MiB serialized cap, measuring the
  // real YAML/header overhead so the top-up lands exactly.
  const listed = await getSnippets()
  const probeSize = 1024 * 1024 - 65536
  await library.saveSkillSnippets([{ trigger: ';big', replace: 'x'.repeat(probeSize) }], listed.json.version, true)
  const overhead = (await readFile(matchFile, 'utf8')).length - probeSize
  const topped = await library.readSkillSnippets()
  await library.saveSkillSnippets([{ trigger: ';big', replace: 'x'.repeat(1024 * 1024 - overhead - 300) }], topped.version, true)

  await expect(library.ensureSnippetSwitch('manager', MANAGER_SNIPPET_DEFAULT)).rejects.toThrow('serialized snippets exceed 1048576 bytes')
  expect(await readFile(matchFile, 'utf8')).not.toContain(';manager')

  const logs: string[] = []
  runtime.on('log', (line: string) => { logs.push(line) })
  const manager = await createManagerViaBrowser()
  expect(logs).toContainEqual(expect.stringContaining('[chat] creating /manager failed: serialized snippets exceed 1048576 bytes'))

  runtime.prompt(manager.id, { text: 'Do the thing', attachments: [], mentions: [] })
  await until(() => seen.get(manager.id)?.some(event => event.type === 'turn.finished') ?? false)
  const failure = seen.get(manager.id)!.filter(event => event.type === 'error').at(-1)
  expect(failure).toMatchObject({ message: expect.stringContaining('serialized snippets exceed 1048576 bytes') })
  expect(JSON.stringify(failure)).not.toContain('it is missing')
}, 30_000)

it('records a diagnostic only when the /manager revision advances', async () => {
  expect(charterChanged()).toHaveLength(0)
  await createManagerViaBrowser()
  await getSnippets()
  expect(charterChanged()).toHaveLength(1)
  expect(charterChanged()[0]).toMatchObject({ context: { revision: 1, created: true } })

  const listed = await getSnippets()
  const edited = await putSnippets({ snippets: [{ trigger: ';manager', replace: 'Watch every worker' }], base_version: listed.json.version }, true)
  expect(edited.status).toBe(200)
  expect(charterChanged()).toHaveLength(2)
  expect(charterChanged()[1]).toMatchObject({ context: { revision: 2, bytes: 18 } })
  expect(charterChanged()[1]).not.toHaveProperty('context.created')
  expect(JSON.stringify(charterChanged()[1])).not.toContain('Watch every worker')

  const current = await getSnippets()
  expect((await putSnippets({ snippets: current.json.snippets, base_version: current.json.version }, true)).status).toBe(200)
  expect((await putSnippets({ snippets: [], base_version: (await getSnippets()).json.version }, true)).status).toBe(400)
  expect((await putSnippets({ snippets: [{ trigger: ';manager', replace: 'Intruder' }], base_version: (await getSnippets()).json.version }, false)).status).toBe(403)
  expect((await putSnippets({ snippets: [{ trigger: ';manager', replace: 'x'.repeat(65_537) }], base_version: (await getSnippets()).json.version }, true)).status).toBe(413)
  expect(charterChanged()).toHaveLength(2)

  await writeFile(matchFile, 'matches:\n  - trigger: ;manager\n    replace: Hand edit\n')
  expect(charterChanged()).toHaveLength(2)
  await getSnippets()
  expect(charterChanged()).toHaveLength(3)
  expect(charterChanged()[2]).toMatchObject({ context: { revision: 3 } })
}, 30_000)

it('refuses /manager in regular chats before any turn starts', async () => {
  const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
  const ordinary = await runtime.create({ agent: 'grok', model: GROK_MODEL })
  await runPrompt(manager.id, 'Seed the charter')
  expect(prompts.get(manager.id)).toHaveLength(1)

  expect(() => runtime.prompt(ordinary.id, { text: '/manager Do X', attachments: [], mentions: [] }))
    .toThrow('/manager is not supported in regular chats.')
  expect(seen.get(ordinary.id)?.some(event => event.type === 'turn.started')).toBe(false)
  expect(prompts.has(ordinary.id)).toBe(false)

  const queueBefore = messageQueue.readQueue(messageQueue.queueOwner(ordinary.id))
  await expect(runtime.enqueue(ordinary.id, randomUUID(), { text: '/manager Later', attachments: [], mentions: [] }))
    .rejects.toThrow('/manager is not supported in regular chats.')
  expect(messageQueue.readQueue(messageQueue.queueOwner(ordinary.id))).toEqual(queueBefore)

  runtime.prompt(ordinary.id, { text: 'Running work', attachments: [], mentions: [] })
  await until(() => finishes.has(ordinary.id))
  await expect(runtime.steer(ordinary.id, '/manager Now')).rejects.toThrow('/manager is not supported in regular chats.')
  expect(steers.get(ordinary.id) ?? []).toHaveLength(0)
  await finishTurn(ordinary.id)

  const item: QueuedMessage = { id: randomUUID(), sourceSessionId: ordinary.id, prompt: { text: '/manager Later', attachments: [], mentions: [] },
    agent: 'grok', model: GROK_MODEL, effort: 'xhigh', createdAt: new Date().toISOString(), state: 'waiting' }
  storage.commitQueueMutation(ordinary.id, () => messageQueue.enqueueMessage(messageQueue.queueOwner(ordinary.id), item))
  await runPrompt(ordinary.id, 'Arm the queue')
  await until(() => seen.get(ordinary.id)?.some(event => event.type === 'error' && event.message.includes('/manager is not supported in regular chats.')) ?? false)
  expect(prompts.get(ordinary.id)!.every(input => !input.text.includes('/manager Later'))).toBe(true)

  await runPrompt(manager.id, '/manager Check CI')
  const input = prompts.get(manager.id)!.at(-1)!.text
  expect(input.match(/\[Manager charter — the \/manager snippet/g)).toHaveLength(1)
  expect(input.match(/\[Saved switch: \/manager\]/g)).toHaveLength(1)
}, 60_000)
