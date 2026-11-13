import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { datastoreViewOrCli, readDatastoreContent, readDatastoreView, stopDatastoreReader } from '../server/datastore-reader'
import { datastoreContent, normalizeDatetime, parseViewArgs } from '../server/datastore-views'

const ME = 'octocat'
const AGENT = 'octo-agent'
const PYTHON_ENV = { ...process.env, PYTHONPATH: [resolve('caller/github_datastore'), process.env.PYTHONPATH].filter(Boolean).join(':') }

// The argument lists Poise's GitHub reads pass (server/gh.ts fetchKind and
// issue_intake, server/chat/issue-titles.ts), varied over every filter the
// reader mirrors.
const READS: string[][] = [
  ['view', 'pr', '--status', 'open', '--limit', '200', '--format', 'json'],
  ['view', 'issue', '--status', 'open', '--limit', '201', '--format', 'json'],
  ['view', 'pr', '--author', AGENT, '--status', 'open', '--limit', '200', '--format', 'json'],
  ['view', 'issue', '--author', AGENT, '--format', 'json'],
  ['view', 'user', '--username', ME, '--item-type', 'pr', '--status', 'open', '--limit', '200', '--format', 'json'],
  ['view', 'user', '--username', ME, '--item-type', 'issue', '--format', 'json'],
  ['view', 'user', '--username', ME, '--item-type', 'pr', '--updated-since-datetime', '2026-11-05T09:30:00.000+02:00', '--format', 'json'],
  ['view', 'pr', '--status', 'open', '--updated-since-datetime', '2026-11-04T00:00:00.000Z', '--limit', '3', '--format', 'json'],
  ['view', 'issue', '--status', 'open', '--label', 'poise-work', '--format', 'json'],
  ['view', 'pr', '--repo', 'acme/mixed-case', '--number', '2', '--format', 'json'],
  ['view', 'issue', '--repo', 'ACME/PLAIN', '--number', '4', '--format', 'json'],
  ['view', 'issue', '--status', 'open', '--after-repo', 'acme/Mixed-Case', '--after-number', '7', '--limit', '5', '--format', 'json'],
  ['view', 'pr', '--created-since-datetime', '2026-11-03T00:00:00Z', '--format', 'json'],
  ['view', 'issue', '--created-at-datetime', '2026-11-02T03:00:00Z', '--format', 'json'],
  ['view', 'pr', '--status', 'closed', '--format', 'json'],
  // Native chain discovery's two intake pages (server/behavior-chain-native.ts),
  // the second from an empty cursor and from a stored one; worker capacity's
  // backlog by repository (server/worker-capacity.ts); one issue for work
  // reads (server/mcp-work.ts).
  ['view', 'issue', '--status', 'open', '--format', 'json', '--limit', '100', '--label', 'poise-work'],
  ['view', 'issue', '--status', 'open', '--format', 'json', '--limit', '100', '--label', 'poise-work', '--after-repo', '', '--after-number', '0'],
  ['view', 'issue', '--status', 'open', '--format', 'json', '--limit', '100', '--after-repo', 'acme/plain', '--after-number', '3'],
  ['view', 'issue', '--status', 'open', '--label', 'poise-work', '--repo', 'acme/plain', '--limit', '50', '--format', 'json'],
  ['view', 'issue', '--repo', 'acme/plain', '--number', '4', '--limit', '1', '--format', 'json'],
]
const LABEL_READ = READS[8]

type Answer = { rows?: Record<string, unknown>[], error?: string }
type Row = Record<string, unknown>

/** Builds a datastore at `db` with Caller's own store and returns Caller's own answers. */
function caller(db: string, argvs: string[][], unlabelled = false): Answer[] {
  return JSON.parse(execFileSync('python3', ['tests/fixtures/datastore-views.py'], {
    input: JSON.stringify({ db, me: ME, agent: AGENT, argvs, unlabelled }), encoding: 'utf8', timeout: 60_000, env: PYTHON_ENV,
  }))
}

