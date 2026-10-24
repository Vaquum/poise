import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities, PromptInput } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'
import type { ChatControl, CiObservation, MergeWakeObservation, OpenPrClosingList, ReviewsCursor, ReviewsObservation, WorkTargetStatus } from '../server/chat/control'
import type { Organization } from '../server/organizations'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
const caps: Capabilities = { steer: true, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
let root: string
let runtime: ChatRuntime
let control: ChatControl
let server: Server
let origin: string
let clock: number
let instance: string
let workspaceRoot: string
let store: typeof import('../server/chat/control-store')
let database: typeof import('../server/db')
let Runtime: typeof ChatRuntime
let Control: typeof ChatControl
const prompts = new Map<string, PromptInput[]>()
const finishes = new Map<string, (result: TurnResult) => void>()
const ci = vi.fn<() => Promise<CiObservation>>()
const targetStatus = vi.fn<(target: { url: string, repo: string, kind: 'issues' | 'pull', number: number }) => Promise<WorkTargetStatus>>()
const reviews = vi.fn<(target: { url: string, repo: string, kind: 'issues' | 'pull', number: number }, cursor?: ReviewsCursor) => Promise<ReviewsObservation | null>>()
const ownsBehind = vi.fn<(target: { url: string, repo: string, kind: 'issues' | 'pull', number: number }, ci: CiObservation, status: WorkTargetStatus) => boolean>()
const mergeWake = vi.fn<(target: { url: string, repo: string, kind: 'issues' | 'pull', number: number }) => Promise<MergeWakeObservation | null>>()
const closingRefs = vi.fn<(org: Organization, repo: string, after?: number) => Promise<OpenPrClosingList | null>>()

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
vi.setConfig({ testTimeout: 25_000, hookTimeout: 25_000 })
async function until(check: () => boolean) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) { if (check()) return; await new Promise(done => setTimeout(done, 15)) }
  throw new Error('autobind fixture readiness deadline')
}
async function observeMerge(target: string): Promise<void> {
  await control.tick()
  await until(() => store.observation(runtime.instance, `merge:${target}`)?.checked_at === clock)
}
async function observeReviews(target: string): Promise<void> {
  await control.tick()
  await until(() => store.observation(runtime.instance, `reviews:${target}`)?.checked_at === clock)
}
async function config(id: string) {
  const context = await control.context(id)
  const path = /"([^"\n]+\.json)"/.exec(context)?.[1]
  if (!path) throw new Error('native control connection missing')
  return { path, ...JSON.parse(await readFile(path, 'utf8')) as { token: string, sessionId: string, origin: string } }
}
async function request(id: string, command: Record<string, unknown>) {
  const connection = await config(id)
  return fetch(`${origin}/api/chat/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Poise-Chat': id, Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ requestId: randomUUID(), ...command }) })
}
async function command(id: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await request(id, input)
  const body = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(JSON.stringify(body))
  return (body.result ?? body) as Record<string, unknown>
}
async function manager() {
  const model = CATALOG.models.find(m => m.provider === 'grok')
  if (!model) throw new Error('fixture lacks grok')
  return runtime.create({ agent: 'grok', model: model.identity, title: 'Manager', deferStart: true })
}
function makeRuntime() {
  return new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: adapter }, requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => 64, controlContext: id => control.context(id) })
}
function seedAcme() {
  database.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
    VALUES ('acme', ?, 1, 'ready', 'ready', ?)`).run(join(root, 'acme.sqlite'), 'fixture-agent')
  // A managed org reads ready only when its indexed user is the current me.
  database.setMeta('me', 'fixture-agent')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-autobind-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  ;({ ChatControl: Control } = await import('../server/chat/control'))
  store = await import('../server/chat/control-store')
  database = await import('../server/db')
})
beforeEach(async () => {
  clock = Date.now()
  prompts.clear(); finishes.clear()
  ci.mockReset().mockResolvedValue({ head: 'a'.repeat(40), failing: [] })
  targetStatus.mockReset().mockResolvedValue('open')
  reviews.mockReset().mockResolvedValue(null)
  ownsBehind.mockReset().mockReturnValue(false)
  mergeWake.mockReset().mockResolvedValue(null)
  closingRefs.mockReset().mockResolvedValue({ prs: [], truncated: false, more: false })
  instance = `autobind:${randomUUID()}`
  workspaceRoot = join(root, randomUUID())
  runtime = makeRuntime()
  control = new Control(runtime, { ci, now: () => clock, targetStatus, reviews, ownsBehind, mergeWake, closingRefs })
  server = createServer((req, res) => {
    if (req.url === '/api/chat/control') { void control.handle(req, res); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ nativeApi: true, path: req.url }))
  })
  control.attach(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture needs TCP')
  origin = `http://127.0.0.1:${address.port}`
  control.start()
  seedAcme()
})
afterEach(async () => {
  await control?.stop()
  await runtime?.stop()
  await new Promise<void>(done => server.close(() => done()))
  database.db.prepare('DELETE FROM organizations WHERE login = ?').run('acme')
  database.setMeta('me', '')
})
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

