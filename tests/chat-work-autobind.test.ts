import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
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
const closingRefs = vi.fn<(org: Organization, after?: { repo: string, number: number }) => Promise<OpenPrClosingList | null>>()

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
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => 64, controlContext: id => control.context(id),
    resolveCheckout: async (repo: string) => {
      const dir = join(root, 'checkouts', repo.replace('/', '-'))
      await mkdir(dir, { recursive: true })
      return dir
    } })
}
const execFileAsync = promisify(execFile)
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 })
  return stdout
}
/** A nested clone with `branch` really pushed (to a local bare remote),
 *  then re-pointed at the GitHub repo: the post-`push -u` state of a worker
 *  that opened its PR from a clone inside its workspace. */
async function pushBranch(checkout: string, branch: string, origin: string): Promise<string> {
  const clone = join(checkout, 'poise')
  await mkdir(join(root, 'origins'), { recursive: true })
  const bare = join(root, 'origins', `${randomUUID()}.git`)
  await execFileAsync('git', ['init', '--bare', '-q', bare], { timeout: 30_000 })
  await mkdir(clone, { recursive: true })
  await git(['init', '-q'], clone)
  await git(['commit', '-q', '--allow-empty', '-m', 'base'], clone)
  await git(['remote', 'add', 'origin', bare], clone)
  await git(['checkout', '-q', '-b', branch], clone)
  await git(['commit', '-q', '--allow-empty', '-m', 'work'], clone)
  await git(['push', '-q', '-u', 'origin', branch], clone)
  await git(['remote', 'set-url', 'origin', `https://github.com/${origin}.git`], clone)
  return clone
}
/** A nested clone whose branch was never pushed: no upstream, no remote. */
async function localBranch(checkout: string, branch: string): Promise<string> {
  const clone = join(checkout, 'poise')
  await mkdir(clone, { recursive: true })
  await git(['init', '-q'], clone)
  await git(['commit', '-q', '--allow-empty', '-m', 'base'], clone)
  await git(['checkout', '-q', '-b', branch], clone)
  await git(['commit', '-q', '--allow-empty', '-m', 'work'], clone)
  return clone
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
  control = new Control(runtime, { ci, now: () => clock, targetStatus, reviews, ownsBehind, mergeWake, closingRefs, connectionDir: join(root, 'connections') })
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
    closing: [{ repo: 'acme/app', number: issueNumber }], closesVia: 'closing-references', closingTruncated: false, headRef: null, headRepo: null }], truncated: false, more: false }
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
      closing: [{ repo: 'acme/app', number: 7 }, { repo: 'acme/app', number: 8 }], closesVia: 'closing-references', closingTruncated: false, headRef: null, headRepo: null }],
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

  it('reads one local listing per organization per minute and nothing else', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: ISSUE })
    const listed = closingRefs.mock.calls.length
    clock += 61_000
    await control.tick()
    await until(() => closingRefs.mock.calls.length > listed)
    await until(() => store.observation(runtime.instance, `behavior:${ISSUE}`)?.checked_at === clock)
    const calls = closingRefs.mock.calls.length
    expect(closingRefs.mock.calls[calls - 1]?.[0]).toMatchObject({ login: 'acme' })
    expect(closingRefs.mock.calls[calls - 1]?.[1]).toBeUndefined()
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
        closesVia: 'body-keywords', closingTruncated: true, headRef: null, headRepo: null },
      { repo: 'acme/app', number: 13, url: other, closing: [{ repo: 'acme/app', number: 7 }],
        closesVia: 'closing-references', closingTruncated: false, headRef: null, headRepo: null },
    ], truncated: true, more: false })
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === other))
    expect(store.bindings(runtime.instance).find(b => b.target === other)?.session).toBe(parent.id)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
  })

  it('pages past the first listing to reach later PRs, including cross-repo ones', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: ISSUE })
    // No bindings in acme/other: the cross-repo PR is found anyway because
    // the listing covers the whole organization.
    const other = 'https://github.com/acme/other/pull/5'
    closingRefs.mockImplementation(async (_org: Organization, after?: { repo: string, number: number }) => {
      if (after === undefined) {
        return { prs: [{ repo: 'acme/app', number: 12, url: PR, closing: [], closesVia: 'closing-references', closingTruncated: false, headRef: null, headRepo: null }],
          truncated: true, more: true }
      }
      if (after.repo === 'acme/app' && after.number === 12) {
        return { prs: [{ repo: 'acme/other', number: 5, url: other, closing: [{ repo: 'acme/app', number: 7 }],
          closesVia: 'closing-references', closingTruncated: false, headRef: null, headRepo: null }], truncated: false, more: false }
      }
      return { prs: [], truncated: false, more: false }
    })
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === other))
    expect(store.bindings(runtime.instance).find(b => b.target === other)?.session).toBe(parent.id)
    expect(closingRefs.mock.calls.some(([, after]) => after?.repo === 'acme/app' && after?.number === 12)).toBe(true)
  })
})