// Minutes since an update are computed at read time: two reads a moment apart
// may straddle a minute.
const AGES = ['updated_minutes_ago', 'opened_minutes_ago']
function expectSameRows(actual: Row[], expected: Row[]): void {
  const fixed = (rows: Row[]) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !AGES.includes(key))))
  expect(fixed(actual)).toEqual(fixed(expected))
  actual.forEach((row, index) => {
    for (const key of AGES) {
      if (key in expected[index]) expect(Math.abs(Number(row[key]) - Number(expected[index][key]))).toBeLessThanOrEqual(1)
    }
  })
}

let directory: string
let db: string
let answers: Answer[]

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'poise-datastore-views-'))
  db = join(directory, 'acme.sqlite')
  answers = caller(db, READS)
})

afterAll(async () => {
  await stopDatastoreReader()
  rmSync(directory, { recursive: true, force: true })
})

describe('datastore views read in-process', () => {
  it('answers every read Poise makes exactly as github-datastore view does', async () => {
    expect(answers.every((answer) => answer.rows)).toBe(true)
    // The fixture leaves no filter vacuous: most reads match rows.
    expect(answers.filter((answer) => answer.rows!.length > 0).length).toBeGreaterThanOrEqual(READS.length - 2)
    for (const [index, argv] of READS.entries()) {
      expect(parseViewArgs(argv)).not.toBeNull()
      expectSameRows(await readDatastoreView(db, argv)!, answers[index].rows!)
    }
  })

  it('answers a view in-process when it can, and from the CLI when it declines or fails', async () => {
    const cli = vi.fn(async () => JSON.stringify([{ from: 'cli' }]))
    const read = READS[READS.length - 1]
    expectSameRows(await datastoreViewOrCli(db, read, cli) as Row[], answers[READS.length - 1].rows!)
    expect(cli).not.toHaveBeenCalled()
    // A label passed as one --label=value argument is declined: the CLI answers.
    await expect(datastoreViewOrCli(db, ['view', 'issue', '--repo', 'acme/plain', '--label=poise-work', '--format', 'json'], cli)).resolves.toEqual([{ from: 'cli' }])
    // No datastore of its own, and a reader failure, are the CLI's too; a failure is reported once.
    await expect(datastoreViewOrCli(undefined, read, cli)).resolves.toEqual([{ from: 'cli' }])
    const broken = join(directory, 'not-a-datastore.sqlite')
    new Database(broken).close()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(datastoreViewOrCli(broken, read, cli)).resolves.toEqual([{ from: 'cli' }])
    await expect(datastoreViewOrCli(broken, read, cli)).resolves.toEqual([{ from: 'cli' }])
    expect(error.mock.calls.filter(([message]) => String(message).includes('in-process read failed'))).toHaveLength(1)
    error.mockRestore()
    expect(cli).toHaveBeenCalledTimes(4)
  })

  it('fails where Caller fails: incomplete label evidence', async () => {
    const unlabelled = join(directory, 'unlabelled.sqlite')
    const [answer] = caller(unlabelled, [LABEL_READ], true)
    expect(answer.error).toContain('issue label evidence is incomplete')
    await expect(readDatastoreView(unlabelled, LABEL_READ)!).rejects.toThrow('issue label evidence is incomplete')
  })

  it('reads a datastore that was replaced, not the file it replaced', async () => {
    const read = READS[0]
    expect((await readDatastoreView(db, read)!).some((row) => row.number === 2)).toBe(true)
    const rebuilt = join(directory, 'rebuilt.sqlite')
    caller(rebuilt, [])
    const writer = new Database(rebuilt)
    writer.prepare('DELETE FROM items WHERE number = 2').run()
    writer.pragma('journal_mode = DELETE')
    writer.close()
    rmSync(`${db}-wal`, { force: true })
    rmSync(`${db}-shm`, { force: true })
    renameSync(rebuilt, db)
    const rows = await readDatastoreView(db, read)!
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((row) => row.number === 2)).toBe(false)
  })

  it('keeps one content mark across bookkeeping commits, and moves it when an item or its evidence changes', async () => {
    const marked = join(directory, 'marked.sqlite')
    caller(marked, [])
    const writer = new Database(marked)
    try {
      const before = await readDatastoreContent(marked)!
      expect(before).toBe(datastoreContent(writer))
      writer.prepare("INSERT OR REPLACE INTO sync_state VALUES ('org', 'last_sync_at', ?, ?)").run('2026-11-13T08:00:00Z', '2026-11-13T08:00:00Z')
      expect(await readDatastoreContent(marked)!).toBe(before)
      writer.prepare("UPDATE items SET updated_at = '2026-11-13T08:00:01Z' WHERE item_id = (SELECT min(item_id) FROM items)").run()
      const updated = await readDatastoreContent(marked)!
      expect(updated).not.toBe(before)
      writer.prepare("INSERT INTO associations VALUES (?, (SELECT min(item_id) FROM items), 'commenter', 'comment', 'c-new', 'body', NULL, NULL)").run(ME)
      expect(await readDatastoreContent(marked)!).not.toBe(updated)
    } finally {
      writer.close()
    }
    // A file without the datastore's tables gives no mark: its views are read as before.
    const bare = join(directory, 'bare.sqlite')
    new Database(bare).exec('CREATE TABLE t (x)')
    expect(await readDatastoreContent(bare)!).toBeNull()
    expect(readDatastoreContent(join(directory, 'missing.sqlite'))).toBeNull()
  })

  it('leaves to the CLI what it does not mirror', () => {
    const declined = [
      ['view', 'pr', '--status', 'open', '--format', 'csv'],
      ['view', 'pr-reviews', '--repo', 'acme/plain', '--number', '2', '--format', 'json'],
      ['view', 'pr', '--label', 'poise-work'],
      ['view', 'issue', '--created-since-datetime', '2026-11-01T00:00:00Z', '--created-at-datetime', '2026-11-02T00:00:00Z'],
      ['view', 'issue', '--limit', '0'],
      ['view', 'issue', '--number', 'two'],
      ['view', 'issue', '--author', '-x'],
      ['view', 'issue', '--status', 'open', '--status', 'closed'],
      ['view', 'issue', '--updated-since-datetime', '2026-11-04T00:00:00'],
      ['view', 'issue', '--after-repo', 'acme/plain'],
      ['view', 'issue', '--label', ' '],
      ['view', 'user', '--item-type', 'discussion'],
      ['view', 'pr', '--status'],
    ]
    for (const argv of declined) expect(parseViewArgs(argv), argv.join(' ')).toBeNull()
    expect(readDatastoreView(db, declined[0])).toBeNull()
    expect(readDatastoreView(join(directory, 'missing.sqlite'), READS[0])).toBeNull()
  })

  it('normalizes a datetime as Caller does, and declines what it cannot match', () => {
    const values = ['2026-11-11T22:00:00.000Z', '2026-11-11T22:00:00Z', '2026-11-05T09:30:00.123456+02:00',
      '2026-01-01T00:30:00.999-05:30', '2024-02-29T23:59:59+00:00', '2026-02-29T00:00:00Z', '2026-11-11T22:00:00',
      '2026-11-11T24:00:00Z', '2026-11-11 22:00:00Z']
    const expected: Array<string | null> = JSON.parse(execFileSync('python3', ['-c', `
import json, sys
from github_datastore.views import _normalize_datetime
out = []
for value in json.load(sys.stdin):
    try: out.append(_normalize_datetime(value))
    except ValueError: out.append(None)
print(json.dumps(out))`], { input: JSON.stringify(values), encoding: 'utf8', env: PYTHON_ENV }))
    // Declining sends the read to the CLI; an answer must be Caller's.
    for (const [index, value] of values.entries()) {
      const ours = normalizeDatetime(value)
      if (ours !== null) expect(ours, value).toBe(expected[index])
    }
    expect(values.map(normalizeDatetime)).toEqual(['2026-11-11T22:00:00Z', '2026-11-11T22:00:00Z', '2026-11-05T07:30:00Z',
      '2026-01-01T06:00:00Z', '2024-02-29T23:59:59Z', null, null, null, null])
  })
})
