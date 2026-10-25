import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

vi.setConfig({ testTimeout: 25_000, hookTimeout: 25_000 })

// The notices through the HTTP API the page's notification island uses, and
// the Notifications setting that turns them off.
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

let root = ''
let server: Server | undefined
let base = ''
let database: typeof import('../server/db') | undefined
let store: typeof import('../server/alerts/store') | undefined
let cache: typeof import('../server/cache-plugin') | undefined
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

async function call(method: 'GET' | 'POST', path: string, body?: unknown, person = false): Promise<{ status: number, body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(person ? { Origin: base } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-notices-api-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
  // Nothing here may reach a CLI: no GitHub account is set, so the check of
  // pull requests has nothing to read.
  mocks.runFile.mockReset().mockImplementation(async (command: string, args: string[]) => {
    if (command === 'agent-interface' && args[0] === '--diagnostics') return { stdout: JSON.stringify({ version: 1, streamId: 'f'.repeat(32), events: [], cursor: Number(args[1]), hasMore: false, backfillPending: false }) }
    throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
  })
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  vi.resetModules()
  database = await import('../server/db')
  store = await import('../server/alerts/store')
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
})

afterEach(async () => {
  await cache?.stopPoiseRuntime()
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  if (database?.db.open) database.closeDatabase()
  database = undefined
  store = undefined
  server = undefined
  cache = undefined
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

const waiting = { kind: 'chat_waiting', dedupeKey: 'chat-waiting:s1', title: 'Claude Code is waiting for you', body: 'Allow it?', path: '/', target: { chat: 's1' } } as const
const ready = { kind: 'pr_ready', dedupeKey: 'pr-ready:acme/api#1', title: 'acme/api#1 is ready to merge', body: 'Change 1', path: '/', target: { pullRequest: 'https://github.com/acme/api/pull/1' } } as const

it.each([
  { path: '/api/analytics?since=2026-10-01T00:00:00Z&until=2026-10-02T00:00:00Z', method: 'readAnalytics' as const },
  { path: '/api/analytics/history?bounds=2026-10-01T00:00:00Z,2026-10-02T00:00:00Z', method: 'readAnalyticsHistory' as const },
])('cancels server work when the client abandons $method', async ({ path, method }) => {
  const analytics = await import('../server/analytics')
  let signal: AbortSignal | undefined
  let release: (() => void) | undefined
  const read = vi.spyOn(analytics, method).mockImplementation((...args: Parameters<typeof analytics.readAnalytics> | Parameters<typeof analytics.readAnalyticsHistory>) => {
    const last = args.at(-1)
    signal = last instanceof AbortSignal ? last : undefined
    return new Promise<never>((_resolve, reject) => {
      release = () => reject(new Error('released test read'))
      signal?.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
  })
  const controller = new AbortController()
  const pending = fetch(base + path, { signal: controller.signal }).catch(error => error)
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    expect(signal).toBeInstanceOf(AbortSignal)
    controller.abort()
    await pending
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
  } finally {
    controller.abort()
    release?.()
    await pending
    read.mockRestore()
  }
})

describe('the notices API', () => {
  it('retains source evidence when Off is selected during an actual quota API read', async () => {
    database!.setMeta('me', 'octocat')
    const reset = Math.floor(Date.now() / 1000) + 3600
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'test-stored-credential' }
      database!.setMeta('notification_settings', JSON.stringify({ enabled: false }))
      return { stdout: JSON.stringify({ resources: { core: { limit: 5000, used: 5000, remaining: 0, reset } } }) }
    })
    expect((await call('GET', '/api/github-quota')).body.accounts[0].buckets[0].remaining).toBe(0)
    expect((await call('GET', '/api/notices')).body).toEqual({ enabled: false, notices: [] })
    const logging = await import('../server/logging')
    logging.loggingRuntime()!.flush()
    const retained = await call('GET', '/api/logging?source=poise&account=octocat')
    expect(retained.status).toBe(200)
    expect(retained.body.events.some((event: { operation: string }) => event.operation === 'github_quota.exhausted')).toBe(true)
    expect(JSON.stringify(retained.body)).not.toContain('test-stored-credential')
  })

  it('serves explicit-account quota and its exhaustion error through the notification API', async () => {
    database!.setMeta('me', 'octocat')
    const reset = Math.floor(Date.now() / 1000) + 3600
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({
      stdout: args[0] === 'auth' ? 'test-stored-credential' : JSON.stringify({ resources: { core: { limit: 5000, used: 5000, remaining: 0, reset } } }),
    }))
    const quota = await call('GET', '/api/github-quota')
    expect(quota.status).toBe(200)
    expect(quota.body.accounts[0]).toMatchObject({ login: 'octocat', roles: ['user'], error: null, buckets: [{ resource: 'core', remaining: 0, riskPercent: 100 }] })
    expect(JSON.stringify(quota.body)).not.toContain('test-stored-credential')
    const state = await call('GET', '/api/notices')
    expect(state.body.notices[0]).toMatchObject({ kind: 'github_quota_exhausted', title: 'GitHub REST API quota exhausted for octocat', silenceable: false })
    expect((await call('POST', `/api/notices/${state.body.notices[0].id}/dismiss`, undefined, true)).body.notices).toEqual([])
    await call('GET', '/api/github-quota')
    expect((await call('GET', '/api/notices')).body.notices).toEqual([])
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(2)
  })

  it('gives an existing failed-behavior notice its exact Swarm call', async () => {
    const failed = store!.raiseAlert({
      kind: 'behavior_held', dedupeKey: 'behavior-held:approve-prs:acme/api#9',
      title: 'Approve Pull Requests failed on acme/api#9',
      body: 'Open Behaviors in Poise to see what happened.', path: '/', target: { view: 'behaviors' },
    })!
    database!.db.prepare(`
      INSERT INTO behavior_dead_letters(id, behavior, target, repo, pr, call_id, error, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run('failed', 'approve-prs', 'acme/api#9', 'acme/api', 9, 'failed-call', 'Approval failed', new Date().toISOString())
    const answer = await call('GET', '/api/notices')
    expect(answer.status).toBe(200)
    expect(answer.body.notices).toEqual([expect.objectContaining({
      id: failed.id, target: { swarm: 'failed-call' }, body: 'Open it in Poise to see what happened.',
      subject: { behavior: 'approve-prs', target: 'acme/api#9' },
    })])
  })

  it('serves what the page shows, the most pressing first', async () => {
    store!.raiseAlert(ready)
    store!.raiseAlert(waiting)
    const answer = await call('GET', '/api/notices')
    expect(answer.status).toBe(200)
    expect(answer.body.enabled).toBe(true)
    expect(answer.body.notices.map((notice: any) => [notice.kind, notice.target, notice.silenceable])).toEqual([
      ['chat_waiting', { chat: 's1' }, false],
      ['pr_ready', { pullRequest: 'https://github.com/acme/api/pull/1' }, true],
    ])
    // Only a failed behavior names a behavior and target.
    expect(answer.body.notices.some((notice: any) => 'subject' in notice)).toBe(false)
  })

  it('puts a notice away and answers with what is left', async () => {
    const chat = store!.raiseAlert(waiting)!
    store!.raiseAlert(ready)
    const dismissed = await call('POST', `/api/notices/${encodeURIComponent(chat.id)}/dismiss`, undefined, true)
    expect(dismissed.status).toBe(200)
    expect(dismissed.body.notices.map((notice: any) => notice.kind)).toEqual(['pr_ready'])
    // Every page reads the same: it stays away.
    expect((await call('GET', '/api/notices')).body.notices.map((notice: any) => notice.kind)).toEqual(['pr_ready'])
  })

  it('silences a pull request ready to merge or asking for review, and refuses to silence anything else', async () => {
    const chat = store!.raiseAlert(waiting)!
    const pr = store!.raiseAlert(ready)!
    const review = store!.raiseAlert({ kind: 'review_requested', dedupeKey: 'review-requested:acme/api#4', title: 'acme/api#4 requests your review', body: 'Change 4', path: '/', target: { pullRequest: 'https://github.com/acme/api/pull/4' } })!
    const refused = await call('POST', `/api/notices/${encodeURIComponent(chat.id)}/silence`)
    expect(refused.status).toBe(400)
    expect(refused.body.error).toMatch(/Only a pull request ready to merge or asking for your review can be silenced/)
    const silenced = await call('POST', `/api/notices/${encodeURIComponent(pr.id)}/silence`)
    expect(silenced.status).toBe(200)
    expect(silenced.body.notices.map((notice: any) => notice.kind).sort()).toEqual(['chat_waiting', 'review_requested'])
    const quiet = await call('POST', `/api/notices/${encodeURIComponent(review.id)}/silence`)
    expect(quiet.status).toBe(200)
    expect(quiet.body.notices.map((notice: any) => notice.kind)).toEqual(['chat_waiting'])
  })

  it('answers 404 for a notice it did not issue or that has cleared, and 400 for an unreadable id', async () => {
    const chat = store!.raiseAlert(waiting)!
    store!.resolveAlert(waiting.dedupeKey)
    for (const id of [chat.id, '000000000000-1', 'nope']) {
      const answer = await call('POST', `/api/notices/${encodeURIComponent(id)}/dismiss`, undefined, true)
      expect(answer.status, id).toBe(404)
      expect(answer.body.error, id).toMatch(/notification/)
    }
    expect((await call('POST', '/api/notices/%E0%A4%A/dismiss', undefined, true)).status).toBe(400)
  })

  it('turns notifications off and on from Settings', async () => {
    store!.raiseAlert(waiting)
    expect((await call('GET', '/api/settings')).body.notifications).toEqual({ enabled: true })

    const off = await call('POST', '/api/settings', { notifications: { enabled: false } })
    expect(off.status).toBe(200)
    expect(off.body.notifications).toEqual({ enabled: false })
    expect((await call('GET', '/api/notices')).body).toEqual({ enabled: false, notices: [] })

    const refused = await call('POST', '/api/settings', { notifications: { enabled: 'yes' } })
    expect(refused.status).toBe(400)
    expect((await call('GET', '/api/settings')).body.notifications).toEqual({ enabled: false })

    expect((await call('POST', '/api/settings', { notifications: { enabled: true } })).status).toBe(200)
    expect((await call('GET', '/api/notices')).body.notices.map((notice: any) => notice.kind)).toEqual(['chat_waiting'])
    // Turned on, the check ran at once; with no GitHub account set it asked GitHub nothing.
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore' || command === 'github-interface')).toEqual([])
  })
})

describe('the handling log', () => {
  async function handled(): Promise<{ status: number, body: { handled: Array<Record<string, unknown>> } }> {
    return await call('GET', '/api/notices/handled') as { status: number, body: { handled: Array<Record<string, unknown>> } }
  }

  it('records a dismissal while the notice stays active, then its clearing', async () => {
    const raised = store!.raiseAlert(waiting)!
    const dismissed = await call('POST', `/api/notices/${encodeURIComponent(raised.id)}/dismiss`, undefined, true)
    expect(dismissed.status).toBe(200)
    let state = await handled()
    expect(state.status).toBe(200)
    expect(state.body.handled).toHaveLength(1)
    expect(state.body.handled[0]).toMatchObject({ kind: 'notice', source: 'chat_waiting',
      title: waiting.title, outcome: 'dismissed', actor: 'person' })
    expect(Date.parse(state.body.handled[0]!.finishedAt as string))
      .toBeGreaterThanOrEqual(Date.parse(state.body.handled[0]!.startedAt as string))

    // Dismissed, not cleared: the earlier dismissal is preserved when the
    // condition later clears.
    store!.resolveAlert(waiting.dedupeKey)
    state = await handled()
    expect(state.body.handled.map((row) => row.outcome)).toEqual(['resolved', 'dismissed'])
    expect(state.body.handled[0]).toMatchObject({ actor: 'notices-service' })
    expect((await call('GET', '/api/notices')).body.notices).toEqual([])
  })

  it('refuses a dismissal without the person, through fetch and the native control api', async () => {
    const raised = store!.raiseAlert(waiting)!
    const refused = await call('POST', `/api/notices/${encodeURIComponent(raised.id)}/dismiss`)
    expect(refused.status).toBe(403)
    expect((await handled()).body.handled).toEqual([])

    const { execFile } = await import('node:child_process')
    const { writeFile } = await import('node:fs/promises')
    const { promisify } = await import('node:util')
    const config = join(root, 'control.json')
    await writeFile(config, JSON.stringify({ origin: base, sessionId: 's', token: 't' }))
    const stderr = await promisify(execFile)(process.execPath,
      [join(process.cwd(), 'scripts', 'poise-chat-control.mjs'), config,
        JSON.stringify({ operation: 'api', path: `/api/notices/${raised.id}/dismiss`, method: 'POST' })])
      .then(() => null, (error: any) => String(error?.stderr ?? error))
    expect(stderr).toMatch(/"status":\s*403/)
    expect((await handled()).body.handled).toEqual([])
  })

  it('attributes a silence from outside the browser to the api', async () => {
    const raised = store!.raiseAlert(ready)!
    const silenced = await call('POST', `/api/notices/${encodeURIComponent(raised.id)}/silence`)
    expect(silenced.status).toBe(200)
    const state = await handled()
    // The read's own check resolved the silence's alert first: with no
    // GitHub account set, nothing is followed, so nothing stays active.
    expect(state.body.handled.map((row) => row.outcome).sort()).toEqual(['resolved', 'silenced'])
    expect(state.body.handled.find((row) => row.outcome === 'silenced')).toMatchObject({ actor: 'api' })
  })

  it('logs behavior firings and Caller-reported runs with their outcomes', async () => {
    const metrics = await import('../server/behavior-metrics')
    const run = metrics.startDirectBehaviorRun('merge-prs')
    metrics.finishDirectBehaviorRun(run, false)
    const completed = metrics.startDirectBehaviorRun('resolve-unblocking')
    metrics.finishDirectBehaviorRun(completed, true)

    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'agent-interface' && args[0] === '--logs') {
        const now = new Date().toISOString()
        const rows = [{ id: 'a'.repeat(32), pr_id: '9', repo: 'acme/api', actor: 'review-bot',
          model: 'opus-5-xhigh', behavior: 'pr_review', session_id: null, prompt: '', started_at: now,
          started_at_precise: now, completed_at: now, time_elapsed: '1m', status: 'completed', outcome: 'clean',
          head_sha: 'b'.repeat(40), expected_head: 'b'.repeat(40), source: 'poise:review-new-prs',
          correlation_id: 'correlation-fixture', action: 'reviewed_clean', response: null, error: '' }]
        return { stdout: JSON.stringify(args.includes('--limit') ? { rows, nextCursor: null, total: rows.length } : rows), stderr: '' }
      }
      if (command === 'agent-interface' && args[0] === '--diagnostics') return { stdout: JSON.stringify({ version: 1, streamId: 'f'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }) }
      throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
    })
    expect((await call('GET', '/api/agent-logs?limit=100')).status).toBe(200)

    const state = await handled()
    expect(state.body.handled).toHaveLength(3)
    const firing = state.body.handled.find((row) => row.source === 'merge-prs')
    expect(firing).toMatchObject({ kind: 'behavior-firing', outcome: 'failed', actor: 'behaviors', error: null })
    const update = state.body.handled.find((row) => row.kind === 'caller-update')
    expect(update).toMatchObject({ source: 'pr_review', title: 'acme/api#9 pr_review',
      outcome: 'clean', actor: 'caller' })

    // A second sighting of the same run records nothing new.
    expect((await call('GET', '/api/agent-logs?limit=100')).status).toBe(200)
    expect((await handled()).body.handled).toHaveLength(3)
  })

  it('caps the read at the newest 200 rows', async () => {
    const { recordHandling } = await import('../server/alerts/handling')
    for (let n = 0; n < 205; n++) {
      recordHandling({ kind: 'notice', source: 'pr_ready', title: `Row ${n}`, startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(), outcome: 'resolved', actor: 'notices-service', ref: `test-row:${n}` })
    }
    const state = await handled()
    expect(state.body.handled).toHaveLength(200)
    expect(state.body.handled[0]!.title).toBe('Row 204')
    expect(state.body.handled.at(-1)!.title).toBe('Row 5')
  })

  it('keeps a row handled within 30 days however old its notice, and drops older handlings', async () => {
    const { recordHandling } = await import('../server/alerts/handling')
    const old = new Date(Date.now() - 60 * 24 * 60 * 60_000).toISOString()
    recordHandling({ kind: 'notice', source: 'pr_ready', title: 'Old notice, fresh handling',
      startedAt: old, finishedAt: new Date().toISOString(), outcome: 'dismissed', actor: 'person', ref: 'test-row:old-notice' })
    recordHandling({ kind: 'notice', source: 'pr_ready', title: 'Stale handling',
      startedAt: old, finishedAt: old, outcome: 'resolved', actor: 'notices-service', ref: 'test-row:stale' },
      new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString())
    const state = await handled()
    expect(state.body.handled.map((row) => row.title)).toEqual(['Old notice, fresh handling'])
  })

  it('answers stored rows when unreadiness or a failing datastore stops the checks', async () => {
    store!.raiseAlert(ready)!
    const dismissed = await call('POST', `/api/notices/${encodeURIComponent((await call('GET', '/api/notices')).body.notices[0].id)}/dismiss`, undefined, true)
    expect(dismissed.status).toBe(200)
    // No GitHub account is set: the read's check has nothing to read, and
    // the stored dismissal still answers.
    let state = await handled()
    expect(state.status).toBe(200)
    expect(state.body.handled.map((row) => row.outcome).sort()).toEqual(['dismissed', 'resolved'])

    // A failing datastore keeps prior state instead of failing the read.
    database!.setMeta('me', 'octocat')
    database!.setMeta('agentAccount', 'octo-agent')
    database!.setMeta('org', 'Legacy')
    mocks.runFile.mockImplementation(async () => { throw new Error('datastore unavailable') })
    state = await handled()
    expect(state.status).toBe(200)
    expect(state.body.handled.map((row) => row.outcome).sort()).toEqual(['dismissed', 'resolved'])
  })

  it('filters by since and refuses a malformed one', async () => {
    const { recordHandling } = await import('../server/alerts/handling')
    const first = new Date(Date.now() - 60_000).toISOString()
    recordHandling({ kind: 'notice', source: 'pr_ready', title: 'Older', startedAt: first,
      finishedAt: first, outcome: 'resolved', actor: 'notices-service', ref: 'test-row:older' }, first)
    recordHandling({ kind: 'notice', source: 'pr_ready', title: 'Newer', startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), outcome: 'resolved', actor: 'notices-service', ref: 'test-row:newer' })
    const filtered = await call('GET', `/api/notices/handled?since=${encodeURIComponent(first)}`)
    expect(filtered.status).toBe(200)
    expect(filtered.body.handled.map((row: any) => row.title)).toEqual(['Newer', 'Older'])
    expect(filtered.body.handled[0].id).toBeGreaterThan(0)
    const future = await call('GET', `/api/notices/handled?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)
    expect(future.body.handled).toEqual([])
    expect((await call('GET', '/api/notices/handled?since=soon')).status).toBe(400)
  })

  it('notices nothing when notifications turn off while a check is in flight', async () => {
    database!.setMeta('me', 'octocat')
    database!.setMeta('agentAccount', 'octo-agent')
    database!.setMeta('org', 'Legacy')
    store!.raiseAlert(ready)!
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'github-datastore') {
        await gate
        return { stdout: '[]', stderr: '' }
      }
      throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
    })
    const reading = handled()
    await vi.waitFor(() => expect(mocks.runFile.mock.calls.some(([command]) => command === 'github-datastore')).toBe(true))
    expect((await call('POST', '/api/settings', { notifications: { enabled: false } })).status).toBe(200)
    release()
    expect((await reading).status).toBe(200)
    // The pass noticed nothing: the alert stays open and unhandled.
    expect(store!.openAlerts().map((alert) => alert.dedupeKey)).toContain('pr-ready:acme/api#1')
    expect((await handled()).body.handled).toEqual([])
  })
})
