import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), repos: vi.fn(), me: 'octocat', orgs: [{ login: 'acme' }, { login: 'beta' }] }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile }))
vi.mock('../server/db', () => ({ getMeta: () => mocks.me }))
vi.mock('../server/gh', () => ({
  listOrganizationsRepos: mocks.repos,
  selectOrganizations: (org?: string) => {
    if (org && !mocks.orgs.some((entry) => entry.login === org)) throw new Error('not configured')
    return mocks.orgs.filter((entry) => !org || entry.login === org)
  },
}))
import { invalidateActionRunCache, listActionRuns } from '../server/action-runs'

function response(runs: unknown[] = [run()], total = runs.length): string {
  return 'HTTP/2.0 200 OK\r\nETag: "snapshot"\r\n\r\n' + JSON.stringify({ workflow_runs: runs, total_count: total })
}

function run(id = 1, conclusion: string | null = 'failure') {
  return { id, name: 'Deploy', display_title: 'Deploy after merge', html_url: `https://github.com/acme/site/actions/runs/${id}`,
    actor: { login: 'octocat' }, status: conclusion ? 'completed' : 'in_progress', conclusion,
    updated_at: '2026-10-14T08:00:00Z', head_branch: 'main', event: 'push', pull_requests: [] }
}

beforeEach(() => {
  vi.useRealTimers()
  invalidateActionRunCache()
  mocks.me = 'octocat'
  mocks.runFile.mockReset()
  mocks.repos.mockReset().mockImplementation(async (org: string) => ({ repos: [`${org}/site`], errors: [] }))
  mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === 'auth' ? 'selected-secret' : response() }))
})

describe('Archive workflow snapshots', () => {
  it('reads post-merge push failures once per repository and shares count, paging and local filters', async () => {
    const [page, count] = await Promise.all([
      listActionRuns({}), listActionRuns({ count_only: true }),
    ])
    expect(page.body).toMatchObject({ records: [
      { kind: 'action', repo: 'acme/site', branch: 'main', event: 'push', state: 'failure' },
      { kind: 'action', repo: 'beta/site', branch: 'main', event: 'push', state: 'failure' },
    ] })
    expect(count.body).toMatchObject({ count: 2 })
    await listActionRuns({ org: 'beta', q: 'deploy', updated_since: '2026-10-01', offset: 1, limit: 20 })
    const api = mocks.runFile.mock.calls.filter(([, args]) => args[0] === 'api')
    expect(api.map(([, args]) => args)).toEqual([
      ['api', 'repos/acme/site/actions/runs?per_page=100&status=failure', '--method', 'GET', '--include'],
      ['api', 'repos/beta/site/actions/runs?per_page=100&status=failure', '--method', 'GET', '--include'],
    ])
    expect(mocks.repos).toHaveBeenCalledTimes(2)
    expect(mocks.runFile.mock.calls[0][1]).toEqual(['auth', 'token', '--hostname', 'github.com', '--user', 'octocat'])
    expect(api[0][2].env).toMatchObject({ GH_HOST: 'github.com', GH_TOKEN: 'selected-secret', GITHUB_TOKEN: undefined })
  })

  it('expires after five minutes and keeps outcomes and identities isolated', async () => {
    vi.useFakeTimers()
    await listActionRuns({ org: 'acme' })
    await listActionRuns({ org: 'acme' })
    expect(mocks.repos).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5 * 60_000)
    await listActionRuns({ org: 'acme' })
    await listActionRuns({ org: 'acme', record_state: 'all' })
    mocks.me = 'another-person'
    await listActionRuns({ org: 'acme' })
    expect(mocks.repos).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })

  it('includes active runs in Any and filters branch and dates without new reads', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === 'auth' ? 'selected-secret' : response([run(2, null)]) }))
    const result = await listActionRuns({ org: 'acme', record_state: 'all', q: 'main' })
    expect(result.body).toMatchObject({ records: [{ state: 'in_progress' }] })
    expect((await listActionRuns({ org: 'acme', record_state: 'all', updated_until: '2026-10-13' })).body).toMatchObject({ records: [] })
    expect(mocks.repos).toHaveBeenCalledTimes(1)
  })

  it('makes truncated history explicit', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === 'auth' ? 'selected-secret' : response([run()], 130) }))
    expect((await listActionRuns({ org: 'acme' })).body).toMatchObject({ warnings: ['acme/site: showing the latest 1 of 130 failed runs. Open GitHub for older runs.'] })
  })

  it('reports partial failures, caches failed reads and never exposes a token in diagnostics', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'selected-secret' }
      if (args[1].includes('beta/')) throw new Error('denied selected-secret')
      return { stdout: response() }
    })
    const result = await listActionRuns({})
    expect(result.body).toMatchObject({ records: [{ repo: 'acme/site' }], errors: [{ org: 'beta', error: 'beta/site: denied ***' }] })
    const calls = mocks.runFile.mock.calls.length
    await expect(listActionRuns({ org: 'beta' })).rejects.toThrow('denied ***')
    expect(mocks.runFile).toHaveBeenCalledTimes(calls)
  })

  it('fails loudly on missing identity, malformed inventory and unconfigured scope', async () => {
    mocks.me = ''
    await expect(listActionRuns({})).rejects.toThrow('Set your GitHub account')
    expect(mocks.runFile).not.toHaveBeenCalled()
    mocks.me = 'octocat'
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === 'auth' ? 'selected-secret' : 'HTTP/2.0 200 OK\n\n{}' }))
    await expect(listActionRuns({ org: 'acme' })).rejects.toThrow('malformed workflow inventory')
    await expect(listActionRuns({ org: 'outside' })).rejects.toThrow('not configured')
  })

  it('retains a healthy empty repository when another repository is unavailable', async () => {
    mocks.repos.mockResolvedValue({ repos: ['acme/healthy', 'acme/offline'], errors: [] })
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'selected-secret' }
      if (args[1].includes('/offline/')) throw new Error('repository unavailable')
      return { stdout: response([]) }
    })
    expect((await listActionRuns({ org: 'acme' })).body).toMatchObject({
      records: [], errors: [{ org: 'acme', error: 'acme/offline: repository unavailable' }],
    })
    expect((await listActionRuns({ org: 'acme', count_only: true })).body).toMatchObject({ count: 0 })
  })
})


