import Database from 'better-sqlite3'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '../server/organizations'
import type { RunFileOptions } from '../server/process'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { CATALOG_STDOUT } from './model-catalog-fixture'

vi.setConfig({ testTimeout: 25_000, hookTimeout: 25_000 })

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...(await original<typeof import('../server/process')>()),
  runFile: mocks.runFile,
  spawnDetached: vi.fn(async () => { throw new Error('unexpected agent launch') }),
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
let cache: typeof import('../server/cache-plugin') | undefined
let pendingIndex: Promise<void> | undefined
let releaseIndex: (() => void) | undefined
let pendingHealth: Promise<void> | undefined
let releaseHealth: (() => void) | undefined
let failIndex = false
let behaviorLogs: unknown[] = []
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

function writeIndex(path: string, login: string) {
  const fixture = new Database(path)
  try {
    fixture.exec('CREATE TABLE sync_state(scope TEXT, key TEXT, value TEXT)')
    const insert = fixture.prepare('INSERT INTO sync_state VALUES (?, ?, ?)')
    insert.run('org', 'login', login)
    insert.run('org', 'last_full_build_at', new Date().toISOString())
  } finally { fixture.close() }
}

async function cli(command: string, args: string[], options: RunFileOptions) {
  if (command === 'agent-interface' && args[0] === '--models') return { stdout: CATALOG_STDOUT, stderr: '' }
  // Paged reads speak the envelope with Caller's newest-first pagination,
  // org pre-filter and exact total. Fixture order is insertion order.
  if (command === 'agent-interface' && args[0] === '--logs' && args.includes('--limit')) {
    const flag = (name: string) => {
      const at = args.indexOf(name)
      return at >= 0 ? args[at + 1]! : undefined
    }
    const limit = Number(flag('--limit'))
    const cursor = flag('--cursor')
    const org = flag('--org')
    const search = flag('--search')
    const ownerOf = (repo: unknown) => typeof repo === 'string' ? repo.split('/', 1)[0].toLowerCase() : null
    const matchesSearch = (row: Record<string, unknown>) => {
      if (search === undefined) return true
      const q = search.toLowerCase()
      const repo = typeof row.repo === 'string' ? row.repo : ''
      const pr = row.pr_id === null || row.pr_id === undefined ? '' : String(row.pr_id)
      return [
        row.id, row.model, row.recovery_model, row.behavior, row.prompt, row.status,
        row.actor, row.repo, row.pr_id, row.session_id, row.outcome, row.error,
        repo && pr ? `${repo}#${pr}` : (repo || (pr ? `#${pr}` : '')),
      ].some((field) => String(field ?? '').toLowerCase().includes(q))
    }
    const matching = (behaviorLogs as Record<string, unknown>[])
      .map((row, index) => ({ row, rowid: index + 1 }))
      .filter(({ row }) => (org === undefined || ownerOf(row.repo) === org.toLowerCase()) && matchesSearch(row))
    const total = matching.length
    const bound = cursor === undefined ? undefined : Number(cursor)
    const older = bound === undefined ? matching : matching.filter(({ rowid }) => rowid < bound)
    const newestFirst = [...older].reverse()
    const slice = newestFirst.slice(0, limit + 1)
    const page = slice.slice(0, limit)
    const oldest = page.length ? page[page.length - 1]!.rowid : null
    return { stdout: JSON.stringify({
      rows: [...page].reverse().map(({ row }) => row),
      nextCursor: slice.length > limit && oldest !== null ? String(oldest) : null,
      total,
    }), stderr: '' }
  }
  // Single-id point reads filter to the requested call, like Caller's
  // primary-key lookup. Other selections keep the full fixture for the
  // behavior tests that rely on it.
  if (command === 'agent-interface' && args[0] === '--logs' && args[1] === '--select') {
    try {
      const selection = JSON.parse(args[2]!) as { latest?: unknown[], ids?: unknown }
      if (Array.isArray(selection.latest) && selection.latest.length === 0 && Array.isArray(selection.ids) && selection.ids.length === 1) {
        const wanted = String(selection.ids[0]).toLowerCase()
        const found = (behaviorLogs as Record<string, unknown>[]).filter((row) => String(row.id ?? '').toLowerCase() === wanted)
        return { stdout: JSON.stringify(found), stderr: '' }
      }
    } catch {
      // Fall through to the full fixture; the server validates instead.
    }
  }
  if (command === 'agent-interface' && args[0] === '--logs') return { stdout: JSON.stringify(behaviorLogs), stderr: '' }
  if (command === 'github-interface' && args[0] === '--view-repos') {
    return { stdout: JSON.stringify({ repos: [{ full_name: `${args[1]}/same-repo` }] }), stderr: '' }
  }
  if (command === 'gh') return { stdout: 'test-secret-token', stderr: '' }
  if (command !== 'github-datastore') throw new Error(`Unexpected test command: ${command}`)
  if (args[2] === 'init-org') {
    if (pendingIndex) await Promise.race([
      pendingIndex,
      new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    ])
    if (failIndex) throw new Error('organization access denied')
    writeIndex(args[1]!, args[3]!)
  }
  if (args[2] === 'health' && pendingHealth) await Promise.race([
    pendingHealth,
    new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  ])
  return {
    stdout: args[2] === 'health'
      ? JSON.stringify({ action: 'health', healthy: true, status: 'healthy', database: args[1] })
      : '',
    stderr: '',
  }
}

// The server graph is re-imported per test, so the reset must come from the
// test's own instance. Call it after re-pointing behaviorLogs mid-test: the
// lanes would otherwise keep serving the previous phase's snapshot.
async function resetLogCache() {
  (await import('../server/agent')).resetAgentLogCache()
}

