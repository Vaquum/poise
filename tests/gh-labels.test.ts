import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  closing: vi.fn(),
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
vi.mock('../server/chat/control', () => ({ readOpenPrClosingRefs: mocks.closing }))
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

describe('assign_issue', () => {
  const issue = { number: 7, title: 'Pick me', body: null, state: 'open', html_url: 'https://github.com/alpha/same/issues/7',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }
  const github = (read: Record<string, unknown>, added: unknown) => mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'auth') return { stdout: 'selected-token\n', stderr: '' }
    return { stdout: JSON.stringify(args.includes('POST') ? added : read), stderr: '' }
  })
  const assign = (extra: Record<string, unknown> = {}) => handleGhBody({ operation: 'assign_issue', repository_full_name: 'alpha/same', issue_number: 7, ...extra })
  const writes = () => mocks.runFile.mock.calls.filter((call) => call[1].includes('POST'))

  it('adds the configured intake label as the configured user, whatever the browser asks for', async () => {
    mocks.meta.behavior_chain_settings = JSON.stringify({ enabled: false, seedMode: 'label', label: 'intake' })
    github(issue, [{ name: 'bug' }, { name: 'Intake' }])
    const result = await assign({ label: 'forged' })
    expect(result).toEqual({ status: 200, body: { label: 'intake' } })
    expect(writes()).toHaveLength(1)
    expect(writes()[0][1]).toEqual(['api', 'repos/alpha/same/issues/7/labels', '--method', 'POST', '-f', 'labels[]=intake'])
    expect(writes()[0][2].env).toMatchObject({ GH_HOST: 'github.com', GH_TOKEN: 'selected-token' })
  })

  it('fails when GitHub does not confirm the label, and never leaks the token', async () => {
    github(issue, [{ name: 'bug' }])
    const missing = await assign()
    expect(missing.status).toBe(502)
    expect(JSON.stringify(missing.body)).toContain('did not confirm the poise label')
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'selected-token\n', stderr: '' }
      if (args.includes('POST')) throw new Error('denied for selected-token')
      return { stdout: JSON.stringify(issue), stderr: '' }
    })
    const denied = await assign()
    expect(denied.status).toBe(502)
    expect(JSON.stringify(denied.body)).not.toContain('selected-token')
  })

  it('writes nothing for a pull request, a closed issue or an intake without a label', async () => {
    github({ ...issue, pull_request: {} }, [{ name: 'poise' }])
    expect((await assign()).status).toBe(400)
    github({ ...issue, state: 'closed' }, [{ name: 'poise' }])
    expect((await assign()).status).toBe(409)
    mocks.meta.behavior_chain_settings = JSON.stringify({ enabled: true, seedMode: 'all', label: 'poise' })
    github(issue, [{ name: 'poise' }])
    expect((await assign()).status).toBe(409)
    expect(writes()).toHaveLength(0)
  })

  it('rejects an unconfigured repository, a bad number and a missing account without calling gh', async () => {
    expect((await assign({ repository_full_name: 'outside/same' })).status).toBe(400)
    expect((await assign({ issue_number: 0 })).status).toBe(400)
    mocks.meta = {}
    expect((await assign()).status).toBe(400)
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
})

describe('issue_intake', () => {
  const closingPage = (prs: Array<{ number: number, closing: Array<{ repo: string, number: number }>, closingTruncated?: boolean }>, more = false) => ({
    prs: prs.map((pr) => ({ repo: 'alpha/same', url: `https://github.com/alpha/same/pull/${pr.number}`, closingTruncated: false, ...pr })), truncated: more, more,
  })
  const datastore = (rows: Record<string, unknown[]>) => mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
    return { stdout: JSON.stringify(rows[args[1]] ?? []), stderr: '' }
  })

  beforeEach(() => {
    mocks.closing.mockReset()
    mocks.closing.mockResolvedValue(closingPage([]))
  })

  it('reads the chain\'s label filter locally and maps closing pull requests across pages', async () => {
    datastore({ '/alpha.sqlite': [{ repo: 'alpha/Same', number: 7 }], '/beta.sqlite': [{ repo: 'beta/other', number: 8 }] })
    mocks.closing.mockImplementation(async (org: { login: string }, after?: { number: number }) => {
      if (org.login !== 'alpha') return closingPage([])
      return after ? closingPage([{ number: 2, closing: [{ repo: 'alpha/Same', number: 7 }] }])
        : closingPage([{ number: 1, closing: [{ repo: 'alpha/same', number: 7 }, { repo: 'alpha/same', number: 9 }] }], true)
    })
    const result = await handleGhBody({ operation: 'issue_intake' })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      label: 'poise',
      labelled: expect.arrayContaining(['alpha/same#7', 'beta/other#8']),
      prs: {
        'alpha/same#7': [{ number: 1, url: 'https://github.com/alpha/same/pull/1' }, { number: 2, url: 'https://github.com/alpha/same/pull/2' }],
        'alpha/same#9': [{ number: 1, url: 'https://github.com/alpha/same/pull/1' }],
      },
      errors: [],
    })
    expect(mocks.closing).toHaveBeenCalledWith(expect.objectContaining({ login: 'alpha' }), { repo: 'alpha/same', number: 1 })
    expect(mocks.runFile.mock.calls.map((call) => [call[0], call[1]])).toEqual(expect.arrayContaining([
      ['github-datastore', ['--db', '/alpha.sqlite', 'view', 'issue', '--status', 'open', '--label', 'poise', '--format', 'json']],
    ]))
    expect(mocks.runFile.mock.calls.every((call) => call[0] === 'github-datastore')).toBe(true)
  })

  it('reports an organization whose references or labels are incomplete, and keeps the others', async () => {
    for (const failed of [null, { ...closingPage([]), truncated: true }, closingPage([{ number: 1, closing: [], closingTruncated: true }]), closingPage([], true)]) {
      datastore({ '/alpha.sqlite': [{ repo: 'alpha/same', number: 7 }], '/beta.sqlite': [{ repo: 'beta/other', number: 8 }] })
      mocks.closing.mockImplementation(async (org: { login: string }) => org.login === 'alpha' ? failed : closingPage([]))
      const body = (await handleGhBody({ operation: 'issue_intake' })).body as { labelled: string[], errors: Array<{ org: string }> }
      expect(body.errors.map((entry) => entry.org)).toEqual(['alpha'])
      expect(body.labelled).toEqual(['beta/other#8'])
    }
    mocks.closing.mockResolvedValue(closingPage([]))
    mocks.runFile.mockRejectedValue(new Error('issue label evidence is incomplete'))
    const body = (await handleGhBody({ operation: 'issue_intake', org: 'beta' })).body as { errors: unknown[] }
    expect(body.errors).toEqual([{ org: 'beta', error: 'issue label evidence is incomplete' }])
  })

  it('has no label to report when the chain takes every open issue', async () => {
    mocks.meta.behavior_chain_settings = JSON.stringify({ enabled: true, seedMode: 'all', label: 'poise' })
    mocks.closing.mockResolvedValue(closingPage([{ number: 3, closing: [{ repo: 'alpha/same', number: 7 }] }]))
    const body = (await handleGhBody({ operation: 'issue_intake', org: 'alpha' })).body as { label: unknown, labelled: unknown, prs: Record<string, unknown> }
    expect(body.label).toBeNull()
    expect(body.labelled).toEqual([])
    expect(Object.keys(body.prs)).toEqual(['alpha/same#7'])
    expect(mocks.runFile).not.toHaveBeenCalled()
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
