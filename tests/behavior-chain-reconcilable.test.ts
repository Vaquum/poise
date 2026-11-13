import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { BehaviorChainJournal } from '../server/behavior-chain-store'

const NOW = 1_800_000_000_000
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

it('pages reconcilable chains through the reconciliation index, in chain order', () => {
  const db = new Database(':memory:'); databases.push(db)
  const journal = new BehaviorChainJournal(db)
  for (const issue of [3, 1, 2]) {
    journal.append(`acme/repo#${issue}`, `seed-${issue}`, 0,
      { type: 'chain.admitted', repository: 'acme/repo', issue, branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' }, NOW - 60_000)
  }
  const prepare = db.prepare.bind(db)
  let sql = ''
  ;(db as unknown as { prepare: (text: string) => unknown }).prepare = (text: string) => {
    if (text.includes('FROM behavior_chain_current') && text.includes('chain_id > ?')) sql = text
    return prepare(text)
  }
  expect(journal.reconcilable('', NOW, false).map((chain) => chain.id)).toEqual(['acme/repo#1', 'acme/repo#2', 'acme/repo#3'])
  expect(journal.reconcilable('acme/repo#1', NOW, false, 1).map((chain) => chain.id)).toEqual(['acme/repo#2'])
  expect(journal.reconcilable('', NOW, true)).toEqual([])
  const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, NOW, '', 100) as Array<{ detail: string }>
  expect(plan.map((row) => row.detail).join(' ')).toContain('USING COVERING INDEX behavior_chain_reconciliation')
})