async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as { organizations: Organization[], error?: string, org?: string, me?: string } }
}

async function orgStatus(login: string, status: Organization['status']) {
  await vi.waitFor(async () => {
    const result = await request('/api/organizations')
    expect(result.body.organizations.find((org) => org.login.toLowerCase() === login.toLowerCase())?.status).toBe(status)
  })
}

describe('independent account reads', () => {
  it('returns a fast account while another provider is still being checked', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const { invalidateAccounts } = await import('../server/accounts')
    invalidateAccounts()
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'gh' && args[0] === '--version') { await held; return { stdout: '2.92.0', stderr: '' } }
      if (command === 'gh' && args[0] === 'auth') return { stdout: '{"hosts":{"github.com":[]}}', stderr: '' }
      if (command === 'codex') return { stdout: args[0] === '--version' ? '0.160.0' : '', stderr: 'Logged in using ChatGPT' }
      return cli(command, args, options)
    })
    const slow = fetch(`${base}/api/accounts?id=gh`)
    try {
      await vi.waitFor(() => expect(mocks.runFile).toHaveBeenCalledWith('gh', ['--version'], expect.anything()))
      const fast = await fetch(`${base}/api/accounts?id=codex`)
      expect(fast.status).toBe(200)
      expect((await fast.json()).accounts).toEqual([expect.objectContaining({ id: 'codex', signedIn: true })])
    } finally { release(); await slow }
  })

  it.each(['', 'unknown', '../gh'])('rejects an invalid account id %s without starting probes', async id => {
    const probes = () => mocks.runFile.mock.calls.filter(([, args]) => ['--version', 'auth', 'login'].includes(args[0]))
    const before = probes().length
    const response = await fetch(`${base}/api/accounts?id=${encodeURIComponent(id)}`)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('id must name')
    expect(probes().length).toBe(before)
  })
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-organizations-api-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
  pendingIndex = undefined
  releaseIndex = undefined
  pendingHealth = undefined
  releaseHealth = undefined
  failIndex = false
  behaviorLogs = []
  mocks.runFile.mockReset().mockImplementation(cli)
  vi.resetModules()
  database = await import('../server/db')
  database.setMeta('org', 'Legacy')
  database.setMeta('me', 'octocat')
  const behaviors = await import('../server/behaviors')
  vi.spyOn(behaviors, 'startBehaviorsRuntime').mockImplementation(() => undefined)
  vi.spyOn(behaviors, 'stopBehaviorsRuntime').mockResolvedValue(undefined)
  cache = await import('../server/cache-plugin')
  const middleware = cache.createPoiseMiddleware({ claudeAuth: createAuthenticatedClaudeAuth(), selfUpdateBridge: null })
  server = createServer((req, res) => {
    void middleware(req, res, () => { res.statusCode = 404; res.end() })
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

describe('organizations API', () => {
  it('says this is a personal computer, so Settings adds no gateway sections and setup never opens', async () => {
    const response = await fetch(`${base}/api/workspace`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mode: 'local' })
    expect(await (await fetch(`${base}/api/onboarding`)).json()).toEqual({ available: false, status: 'done' })
    expect((await request('/api/onboarding', { step: 'github' })).status).toBe(404)
    expect((await request('/api/onboarding/github', { role: 'me', login: 'octocat' })).status).toBe(404)
  })

  it('returns the existing organization unchanged through registry and Settings', async () => {
    const registry = await request('/api/organizations')
    expect(registry.status).toBe(200)
    expect(registry.body.organizations).toEqual([{
      login: 'Legacy', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null, retryAt: null,
    }])
    const settings = await request('/api/settings')
    expect(settings.body).toMatchObject({ org: 'Legacy', me: 'octocat', organizations: registry.body.organizations })
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore')).toEqual([])
  })

  it('returns accepted before indexing ends, then publishes ready status without touching legacy', async () => {
    pendingIndex = new Promise<void>((resolve) => { releaseIndex = resolve })
    pendingHealth = new Promise<void>((resolve) => { releaseHealth = resolve })
    database!.recordSeen('review-new-prs', 'Legacy/repo#1')
    const added = await request('/api/organizations', { org: ' Acme ', datastorePath: '/ignored.sqlite' })
    expect(added.status).toBe(202)
    expect(added.body.organizations).toMatchObject([
      { login: 'Legacy', status: 'ready', managed: false },
      { login: 'acme', status: 'initializing', managed: true, datastorePath: join(root, 'datastores/acme/github.sqlite') },
    ])
    const duplicate = await request('/api/organizations', { org: 'ACME' })
    expect(duplicate.status).toBe(202)
    expect(duplicate.body.organizations).toHaveLength(2)
    const progress = await request('/api/organizations')
    expect(progress.body.organizations[1]!.status).toBe('initializing')
    releaseIndex!()
    pendingIndex = undefined
    await vi.waitFor(() => expect(mocks.runFile.mock.calls.some(([command, args]) => command === 'github-datastore' && args[2] === 'health')).toBe(true), { timeout: 5000 })
    const checking = await request('/api/organizations')
    expect(checking.body.organizations[1]).toMatchObject({ status: 'initializing', stage: 'checking' })
    releaseHealth!()
    pendingHealth = undefined
    await orgStatus('acme', 'ready')
    expect(mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-datastore' && args[2] === 'init-org')).toHaveLength(1)
    expect(database!.getMeta('org')).toBe('Legacy')
    expect(database!.hasSeen('review-new-prs', 'Legacy/repo#1')).toBe(true)
  })

  it.each([{}, null, [], { org: 12 }, { org: '../escape' }, { org: 'https://github.com/acme' }])('rejects malformed organization input %j without starting work', async (body) => {
    const result = await request('/api/organizations', body)
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('GitHub organization name')
    expect((await request('/api/organizations')).body.organizations).toHaveLength(1)
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore')).toEqual([])
  })

  it('exposes the shared quota reset and refuses to bypass it through the retry API', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'github-datastore' && args[2] === 'init-org') {
        throw Object.assign(new Error('GitHub API rate limit exceeded'), {
          stderr: `GITHUB_RATE_LIMIT_RESET=${reset}`,
        })
      }
      return cli(command, args, options)
    })
    await request('/api/organizations', { org: 'acme' })
    await vi.waitFor(async () => {
      const result = await request('/api/organizations')
      expect(result.body.organizations[1]).toMatchObject({
        login: 'acme', status: 'initializing', stage: 'rate-limited',
        retryAt: new Date(reset * 1000).toISOString(), error: expect.stringContaining('automatically'),
      })
    })
    const requests = () => mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore' || command === 'gh')
    const count = requests().length
    const retry = await request('/api/organizations/acme/retry', {})
    expect(retry.status).toBe(202)
    expect(retry.body.organizations[1]!.retryAt).toBe(new Date(reset * 1000).toISOString())
    const added = await request('/api/organizations', { org: 'beta' })
    expect(added.body.organizations[2]).toMatchObject({ login: 'beta', stage: 'rate-limited', retryAt: new Date(reset * 1000).toISOString() })
    const settings = await request('/api/settings')
    expect(settings.body.organizations[1]!.retryAt).toBe(new Date(reset * 1000).toISOString())
    expect(requests()).toHaveLength(count)
    expect(settings.body.organizations[0]!.retryAt).toBeNull()
  })

  it('persists an activation error and recovers through its explicit retry endpoint', async () => {
    failIndex = true
    expect((await request('/api/organizations', { org: 'acme' })).status).toBe(202)
    await orgStatus('acme', 'error')
    const failed = (await request('/api/organizations')).body.organizations[1]!
    expect(failed.error).toContain('organization access denied')
    failIndex = false
    expect((await request('/api/organizations/ACME/retry', {})).status).toBe(202)
    await orgStatus('acme', 'ready')
    expect((await request('/api/organizations')).body.organizations[1]!.error).toBeNull()
    expect((await request('/api/organizations/missing/retry', {})).status).toBe(400)
  })

  it('rejects a settings update that would bypass organization activation before saving any fields', async () => {
    const result = await request('/api/settings', { org: 'uninitialized', me: 'different-user' })
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('account setup')
    expect(database!.getMeta('org')).toBe('Legacy')
    expect(database!.getMeta('me')).toBe('octocat')
    expect((await request('/api/organizations')).body.organizations).toHaveLength(1)
    const valid = await request('/api/settings', { org: 'Legacy', timezone: 'UTC' })
    expect(valid.status).toBe(200)
    expect(valid.body.organizations[0]!.login).toBe('Legacy')
  })
})


