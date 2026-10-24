import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

// The person's Approve and Merge endpoints: acting with their GitHub
// account, receipts making every retry safe, and nobody else acting.
const mocks = vi.hoisted(() => ({ runFile: vi.fn(), spawnDetached: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...(await original<typeof import('../server/process')>()),
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
}))
vi.mock('../server/content-jobs', async (original) => ({
  ...(await original<typeof import('../server/content-jobs')>()),
  startContentFinalizer: vi.fn(),
  stopContentFinalizer: vi.fn(async () => undefined),
}))
vi.mock('../server/chat/runtime', async (original) => {
  const { EventEmitter } = await import('node:events')
  const { CheckSemaphore, DEFAULT_CHECK_SLOT_CAP } = await import('../server/check-semaphore')
  return {
    ...(await original<typeof import('../server/chat/runtime')>()),
    ChatRuntime: class extends EventEmitter {
      draining = null
      checkSlots = new CheckSemaphore(() => DEFAULT_CHECK_SLOT_CAP)
      async recover() {}
      async stop() {}
      endDrain() {}
    },
  }
})
vi.mock('../server/jev/api', () => ({
  handleJevApi: vi.fn(async () => false),
  stopJev: vi.fn(async () => undefined),
}))

const runScript = promisify(execFile)

let root = ''
let server: Server | undefined
let base = ''
let database: typeof import('../server/db') | undefined
let cache: typeof import('../server/cache-plugin') | undefined
let actions: typeof import('../server/pull-requests') | undefined
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

