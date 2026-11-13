import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runFile: vi.fn(),
  read: vi.fn(),
  content: vi.fn(),
  closing: vi.fn(),
  org: { login: 'alpha', datastorePath: '/alpha.sqlite', status: 'ready', error: null as string | null },
}))
vi.mock('../server/db', () => ({ getMeta: () => null, setMeta: vi.fn(), db: { transaction: (fn: (...args: never[]) => unknown) => fn } }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, MAX_PROCESS_ARG_BYTES: 64 * 1024 }))
vi.mock('../server/organizations', () => ({
  getOrganizations: () => [mocks.org],
  readyOrganizations: () => [mocks.org],
  organizationArgs: (org: { datastorePath: string }, args: string[]) => ['--db', org.datastorePath, ...args],
}))
vi.mock('../server/datastore-reader', () => ({ readDatastoreView: mocks.read, readDatastoreContent: mocks.content }))
vi.mock('../server/chat/control', () => ({ readOpenPrClosingRefs: mocks.closing }))
const { handleGhBody, runCli } = await import('../server/gh')

const ARGS = ['view', 'pr', '--status', 'open', '--format', 'json']
const row = (repo: string, number: number) => ({ repo, number, status: 'open', title: `${repo} ${number}` })
const reader = [row('alpha/one', 1)]
const cli = [row('alpha/one', 1), row('alpha/two', 2)]