describe('automatic PR binding through workspace branches', () => {
  function branchListing(headRef: string | null, headRepo: string | null = 'acme/app', closing: Array<{ repo: string, number: number }> = []): OpenPrClosingList {
    return { prs: [{ repo: 'acme/app', number: 12, url: PR, closing,
      closesVia: 'closing-references', closingTruncated: false, headRef, headRepo }], truncated: false, more: false }
  }
  async function workerWithCheckout(parent: string): Promise<{ worker: string, checkout: string }> {
    const created = await command(parent, { operation: 'create', title: 'Worker', task: 'Fix the issue' })
    const worker = (created.session as { id: string }).id
    const checkout = runtime.get(worker)?.checkout
    if (!checkout) throw new Error('worker lacks a checkout')
    return { worker, checkout }
  }
  // A negative needs pass-completion proof: an unrelated issue binding the
  // listing never matches, whose observation proves the pass ran past discovery.
  async function unrelatedBinding(): Promise<void> {
    const other = await manager()
    await command(other.id, { operation: 'bind', target: 'https://github.com/acme/app/issues/9' })
  }

  it('binds the PR pushed from a created worker\'s nested clone and wakes it for the review', async () => {
    const parent = await manager()
    const { worker, checkout } = await workerWithCheckout(parent.id)
    await pushBranch(checkout, 'fix/7-worker', 'acme/app')
    // No closing reference and no bound issue: only the pushed branch can find it.
    closingRefs.mockResolvedValue(branchListing('fix/7-worker'))
    reviews.mockResolvedValue({ found: true, truncated: false, reviews: [{ id: 'R_1', author: 'reviewer', state: 'CHANGES_REQUESTED' }],
      threads: [{ thread: 'T_1', resolved: false, outdated: false, comments: [{ id: 'C_1', author: 'reviewer' }] }] })
    clock += 61_000
    await control.tick()
    await until(() => prompts.has(worker))
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(worker)
    // The worker never called bind: the discovered PR is its only binding.
    expect(store.bindings(runtime.instance).filter(b => b.session === worker)).toHaveLength(1)
    finishes.get(worker)!({ stopReason: 'end_turn' })
    await until(() => (prompts.get(worker)?.length ?? 0) === 2)
    expect(prompts.get(worker)![1].text).toContain('CHANGES_REQUESTED')
    expect(store.inbox(runtime.instance, worker).some(m => m.event_key.startsWith('reviews:'))).toBe(true)
  }, 60_000)

  it('binds a repository session through its own branch', async () => {
    const model = CATALOG.models.find(m => m.provider === 'grok')
    if (!model) throw new Error('fixture lacks grok')
    const session = await runtime.create({ agent: 'grok', model: model.identity, repo: 'acme/app',
      branch: { existing: 'fix/7-session' }, title: 'Repo', deferStart: true })
    closingRefs.mockResolvedValue(branchListing('fix/7-session'))
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(session.id)
  })

  it('matches a fork head through the head repository', async () => {
    const parent = await manager()
    const { worker, checkout } = await workerWithCheckout(parent.id)
    await pushBranch(checkout, 'fix/7-fork', 'fork/app')
    // No bindings at all: the fork owner is unmanaged, so discovery lists
    // every managed organization to reach the base repository's listing.
    closingRefs.mockResolvedValue(branchListing('fix/7-fork', 'fork/app'))
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(worker)
  })

  it('reaches a base listing when the only evidence is another managed org\'s fork', async () => {
    database.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES ('other', ?, 1, 'ready', 'ready', ?)`).run(join(root, 'other.sqlite'), 'fixture-agent')
    try {
      const parent = await manager()
      const { worker, checkout } = await workerWithCheckout(parent.id)
      await pushBranch(checkout, 'fix/7-xorg', 'other/app')
      // Each organization's listing carries only its own PRs: the fork's
      // organization never lists the base PR.
      closingRefs.mockImplementation(async (org: Organization) => org.login === 'acme'
        ? branchListing('fix/7-xorg', 'other/app')
        : { prs: [], truncated: false, more: false })
      clock += 61_000
      await control.tick()
      await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
      expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(worker)
    } finally {
      database.db.prepare('DELETE FROM organizations WHERE login = ?').run('other')
    }
  })

  it('binds a fork PR to its pusher, never a same-named base branch', async () => {
    const parent = await manager()
    const base = await workerWithCheckout(parent.id)
    const fork = await workerWithCheckout(parent.id)
    await pushBranch(base.checkout, 'fix/7-same', 'acme/app')
    await pushBranch(fork.checkout, 'fix/7-same', 'fork/app')
    closingRefs.mockResolvedValue(branchListing('fix/7-same', 'fork/app'))
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(fork.worker)
  })

  it('leaves a PR pushed from two chats\' workspaces unbound', async () => {
    const parent = await manager()
    const first = await workerWithCheckout(parent.id)
    const second = await workerWithCheckout(parent.id)
    await pushBranch(first.checkout, 'fix/7-dup', 'acme/app')
    await pushBranch(second.checkout, 'fix/7-dup', 'acme/app')
    await unrelatedBinding()
    closingRefs.mockResolvedValue(branchListing('fix/7-dup'))
    clock += 61_000
    await control.tick()
    await until(() => store.observation(runtime.instance, 'behavior:https://github.com/acme/app/issues/9')?.checked_at === clock)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
  })

  it('leaves a PR claimed through closing refs and branches of different chats unbound', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: ISSUE })
    const { checkout } = await workerWithCheckout(parent.id)
    await pushBranch(checkout, 'fix/7-other', 'acme/app')
    closingRefs.mockResolvedValue(branchListing('fix/7-other', 'acme/app', [{ repo: 'acme/app', number: 7 }]))
    clock += 61_000
    await control.tick()
    await until(() => store.observation(runtime.instance, `behavior:${ISSUE}`)?.checked_at === clock)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
  })

  it('ignores branches without a GitHub push', async () => {
    const parent = await manager()
    const { checkout } = await workerWithCheckout(parent.id)
    await localBranch(checkout, 'fix/7-local')
    await unrelatedBinding()
    closingRefs.mockResolvedValue(branchListing('fix/7-local'))
    clock += 61_000
    await control.tick()
    await until(() => store.observation(runtime.instance, 'behavior:https://github.com/acme/app/issues/9')?.checked_at === clock)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
  })

  it.each([[null, null], ['fix/7-pushed', null]] as Array<[string | null, string | null]>)(
    'skips branch matching when the head is unknown (headRef=%s headRepo=%s)', async (headRef, headRepo) => {
    const parent = await manager()
    const { checkout } = await workerWithCheckout(parent.id)
    await pushBranch(checkout, 'fix/7-pushed', 'acme/app')
    await unrelatedBinding()
    // Old rows know neither half; a half-known head is incomplete evidence
    // either way and matches nothing.
    closingRefs.mockResolvedValue(branchListing(headRef, headRepo))
    clock += 61_000
    await control.tick()
    await until(() => store.observation(runtime.instance, 'behavior:https://github.com/acme/app/issues/9')?.checked_at === clock)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
  })

  it('never rebinds a branch-matched PR after unbind', async () => {
    const parent = await manager()
    const { worker, checkout } = await workerWithCheckout(parent.id)
    await pushBranch(checkout, 'fix/7-once', 'acme/app')
    await command(parent.id, { operation: 'bind', target: 'https://github.com/acme/app/issues/9' })
    closingRefs.mockResolvedValue(branchListing('fix/7-once'))
    clock += 61_000
    await control.tick()
    await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
    expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(worker)
    await command(worker, { operation: 'unbind', target: PR })
    clock += 61_000
    await control.tick()
    await until(() => store.observation(runtime.instance, 'behavior:https://github.com/acme/app/issues/9')?.checked_at === clock)
    expect(store.bindings(runtime.instance).some(b => b.target === PR)).toBe(false)
  })

  it('keeps closing references working while an unreadable workspace pauses branch matching', async () => {
    const parent = await manager()
    const { worker, checkout } = await workerWithCheckout(parent.id)
    await pushBranch(checkout, 'fix/7-broken', 'acme/app')
    const unreadable = join(checkout, 'unreadable')
    await mkdir(unreadable, { recursive: true })
    await chmod(unreadable, 0o000)
    try {
      await command(worker, { operation: 'bind', target: ISSUE })
      // The closing list names the worker's issue; the head branch is the
      // worker's own push, which the paused scan cannot see.
      closingRefs.mockResolvedValue(branchListing('fix/7-broken', 'acme/app', [{ repo: 'acme/app', number: 7 }]))
      clock += 61_000
      await control.tick()
      await until(() => store.bindings(runtime.instance).some(b => b.target === PR))
      expect(store.bindings(runtime.instance).find(b => b.target === PR)?.session).toBe(worker)
    } finally {
      await chmod(unreadable, 0o700)
    }
  })
})

describe('pushed branch evidence', () => {
  it('reads pushed branches with their GitHub repos and skips the rest', async () => {
    const { pushedBranches, githubRepoFromRemoteUrl } = await import('../server/chat/git')
    expect(githubRepoFromRemoteUrl('https://github.com/Acme/App.git')).toBe('acme/app')
    expect(githubRepoFromRemoteUrl('https://github.com/acme/app/')).toBe('acme/app')
    expect(githubRepoFromRemoteUrl('https://user@github.com/acme/app')).toBe('acme/app')
    expect(githubRepoFromRemoteUrl('git@github.com:acme/app.git')).toBe('acme/app')
    expect(githubRepoFromRemoteUrl('ssh://git@github.com/acme/app.git')).toBe('acme/app')
    expect(githubRepoFromRemoteUrl('https://gitlab.com/acme/app.git')).toBeNull()
    expect(githubRepoFromRemoteUrl('/tmp/local.git')).toBeNull()
    expect(githubRepoFromRemoteUrl('not a url')).toBeNull()
    expect(githubRepoFromRemoteUrl('')).toBeNull()
    const dir = join(root, 'evidence', randomUUID())
    await mkdir(dir, { recursive: true })
    await git(['init', '-q'], dir)
    await git(['commit', '-q', '--allow-empty', '-m', 'base'], dir)
    // A branch with no upstream, one tracking a local branch, and one with
    // a removed remote contribute nothing; only the GitHub push counts.
    await git(['checkout', '-q', '-b', 'local-only'], dir)
    await git(['checkout', '-q', '-b', 'tracks-local', 'main'], dir)
    await git(['branch', '--set-upstream-to=main', 'tracks-local'], dir)
    await git(['checkout', '-q', '-b', 'remote-gone', 'main'], dir)
    await git(['remote', 'add', 'gone', 'https://github.com/acme/gone.git'], dir)
    await git(['update-ref', 'refs/remotes/gone/remote-gone', 'HEAD'], dir)
    await git(['branch', '--set-upstream-to=gone/remote-gone', 'remote-gone'], dir)
    await git(['config', '--remove-section', 'remote.gone'], dir)
    await git(['checkout', '-q', '-b', 'pushed', 'main'], dir)
    await git(['remote', 'add', 'origin', 'https://github.com/Acme/App.git'], dir)
    await git(['update-ref', 'refs/remotes/origin/pushed', 'HEAD'], dir)
    await git(['branch', '--set-upstream-to=origin/pushed', 'pushed'], dir)
    // A local branch tracking a differently-named remote branch reports the
    // remote's name: that is the branch a PR head would carry.
    await git(['checkout', '-q', '-b', 'work', 'main'], dir)
    await git(['update-ref', 'refs/remotes/origin/fix/7-remote', 'HEAD'], dir)
    await git(['branch', '--set-upstream-to=origin/fix/7-remote', 'work'], dir)
    expect(await pushedBranches(dir)).toEqual([
      { branch: 'fix/7-remote', repo: 'acme/app' },
      { branch: 'pushed', repo: 'acme/app' },
    ])
    // A git failure is loud: reading as no pushed branches would let
    // discovery bind on incomplete evidence.
    await chmod(join(dir, '.git', 'config'), 0o000)
    try {
      await expect(pushedBranches(dir)).rejects.toThrow()
    } finally {
      await chmod(join(dir, '.git', 'config'), 0o644)
    }
  })
})