async function call(method: 'GET' | 'POST', path: string, body?: unknown, person = true): Promise<{ status: number, body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(person ? { Origin: base } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-pull-requests-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
  mocks.runFile.mockReset().mockImplementation(async () => { throw new Error('Unexpected test command') })
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  vi.resetModules()
  database = await import('../server/db')
  actions = await import('../server/pull-requests')
  const behaviors = await import('../server/behaviors')
  vi.spyOn(behaviors, 'startBehaviorsRuntime').mockImplementation(() => undefined)
  vi.spyOn(behaviors, 'stopBehaviorsRuntime').mockResolvedValue(undefined)
  cache = await import('../server/cache-plugin')
  const middleware = cache.createPoiseMiddleware({ claudeAuth: createAuthenticatedClaudeAuth(), selfUpdateBridge: null })
  server = createServer((req, res) => {
    void middleware(req, res, () => { res.statusCode = 404; res.end('{}') })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  base = `http://127.0.0.1:${address.port}`
  database.setMeta('me', 'octocat')
})

afterEach(async () => {
  await cache?.stopPoiseRuntime()
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  if (database?.db.open) database.closeDatabase()
  database = undefined
  server = undefined
  cache = undefined
  actions = undefined
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

const H = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
const MERGE = 'c'.repeat(40)

function stateResponse(overrides: Record<string, unknown> = {}) {
  return {
    action: 'pull_action_state', repository: 'acme/api', pull_number: 7, actor: 'octocat',
    state: 'open', merged: false, merged_by: null, head_sha: H, merge_sha: null,
    queue_entry_id: null, my_reviews: [], ...overrides,
  }
}

function cliError(stderr: string): Error {
  return Object.assign(new Error(`Command failed (1): github-interface`), { code: 1, stdout: '', stderr })
}

function interfaceMock(answers: Record<string, unknown | Error>) {
  mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'agent-interface' && args[0] === '--diagnostics') {
      return { stdout: JSON.stringify({ version: 1, streamId: 'f'.repeat(32), events: [], cursor: Number(args[1]), hasMore: false, backfillPending: false }), stderr: '' }
    }
    if (command !== 'github-interface') throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
    const answer = answers[args[0]]
    if (answer instanceof Error) throw answer
    if (answer === undefined) throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
    return { stdout: typeof answer === 'string' ? answer : JSON.stringify(answer), stderr: '' }
  })
}

function interfaceCalls(flag: string): string[][] {
  return mocks.runFile.mock.calls
    .filter(([command, args]) => command === 'github-interface' && (args as string[])[0] === flag)
    .map(([, args]) => args as string[])
}

function githubCalls(): unknown[][] {
  return mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface')
}

describe('approving a pull request as you', () => {
  const approve = (overrides: Record<string, unknown> = {}) => ({
    action: 'approved_pr', repository: 'acme/api', pull_number: 7, actor: 'octocat',
    outcome: 'approved', head_sha: H, review_id: 11, submitted_at: '2026-09-01T00:00:00Z', ...overrides,
  })
  const body = (overrides: Record<string, unknown> = {}) => ({ repo: 'acme/api', number: 7, expectedHeadSha: H, actionId: '11111111-1111-4111-8111-111111111111', ...overrides })

  it('approves at the expected head with your account', async () => {
    interfaceMock({ '--pull-action-state': stateResponse(), '--approve-pr': approve() })
    const result = await call('POST', '/api/pull-requests/approve', body())
    expect(result).toEqual({ status: 200, body: {
      outcome: 'approved', repo: 'acme/api', number: 7, actor: 'octocat',
      approvedHead: H, expectedHead: H, currentHead: H, reviewId: 11, submittedAt: '2026-09-01T00:00:00Z',
    } })
    expect(interfaceCalls('--approve-pr')).toEqual([['--approve-pr', '#7', '--expected-head', H, '--repository', 'acme/api', '--token-user', 'octocat']])
  })

  it('reports an approval already granted without approving again', async () => {
    const review = { id: 9, user: { login: 'octocat' }, state: 'APPROVED', commit_id: H, submitted_at: '2026-08-01T00:00:00Z' }
    interfaceMock({ '--pull-action-state': stateResponse({ my_reviews: [review] }) })
    const result = await call('POST', '/api/pull-requests/approve', body())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ outcome: 'already_approved', approvedHead: H, reviewId: 9 })
    expect(interfaceCalls('--approve-pr')).toEqual([])
  })

  it('reports the approval at H while the head is now H2', async () => {
    let reads = 0
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command !== 'github-interface') throw new Error('Unexpected test command')
      if (args[0] === '--pull-action-state') {
        reads += 1
        return { stdout: JSON.stringify(stateResponse(reads === 1 ? {} : { head_sha: H2 })), stderr: '' }
      }
      return { stdout: JSON.stringify(approve()), stderr: '' }
    })
    const result = await call('POST', '/api/pull-requests/approve', body())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ outcome: 'approved', approvedHead: H, expectedHead: H, currentHead: H2 })
  })

  it('reports an approval GitHub attached elsewhere', async () => {
    const review = { id: 12, user: { login: 'octocat' }, state: 'APPROVED', commit_id: H2, submitted_at: '2026-09-03T00:00:00Z' }
    let reads = 0
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command !== 'github-interface') throw new Error('Unexpected test command')
      if (args[0] === '--pull-action-state') {
        reads += 1
        return { stdout: JSON.stringify(stateResponse(reads === 1 ? {} : { head_sha: H2, my_reviews: [review] })), stderr: '' }
      }
      throw cliError(`Traceback (most recent call last):\nRuntimeError: GitHub attached approval to ${H2}, expected ${H}\n`)
    })
    const result = await call('POST', '/api/pull-requests/approve', body())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ outcome: 'approved', approvedHead: H2, expectedHead: H, currentHead: H2, reviewId: 12 })
  })

  it('refuses what is not ready without acting', async () => {
    interfaceMock({
      '--pull-action-state': stateResponse(),
      '--approve-pr': cliError('Traceback (most recent call last):\nRuntimeError: pull request is not open and ready for review\n'),
    })
    const result = await call('POST', '/api/pull-requests/approve', body())
    expect(result).toEqual({ status: 409, body: { outcome: 'refused', repo: 'acme/api', number: 7, error: 'pull request is not open and ready for review' } })
  })

  it('approves again when a change request followed the earlier approval', async () => {
    const approved = { id: 9, state: 'APPROVED', commit_id: H, submitted_at: '2026-08-01T00:00:00Z' }
    const changes = { id: 10, state: 'CHANGES_REQUESTED', commit_id: H, submitted_at: '2026-08-02T00:00:00Z' }
    interfaceMock({ '--pull-action-state': stateResponse({ my_reviews: [approved, changes] }), '--approve-pr': approve() })
    const result = await call('POST', '/api/pull-requests/approve', body())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ outcome: 'approved', approvedHead: H })
    expect(interfaceCalls('--approve-pr')).toHaveLength(1)
  })

  it('reports already approved when the approval followed the change request', async () => {
    const changes = { id: 10, state: 'CHANGES_REQUESTED', commit_id: H, submitted_at: '2026-08-02T00:00:00Z' }
    const approved = { id: 11, state: 'APPROVED', commit_id: H, submitted_at: '2026-08-03T00:00:00Z' }
    interfaceMock({ '--pull-action-state': stateResponse({ my_reviews: [changes, approved] }) })
    const result = await call('POST', '/api/pull-requests/approve', body())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ outcome: 'already_approved', reviewId: 11 })
    expect(interfaceCalls('--approve-pr')).toEqual([])
  })

  it('refuses counted unresolved conversations with their explanation', async () => {
    interfaceMock({
      '--pull-action-state': stateResponse(),
      '--approve-pr': cliError('Traceback (most recent call last):\nRuntimeError: 2 unresolved review conversation(s) from other reviewers remain\n'),
    })
    const result = await call('POST', '/api/pull-requests/approve', body())
    expect(result).toEqual({ status: 409, body: { outcome: 'refused', repo: 'acme/api', number: 7, error: '2 unresolved review conversation(s) from other reviewers remain' } })
  })

  it('answers a GitHub refusal in GitHub words', async () => {
    interfaceMock({
      '--pull-action-state': stateResponse(),
      '--approve-pr': cliError('Traceback (most recent call last):\nRuntimeError: GitHub 422: {"message": "Can not approve your own pull request"}\n'),
    })
    const result = await call('POST', '/api/pull-requests/approve', body())
    expect(result.status).toBe(422)
    expect(result.body).toMatchObject({ outcome: 'refused', error: '{"message": "Can not approve your own pull request"}' })
  })
})