describe('global behavior settings API', () => {
  async function addSecondAccount() {
    expect((await request('/api/organizations', { org: 'beta' })).status).toBe(202)
    await orgStatus('beta', 'ready')
  }

  async function state(query = '') {
    const response = await fetch(`${base}/api/behaviors${query}`)
    const data = await response.json() as Record<string, Record<string, unknown>>
    expect(response.status, JSON.stringify(data)).toBe(200)
    return data
  }

  it('shares preferences and memory conflict checks across legacy account query parameters', async () => {
    await addSecondAccount()
    database!.setMeta('behavior_review_new_prs_enabled', '1')
    const updated = await request('/api/behaviors/review-new-prs?org=beta', {
      setting: 'p3', reviewers: 3, scratchpad: 'Shared instructions',
    })
    expect(updated.status, JSON.stringify(updated.body)).toBe(200)
    for (const query of ['', '?org=Legacy', '?org=beta', '?org=not-configured']) {
      expect((await state(query))['review-new-prs']).toMatchObject({
        enabled: true, setting: 'p3', reviewers: 3, scratchpad: 'Shared instructions',
      })
    }
    expect(database!.getMeta('org:beta:behavior_review_new_prs_setting')).toBeNull()
    expect((await request('/api/behaviors/review-new-prs?org=Legacy', {
      scratchpad: 'Stale overwrite', scratchpadPrevious: '',
    })).status).toBe(409)
    expect((await state())['review-new-prs']!.scratchpad).toBe('Shared instructions')
    expect((await request('/api/behaviors/review-new-prs?org=beta', { enabled: false })).status).toBe(200)
    expect((await state('?org=Legacy'))['review-new-prs']!.enabled).toBe(false)
    expect((await state('?org=beta'))['review-new-prs']!.enabled).toBe(false)
  })

  it('keeps one issue repository selection across accounts and validates each repository owner', async () => {
    await addSecondAccount()
    const repos = ['beta/same-repo', 'Legacy/same-repo']
    const added = await request('/api/behaviors/review-new-issues', { repos })
    expect(added.status, JSON.stringify(added.body)).toBe(200)
    expect((await state())['review-new-issues']!.repos).toEqual(repos)
    expect((await state('?org=beta'))['review-new-issues']!.repos).toEqual(repos)
    expect(mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--view-repos')
      .map(([, args]) => args[1]).sort()).toEqual(['Legacy', 'beta'])
    const before = database!.getMeta('behavior_review_new_issues_repos')
    expect((await request('/api/behaviors/review-new-issues', { enabled: true, repos: [...repos, 'beta/unknown'] })).status).toBe(400)
    expect(database!.getMeta('behavior_review_new_issues_repos')).toBe(before)
    expect((await state())['review-new-issues']!.enabled).toBe(false)
  })

  it('serves healthy Swarm rows and diagnostics when one worker row is unreadable', async () => {
    const healthy = { id: '1'.repeat(32), behavior: 'pr_review',
      source: 'poise:review-new-prs', repo: 'Legacy/same-repo', pr_id: '1',
      started_at: '2026-10-01T12:00:00Z', completed_at: '2026-10-01T12:00:01Z', status: 'completed',
      actor: 'review-bot', expected_head: 'a'.repeat(40), head_sha: 'a'.repeat(40),
      correlation_id: 'healthy-review', action: 'reviewed_clean', outcome: 'clean',
      model: 'test', prompt: '', time_elapsed: '1s' }
    behaviorLogs = [healthy, { ...healthy, id: '2'.repeat(32), pr_id: '2',
      correlation_id: 'unreadable-review', outcome: null }]
    const response = await fetch(`${base}/api/agent-logs?limit=100`)
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.logs).toMatchObject([{ id: healthy.id }])
    expect(data.quarantined).toMatchObject([{ id: '2'.repeat(32), prId: '2' }])
    expect(data.total).toBe(2)
    expect(data.nextCursor).toBeNull()
    const diagnostics = await state()
    expect(diagnostics['review-new-prs']!.lastTriggered).toMatchObject({ target: 'Legacy/same-repo#1' })
    // Caller pre-filters by org; a non-matching row never reaches the page.
    // Real Caller rows cannot share an id or correlation (primary key and
    // unique index), so cross-org ambiguity cannot arise at the source.
    behaviorLogs = [healthy, { ...healthy, id: '3'.repeat(32), repo: 'elsewhere/repo', outcome: null,
      correlation_id: 'elsewhere-review' }]
    await resetLogCache()
    const scoped = await (await fetch(`${base}/api/agent-logs?org=Legacy&limit=100`)).json()
    expect(scoped.logs).toMatchObject([{ id: healthy.id }])
    expect(scoped.quarantined).toEqual([])
    expect(scoped.total).toBe(1)
    // Within one org a duplicate id still withholds: the page carries both
    // rows and the readable one is not served while ambiguous.
    behaviorLogs = [healthy, { ...healthy, repo: 'Legacy/same-repo', outcome: null }]
    await resetLogCache()
    const conflictingCorrelation = await (await fetch(`${base}/api/agent-logs?org=Legacy&limit=100`)).json()
    expect(conflictingCorrelation.logs).toEqual([])
    expect(conflictingCorrelation.quarantined).toMatchObject([{
      id: healthy.id, repo: 'Legacy/same-repo', correlationId: 'healthy-review',
      error: expect.stringContaining('incomplete terminal outcome'),
    }])
  })

  it('limits the newest scoped runs after validation without truncating diagnostics', async () => {
    const row = (index: number, repo = 'Legacy/same-repo') => ({
      id: index.toString(16).padStart(32, '0'), repo, pr_id: String(index), model: 'test',
      behavior: 'pr_review', prompt: '', actor: 'review-bot', status: 'completed', outcome: null,
      started_at: '2026-10-01T12:00:00Z', completed_at: '2026-10-01T12:01:00Z', time_elapsed: '1m',
    })
    behaviorLogs = [{ ...row(900), actor: 42 }, ...Array.from({ length: 80 }, (_, index) => row(index + 1)), row(901, 'beta/other')]
    const data = await (await fetch(`${base}/api/agent-logs?org=Legacy&limit=2`)).json()
    expect(data.logs.map((entry: { id: string }) => entry.id)).toEqual([row(80).id, row(79).id])
    // Total counts matching rows at the source, including the unreadable one.
    expect(data.total).toBe(81)
    expect(data.nextCursor).toEqual(expect.any(String))
    // The unreadable row is older than this page; it arrives with its page.
    expect(data.quarantined).toEqual([])
    const second = await (await fetch(`${base}/api/agent-logs?org=Legacy&limit=80&cursor=${data.nextCursor}`)).json()
    expect(second.quarantined).toMatchObject([{ id: row(900).id, error: expect.stringContaining('invalid actor') }])
    expect(second.total).toBe(81)
    const conflict = { ...row(80), actor: 42 }
    behaviorLogs.push(conflict)
    await resetLogCache()
    const withheld = await (await fetch(`${base}/api/agent-logs?org=Legacy&limit=1`)).json()
    expect(withheld.logs).toEqual([])
    expect(withheld.total).toBe(82)
    expect(withheld.quarantined).toEqual(expect.arrayContaining([expect.objectContaining({ id: row(80).id })]))
  })

  it.each(['0', '-1', '1001', '1.5', 'abc', ''])('rejects invalid agent-log preview limit %s before reading Caller', async limit => {
    const before = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--logs').length
    const response = await fetch(`${base}/api/agent-logs?limit=${limit}`)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('limit must be an integer from 1 to 1000')
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--logs')).toHaveLength(before)
  })

  it('requires a bound for history reads and validates cursor and search before reading Caller', async () => {
    const before = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--logs').length
    for (const path of ['/api/agent-logs', '/api/agent-logs?org=Legacy', '/api/agent-logs?cursor=5', '/api/agent-logs?search=x']) {
      const response = await fetch(`${base}${path}`)
      expect(response.status).toBe(400)
      expect((await response.json()).error).toMatch(/limit is required|cursor and search require limit/)
    }
    for (const path of ['/api/agent-logs?limit=10&cursor=0', '/api/agent-logs?limit=10&cursor=oldest',
      '/api/agent-logs?limit=10&search=', '/api/agent-logs?limit=10&status=running&cursor=5']) {
      const response = await fetch(`${base}${path}`)
      expect(response.status).toBe(400)
    }
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--logs')).toHaveLength(before)
  })

  it('serves one exact call by id for settled-running refresh', async () => {
    const target = 'a'.repeat(32)
    behaviorLogs = [
      { id: target, repo: 'Legacy/same-repo', pr_id: '9', model: 'test', behavior: 'pr_review',
        prompt: '', actor: 'review-bot', status: 'completed', outcome: null,
        started_at: '2026-10-01T12:00:00Z', completed_at: '2026-10-01T12:01:00Z', time_elapsed: '1m' },
      { id: 'b'.repeat(32), repo: 'Legacy/same-repo', pr_id: '10', model: 'test', behavior: 'pr_review',
        prompt: '', actor: 'review-bot', status: 'running',
        started_at: '2026-10-01T12:00:00Z', completed_at: null, time_elapsed: '1m', outcome: null },
    ]
    const data = await (await fetch(`${base}/api/agent-logs?id=${target}`)).json()
    expect(data.logs.map((entry: { id: string }) => entry.id)).toEqual([target])
    expect(data.quarantined).toEqual([])
    const missing = await (await fetch(`${base}/api/agent-logs?id=${'c'.repeat(32)}`)).json()
    expect(missing.logs).toEqual([])
    const scoped = await (await fetch(`${base}/api/agent-logs?id=${target}&org=Legacy`)).json()
    expect(scoped.logs.map((entry: { id: string }) => entry.id)).toEqual([target])
    const before = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--logs').length
    for (const path of [`/api/agent-logs?id=short`, `/api/agent-logs?id=${target}&limit=1`,
      `/api/agent-logs?id=${target}&status=running`]) {
      const response = await fetch(`${base}${path}`)
      expect(response.status).toBe(400)
    }
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--logs')).toHaveLength(before)
    const selected = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--logs' && args[1] === '--select')
    expect(selected.length).toBeGreaterThan(0)
    for (const [, args] of selected) expect(args.join(' ')).not.toContain('--limit')
  })

  it('serves a running-only agent-log read for the Current accent', async () => {
    const row = (index: number, status = 'running', repo = 'Legacy/same-repo') => ({
      id: index.toString(16).padStart(32, '0'), repo, pr_id: String(index), model: 'test',
      behavior: 'pr_review', prompt: '', actor: 'review-bot', status,
      started_at: '2026-10-01T12:00:00Z',
      completed_at: status === 'running' ? null : '2026-10-01T12:01:00Z',
      time_elapsed: '1m', outcome: null,
    })
    behaviorLogs = [
      row(1, 'running'),
      row(2, 'completed'),
      row(3, 'running', 'beta/other'),
      { ...row(4, 'completed'), actor: 42 },
      { ...row(5, 'running'), status: 42 },
      { ...row(6, 'running'), correlation_id: 'dupe-run' },
      { ...row(7, 'running'), correlation_id: 'dupe-run', actor: 42 },
      row(8, 'running'),
    ]
    const running = await (await fetch(`${base}/api/agent-logs?org=Legacy&status=running`)).json()
    expect(running.logs.map((entry: { id: string }) => entry.id)).toEqual([row(8).id, row(1).id])
    expect(running.quarantined.map((entry: { id: string }) => entry.id)).toEqual([row(5).id, row(7).id])
    expect(running).not.toHaveProperty('total')
    const full = await (await fetch(`${base}/api/agent-logs?org=Legacy&limit=100`)).json()
    expect(running.logs).toEqual(full.logs.filter((entry: { status: string }) => entry.status === 'running'))
    const preview = await (await fetch(`${base}/api/agent-logs?org=Legacy&status=running&limit=1`)).json()
    expect(preview.logs.map((entry: { id: string }) => entry.id)).toEqual([row(8).id])
    expect(preview.total).toBe(2)
    const before = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--logs').length
    const rejected = await fetch(`${base}/api/agent-logs?status=completed`)
    expect(rejected.status).toBe(400)
    expect((await rejected.json()).error).toContain('status must be running')
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--logs')).toHaveLength(before)
  })

  it('classifies retained no-action incidents even after their failure summary is gone', async () => {
    const target = 'Legacy/same-repo#18'
    const claimId = database!.claimSeenOwned('review-new-prs', target)!
    const error = `pull-request head changed: expected ${'a'.repeat(40)}, got ${'b'.repeat(40)}`
    expect(database!.markBehaviorLaunchIntentOwned({ key: 'review-new-prs', target, claimId,
      launchBehavior: 'pr_review', repo: 'Legacy/same-repo', pr: 18, requestedAt: '2026-10-13T14:08:00Z',
      expectedHead: 'a'.repeat(40), actor: 'review-bot', source: 'poise:review-new-prs', correlationId: claimId })).toBe(true)
    const claim = database!.listBehaviorLaunchClaims('review-new-prs').find((row) => row.target === target)!
    const callId = 'd'.repeat(32)
    database!.recordBehaviorDeadLetter(claim, error, callId)
    behaviorLogs = [{ id: callId, model: 'test', prompt: '', time_elapsed: '4s', behavior: 'pr_review',
      repo: 'Legacy/same-repo', pr_id: '18', actor: 'review-bot', source: 'poise:review-new-prs',
      correlation_id: claimId, started_at: '2026-10-13T14:08:00Z', completed_at: '2026-10-13T14:08:04Z',
      status: 'failed', action: 'not_started', outcome: 'preflight_failed', expected_head: 'a'.repeat(40),
      head_sha: null, review_id: null, receipts: null, error }]
    const response = await (await fetch(`${base}/api/behaviors`)).json()
    expect(response.diagnostics.failures).toEqual([])
    expect(response.diagnostics.deadLetters).toContainEqual(expect.objectContaining({ callId,
      diagnostic: { severity: 'info', code: 'head_changed' } }))
    behaviorLogs = []
    await resetLogCache()
    const unread = await (await fetch(`${base}/api/behaviors`)).json()
    expect(unread.diagnostics.deadLetters).toContainEqual(expect.objectContaining({ callId,
      diagnostic: { severity: 'warning', code: 'held_result' } }))
    const secondTarget = `${target}:secondary`
    const secondId = database!.claimSeenOwned('review-new-prs', secondTarget)!
    expect(database!.markBehaviorLaunchIntentOwned({ key: 'review-new-prs', target: secondTarget, claimId: secondId,
      launchBehavior: 'pr_review', repo: 'Legacy/same-repo', pr: 18, requestedAt: '2026-10-13T14:09:00Z',
      expectedHead: 'b'.repeat(40), actor: 'review-bot', source: 'poise:review-new-prs', correlationId: secondId })).toBe(true)
    const second = database!.listBehaviorLaunchClaims('review-new-prs').find((row) => row.target === secondTarget)!
    database!.recordBehaviorDeadLetter(second, error, 'e'.repeat(32))
    database!.quarantineBehaviorLaunchOwned('review-new-prs', target, claimId, 'invalid_result', 'launch contract mismatch', false)
    behaviorLogs = [{ id: 'e'.repeat(32), model: 'test', prompt: '', time_elapsed: '4s', behavior: 'pr_review',
      repo: 'Legacy/same-repo', pr_id: '18', actor: 'review-bot', source: 'poise:review-new-prs',
      correlation_id: secondId, started_at: '2026-10-13T14:09:00Z', completed_at: '2026-10-13T14:09:04Z',
      status: 'failed', action: 'not_started', outcome: 'preflight_failed', expected_head: 'b'.repeat(40),
      head_sha: null, review_id: null, receipts: null, error }]
    await resetLogCache()
    const separate = await (await fetch(`${base}/api/behaviors`)).json()
    expect(separate.diagnostics.deadLetters).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId, diagnostic: { severity: 'error', code: 'invalid_agent_result' } }),
      expect.objectContaining({ callId: 'e'.repeat(32), diagnostic: { severity: 'info', code: 'head_changed' } }),
    ]))
  })

  it('shows latest behavior activity across configured accounts', async () => {
    await addSecondAccount()
    behaviorLogs = ['Legacy', 'beta', 'unconfigured'].map((owner, index) => ({
      id: String(index + 1).repeat(32), behavior: 'pr_review',
      source: 'poise:review-new-prs', repo: `${owner}/same-repo`, pr_id: '1',
      started_at: `2026-10-01T12:0${index}:00Z`, completed_at: `2026-10-01T12:0${index}:01Z`, status: 'completed',
      actor: 'review-bot', expected_head: 'a'.repeat(40), head_sha: 'a'.repeat(40),
      correlation_id: `review-${index}`, action: 'reviewed_clean', outcome: 'clean',
      model: 'test', prompt: '', time_elapsed: '1s',
    }))
    for (const query of ['', '?org=Legacy']) {
      expect((await state(query))['review-new-prs']!.lastTriggered).toEqual({
        at: '2026-10-01T12:01:00Z', target: 'beta/same-repo#1',
      })
    }
  })

  // A held paged-history read must not slow the dashboard or health:
  // behaviors walks bounded selections on its own lanes, and health reads
  // no log at all.
  it('keeps behaviors and health responsive while a history read runs', async () => {
    behaviorLogs = [{
      id: '1'.repeat(32), behavior: 'pr_review',
      source: 'poise:review-new-prs', repo: 'Legacy/same-repo', pr_id: '1',
      started_at: '2026-10-01T12:00:00Z', completed_at: '2026-10-01T12:00:01Z', status: 'completed',
      actor: 'review-bot', expected_head: 'a'.repeat(40), head_sha: 'a'.repeat(40),
      correlation_id: 'review-0', action: 'reviewed_clean', outcome: 'clean',
      model: 'test', prompt: '', time_elapsed: '1s',
    }]
    let releaseHistory!: (value: { stdout: string, stderr: string }) => void
    const held = new Promise<{ stdout: string, stderr: string }>((resolve) => { releaseHistory = resolve })
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: RunFileOptions) => {
      if (command === 'agent-interface' && args[0] === '--logs' && args.includes('--limit')) return held
      return cli(command, args, options)
    })
    // Steady-state latencies: one unmeasured round warms the path first.
    await fetch(`${base}/api/behaviors`)
    await fetch(`${base}/api/health`)
    const history = fetch(`${base}/api/agent-logs?limit=100`)
    try {
      await vi.waitFor(() => expect(mocks.runFile.mock.calls.some(([, args]) => args.includes('--limit'))).toBe(true))
      const latencies: number[] = []
      for (let index = 0; index < 20; index++) {
        for (const path of ['/api/behaviors', '/api/health']) {
          const started = performance.now()
          const response = await fetch(`${base}${path}`)
          latencies.push(performance.now() - started)
          // Health answers degraded in the fixture; both must answer fast.
          expect([200, 503]).toContain(response.status)
        }
      }
      const sorted = [...latencies].sort((a, b) => a - b)
      expect(sorted[Math.ceil(0.95 * sorted.length) - 1]).toBeLessThan(250)
      expect((await state())['review-new-prs']!.lastTriggered).toEqual({
        at: '2026-10-01T12:00:00Z', target: 'Legacy/same-repo#1',
      })
    } finally {
      releaseHistory({ stdout: JSON.stringify({ rows: behaviorLogs, nextCursor: null, total: behaviorLogs.length }), stderr: '' })
    }
    await expect(history.then((response) => response.status)).resolves.toBe(200)
  })
})

