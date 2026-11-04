import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  meta: {} as Record<string, string>,
  orgs: [
    { login: 'alpha', datastorePath: '/alpha.sqlite', status: 'ready', error: null as string | null },
    { login: 'beta', datastorePath: '/beta.sqlite', status: 'ready', error: null as string | null },
  ],
}))
vi.mock('../server/db', () => ({ getMeta: (key: string) => mocks.meta[key] ?? null, setMeta: vi.fn(), db: { transaction: (fn: (...args: never[]) => unknown) => fn } }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, MAX_PROCESS_ARG_BYTES: 64 * 1024 }))
vi.mock('../server/organizations', () => ({
  getOrganizations: () => mocks.orgs,
  readyOrganizations: () => mocks.orgs.filter((org) => org.status === 'ready'),
  organizationArgs: (org: { datastorePath: string }, args: string[]) => ['--db', org.datastorePath, ...args],
}))
const { handleGhBody } = await import('../server/gh')

beforeEach(() => {
  mocks.meta = { me: 'octocat' }
  mocks.runFile.mockReset()
  mocks.orgs.forEach((org) => { org.status = 'ready'; org.error = null })
  mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'auth') return { stdout: 'selected-token\n', stderr: '' }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  })
})

describe('list_repo_labels', () => {
  it('reads the repository catalogue as the configured user', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'selected-token\n', stderr: '' }
      return { stdout: JSON.stringify([
        { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
        { name: 'wip', color: 'cccccc', description: null },
      ]), stderr: '' }
    })
    const result = await handleGhBody({ operation: 'list_repo_labels', repository_full_name: 'alpha/same' })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ labels: [
      { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
      { name: 'wip', color: 'cccccc', description: null },
    ] })
    expect(mocks.runFile.mock.calls[0][1]).toEqual(['auth', 'token', '--hostname', 'github.com', '--user', 'octocat'])
    expect(mocks.runFile.mock.calls[1][1]).toEqual(['api', 'repos/alpha/same/labels', '--method', 'GET', '-f', 'per_page=100', '-f', 'page=1'])
    // The pinned credential authenticates the read.
    expect(mocks.runFile.mock.calls[1][2].env).toMatchObject({ GH_HOST: 'github.com', GH_TOKEN: 'selected-token' })
  })

  it('pages past a full page and stops at a short one', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}`, color: 'ffffff', description: '' }))
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 't\n', stderr: '' }
      return { stdout: JSON.stringify(args.includes('page=1') ? full : [{ name: 'last', color: '000000', description: null }]), stderr: '' }
    })
    const result = await handleGhBody({ operation: 'list_repo_labels', repository_full_name: 'alpha/same' })
    expect(result.status).toBe(200)
    expect((result.body as any).labels).toHaveLength(101)
    expect(mocks.runFile.mock.calls.filter((call) => call[1][0] === 'api')).toHaveLength(2)
  })

  it('rejects unconfigured repositories and a missing account without calling gh', async () => {
    expect((await handleGhBody({ operation: 'list_repo_labels', repository_full_name: 'outside/same' })).status).toBe(400)
    mocks.orgs[0].status = 'initializing'
    expect((await handleGhBody({ operation: 'list_repo_labels', repository_full_name: 'alpha/same' })).status).toBe(400)
    mocks.orgs[0].status = 'ready'
    mocks.meta = {}
    expect((await handleGhBody({ operation: 'list_repo_labels', repository_full_name: 'alpha/same' })).status).toBe(400)
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('fails loud on an unexpected shape and never leaks the token', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'selected-token\n', stderr: '' }
      return { stdout: JSON.stringify({ labels: [] }), stderr: '' }
    })
    const shaped = await handleGhBody({ operation: 'list_repo_labels', repository_full_name: 'alpha/same' })
    expect(shaped.status).toBe(502)
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'selected-token\n', stderr: '' }
      throw new Error('denied for selected-token')
    })
    const failed = await handleGhBody({ operation: 'list_repo_labels', repository_full_name: 'alpha/same' })
    expect(failed.status).toBe(502)
    expect(JSON.stringify(failed.body)).not.toContain('selected-token')
  })
})

describe('open_issue with labels', () => {
  function created(labels: Array<{ name: string }>) {
    return { number: 42, state: 'open', title: 'Labeled', html_url: 'https://github.com/alpha/same/issues/42',
      user: { login: 'octocat' }, labels }
  }

  it('sends the selection and names what GitHub silently dropped', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 't\n', stderr: '' }
      return { stdout: JSON.stringify(created([{ name: 'bug' }])), stderr: '' }
    })
    const result = await handleGhBody({ operation: 'open_issue', repository_full_name: 'alpha/same', title: 'Labeled', labels: ['bug', 'no-triage'] })
    expect(result.status).toBe(200)
    const api = mocks.runFile.mock.calls.find((call) => call[1][0] === 'api')![1] as string[]
    expect(api).toEqual(expect.arrayContaining(['-f', 'labels[]=bug']))
    expect(api.filter((arg) => arg === '-f')).toHaveLength(3) // title + two labels
    expect(api).toContain('labels[]=no-triage')
    expect((result.body as any).record.labels).toEqual(['bug'])
    expect((result.body as any).labels_dropped).toEqual(['no-triage'])
  })

  it('reports no drops when GitHub applied everything, and none were asked', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 't\n', stderr: '' }
      return { stdout: JSON.stringify(created([{ name: 'bug' }])), stderr: '' }
    })
    const labeled = await handleGhBody({ operation: 'open_issue', repository_full_name: 'alpha/same', title: 'Labeled', labels: ['bug'] })
    expect((labeled.body as any).labels_dropped).toEqual([])
    const plain = await handleGhBody({ operation: 'open_issue', repository_full_name: 'alpha/same', title: 'Plain' })
    expect((plain.body as any).labels_dropped).toEqual([])
    expect((plain.body as any).record.labels).toEqual(['bug'])
  })

  it('rejects malformed label selections without calling gh', async () => {
    for (const labels of [['ok', 7], 'bug', ['', 'bug'], ['x'.repeat(201)], Array.from({ length: 101 }, () => 'bug')]) {
      const result = await handleGhBody({ operation: 'open_issue', repository_full_name: 'alpha/same', title: 'Labeled', labels })
      expect(result.status, JSON.stringify(labels).slice(0, 40)).toBe(400)
    }
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
})