describe('merging a pull request as you', () => {
  const body = (overrides: Record<string, unknown> = {}) => ({ repo: 'acme/api', number: 7, expectedHeadSha: H, actionId: '22222222-2222-4222-8222-222222222222', ...overrides })
  const merge = (overrides: Record<string, unknown> = {}) => ({
    action: 'merge_pr', repository: 'acme/api', pull_number: 7, head_sha: H, ...overrides,
  })

  it('merges a green head with the pinned SHA and reports the merge', async () => {
    interfaceMock({ '--pull-action-state': stateResponse(), '--merge-pr': merge({ outcome: 'merged', merge_sha: MERGE, merge_method: 'squash' }) })
    const result = await call('POST', '/api/pull-requests/merge', body())
    expect(result).toEqual({ status: 200, body: {
      outcome: 'merged', repo: 'acme/api', number: 7, actor: 'octocat', headSha: H, mergeSha: MERGE, mergeMethod: 'squash',
    } })
    expect(interfaceCalls('--merge-pr')).toEqual([['--merge-pr', '#7', '--expected-head', H, '--repository', 'acme/api', '--token-user', 'octocat']])
  })

  it('reports a merge already granted, with who merged it, without merging again', async () => {
    interfaceMock({ '--pull-action-state': stateResponse({ state: 'closed', merged: true, merged_by: 'hubot', merge_sha: MERGE }) })
    const result = await call('POST', '/api/pull-requests/merge', body())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ outcome: 'already_merged', mergedBy: 'hubot', mergeSha: MERGE })
    expect(interfaceCalls('--merge-pr')).toEqual([])
  })

  it('reports a queued pull request without admitting it again', async () => {
    interfaceMock({ '--pull-action-state': stateResponse({ queue_entry_id: 'entry-1' }) })
    const result = await call('POST', '/api/pull-requests/merge', body())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ outcome: 'in_queue', queueEntryId: 'entry-1' })
    expect(interfaceCalls('--merge-pr')).toEqual([])
  })

  it('names both heads when H2 merged after H was expected', async () => {
    interfaceMock({ '--pull-action-state': stateResponse({ state: 'closed', merged: true, merged_by: 'hubot', merge_sha: MERGE, head_sha: H2 }) })
    const result = await call('POST', '/api/pull-requests/merge', body())
    expect(result).toEqual({ status: 200, body: {
      outcome: 'already_merged', repo: 'acme/api', number: 7, actor: 'octocat',
      headSha: H2, expectedHead: H, mergedBy: 'hubot', mergeSha: MERGE,
    } })
    expect(interfaceCalls('--merge-pr')).toEqual([])
  })

  it('names both heads when H2 queued after H was expected', async () => {
    interfaceMock({ '--pull-action-state': stateResponse({ head_sha: H2, queue_entry_id: 'entry-9' }) })
    const result = await call('POST', '/api/pull-requests/merge', body())
    expect(result).toEqual({ status: 200, body: {
      outcome: 'in_queue', repo: 'acme/api', number: 7, actor: 'octocat',
      headSha: H2, expectedHead: H, queueEntryId: 'entry-9',
    } })
    expect(interfaceCalls('--merge-pr')).toEqual([])
  })

  it('admits a queue repository pull request to its queue', async () => {
    interfaceMock({ '--pull-action-state': stateResponse(), '--merge-pr': merge({ outcome: 'enqueued', queue_entry_id: 'entry-2' }) })
    const result = await call('POST', '/api/pull-requests/merge', body())
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ outcome: 'enqueued', queueEntryId: 'entry-2' })
  })

  it('answers a stale head from the start with both heads', async () => {
    interfaceMock({
      '--pull-action-state': stateResponse({ head_sha: H2 }),
      '--merge-pr': merge({ outcome: 'superseded', actual_head: H2 }),
    })
    const result = await call('POST', '/api/pull-requests/merge', body())
    expect(result).toEqual({ status: 409, body: {
      outcome: 'superseded', repo: 'acme/api', number: 7, actor: 'octocat', headSha: H, expectedHead: H, actualHead: H2,
    } })
  })

  it('answers not ready and refused protections in GitHub words', async () => {
    interfaceMock({ '--pull-action-state': stateResponse(), '--merge-pr': merge({ outcome: 'not_ready' }) })
    const cold = await call('POST', '/api/pull-requests/merge', body())
    expect(cold).toEqual({ status: 409, body: { outcome: 'not_ready', repo: 'acme/api', number: 7, actor: 'octocat', headSha: H } })
    interfaceMock({
      '--pull-action-state': stateResponse(),
      '--merge-pr': merge({ outcome: 'refused', message: '3 of 4 required status checks are expected.' }),
    })
    const refused = await call('POST', '/api/pull-requests/merge', body({ actionId: '22222222-2222-4222-8222-222222222223' }))
    expect(refused.status).toBe(422)
    expect(refused.body).toMatchObject({ outcome: 'refused', error: '3 of 4 required status checks are expected.' })
  })
})

