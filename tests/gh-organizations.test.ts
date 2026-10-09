import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  meta: {} as Record<string, string>,
  orgs: [
    { login: 'alpha', datastorePath: '/alpha.sqlite', status: 'ready', error: null as string | null },
    { login: 'beta', datastorePath: '/beta.sqlite', status: 'ready', error: null as string | null },
  ],
}))
vi.mock('../server/db', () => ({ getMeta: (key: string) => mocks.meta[key] ?? null, setMeta: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, MAX_PROCESS_ARG_BYTES: 64 * 1024 }))
vi.mock('../server/organizations', () => ({
  getOrganizations: () => mocks.orgs,
  readyOrganizations: () => mocks.orgs.filter((org) => org.status === 'ready'),
  organizationArgs: (org: { datastorePath: string }, args: string[]) => ['--db', org.datastorePath, ...args],
}))
const { handleGhBody, invalidateRepoListCache, listOrganizationsRepos, listOrgRepos, readOwnPullRequests } = await import('../server/gh')

function record(org: string, number: number, day: number) {
  const date = `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`
  return { repo: `${org}/same`, number, status: 'open', author: 'octocat', title: `${org} ${number}`, url: `https://github.com/${org}/same/pull/${number}`, created_at: date, updated_at: date, closed_at: null, comments_count: 0 }
}

beforeEach(() => {
  mocks.meta = { me: 'octocat' }
  mocks.runFile.mockReset()
  mocks.orgs.forEach((org) => { org.status = 'ready'; org.error = null })
  invalidateRepoListCache()
  mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({
    stdout: JSON.stringify(args[1] === '/alpha.sqlite' ? [record('alpha', 1, 5), record('alpha', 2, 1)] : [record('beta', 1, 6), record('beta', 2, 3)]), stderr: '',
  }))
})

describe('organization data aggregation', () => {
  it('keeps same repository names and issue numbers distinct, and paginates the combined order', async () => {
    const result = await handleGhBody({ operation: 'list', record_type: 'pull_request', offset: 1, limit: 2 })
    expect((result.body as any).records.map((r: any) => `${r.repo}#${r.number}`)).toEqual(['alpha/same#1', 'beta/same#2'])
    expect(mocks.runFile.mock.calls.map((call) => call[1].slice(0, 2))).toEqual([['--db', '/alpha.sqlite'], ['--db', '/beta.sqlite']])
    for (const call of mocks.runFile.mock.calls) expect(call[1]).toEqual(expect.arrayContaining(['--limit', '3']))
  })

  it('only queries the selected organization and rejects unknown selections', async () => {
    const result = await handleGhBody({ operation: 'list', record_type: 'issue', org: 'BETA' })
    expect((result.body as any).records.every((r: any) => r.repo === 'beta/same')).toBe(true)
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    await expect(handleGhBody({ operation: 'list', org: 'outside' })).rejects.toThrow('not configured')
  })

  it('does not truncate counts or searches before applying their filters', async () => {
    const result = await handleGhBody({ operation: 'list', record_type: 'issue', count_only: true, q: 'beta' })
    expect(result.body).toEqual({ count: 2, errors: [] })
    for (const call of mocks.runFile.mock.calls) expect(call[1]).not.toContain('--limit')
  })

  it('retains healthy organizations and explicitly reports an unavailable one', async () => {
    mocks.runFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[1] === '/beta.sqlite') throw new Error('offline')
      return { stdout: JSON.stringify([record('alpha', 1, 5)]), stderr: '' }
    })
    const result = await handleGhBody({ operation: 'list', record_type: 'issue' })
    expect((result.body as any).records).toHaveLength(1)
    expect((result.body as any).errors).toEqual([{ org: 'beta', error: 'offline' }])
    await expect(handleGhBody({ operation: 'list', record_type: 'issue', org: 'beta' })).rejects.toThrow('offline')
  })

  it('reports a failed sync even when its cached records are still readable', async () => {
    mocks.orgs[1].error = 'Synchronization failed'
    const result = await handleGhBody({ operation: 'list', record_type: 'issue' })
    expect((result.body as any).records).toHaveLength(4)
    expect((result.body as any).errors).toEqual([{ org: 'beta', error: 'Synchronization failed' }])
  })

  it('rejects a database that contains another owner rather than exposing it', async () => {
    mocks.runFile.mockResolvedValue({ stdout: JSON.stringify([record('outside', 1, 5)]), stderr: '' })
    await expect(handleGhBody({ operation: 'list', record_type: 'issue' })).rejects.toThrow('outside alpha')
  })

  it('excludes initializing databases and rejects writes to unconfigured owners', async () => {
    mocks.orgs[1].status = 'initializing'
    await handleGhBody({ operation: 'list', record_type: 'issue' })
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
    mocks.runFile.mockClear()
    const result = await handleGhBody({ operation: 'open_issue', repository_full_name: 'beta/same', title: 'Must not post' })
    expect(result.status).toBe(400)
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
})

