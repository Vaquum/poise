import { afterAll, expect, it } from 'vitest'
import { closeDatabase } from '../server/db'
import { behaviorChainJournal, behaviorChainOwner, behaviorChainOwnsRepository } from '../server/behavior-chain-journal'
import { bindWork, bindWorkAuto, bindings } from '../server/chat/control-store'

afterAll(() => closeDatabase())

it('reserves the native branch before publication is observed and refuses Chat takeover without claiming a same-named fork branch', () => {
  const chain = behaviorChainJournal().append('example/repo#7', 'seed', 0, { type: 'chain.admitted',
    repository: 'Example/Repo', issue: 7, branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' })
  const identity = { headRef: chain.branch, headRepo: 'example/repo' }
  expect(chain.observation).toBeNull()
  expect(behaviorChainOwnsRepository('EXAMPLE/REPO')).toBe(true)
  expect(behaviorChainOwner('Example/Repo', 37, 'pull')).toBeNull()
  expect(behaviorChainOwner('Example/Repo', 37, 'pull', identity)).toBe(chain.id)
  expect(behaviorChainOwner('Example/Repo', 37, 'pull', { ...identity, headRepo: 'other/repo' })).toBeNull()
  expect(() => bindWork('fixture', 'chat', 'https://github.com/Example/Repo/pull/37', identity)).toThrow('owned by behavior chain')
  expect(bindWorkAuto('fixture', 'chat', 'https://github.com/Example/Repo/pull/37', identity)).toBeNull()
  expect(bindings('fixture')).toHaveLength(0)
})

it('keeps the seed obligation owned after a confirmed merge without qualifying pre-merge review evidence', () => {
  const journal = behaviorChainJournal()
  const chain = journal.append('example/repo#8', 'seed-eight', 0, { type: 'chain.admitted',
    repository: 'Example/Repo', issue: 8, branch: 'poise/issue-8', author: 'author', reviewer: 'reviewer' })
  journal.append(chain.id, 'merged-eight', chain.sequence, { type: 'chain.merged', mergeSha: 'a'.repeat(40),
    evidence: { repository: chain.repository, pull_number: 38, merged: true, merge_sha: 'a'.repeat(40), review_complete: false } })
  expect(behaviorChainOwner(chain.repository, 8, 'issues')).toBe(chain.id)
  journal.rebuild()
  expect(behaviorChainOwner(chain.repository, 8, 'issues')).toBe(chain.id)
})