it('uses ETags after expiry and recovers unavailable repositories without rereading healthy ones', async () => {
  vi.useFakeTimers()
  try {
    mocks.repos.mockResolvedValue({ repos: ['acme/healthy', 'acme/offline'], errors: [] })
    let unavailable = true
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'selected-secret' }
      if (args[1].includes('/offline/') && unavailable) throw new Error('temporarily unavailable')
      if (args.includes('--header')) throw Object.assign(new Error('gh: HTTP 304'), { code: 1, stdout: 'HTTP/2.0 304 Not Modified\r\n\r\n' })
      return { stdout: response() }
    })
    expect((await listActionRuns({ org: 'acme' })).body).toMatchObject({ records: [{ repo: 'acme/healthy' }] })
    unavailable = false
    vi.advanceTimersByTime(60_000)
    expect((await listActionRuns({ org: 'acme' })).body).toMatchObject({ records: [{ repo: 'acme/healthy' }, { repo: 'acme/offline' }], errors: [] })
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === 'api')).toHaveLength(3)
    vi.advanceTimersByTime(5 * 60_000)
    await listActionRuns({ org: 'acme' })
    const conditional = mocks.runFile.mock.calls.filter(([, args]) => args.includes('--header'))
    expect(conditional).toHaveLength(2)
    expect(conditional[0][1]).toContain('If-None-Match: "snapshot"')
  } finally { vi.useRealTimers() }
})

it('recovers total transient failure after one minute and retains valid runs alongside malformed or changed entries', async () => {
  vi.useFakeTimers()
  try {
    mocks.runFile.mockRejectedValue(new Error('network offline'))
    await expect(listActionRuns({ org: 'acme' })).rejects.toThrow('network offline')
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === 'auth' ? 'selected-secret' : response([run(), { id: 2 }, run(3, 'success')]) }))
    vi.advanceTimersByTime(60_000)
    expect((await listActionRuns({ org: 'acme' })).body).toMatchObject({ records: [{ number: 1 }], errors: [{ org: 'acme', error: 'acme/site: malformed workflow run 2' }] })
  } finally { vi.useRealTimers() }
})


it('rejects a 304 without prior data and propagates conditional HTTP and process failures', async () => {
  vi.useFakeTimers()
  try {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === 'auth' ? 'selected-secret' : 'HTTP/2.0 304 Not Modified\r\n\r\n' }))
    await expect(listActionRuns({ org: 'acme' })).rejects.toThrow('304 without a cached')
    invalidateActionRunCache()
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === 'auth' ? 'selected-secret' : response() }))
    await listActionRuns({ org: 'acme' })
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'selected-secret' }
      throw Object.assign(new Error('HTTP 403'), { code: 1, stdout: 'HTTP/2.0 403 Forbidden\r\n\r\n' })
    })
    vi.advanceTimersByTime(5 * 60_000)
    await expect(listActionRuns({ org: 'acme' })).rejects.toThrow('HTTP 403')
  } finally { vi.useRealTimers() }
})

it('does not extend healthy repository freshness when another repository recovers later', async () => {
  vi.useFakeTimers()
  try {
    mocks.repos.mockResolvedValue({ repos: ['acme/healthy', 'acme/offline'], errors: [] })
    let unavailable = true
    let healthyRun = 1
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'selected-secret' }
      if (args[1].includes('/offline/') && unavailable) throw new Error('temporarily unavailable')
      return { stdout: response([run(args[1].includes('/healthy/') ? healthyRun : 1)]) }
    })
    await listActionRuns({ org: 'acme' })
    vi.advanceTimersByTime(4 * 60_000)
    unavailable = false
    await listActionRuns({ org: 'acme' })
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === 'api')).toHaveLength(3)
    healthyRun = 2
    vi.advanceTimersByTime(60_000)
    expect((await listActionRuns({ org: 'acme' })).body).toMatchObject({ records: [{ repo: 'acme/healthy', number: 2 }, { repo: 'acme/offline', number: 1 }] })
    expect(mocks.runFile.mock.calls.filter(([, args]) => args[0] === 'api')).toHaveLength(4)
  } finally { vi.useRealTimers() }
})