describe('stopping following an organization', () => {
  const runScript = promisify(execFile)

  async function remove(login: string, person: boolean) {
    const response = await fetch(`${base}/api/organizations/${encodeURIComponent(login)}`, {
      method: 'DELETE', headers: person ? { Origin: base } : {},
    })
    return { status: response.status, body: await response.json() as { organizations: Organization[], error?: string } }
  }

  async function addReady(login: string) {
    expect((await request('/api/organizations', { org: login })).status).toBe(202)
    await orgStatus(login, 'ready')
  }

  function registered(login: string): boolean {
    return !!database!.db.prepare('SELECT 1 FROM organizations WHERE login = ? COLLATE NOCASE').get(login)
  }

  function datastoreCalls(): unknown[][] {
    return mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore' || command === 'gh')
  }

  it('removes a ready managed organization and refuses the legacy, the last, the unknown and the malformed', async () => {
    await addReady('acme')
    const removed = await remove('acme', true)
    expect(removed.status).toBe(200)
    expect(removed.body.organizations).toEqual([
      { login: 'Legacy', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null, retryAt: null },
    ])
    expect(registered('acme')).toBe(false)

    const legacy = await remove('Legacy', true)
    expect(legacy.status).toBe(400)
    expect(legacy.body.error).toContain('needs this account')
    const missing = await remove('missing', true)
    expect(missing.status).toBe(400)
    expect(missing.body.error).toContain('not configured')
    const malformed = await remove('../escape', true)
    expect(malformed.status).toBe(400)
    expect((await request('/api/organizations')).body.organizations).toHaveLength(1)

    // The last account standing cannot go either.
    await addReady('beta')
    database!.db.prepare('DELETE FROM organizations WHERE login = ? COLLATE NOCASE').run('Legacy')
    database!.setMeta('org', '')
    expect((await request('/api/organizations')).body.organizations.map((org) => org.login)).toEqual(['beta'])
    const last = await remove('beta', true)
    expect(last.status).toBe(400)
    expect(last.body.error).toContain('last GitHub account')
    expect(registered('beta')).toBe(true)
  })

  it('aborts an activation in flight and publishes nothing after it', async () => {
    pendingIndex = new Promise<void>((resolve) => { releaseIndex = resolve })
    expect((await request('/api/organizations', { org: 'acme' })).status).toBe(202)
    await vi.waitFor(() => expect(datastoreCalls().some(([, args]: any[]) => args[2] === 'init-org')).toBe(true))
    const removed = await remove('ACME', true)
    expect(removed.status).toBe(200)
    expect(removed.body.organizations).toHaveLength(1)
    expect(registered('acme')).toBe(false)
    releaseIndex!()
    pendingIndex = undefined
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await request('/api/organizations')).body.organizations).toHaveLength(1)
    expect(database!.getMeta('organization_generation:acme')).toBe('1')
  })

  it('aborts a sync in flight and publishes nothing after it', async () => {
    await addReady('acme')
    const health = () => datastoreCalls().filter(([, args]: any[]) => (args as string[])[2] === 'health').length
    const before = health()
    pendingHealth = new Promise<void>((resolve) => { releaseHealth = resolve })
    expect((await request('/api/organizations/acme/retry', {})).status).toBe(202)
    await vi.waitFor(() => expect(health()).toBeGreaterThan(before))
    const removed = await remove('acme', true)
    expect(removed.status).toBe(200)
    expect(registered('acme')).toBe(false)
    releaseHealth!()
    pendingHealth = undefined
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await request('/api/organizations')).body.organizations).toHaveLength(1)
    expect(database!.getMeta('organization_generation:acme')).toBe('1')
  })

  it('refuses the second of two concurrent removals that would leave none', async () => {
    await addReady('acme')
    await addReady('beta')
    database!.db.prepare('DELETE FROM organizations WHERE login = ? COLLATE NOCASE').run('Legacy')
    database!.setMeta('org', '')
    // Beta's sync holds its abort: the removal waits inside the job settle
    // even after aborting, while acme's removal lands.
    let releaseAbort!: () => void
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve })
    let aborted = false
    let held = false
    const baseCli = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: RunFileOptions) => {
      if (command === 'github-datastore' && args[2] === 'health' && (args[1] as string).includes('/beta/') && !held) {
        held = true
        await new Promise<void>((resolve) => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
        aborted = true
        await abortGate
        throw new Error('aborted')
      }
      return (baseCli as (...call: unknown[]) => Promise<{ stdout: string, stderr: string }>)(command, args, options)
    })
    const health = () => datastoreCalls().filter(([, args]: any[]) => args[2] === 'health' && (args[1] as string).includes('/beta/')).length
    const before = health()
    expect((await request('/api/organizations/beta/retry', {})).status).toBe(202)
    await vi.waitFor(() => expect(health()).toBeGreaterThan(before))
    // Beta's removal passes its first check with two left, then waits.
    const beta = remove('beta', true)
    await vi.waitFor(() => expect(aborted).toBe(true))
    expect((await remove('acme', true)).status).toBe(200)
    expect(registered('beta')).toBe(true)
    // The recheck refuses: beta is now the last GitHub account.
    releaseAbort()
    const refused = await beta
    expect(refused.status).toBe(400)
    expect(refused.body.error).toContain('last GitHub account')
    expect(registered('beta')).toBe(true)
    expect(registered('acme')).toBe(false)
    expect((await request('/api/organizations')).body.organizations.map((org) => org.login)).toEqual(['beta'])
  })

  it('activates a re-added organization cleanly while the old job stays fenced', async () => {
    pendingIndex = new Promise<void>((resolve) => { releaseIndex = resolve })
    expect((await request('/api/organizations', { org: 'acme' })).status).toBe(202)
    await vi.waitFor(() => expect(datastoreCalls().some(([, args]: any[]) => args[2] === 'init-org')).toBe(true))
    expect((await remove('acme', true)).status).toBe(200)
    expect((await request('/api/organizations', { org: 'acme' })).status).toBe(202)
    releaseIndex!()
    pendingIndex = undefined
    await orgStatus('acme', 'ready')
    const rows = database!.db.prepare('SELECT login, status, error FROM organizations WHERE login = ? COLLATE NOCASE').all('acme')
    expect(rows).toEqual([{ login: 'acme', status: 'ready', error: null }])
    expect(database!.getMeta('organization_generation:acme')).toBe('1')
  })

  it('resolves its notices and drops its repositories from selections and scope', async () => {
    await addReady('acme')
    const { raiseAlert, openAlerts, silenceAlert, silencedKeys } = await import('../server/alerts/store')
    const alert = (kind: any, dedupeKey: string) => raiseAlert({ kind, dedupeKey, title: dedupeKey, body: dedupeKey, path: '/' })
    alert('datastore_sync_failing', 'datastore-sync:acme')
    alert('pr_ready', 'pr-ready:acme/repo#1')
    const silenced = alert('review_requested', 'review-requested:acme/repo#2')
    silenceAlert(silenced!.seq)
    alert('behavior_held', 'behavior-held:merge-prs:acme/repo#3:check')
    alert('datastore_sync_failing', 'datastore-sync:legacy')
    alert('pr_ready', 'pr-ready:legacy/repo#1')
    alert('storage_low', 'storage:low')
    expect((await request('/api/behaviors/review-new-issues', { repos: ['acme/same-repo', 'Legacy/same-repo'] })).status).toBe(200)
    const scoped = await fetch(`${base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ manager: { scope: ['acme/repo', 'Legacy/repo'] } }),
    })
    expect(scoped.status).toBe(200)

    expect((await remove('acme', true)).status).toBe(200)
    expect(openAlerts().map((entry) => entry.dedupeKey).sort()).toEqual(
      ['datastore-sync:legacy', 'pr-ready:legacy/repo#1', 'storage:low'])
    expect(silencedKeys('review-requested:')).toEqual([])

    const behaviors = await (await fetch(`${base}/api/behaviors`)).json() as Record<string, Record<string, unknown>>
    expect(behaviors['review-new-issues']!.repos).toEqual(['Legacy/same-repo'])
    const settings = await (await fetch(`${base}/api/settings`)).json() as Record<string, any>
    expect(settings.manager.scope).toEqual(['Legacy/repo'])
    expect(settings.manager.version).toBe(2)
  })

  it('keeps the datastore files and touches nothing on GitHub', async () => {
    await addReady('acme')
    const external = join(root, 'external.sqlite')
    await writeFile(external, 'externally managed')
    process.env.POISE_DATASTORE_DB = external
    const calls = datastoreCalls().length
    expect((await remove('acme', true)).status).toBe(200)
    expect(datastoreCalls()).toHaveLength(calls)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, 'datastores/acme/github.sqlite'))).toBe(true)
    expect(existsSync(external)).toBe(true)
  })

  it('refuses without the person, through fetch and through the native control api', async () => {
    await addReady('acme')
    const refused = await remove('acme', false)
    expect(refused.status).toBe(403)
    expect(registered('acme')).toBe(true)

    const config = join(root, 'control.json')
    await writeFile(config, JSON.stringify({ origin: base, sessionId: 's', token: 't' }))
    const script = join(process.cwd(), 'scripts', 'poise-chat-control.mjs')
    const stderr = await runScript(process.execPath,
      [script, config, JSON.stringify({ operation: 'api', path: '/api/organizations/acme', method: 'DELETE' })])
      .then(() => null, (error: any) => String(error?.stderr ?? error))
    expect(stderr).toMatch(/"status":\s*403/)
    expect(registered('acme')).toBe(true)
    expect((await request('/api/organizations')).body.organizations).toHaveLength(2)
  })

  it('stays removed across a restart of the organizations runtime', async () => {
    await addReady('acme')
    expect((await remove('acme', true)).status).toBe(200)
    const { startOrganizationsRuntime, stopOrganizationsRuntime } = await import('../server/organizations')
    await stopOrganizationsRuntime()
    const calls = datastoreCalls().length
    startOrganizationsRuntime()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(registered('acme')).toBe(false)
    expect((await request('/api/organizations')).body.organizations).toHaveLength(1)
    expect(datastoreCalls()).toHaveLength(calls)
    await stopOrganizationsRuntime()
  })
})