describe('the accounts GitHub is read as', () => {
  it('lists repositories as your own account and not without it', async () => {
    mocks.runFile.mockImplementation(async (_cmd: string, args: string[]) => ({ stdout: JSON.stringify({ repos: [{ full_name: `${args[1]}/same` }] }), stderr: '' }))
    await listOrgRepos()
    expect(mocks.runFile.mock.calls.map(([command, args]) => [command, ...args])).toEqual([
      ['github-interface', '--view-repos', 'alpha', '--token-user', 'octocat'],
      ['github-interface', '--view-repos', 'beta', '--token-user', 'octocat'],
    ])
    invalidateRepoListCache()
    mocks.runFile.mockClear()
    mocks.meta = {}
    await expect(listOrgRepos()).rejects.toThrow('Set your GitHub account in Settings → GitHub to list repositories')
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('checks which pull requests are green as the agent account', async () => {
    mocks.meta = { me: 'octocat', agentAccount: 'review-bot' }
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => command === 'github-interface'
      ? { stdout: JSON.stringify({ mergeable: args[1] === '#1' }), stderr: '' }
      : { stdout: JSON.stringify(args[1] === '/alpha.sqlite' ? [record('alpha', 1, 5)] : []), stderr: '' })
    const result = await handleGhBody({ operation: 'green_pr' })
    expect(result.body).toEqual({ records: [{ repo: 'alpha/same', number: 1, status: 'green' }], errors: [] })
    const checks = mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface')
    expect(checks.map(([, args]) => args)).toEqual([['--mergeable', '#1', '--token-user', 'review-bot']])
  })

  it('passes on each pull request\'s colour: yellow while a check or a conversation is not done', async () => {
    mocks.meta = { me: 'octocat', agentAccount: 'review-bot' }
    const colours: Record<string, unknown> = { '#2': { mergeable: true, status: 'yellow' }, '#3': { mergeable: false, status: null } }
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => command === 'github-interface'
      ? { stdout: JSON.stringify(colours[args[1]]), stderr: '' }
      : { stdout: JSON.stringify(args[1] === '/alpha.sqlite' ? [record('alpha', 2, 5), record('alpha', 3, 4)] : []), stderr: '' })
    const result = await handleGhBody({ operation: 'green_pr' })
    expect(result.body).toEqual({ records: [{ repo: 'alpha/same', number: 2, status: 'yellow' }], errors: [] })
  })

  it('reads your own open pull requests, and leaves one GitHub is still working out unknown', async () => {
    mocks.meta = { me: 'octocat', agentAccount: 'review-bot' }
    const answers: Record<string, unknown> = {
      '#7': { action: 'mergeable', mergeable: true, github_mergeable: true, github_mergeable_state: 'clean', state: 'open', status: 'green' },
      '#8': { action: 'mergeable', mergeable: false, github_mergeable: null, github_mergeable_state: 'unknown', state: 'open', status: null },
      '#9': { action: 'mergeable', mergeable: false, github_mergeable: true, github_mergeable_state: 'blocked', state: 'open', status: null },
    }
    const pull = (number: number, author: string) => ({ ...record('alpha', number, 5), author })
    mocks.runFile.mockImplementation(async (command: string, args: string[]) => command === 'github-interface'
      ? { stdout: JSON.stringify(answers[args[1]]), stderr: '' }
      : { stdout: JSON.stringify(args[1] === '/alpha.sqlite' ? [pull(7, 'octocat'), pull(8, 'review-bot'), pull(9, 'octocat'), pull(10, 'someone-else')] : []), stderr: '' })
    expect(await readOwnPullRequests()).toEqual({
      pullRequests: [
        { repo: 'alpha/same', number: 7, title: 'alpha 7', status: 'green' },
        { repo: 'alpha/same', number: 8, title: 'alpha 8', status: undefined },
        { repo: 'alpha/same', number: 9, title: 'alpha 9', status: null },
      ],
      read: ['alpha', 'beta'],
      tracked: ['alpha', 'beta'],
    })
    // Someone else's pull request is not asked about. The checks run side by side.
    const asked = mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface').map(([, args]) => args[1])
    expect(asked.sort()).toEqual(['#7', '#8', '#9'])
    // Current colours only what is known.
    expect((await handleGhBody({ operation: 'green_pr' })).body).toEqual({ records: [{ repo: 'alpha/same', number: 7, status: 'green' }], errors: [] })
  })

  it('reads no pull requests of yours until both GitHub accounts are set', async () => {
    mocks.meta = { me: 'octocat' }
    expect(await readOwnPullRequests()).toEqual({ pullRequests: [], read: [], tracked: [] })
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('says the agent account is missing instead of reporting nothing green', async () => {
    await expect(handleGhBody({ operation: 'green_pr' })).rejects.toThrow('No agent account is set')
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('opens an issue only as your own account, never as gh\'s active one', async () => {
    mocks.meta = {}
    const result = await handleGhBody({ operation: 'open_issue', repository_full_name: 'alpha/same', title: 'Mine' })
    expect(result).toEqual({ status: 400, body: { error: 'Set your GitHub account in Settings → GitHub before creating issues' } })
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
})

describe('organization repository discovery', () => {
  it('caches by organization and keeps full identities in combined pickers', async () => {
    mocks.runFile.mockImplementation(async (_cmd: string, args: string[]) => ({ stdout: JSON.stringify({ repos: [{ full_name: `${args[1]}/same` }] }), stderr: '' }))
    expect(await listOrgRepos()).toEqual(['alpha/same', 'beta/same'])
    expect(await listOrgRepos('beta')).toEqual(['beta/same'])
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
  })

  it('returns partial discovery with an error, but refuses incomplete validation', async () => {
    mocks.runFile.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[1] === 'beta') throw new Error('permission denied')
      return { stdout: JSON.stringify({ repos: [{ full_name: 'alpha/same' }] }), stderr: '' }
    })
    expect(await listOrganizationsRepos()).toEqual({ repos: ['alpha/same'], errors: [{ org: 'beta', error: 'permission denied' }] })
    await expect(listOrgRepos()).rejects.toThrow('permission denied')
  })

  it('does not repopulate cache with an old request after invalidation', async () => {
    let finish!: (value: { stdout: string, stderr: string }) => void
    mocks.runFile.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const pending = listOrgRepos('alpha')
    invalidateRepoListCache()
    finish({ stdout: JSON.stringify({ repos: [{ full_name: 'alpha/old' }] }), stderr: '' })
    await pending
    mocks.runFile.mockResolvedValueOnce({ stdout: JSON.stringify({ repos: [{ full_name: 'alpha/new' }] }), stderr: '' })
    expect(await listOrgRepos('alpha')).toEqual(['alpha/new'])
  })
})
