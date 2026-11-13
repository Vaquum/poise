import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  read: vi.fn(),
  org: { login: 'alpha', datastorePath: '/alpha.sqlite', status: 'ready', error: null as string | null },
}))
vi.mock('../server/db', () => ({ getMeta: () => null, setMeta: vi.fn(), db: { transaction: (fn: (...args: never[]) => unknown) => fn } }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, MAX_PROCESS_ARG_BYTES: 64 * 1024 }))
vi.mock('../server/organizations', () => ({
  getOrganizations: () => [mocks.org],
  readyOrganizations: () => [mocks.org],
  organizationArgs: (org: { datastorePath: string }, args: string[]) => ['--db', org.datastorePath, ...args],
}))
vi.mock('../server/datastore-reader', () => ({ readDatastoreView: mocks.read }))
const { runCli } = await import('../server/gh')

const ARGS = ['view', 'pr', '--status', 'open', '--format', 'json']
const row = (repo: string, number: number) => ({ repo, number, status: 'open', title: `${repo} ${number}` })
const reader = [row('alpha/one', 1)]
const cli = [row('alpha/one', 1), row('alpha/two', 2)]

beforeEach(() => {
  mocks.runFile.mockReset()
  mocks.read.mockReset()
  mocks.runFile.mockResolvedValue({ stdout: JSON.stringify(cli), stderr: '' })
})
afterEach(() => { vi.restoreAllMocks() })

describe('runCli with the in-process datastore reader', () => {
  it('answers from the reader without starting the CLI', async () => {
    mocks.read.mockReturnValue(Promise.resolve(reader))
    await expect(runCli(mocks.org as never, ARGS)).resolves.toEqual(reader)
    expect(mocks.read).toHaveBeenCalledWith('/alpha.sqlite', ARGS)
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('asks the CLI when the reader fails, and reports that failure once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.read.mockImplementation(() => Promise.reject(new Error('no such table: prs')))
    await expect(runCli(mocks.org as never, ARGS)).resolves.toEqual(cli)
    expect(mocks.runFile).toHaveBeenCalledWith('github-datastore', ['--db', '/alpha.sqlite', ...ARGS], expect.anything())
    await expect(runCli(mocks.org as never, ARGS)).resolves.toEqual(cli)
    expect(mocks.runFile).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toContain('[datastore-reader] alpha')
  })

  it('asks the CLI for arguments the reader declines', async () => {
    mocks.read.mockReturnValue(null)
    await expect(runCli(mocks.org as never, ARGS)).resolves.toEqual(cli)
    expect(mocks.runFile).toHaveBeenCalledTimes(1)
  })

  it('still refuses rows outside the organization', async () => {
    mocks.read.mockReturnValue(Promise.resolve([row('beta/one', 1)]))
    await expect(runCli(mocks.org as never, ARGS)).rejects.toThrow('datastore contains records outside alpha')
  })

  it('joins an identical read in flight, and reads afresh once it settles', async () => {
    let release!: (rows: unknown[]) => void
    mocks.read.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const first = runCli(mocks.org as never, ARGS)
    const joined = runCli(mocks.org as never, ARGS)
    const other = runCli(mocks.org as never, [...ARGS, '--limit', '5'])
    release(reader)
    expect(await joined).toEqual(await first)
    expect(await joined).not.toBe(await first)
    await other
    expect(mocks.read).toHaveBeenCalledTimes(2)
    mocks.read.mockReturnValue(Promise.resolve(reader))
    await runCli(mocks.org as never, ARGS)
    expect(mocks.read).toHaveBeenCalledTimes(3)
  })
})