const ISSUE = 'https://github.com/acme/app/issues/7'
const PR = 'https://github.com/acme/app/pull/12'
function listingFor(issueNumber: number, prNumber = 12): OpenPrClosingList {
  return { prs: [{ repo: 'acme/app', number: prNumber, url: `https://github.com/acme/app/pull/${prNumber}`,
    closing: [{ repo: 'acme/app', number: issueNumber }], closesVia: 'closing-references', closingTruncated: false }], truncated: false, more: false }
}

describe('automatic PR binding through closing references', () => {
  it('binds the PR closing a created worker\'s issue and wakes it for CI failure', async () => {
    const parent = await manager()
    const created = await command(parent.id, { operation: 'create', title: 'Worker', task: 'Fix the issue' })
    const worker = (created.session as { id: string }).id
    // An ordinary control-created worker: no repo, a private scratch branch
    // no PR head ref can match, so only the closing reference can find it.
    expect(runtime.get(worker)?.repo).toBe('')
    expect(runtime.get(worker)?.branch.name).toMatch(/^chat\//)
    await command(worker, { operation: 'bind', target: ISSUE })
    closingRefs.mockResolvedValue(listingFor(7))
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing: [{ name: 'Verify', state: 'completed', conclusion: 'failure' }] })
    // Past any window a 1s interval tick burned while setup was slow.
    clock += 61_000
    await control.tick()
    await until(() => prompts.has(worker))
    expect(prompts.get(worker)).toHaveLength(1)
    // Delivery starts the task turn before the background pass discovers.
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(worker)
    expect(store.bindings(runtime.instance).find(b => b.target === ISSUE)?.session).toBe(worker)
    finishes.get(worker)!({ stopReason: 'end_turn' })
    await until(() => (prompts.get(worker)?.length ?? 0) === 2)
    expect(prompts.get(worker)![1].text).toContain('failure')
    expect(store.inbox(runtime.instance, worker).some(m => m.event_key.startsWith('ci:'))).toBe(true)
  }, 60_000)

  it('receives conflict, behind and review notices for the auto-bound PR', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: ISSUE })
    closingRefs.mockResolvedValue(listingFor(7))
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing: [], mergeable: false, mergeableState: 'dirty', author: 'other', draft: false, base: 'main' })
    clock += 61_000
    await observeMerge(PR)
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(parent.id)
    expect(store.inbox(runtime.instance, parent.id).some(m => JSON.parse(m.body).kind === 'merge')).toBe(true)
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing: [], mergeable: true, mergeableState: 'behind', author: 'other', draft: false, base: 'main' })
    clock += 5 * 60_000
    await observeMerge(PR)
    const bodies = store.inbox(runtime.instance, parent.id).map(m => JSON.parse(m.body))
    expect(bodies.some(notice => notice.kind === 'merge' && notice.behind === true)).toBe(true)
    reviews.mockResolvedValue({ found: true, truncated: false, reviews: [{ id: 'R_1', author: 'reviewer', state: 'CHANGES_REQUESTED' }],
      threads: [{ thread: 'T_1', resolved: false, outdated: false, comments: [{ id: 'C_1', author: 'reviewer' }] }] })
    clock += 5 * 60_000
    await observeReviews(PR)
    expect(store.inbox(runtime.instance, parent.id).some(m => JSON.parse(m.body).kind === 'reviews')).toBe(true)
  })

  it('never takes another chat\'s explicit binding', async () => {
    const first = await manager(), second = await manager()
    await command(second.id, { operation: 'bind', target: PR })
    await command(first.id, { operation: 'bind', target: ISSUE })
    closingRefs.mockResolvedValue(listingFor(7))
    const listed = closingRefs.mock.calls.length
    clock += 61_000
    await control.tick()
    await until(() => closingRefs.mock.calls.length > listed)
    await until(() => store.observation(runtime.instance, `behavior:${ISSUE}`)?.checked_at === clock)
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(second.id)
  })

  it('never rebinds after unbind, and an explicit re-bind holds', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: ISSUE })
    closingRefs.mockResolvedValue(listingFor(7))
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    await command(parent.id, { operation: 'unbind', target: PR })
    expect(store.bindingReleased(runtime.instance, parent.id, PR)).toBe(true)
    const listed = closingRefs.mock.calls.length
    clock += 61_000
    await control.tick()
    await until(() => closingRefs.mock.calls.length > listed)
    await until(() => store.observation(runtime.instance, `behavior:${ISSUE}`)?.checked_at === clock)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
    await command(parent.id, { operation: 'bind', target: PR })
    expect(store.bindingReleased(runtime.instance, parent.id, PR)).toBe(false)
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(parent.id)
  })

  it('skips closed and unknown chats', async () => {
    await manager()
    store.bindWork(runtime.instance, randomUUID(), ISSUE)
    closingRefs.mockResolvedValue(listingFor(7))
    const listed = closingRefs.mock.calls.length
    clock += 61_000
    await control.tick()
    await until(() => closingRefs.mock.calls.length > listed)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
    const worker = await manager()
    await command(worker.id, { operation: 'bind', target: 'https://github.com/acme/app/issues/8' })
    await runtime.close(worker.id)
    store.bindWork(runtime.instance, worker.id, 'https://github.com/acme/app/issues/8')
    closingRefs.mockResolvedValue(listingFor(8))
    const relisted = closingRefs.mock.calls.length
    clock += 61_000
    await control.tick()
    await until(() => closingRefs.mock.calls.length > relisted)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
  })

  it('leaves a PR closing several chats\' issues unbound', async () => {
    const first = await manager(), second = await manager()
    await command(first.id, { operation: 'bind', target: ISSUE })
    await command(second.id, { operation: 'bind', target: 'https://github.com/acme/app/issues/8' })
    closingRefs.mockResolvedValue({ prs: [{ repo: 'acme/app', number: 12, url: PR,
      closing: [{ repo: 'acme/app', number: 7 }, { repo: 'acme/app', number: 8 }], closesVia: 'closing-references', closingTruncated: false }],
      truncated: false, more: false })
    const listed = closingRefs.mock.calls.length
    clock += 61_000
    await control.tick()
    await until(() => closingRefs.mock.calls.length > listed)
    await until(() => store.observation(runtime.instance, `behavior:${ISSUE}`)?.checked_at === clock)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
  })

  it('discovers a PR that appears after a failed or empty listing', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: ISSUE })
    closingRefs.mockResolvedValue(null)
    const listed = closingRefs.mock.calls.length
    clock += 61_000
    await control.tick()
    await until(() => closingRefs.mock.calls.length > listed)
    await until(() => store.observation(runtime.instance, `behavior:${ISSUE}`)?.checked_at === clock)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
    closingRefs.mockResolvedValue(listingFor(7))
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(parent.id)
  })

  it('reads one local listing per repository per minute and nothing else', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: ISSUE })
    const listed = closingRefs.mock.calls.length
    clock += 61_000
    await control.tick()
    await until(() => closingRefs.mock.calls.length > listed)
    await until(() => store.observation(runtime.instance, `behavior:${ISSUE}`)?.checked_at === clock)
    const calls = closingRefs.mock.calls.length
    expect(closingRefs.mock.calls[calls - 1]?.[0]).toMatchObject({ login: 'acme' })
    expect(closingRefs.mock.calls[calls - 1]?.slice(1)).toEqual(['acme/app', undefined])
    expect(ci).not.toHaveBeenCalled()
    expect(targetStatus).not.toHaveBeenCalled()
    expect(reviews).not.toHaveBeenCalled()
    // A new pass inside the same window observes again but lists nothing.
    clock += 1_000
    await control.tick()
    await until(() => store.observation(runtime.instance, `behavior:${ISSUE}`)?.checked_at === clock)
    expect(closingRefs.mock.calls.length).toBe(calls)
  })

  it('keeps created_at and baselines on repeated discovery', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: ISSUE })
    closingRefs.mockResolvedValue(listingFor(7))
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing: [{ name: 'Verify', state: 'completed', conclusion: 'failure' }] })
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    await until(() => store.inbox(runtime.instance, parent.id).length === 1)
    const created = store.bindings(runtime.instance).find(b => b.target === PR)?.created_at
    const listed = closingRefs.mock.calls.length
    clock += 61_000
    await control.tick()
    await until(() => closingRefs.mock.calls.length > listed)
    clock += 5 * 60_000
    await control.tick()
    await until(() => store.observation(runtime.instance, `ci:${PR}`)?.checked_at === clock)
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.created_at).toBe(created)
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(1)
  })

  it('binds the handoff target, never the source', async () => {
    const first = await manager()
    await command(first.id, { operation: 'bind', target: ISSUE })
    const model = CATALOG.models.find(m => m.provider === 'grok')
    if (!model) throw new Error('fixture lacks grok')
    const second = await runtime.handoff(first.id, { agent: 'grok', model: model.identity })
    closingRefs.mockResolvedValue(listingFor(7))
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(second.id)
  })

  it('resolves ownership after the listing read, never from a stale snapshot', async () => {
    const first = await manager(), second = await manager()
    await command(first.id, { operation: 'bind', target: ISSUE })
    closingRefs.mockImplementation(async () => {
      store.unbindWork(runtime.instance, first.id, ISSUE)
      store.bindWork(runtime.instance, second.id, ISSUE)
      return listingFor(7)
    })
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(second.id)
  })

  it('skips a PR whose closing list is truncated while binding a complete one', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: ISSUE })
    const other = 'https://github.com/acme/app/pull/13'
    closingRefs.mockResolvedValue({ prs: [
      { repo: 'acme/app', number: 12, url: PR, closing: [{ repo: 'acme/app', number: 7 }],
        closesVia: 'body-keywords', closingTruncated: true },
      { repo: 'acme/app', number: 13, url: other, closing: [{ repo: 'acme/app', number: 7 }],
        closesVia: 'closing-references', closingTruncated: false },
    ], truncated: true, more: false })
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === other))
    expect(store.bindings(runtime.instance).find(b => b.target === other)?.session).toBe(parent.id)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
  })

  it('pages past the first listing to reach later PRs', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: ISSUE })
    const other = 'https://github.com/acme/app/pull/13'
    closingRefs.mockImplementation(async (_org: Organization, repo: string, after?: number) => {
      expect(repo).toBe('acme/app')
      if (after === undefined) {
        return { prs: [{ repo, number: 12, url: PR, closing: [], closesVia: 'closing-references', closingTruncated: false }],
          truncated: true, more: true }
      }
      if (after === 12) {
        return { prs: [{ repo, number: 13, url: other, closing: [{ repo, number: 7 }], closesVia: 'closing-references', closingTruncated: false }],
          truncated: false, more: false }
      }
      return { prs: [], truncated: false, more: false }
    })
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === other))
    expect(store.bindings(runtime.instance).find(b => b.target === other)?.session).toBe(parent.id)
    expect(closingRefs.mock.calls.some(([, repo, after]) => repo === 'acme/app' && after === 12)).toBe(true)
  })
})
