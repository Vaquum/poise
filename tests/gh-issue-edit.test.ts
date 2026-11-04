import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), meta: {} as Record<string, string> }))
vi.mock('../server/db', () => ({ getMeta: (key: string) => mocks.meta[key] ?? null, setMeta: vi.fn(), db: { transaction: (fn: (...args: never[]) => unknown) => fn } }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, MAX_PROCESS_ARG_BYTES: 64 * 1024 }))
vi.mock('../server/organizations', () => ({
  getOrganizations: () => [{ login: 'acme', status: 'ready' }],
  readyOrganizations: () => [{ login: 'acme', status: 'ready' }], organizationArgs: vi.fn(),
}))
const { handleGhBody } = await import('../server/gh')
const ORIGINAL = { number: 42, title: 'Original title', body: 'Original body', state: 'open',
  html_url: 'https://github.com/acme/app/issues/42', created_at: '2026-09-18T09:00:00Z', updated_at: '2026-09-18T09:00:00Z' }
const READ = { operation: 'read_issue', repository_full_name: 'acme/app', issue_number: 42 }
const EDIT = { ...READ, operation: 'edit_issue', title: 'Edited title', body: 'Edited body',
  expected_title: ORIGINAL.title, expected_body: ORIGINAL.body }
let current = { ...ORIGINAL }
let loseAcknowledgement = false

beforeEach(() => {
  mocks.meta = { me: 'octocat' }
  current = { ...ORIGINAL }
  loseAcknowledgement = false
  mocks.runFile.mockReset()
  mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'auth') return { stdout: 'selected-token\n', stderr: '' }
    if (args.includes('PATCH')) {
      current = { ...current, title: args.find(arg => arg.startsWith('title='))!.slice(6),
        body: args.find(arg => arg.startsWith('body='))!.slice(5), updated_at: '2026-09-18T10:00:00Z' }
      if (loseAcknowledgement) throw new Error('Lost write acknowledgement')
    }
    return { stdout: JSON.stringify(current), stderr: '' }
  })
})

const writes = () => mocks.runFile.mock.calls.filter(call => call[1].includes('PATCH'))

describe('editing an existing issue', () => {
  it('loads fresh title/body through a GET pinned to the configured person', async () => {
    const result = await handleGhBody(READ)
    expect(result).toMatchObject({ status: 200, body: { issue: { number: 42, title: ORIGINAL.title, body: ORIGINAL.body } } })
    expect(mocks.runFile.mock.calls[0][1]).toEqual(['auth', 'token', '--hostname', 'github.com', '--user', 'octocat'])
    expect(mocks.runFile.mock.calls[1][1]).toEqual(['api', 'repos/acme/app/issues/42', '--method', 'GET'])
    expect(mocks.runFile.mock.calls[1][2].env).toMatchObject({ GH_HOST: 'github.com', GH_TOKEN: 'selected-token', GITHUB_TOKEN: undefined })
    expect(writes()).toHaveLength(0)
  })

  it('updates only title/body and returns the confirmed existing issue', async () => {
    const result = await handleGhBody(EDIT)
    expect(result).toMatchObject({ status: 200, body: { record: { kind: 'issue', repo: 'acme/app', number: 42,
      title: 'Edited title', updated_at: '2026-09-18T10:00:00Z' } } })
    expect(writes()).toHaveLength(1)
    expect(writes()[0][1]).toEqual(['api', 'repos/acme/app/issues/42', '--method', 'PATCH', '-f', 'title=Edited title', '-f', 'body=Edited body'])
    expect(writes()[0][2].env).toMatchObject({ GH_TOKEN: 'selected-token' })
  })

  it('refuses a stale title/body without writing', async () => {
    current.body = 'Another edit'
    expect(await handleGhBody(EDIT)).toMatchObject({ status: 409 })
    expect(writes()).toHaveLength(0)
  })

  it('confirms an accepted save after a lost acknowledgement without repeating the write', async () => {
    loseAcknowledgement = true
    expect(await handleGhBody(EDIT)).toMatchObject({ status: 502 })
    expect(current.body).toBe('Edited body')
    expect(await handleGhBody(EDIT)).toMatchObject({ status: 200, body: { record: { number: 42, title: 'Edited title' } } })
    expect(writes()).toHaveLength(1)
  })

  it('allows clearing a body and preserves the issue state', async () => {
    current.state = 'closed'
    expect(await handleGhBody({ ...EDIT, body: '' })).toMatchObject({ status: 200, body: { record: { state: 'closed' } } })
    expect(writes()[0][1]).toContain('body=')
    expect(writes()[0][1].some((arg: string) => arg.startsWith('state='))).toBe(false)
  })

  it('rejects invalid identity, target, snapshot and process-sized fields before authentication', async () => {
    for (const change of [{ repository_full_name: 'outside/app' }, { issue_number: 0 }, { issue_number: 1.5 },
      { title: ' ' }, { expected_body: undefined }, { body: 'x'.repeat(65_536) }]) {
      expect((await handleGhBody({ ...EDIT, ...change })).status).toBeGreaterThanOrEqual(400)
    }
    mocks.meta = {}
    expect((await handleGhBody(EDIT)).status).toBe(400)
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it.each([{ ...ORIGINAL, pull_request: {} }, { ...ORIGINAL, number: 43 },
    { ...ORIGINAL, html_url: 'https://github.com/outside/app/issues/42' }])('refuses a PR or mismatched read: %j', async payload => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === 'auth' ? 'selected-token' : JSON.stringify(payload) }))
    expect((await handleGhBody(EDIT)).status).toBeGreaterThanOrEqual(400)
    expect(writes()).toHaveLength(0)
  })

  it('redacts the pinned credential on a failed read', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'auth') return { stdout: 'selected-token' }
      throw new Error('failed selected-token')
    })
    const result = await handleGhBody(READ)
    expect(result.status).toBe(502)
    expect(JSON.stringify(result.body)).not.toContain('selected-token')
  })

  it('refuses a successful HTTP response that does not confirm the requested edit', async () => {
    mocks.runFile.mockImplementation(async (_command: string, args: string[]) => ({ stdout: args[0] === 'auth'
      ? 'selected-token' : JSON.stringify(args.includes('PATCH') ? { ...ORIGINAL, title: 'Something else' } : ORIGINAL) }))
    expect(await handleGhBody(EDIT)).toMatchObject({ status: 502 })
    expect(writes()).toHaveLength(1)
  })
})