describe('action receipts', () => {
  const body = (overrides: Record<string, unknown> = {}) => ({ repo: 'acme/api', number: 7, expectedHeadSha: H, actionId: '33333333-3333-4333-8333-333333333333', ...overrides })
  const approved = { action: 'approved_pr', repository: 'acme/api', pull_number: 7, actor: 'octocat', outcome: 'approved', head_sha: H, review_id: 11, submitted_at: '2026-09-01T00:00:00Z' }

  it('replays the stored outcome without acting again', async () => {
    interfaceMock({ '--pull-action-state': stateResponse(), '--approve-pr': approved })
    const first = await call('POST', '/api/pull-requests/approve', body())
    expect(first.status).toBe(200)
    const calls = mocks.runFile.mock.calls.length
    const second = await call('POST', '/api/pull-requests/approve', body())
    expect(second).toEqual(first)
    expect(mocks.runFile.mock.calls.length).toBe(calls)
  })

  it('refuses the same action ID for a different action', async () => {
    interfaceMock({ '--pull-action-state': stateResponse(), '--approve-pr': approved })
    expect((await call('POST', '/api/pull-requests/approve', body())).status).toBe(200)
    const conflict = await call('POST', '/api/pull-requests/approve', body({ expectedHeadSha: H2 }))
    expect(conflict.status).toBe(409)
    expect(conflict.body).toEqual({ error: 'This action ID was already used for a different action.' })
  })

  it('reconciles a lost response against GitHub instead of acting twice', async () => {
    const review = { id: 11, user: { login: 'octocat' }, state: 'APPROVED', commit_id: H, submitted_at: '2026-09-01T00:00:00Z' }
    let calls = 0
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command !== 'github-interface') throw new Error('Unexpected test command')
      if (args[0] === '--pull-action-state') {
        calls += 1
        return { stdout: JSON.stringify(stateResponse(calls === 1 ? {} : { my_reviews: [review] })), stderr: '' }
      }
      throw cliError('httpx.ConnectError: [Errno 104] Connection reset by peer')
    })
    const lost = await call('POST', '/api/pull-requests/approve', body())
    expect(lost.status).toBe(200)
    expect(lost.body).toMatchObject({ outcome: 'already_approved', reviewId: 11 })
    expect(interfaceCalls('--approve-pr')).toHaveLength(1)
    const again = await call('POST', '/api/pull-requests/approve', body())
    expect(again).toEqual(lost)
    expect(interfaceCalls('--approve-pr')).toHaveLength(1)
  })

  it('answers unknown with the GitHub state when nothing is recorded there', async () => {
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command !== 'github-interface') throw new Error('Unexpected test command')
      if (args[0] === '--pull-action-state') return { stdout: JSON.stringify(stateResponse()), stderr: '' }
      throw cliError('Command timed out after 60000ms: github-interface')
    })
    const lost = await call('POST', '/api/pull-requests/approve', body())
    expect(lost.status).toBe(503)
    expect(lost.body).toMatchObject({
      outcome: 'unknown', repo: 'acme/api', number: 7,
      github: { state: 'open', merged: false, mergedBy: null, headSha: H, queueEntryId: null, myApproval: null },
    })
    expect(interfaceCalls('--approve-pr')).toHaveLength(1)
    const retry = await call('POST', '/api/pull-requests/approve', body())
    expect(retry.status).toBe(503)
    expect(retry.body.outcome).toBe('unknown')
    expect(interfaceCalls('--approve-pr')).toHaveLength(1)
  })

  it('re-reads GitHub after an unknown outcome instead of replaying it', async () => {
    const review = { id: 11, state: 'APPROVED', commit_id: H, submitted_at: '2026-09-01T00:00:00Z' }
    let reads = 0
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command !== 'github-interface') throw new Error('Unexpected test command')
      if (args[0] === '--pull-action-state') {
        reads += 1
        return { stdout: JSON.stringify(stateResponse(reads < 3 ? {} : { my_reviews: [review] })), stderr: '' }
      }
      throw cliError('Command timed out after 60000ms: github-interface')
    })
    const lost = await call('POST', '/api/pull-requests/approve', body())
    expect(lost.status).toBe(503)
    expect(lost.body.outcome).toBe('unknown')
    const retry = await call('POST', '/api/pull-requests/approve', body())
    expect(retry.status).toBe(200)
    expect(retry.body).toMatchObject({ outcome: 'already_approved', reviewId: 11 })
    expect(interfaceCalls('--approve-pr')).toHaveLength(1)
  })

  it('keeps a refused outcome when a concurrent retry finalizes unknown', async () => {
    let releaseAct!: () => void
    let releaseRead!: () => void
    const actGate = new Promise<void>((resolve) => { releaseAct = resolve })
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve })
    let acts = 0
    let stateReads = 0
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'agent-interface' && args[0] === '--diagnostics') {
        return { stdout: JSON.stringify({ version: 1, streamId: 'f'.repeat(32), events: [], cursor: Number(args[1]), hasMore: false, backfillPending: false }), stderr: '' }
      }
      if (command !== 'github-interface') throw new Error('Unexpected test command')
      if (args[0] === '--pull-action-state') {
        stateReads += 1
        // The retry's read: held until the original persisted its refusal.
        if (stateReads === 2) await readGate
        return { stdout: JSON.stringify(stateResponse()), stderr: '' }
      }
      if (args[0] === '--approve-pr') {
        acts += 1
        await actGate
        throw cliError('RuntimeError: pull request is not open and ready for review\n')
      }
      throw new Error('Unexpected test command')
    })
    // The original acts while the retry reads the pending receipt, then
    // waits inside its own state read.
    const first = call('POST', '/api/pull-requests/approve', body())
    await vi.waitFor(() => expect(acts).toBe(1))
    const second = call('POST', '/api/pull-requests/approve', body())
    await vi.waitFor(() => expect(stateReads).toBe(2))
    releaseAct()
    expect((await first).status).toBe(409)
    // The retry's unknown yields to the persisted refusal, and so does
    // every later retry.
    releaseRead()
    const secondResult = await second
    expect(secondResult.status).toBe(409)
    expect(secondResult.body).toMatchObject({ outcome: 'refused' })
    expect(acts).toBe(1)
    const retry = await call('POST', '/api/pull-requests/approve', body())
    expect(retry.body).toMatchObject({ outcome: 'refused' })
  })

  it('recovers a crash before the receipt was saved', async () => {
    // Reserved, sent, then the server died before recording: the pending
    // receipt carries the action's own fingerprint and no outcome.
    const { createHash } = await import('node:crypto')
    const fingerprint = createHash('sha256').update(JSON.stringify({
      action: 'approve', actor: 'octocat', repo: 'acme/api', number: 7, expectedHead: H,
    })).digest('hex')
    database!.db.prepare('INSERT INTO pull_request_action_receipts (action_id, fingerprint, outcome, created_at) VALUES (?, ?, NULL, ?)')
      .run(body().actionId, fingerprint, new Date().toISOString())
    const review = { id: 11, user: { login: 'octocat' }, state: 'APPROVED', commit_id: H, submitted_at: '2026-09-01T00:00:00Z' }
    interfaceMock({ '--pull-action-state': stateResponse({ my_reviews: [review] }) })
    const again = await call('POST', '/api/pull-requests/approve', body())
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ outcome: 'already_approved', reviewId: 11 })
    expect(interfaceCalls('--approve-pr')).toEqual([])
  })
})

