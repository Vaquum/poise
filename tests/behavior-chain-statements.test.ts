import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { BehaviorChainJournal } from '../server/behavior-chain-store'

// A chain list read, every sweep and system health read each chain, its
// reconciliation schedule and its history: one list page used to compile
// about two hundred statements. They compile once per connection now.
const NOW = 1_800_000_000_000
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

it('reads chains, their schedules and history without compiling statements again', () => {
  const db = new Database(':memory:'); databases.push(db)
  const journal = new BehaviorChainJournal(db)
  for (const issue of [1, 2, 3]) {
    journal.append(`acme/repo#${issue}`, `seed-${issue}`, 0,
      { type: 'chain.admitted', repository: 'acme/repo', issue, branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' }, NOW - 60_000)
  }
  const readAll = () => {
    const seen: string[] = []
    for (const chain of journal.page('', 100, null)) {
      seen.push(journal.read(chain.id)!.id)
      journal.reconciliationAt(chain)
      journal.history(chain.id, 0)
    }
    journal.page('', 100, false)
    journal.page('', 100, true)
    return seen
  }
  expect(readAll()).toEqual(['acme/repo#1', 'acme/repo#2', 'acme/repo#3'])
  const prepare = vi.spyOn(db, 'prepare')
  expect(readAll()).toEqual(['acme/repo#1', 'acme/repo#2', 'acme/repo#3'])
  const compiled = prepare.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, ' ').slice(0, 60))
  prepare.mockRestore()
  expect(compiled).toEqual([])
})