beforeEach(() => {
  mocks.runFile.mockReset()
  mocks.read.mockReset()
  mocks.content.mockReset()
  mocks.content.mockReturnValue(null)
  mocks.closing.mockReset()
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

  it('answers a view again from what it read while the datastore file is unchanged, and reads again once a sync changes it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'poise-view-reads-'))
    try {
      const path = join(directory, 'alpha.sqlite')
      writeFileSync(path, 'datastore')
      const org = { ...mocks.org, datastorePath: path }
      mocks.read.mockImplementation(() => Promise.resolve([row('alpha/one', 1)]))
      expect(await runCli(org as never, ARGS)).toEqual([row('alpha/one', 1)])
      expect(await runCli(org as never, ARGS)).toEqual([row('alpha/one', 1)])
      expect(mocks.read).toHaveBeenCalledTimes(1)
      // A sync commits to the write-ahead log: the view is read again.
      mocks.read.mockImplementation(() => Promise.resolve([row('alpha/one', 1), row('alpha/two', 2)]))
      writeFileSync(`${path}-wal`, 'frame')
      expect(await runCli(org as never, ARGS)).toHaveLength(2)
      expect(mocks.read).toHaveBeenCalledTimes(2)
      appendFileSync(`${path}-wal`, 'another frame')
      expect(await runCli(org as never, ARGS)).toHaveLength(2)
      expect(mocks.read).toHaveBeenCalledTimes(3)
      // A checkpoint rewrites the file itself.
      utimesSync(path, new Date(), new Date(Date.now() + 1_000))
      await runCli(org as never, ARGS)
      expect(mocks.read).toHaveBeenCalledTimes(4)
      // What is not a view always runs.
      mocks.runFile.mockResolvedValue({ stdout: JSON.stringify(cli), stderr: '' })
      mocks.read.mockReturnValue(null)
      await runCli(org as never, ['health', '--format', 'json'])
      await runCli(org as never, ['health', '--format', 'json'])
      expect(mocks.runFile).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('answers a view again across syncs that changed no item, until the content mark moves or five minutes pass', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'poise-view-content-'))
    try {
      const path = join(directory, 'alpha.sqlite')
      writeFileSync(path, 'datastore')
      const org = { ...mocks.org, datastorePath: path }
      let mark = 'mark-1'
      mocks.content.mockImplementation(() => Promise.resolve(mark))
      mocks.read.mockImplementation(() => Promise.resolve([row('alpha/one', 1)]))
      const other = [...ARGS, '--limit', '5']
      await runCli(org as never, ARGS)
      await runCli(org as never, other)
      expect(mocks.read).toHaveBeenCalledTimes(2)
      // Bookkeeping commits: the file changes, the content does not.
      writeFileSync(`${path}-wal`, 'frame')
      expect(await runCli(org as never, ARGS)).toEqual([row('alpha/one', 1)])
      await runCli(org as never, other)
      appendFileSync(`${path}-wal`, 'another frame')
      await runCli(org as never, ARGS)
      expect(mocks.read).toHaveBeenCalledTimes(2)
      // One mark per file version, whatever the number of views.
      expect(mocks.content).toHaveBeenCalledTimes(3)
      // An item changed: read again.
      mark = 'mark-2'
      mocks.read.mockImplementation(() => Promise.resolve([row('alpha/one', 1), row('alpha/two', 2)]))
      appendFileSync(`${path}-wal`, 'item frame')
      expect(await runCli(org as never, ARGS)).toHaveLength(2)
      expect(mocks.read).toHaveBeenCalledTimes(3)
      // An unchanged mark vouches for five minutes, then the view is read again.
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1)
      appendFileSync(`${path}-wal`, 'late frame')
      await runCli(org as never, ARGS)
      expect(mocks.read).toHaveBeenCalledTimes(4)
      clock.mockRestore()
      // No mark: every sync reads again, as before.
      mocks.content.mockReturnValue(null)
      appendFileSync(`${path}-wal`, 'unmarked frame')
      await runCli(org as never, ARGS)
      expect(mocks.read).toHaveBeenCalledTimes(5)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('lets a version the content mark vouched for stand only within five minutes, though nothing is written after it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'poise-view-vouched-'))
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const path = join(directory, 'alpha.sqlite')
      writeFileSync(path, 'datastore')
      const org = { ...mocks.org, datastorePath: path }
      mocks.content.mockImplementation(() => Promise.resolve('mark'))
      mocks.read.mockImplementation(() => Promise.resolve([row('alpha/one', 1)]))
      await runCli(org as never, ARGS)
      // A sync the mark vouches for, then nothing more is written.
      writeFileSync(`${path}-wal`, 'frame')
      now += 60_000
      await runCli(org as never, ARGS)
      now += 3 * 60_000
      await runCli(org as never, ARGS)
      expect(mocks.read).toHaveBeenCalledTimes(1)
      // Past the window the view is read again, at the version it is now read at.
      now += 60_001
      await runCli(org as never, ARGS)
      expect(mocks.read).toHaveBeenCalledTimes(2)
      now += 10 * 60_000
      await runCli(org as never, ARGS)
      expect(mocks.read).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps the pages Board\'s intake reads of closing pull requests across syncs that change no item', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'poise-closing-pages-'))
    const original = mocks.org.datastorePath
    try {
      const path = join(directory, 'alpha.sqlite')
      writeFileSync(path, 'datastore')
      mocks.org.datastorePath = path
      const page = { prs: [{ repo: 'alpha/one', number: 2, url: 'https://github.com/alpha/one/pull/2', closing: [{ repo: 'alpha/one', number: 1 }], closesVia: 'closing-references', closingTruncated: false, headRef: null, headRepo: null }], truncated: false, more: false }
      let mark = 'mark-1'
      mocks.content.mockImplementation(() => Promise.resolve(mark))
      mocks.read.mockImplementation(() => Promise.resolve([]))
      mocks.closing.mockResolvedValue(page)
      const intake = async () => (await handleGhBody({ operation: 'issue_intake' })).body as { prs: Record<string, unknown>, errors: unknown[] }
      expect((await intake()).prs).toEqual({ 'alpha/one#1': [{ number: 2, url: 'https://github.com/alpha/one/pull/2' }] })
      await intake()
      expect(mocks.closing).toHaveBeenCalledTimes(1)
      // A sync that changed no item.
      writeFileSync(`${path}-wal`, 'frame')
      expect((await intake()).errors).toEqual([])
      expect(mocks.closing).toHaveBeenCalledTimes(1)
      // An item changed.
      mark = 'mark-2'
      appendFileSync(`${path}-wal`, 'item frame')
      await intake()
      expect(mocks.closing).toHaveBeenCalledTimes(2)
      // An unavailable page is an organization error, never kept.
      mark = 'mark-3'
      appendFileSync(`${path}-wal`, 'another item frame')
      mocks.closing.mockResolvedValue(null)
      expect((await intake()).errors).toEqual([{ org: 'alpha', error: 'open pull request references are incomplete' }])
      mocks.closing.mockResolvedValue(page)
      expect((await intake()).errors).toEqual([])
      expect(mocks.closing).toHaveBeenCalledTimes(4)
    } finally {
      mocks.org.datastorePath = original
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