describe('who may act', () => {
  const approveBody = { repo: 'acme/api', number: 7, expectedHeadSha: H, actionId: '44444444-4444-4444-8444-444444444444' }
  const mergeBody = { repo: 'acme/api', number: 7, expectedHeadSha: H, actionId: '55555555-5555-4555-8555-555555555555' }

  it('refuses a request that does not speak for the person, through the server', async () => {
    expect(await actions!.handlePullRequestApprove(approveBody, false)).toEqual({
      status: 403, body: { error: 'Approving a pull request is the person\'s action, taken in the browser.', code: 'invalid' },
    })
    expect(await actions!.handlePullRequestMerge(mergeBody, false)).toEqual({
      status: 403, body: { error: 'Merging a pull request is the person\'s action, taken in the browser.', code: 'invalid' },
    })
    expect(githubCalls()).toEqual([])
  })

  it('refuses a request without the browser origin, through HTTP', async () => {
    const approved = await call('POST', '/api/pull-requests/approve', approveBody, false)
    expect(approved.status).toBe(403)
    expect(approved.body.error).toMatch(/the person's action/)
    const merged = await call('POST', '/api/pull-requests/merge', mergeBody, false)
    expect(merged.status).toBe(403)
    expect(githubCalls()).toEqual([])
  })

  it('refuses the native control CLI, which sends no origin', async () => {
    const config = join(root, 'control.json')
    await writeFile(config, JSON.stringify({ origin: base, sessionId: 's', token: 't' }))
    const script = join(process.cwd(), 'scripts', 'poise-chat-control.mjs')
    const run = async (path: string, payload: unknown) => runScript(process.execPath, [script, config, JSON.stringify({ operation: 'api', path, method: 'POST', body: payload })])
      .then(() => null, (error: any) => String(error?.stderr ?? error))
    expect(await run('/api/pull-requests/approve', approveBody)).toMatch(/"status":\s*403/)
    expect(await run('/api/pull-requests/merge', mergeBody)).toMatch(/"status":\s*403/)
    expect(githubCalls()).toEqual([])
  })

  it('validates the body and needs your GitHub account', async () => {
    for (const bad of [
      { ...approveBody, repo: 'nope' },
      { ...approveBody, number: 0 },
      { ...approveBody, expectedHeadSha: 'xyz' },
      { ...approveBody, actionId: '' },
      { repo: 'acme/api' },
    ]) {
      expect((await call('POST', '/api/pull-requests/approve', bad)).status, JSON.stringify(bad)).toBe(400)
    }
    database!.db.prepare("DELETE FROM meta WHERE key = 'me'").run()
    expect((await call('POST', '/api/pull-requests/approve', approveBody)).status).toBe(400)
    expect((await call('POST', '/api/pull-requests/merge', mergeBody)).status).toBe(400)
  })
})
